// tests/verification 共享脚手架（测试角色独占；不依赖、不修改 tests/adapter 既有文件）。
// 事件全部为本地合成，不发任何 LLM 请求；真实 Pi 1.1.0 模块按绝对 file URL 动态导入，
// 临时目录隔离（不触碰用户 Pi 设置/全局扩展）。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PiExtensionApiLike, PiExtensionContextLike } from '../../src/adapter/index.ts';

export const MARKER_TYPE = 'pi-session-tps.measurement';

/** 真实 SessionManager 条目的读取子集（与 dist/core/session-manager.js 运行时形状一致）。 */
export interface RealEntryLike {
	readonly id: string;
	readonly type: string;
	readonly message?: unknown;
	readonly customType?: string;
	readonly data?: unknown;
}

/** 本验证实际消费的真实 SessionManager 方法子集（静态类型独立于 Pi d.ts）。 */
export interface RealSessionManagerLike {
	appendMessage(message: unknown): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	appendCompaction(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
		usage?: unknown,
	): string;
	appendContextEdit(targetId: string, replacement: { content: unknown } | null): string;
	appendModelChange(provider: string, modelId: string): string;
	appendUsage(kind: string, provider: string, model: string, usage: unknown, note?: string): RealEntryLike;
	getBranch(fromId?: string): RealEntryLike[];
	getEntry(id: string): RealEntryLike | undefined;
	getLeafId(): string | null;
	branch(branchFromId: string): void;
	createBranchedSession(leafId: string): string | undefined;
	getSessionFile(): string | undefined;
}

export interface RealSessionManagerStatic {
	create(cwd: string, sessionDir?: string): RealSessionManagerLike;
	open(sessionFile: string, sessionDir?: string, cwdOverride?: string): RealSessionManagerLike;
}

/** 解析本机 Pi 安装（与 scripts/check-loader.mts 同规则；不可用抛“环境阻塞”错误）。 */
export function resolvePiPackageDir(): string {
	const override = process.env.PI_SESSION_TPS_PI_DIR;
	if (override) return path.resolve(override);
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
	const versionFile = path.join(agentDir, 'install', 'current-version');
	if (!fs.existsSync(versionFile)) {
		throw new Error(`verification environment blocked: 未找到 Pi 版本文件 ${versionFile}`);
	}
	const version = fs.readFileSync(versionFile, 'utf8').trim();
	const pkgDir = path.join(
		agentDir,
		'install',
		'releases',
		version,
		'node_modules',
		'@earendil-works',
		'pi-coding-agent',
	);
	if (!fs.existsSync(pkgDir)) {
		throw new Error(`verification environment blocked: 未找到 Pi 包目录 ${pkgDir}`);
	}
	return pkgDir;
}

let cachedSessionManager: RealSessionManagerStatic | undefined;

/** 动态导入真实 Pi 的 SessionManager（绝对 file URL；package exports 不暴露该内部路径）。 */
export async function importRealSessionManager(): Promise<RealSessionManagerStatic> {
	if (cachedSessionManager != null) return cachedSessionManager;
	const modulePath = path.join(resolvePiPackageDir(), 'dist', 'core', 'session-manager.js');
	if (!fs.existsSync(modulePath)) {
		throw new Error(`verification environment blocked: 未找到真实 SessionManager 模块 ${modulePath}`);
	}
	const mod = (await import(pathToFileURL(modulePath).href)) as {
		SessionManager?: RealSessionManagerStatic;
	};
	if (
		typeof mod.SessionManager?.create !== 'function' ||
		typeof mod.SessionManager?.open !== 'function'
	) {
		throw new Error('verification environment blocked: 真实 SessionManager 导入形状不符');
	}
	cachedSessionManager = mod.SessionManager;
	return cachedSessionManager;
}

export function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** 可控单调时钟（验证注入；生产实现使用 performance.now）。 */
export class FakeClock {
	private current: number;

	constructor(start = 1_000) {
		this.current = start;
	}

	now(): number {
		return this.current;
	}

	advance(ms: number): number {
		this.current += ms;
		return this.current;
	}
}

export interface AssistantMsgInit {
	content?: Array<Record<string, unknown>>;
	usageOutput?: number;
	reasoning?: number;
	stopReason?: string;
	provider?: string;
	model?: string;
	timestamp?: number;
}

/** 构造真实 Pi AssistantMessage 形状（含完整 Usage；reasoning 为 output 子集）。 */
export function assistantMsg(init: AssistantMsgInit = {}): Record<string, unknown> {
	const output = init.usageOutput ?? 0;
	return {
		role: 'assistant',
		content: init.content ?? [{ type: 'text', text: '' }],
		provider: init.provider ?? 'anthropic',
		model: init.model ?? 'claude-verification',
		usage: {
			input: 10,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			...(init.reasoning != null ? { reasoning: init.reasoning } : {}),
			totalTokens: output + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: init.stopReason ?? 'stop',
		timestamp: init.timestamp ?? 1_000,
	};
}

export function userMsg(text: string, timestamp: number): Record<string, unknown> {
	return { role: 'user', content: text, timestamp };
}

export interface StatusCall {
	readonly mode: string;
	readonly key: string;
	readonly text: string | undefined;
}

export interface DriverInit {
	readonly mode?: string;
	readonly now: () => number;
	readonly getBranch: () => readonly RealEntryLike[];
	readonly appendEntry?: (customType: string, data?: unknown) => void;
}

/**
 * 以结构兼容方式驱动扩展公共 API：pi.on 注册、pi.appendEntry 桥接真实 SM 或记录器、
 * context 携带真实/合成 getBranch。与 Pi runner 的 createContext 提供面一致。
 */
export class ExtensionDriver {
	readonly statusCalls: StatusCall[] = [];
	private readonly handlers = new Map<
		string,
		Array<(event: never, context: PiExtensionContextLike) => unknown>
	>();
	readonly pi: PiExtensionApiLike;
	readonly context: PiExtensionContextLike;

	constructor(init: DriverInit) {
		const mode = init.mode ?? 'tui';
		const pi = {
			on: (
				event: string,
				handler: (event: never, context: PiExtensionContextLike) => unknown,
			) => {
				const list = this.handlers.get(event) ?? [];
				list.push(handler);
				this.handlers.set(event, list);
				return () => {
					const current = this.handlers.get(event);
					const index = current?.indexOf(handler) ?? -1;
					if (index >= 0) current?.splice(index, 1);
				};
			},
			appendEntry: (customType: string, data?: unknown) => {
				init.appendEntry?.(customType, data);
			},
		};
		this.pi = pi as unknown as PiExtensionApiLike;
		this.context = {
			mode,
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					this.statusCalls.push({ mode, key, text });
				},
			},
			sessionManager: { getBranch: () => init.getBranch() },
		} as unknown as PiExtensionContextLike;
	}

	async emit(event: Record<string, unknown>): Promise<void> {
		for (const handler of [...(this.handlers.get(String(event.type)) ?? [])]) {
			await handler(event as never, this.context);
		}
	}

	lastStatus(): string | undefined {
		return this.statusCalls.at(-1)?.text;
	}
}

export function textPart(text: string): Record<string, unknown> {
	return { type: 'text', text };
}

/** 分支中的 assistant 消息条目（读取子集）。 */
export function assistantEntries(sm: RealSessionManagerLike): RealEntryLike[] {
	return sm.getBranch().filter((entry) => {
		const message = entry.message as { role?: unknown } | undefined;
		return entry.type === 'message' && message?.role === 'assistant';
	});
}

export function markerEntries(sm: RealSessionManagerLike): RealEntryLike[] {
	return sm.getBranch().filter(
		(entry) => entry.type === 'custom' && entry.customType === MARKER_TYPE,
	);
}

/** 读取真实会话文件行（JSONL；含 header）。 */
export function readSessionFileLines(sessionFile: string): Array<Record<string, unknown>> {
	const raw = fs.readFileSync(sessionFile, 'utf8');
	return raw
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

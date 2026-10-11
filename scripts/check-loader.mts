#!/usr/bin/env node
// check:loader — 用本机真实 Pi（dist/core/extensions/loader.js）做扩展加载冒烟：
//   1. 以“本地 package 目录”的官方发现规则（package.json 的 pi.extensions）加载本包 entry；
//   2. 验证扩展工厂执行、恰好注册约定的 9 个事件（含 turn_end 持久化后校准边界）、
//      未注册 tools/commands；
//   3. 通过真实注册的 handler 驱动完整一轮合成事件（不发任何 LLM 请求）：
//      session_start → agent_start → message_start → message_update → message_end
//      → agent_settled →（模拟 marker/assistant 落盘）→ turn_end → session_shutdown。
//      验证非 TUI 模式零 UI 调用、TUI 模式 status 文本形状与「已测 m/n」口径、
//      marker 经真实 appendEntry 路径写出、turn_end 校准不双算/不清当前轮。
// 说明：Pi 的 appendEntry 在 runner.bindCore 前是抛错占位（见 loader.js createExtensionRuntime）；
// 真实运行时由 bindCore 替换。此处同样在该边界替换为记录器，等价于 Pi 的做法。
// 安全边界：不改用户设置；用空临时目录作 agentDir，避免触碰用户全局 extensions/。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');

const MARKER_CUSTOM_TYPE = 'pi-session-tps.measurement';

function fail(message: string): never {
	console.error(`check:loader FAILED: ${message}`);
	process.exit(1);
}

function resolvePiPackageDir() {
	const override = process.env.PI_SESSION_TPS_PI_DIR;
	if (override) return path.resolve(override);
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
	const versionFile = path.join(agentDir, 'install', 'current-version');
	if (!fs.existsSync(versionFile)) {
		fail(
			`未找到 Pi 安装版本文件 ${versionFile}；` +
				'可用 PI_SESSION_TPS_PI_DIR 直接指定 @earendil-works/pi-coding-agent 包目录',
		);
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
	if (!fs.existsSync(pkgDir)) fail(`未找到 Pi 包目录：${pkgDir}`);
	return pkgDir;
}

const piPackageDir = resolvePiPackageDir();
const loaderPath = path.join(piPackageDir, 'dist', 'core', 'extensions', 'loader.js');
if (!fs.existsSync(loaderPath)) fail(`未找到 Pi 扩展 loader：${loaderPath}`);

const loader = await import(pathToFileURL(loaderPath).href);

const EXPECTED_EVENTS = [
	'agent_start',
	'agent_settled',
	'message_end',
	'message_start',
	'message_update',
	'session_shutdown',
	'session_start',
	'session_tree',
	'turn_end',
];

const expectedEntry = path.join(projectRoot, 'index.ts');

// 空临时 agentDir：discoverAndLoadExtensions 也会扫描全局 extensions/ 与
// <cwd>/.pi/extensions/，指向空目录确保只加载本包。
const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-tps-smoke-'));

try {
	const result = await loader.discoverAndLoadExtensions([projectRoot], projectRoot, tempAgentDir);

	if (result.errors.length > 0) {
		fail(`加载错误：${JSON.stringify(result.errors, null, 2)}`);
	}
	if (result.extensions.length !== 1) {
		fail(`期望恰好加载 1 个扩展，实际 ${result.extensions.length}`);
	}
	const extension = result.extensions[0];
	if (path.resolve(extension.resolvedPath) !== expectedEntry) {
		fail(`entry 应解析为 ${expectedEntry}，实际 ${extension.resolvedPath}`);
	}

	const events = [...extension.handlers.keys()].sort();
	const expected = [...EXPECTED_EVENTS].sort();
	if (JSON.stringify(events) !== JSON.stringify(expected)) {
		fail(`注册事件不符：${JSON.stringify(events)}`);
	}
	if (extension.tools.size !== 0 || extension.commands.size !== 0) {
		fail('本扩展不应注册 tools/commands');
	}
	console.log(`loader: package entry 加载成功 (${path.relative(projectRoot, extension.resolvedPath)})`);
	console.log(`loader: 注册事件 ${events.join(', ')}`);

	// 在 Pi 自己替换 appendEntry 占位的边界（runner.bindCore 同一层）注入记录器。
	const appended: Array<{ customType: string; data: unknown }> = [];
	result.runtime.appendEntry = (customType: string, data: unknown) => {
		appended.push({ customType, data });
	};

	const statusLines: Array<{ mode: string; key: string; text: string | undefined }> = [];

	/** 上下文带可变分支：message_end 后写入 marker+assistant 条目，模拟 Pi 落盘顺序。 */
	function makeContext(mode: string) {
		const branch: Array<Record<string, unknown>> = [];
		return {
			mode,
			branch,
			ui: {
				setStatus(key: string, text: string | undefined) {
					statusLines.push({ mode, key, text });
				},
			},
			sessionManager: {
				getBranch() {
					return branch;
				},
			},
		};
	}

	async function emit(eventName: string, event: unknown, context: unknown) {
		for (const handler of extension.handlers.get(eventName) ?? []) {
			await handler(event, context);
		}
	}

	function makeAssistantMessage(text: string, output: number) {
		return {
			role: 'assistant',
			provider: 'smoke-provider',
			model: 'smoke-model',
			timestamp: Date.now(),
			content: [{ type: 'text', text }],
			usage: { output },
			stopReason: 'stop',
		};
	}

	/** 完整一轮：message_end 后取出真实写出的 marker，模拟 Pi 落盘顺序并触发 turn_end 校准。 */
	async function runRound(context: ReturnType<typeof makeContext>, deltaText: string, output: number) {
		await emit('session_start', { type: 'session_start', reason: 'startup' }, context);
		await emit('agent_start', { type: 'agent_start' }, context);
		await emit('message_start', { type: 'message_start', message: { role: 'assistant' } }, context);
		await emit(
			'message_update',
			{
				type: 'message_update',
				message: { role: 'assistant' },
				assistantMessageEvent: { type: 'text_delta', delta: deltaText },
			},
			context,
		);
		const message = makeAssistantMessage(deltaText, output);
		await emit('message_end', { type: 'message_end', message }, context);
		await emit('agent_settled', { type: 'agent_settled', aborted: false }, context);
		// 模拟 Pi 持久化顺序：marker（message_end 中 appendEntry）→ assistant 落盘 → turn_end。
		const marker = appended[appended.length - 1] as { customType: string; data: unknown } | undefined;
		context.branch.push({ type: 'custom', customType: MARKER_CUSTOM_TYPE, data: marker?.data });
		context.branch.push({ type: 'message', message });
		await emit('turn_end', { type: 'turn_end', message }, context);
		return message;
	}

	function assertStatusShape(entry: { key: string; text: string | undefined } | undefined, where: string) {
		if (entry == null || entry.key !== 'pi-session-tps') {
			fail(`${where}：应以 pi-session-tps key 写 status，实际 ${JSON.stringify(entry)}`);
		}
		const text = String(entry.text ?? '');
		if (!/^当轮 [~\d.]+ \| 会话 [~\d.]+ tok\/s \| 已测 \d+\/\d+$/.test(text)) {
			fail(`${where}：status 文本形状不符：${JSON.stringify(text)}`);
		}
		return text;
	}

	// 非 TUI：完整一轮（含 turn_end 校准）后零 UI 调用（R5：非交互仍执行统计且无终端 UI）。
	const rpcContext = makeContext('rpc');
	await runRound(rpcContext, 'hello session tps', 42);
	if (appended.length !== 1) {
		fail(`期望写出 1 个 measurement marker，实际 ${appended.length}`);
	}
	const rpcMarker = appended[0] as { customType: string; data: unknown };
	if (rpcMarker.customType !== MARKER_CUSTOM_TYPE) fail(`marker customType 不符：${rpcMarker.customType}`);
	const data = (rpcMarker.data ?? {}) as Record<string, unknown>;
	// MARKER_VERSION=2（结构无歧义指纹时代；schema 升级时须同步本断言）。
	if (data.v !== 2 || typeof data.roundId !== 'string' || typeof data.segmentId !== 'string') {
		fail(`marker 字段非法：${JSON.stringify(data)}`);
	}
	const match = (data.match ?? {}) as Record<string, unknown>;
	const matchKeys = Object.keys(match).sort();
	if (JSON.stringify(matchKeys) !== JSON.stringify(['contentHash', 'model', 'provider', 'stopReason', 'timestamp'])) {
		fail(`marker.match 应只含五个匹配字段（不含运行时 key）：${JSON.stringify(matchKeys)}`);
	}
	if (typeof match.contentHash !== 'string' || match.contentHash.length === 0) {
		fail(`marker.match.contentHash 非法：${JSON.stringify(match.contentHash)}`);
	}
	const generationMs = data.generationMs;
	if (typeof generationMs !== 'number' || !(generationMs > 0) || !Number.isFinite(generationMs)) {
		fail(`marker generationMs 非法：${String(generationMs)}`);
	}
	const rpcUiCalls = statusLines.filter((line) => line.mode === 'rpc');
	if (rpcUiCalls.length !== 0) {
		fail(`非 TUI 模式不应调用 setStatus，实际 ${rpcUiCalls.length} 次`);
	}
	console.log(`loader: 非 TUI 一轮完成（含 turn_end），零 UI 调用，marker generationMs=${generationMs.toFixed(3)}ms`);

	// TUI：新工厂实例重放一轮（loadExtensions 每次重新执行模块），验证 status 与校准口径。
	const tuiContext = makeContext('tui');
	await runRound(tuiContext, 'second round', 7);
	const totalMarkers: number = appended.length;
	if (totalMarkers !== 2) {
		fail(`期望两轮共写出 2 个 marker，实际 ${totalMarkers}`);
	}
	const tuiLines = statusLines.filter((line) => line.mode === 'tui');
	if (tuiLines.length < 2) {
		fail(`TUI 轮应至少产生 agent_settled 与 turn_end 两条 status，实际 ${tuiLines.length} 条`);
	}
	const settledText = assertStatusShape(tuiLines[tuiLines.length - 2], 'TUI agent_settled 后');
	if (!settledText.includes('已测 1/1')) {
		fail(`agent_settled 后覆盖口径应为已测 1/1（1 个完整观测结算段），实际：${settledText}`);
	}
	const calibratedText = assertStatusShape(tuiLines[tuiLines.length - 1], 'TUI turn_end 校准后');
	if (!calibratedText.includes('已测 1/1')) {
		fail(`turn_end 按真实分支校准后应为已测 1/1（1 条真实 assistant、1 条有效配对），实际：${calibratedText}`);
	}
	if (calibratedText !== settledText) {
		fail(`turn_end 校准不应改变当前轮数值（不双算/不清轮）：${settledText} -> ${calibratedText}`);
	}
	console.log(`loader: TUI status = ${calibratedText}`);

	// session_shutdown 后清理 status（真实退出路径不抛错）。
	await emit('session_shutdown', { type: 'session_shutdown' }, tuiContext);
	console.log('check:loader OK');
} finally {
	fs.rmSync(tempAgentDir, { recursive: true, force: true });
}

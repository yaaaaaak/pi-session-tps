// 独立验证：真实 Pi 1.1.0 扩展 loader（dist/core/extensions/loader.js）加载本包
// default entry（package.json pi.extensions → index.ts），配合真实 SessionManager：
// 加载/注册/事件生命周期、非 TUI 零终端 UI、真实文件顺序（marker 先于 assistant）、
// TUI status 形状与覆盖、session_shutdown 清理。jiti 加载，无 LLM 请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type RealEntryLike,
	type RealSessionManagerLike,
	type RealSessionManagerStatic,
	assistantMsg,
	importRealSessionManager,
	makeTempDir,
	readSessionFileLines,
	removeTempDir,
	resolvePiPackageDir,
	textPart,
	userMsg,
} from './harness.ts';

interface LoadedExtensionShape {
	resolvedPath: string;
	handlers: Map<string, Array<(event: never, context: unknown) => unknown>>;
	tools: { size: number };
	commands: { size: number };
}

interface DiscoverShape {
	(
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
	): Promise<{
		errors: Array<{ path: string; error: string }>;
		extensions: LoadedExtensionShape[];
		runtime: { appendEntry: (customType: string, data?: unknown) => void };
	}>;
}

async function importRealLoader(): Promise<DiscoverShape> {
	const loaderPath = path.join(resolvePiPackageDir(), 'dist', 'core', 'extensions', 'loader.js');
	if (!fs.existsSync(loaderPath)) {
		throw new Error(`verification environment blocked: 未找到真实 loader ${loaderPath}`);
	}
	const mod = (await import(pathToFileURL(loaderPath).href)) as {
		discoverAndLoadExtensions?: DiscoverShape;
	};
	if (typeof mod.discoverAndLoadExtensions !== 'function') {
		throw new Error('verification environment blocked: 真实 loader 导入形状不符');
	}
	return mod.discoverAndLoadExtensions;
}

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
].sort();

test('loader: 真实 loader 经 package 发现规则加载 default entry 并注册 9 事件（含 turn_end）', async () => {
	const projectRoot = path.resolve(import.meta.dirname, '..', '..');
	const discover = await importRealLoader();
	const tempAgentDir = makeTempDir('pi-tps-verify-loader-');
	try {
		const result = await discover([projectRoot], projectRoot, tempAgentDir);
		assert.deepEqual(result.errors, [], '加载不应有错误');
		assert.equal(result.extensions.length, 1, '应恰好加载 1 个扩展');
		const extension = result.extensions[0];
		assert.equal(
			path.resolve(extension.resolvedPath),
			path.join(projectRoot, 'index.ts'),
			'entry 应解析为 package.json pi.extensions 指向的 index.ts',
		);
		assert.deepEqual([...extension.handlers.keys()].sort(), EXPECTED_EVENTS);
		assert.equal(extension.tools.size, 0, '不应注册 tools');
		assert.equal(extension.commands.size, 0, '不应注册 commands');
	} finally {
		removeTempDir(tempAgentDir);
	}
});

test('loader: 真实 loader + 真实 SessionManager 全生命周期（rpc 零 UI / TUI status / 文件顺序）', async () => {
	const statics: RealSessionManagerStatic = await importRealSessionManager();
	const discover = await importRealLoader();
	const projectRoot = path.resolve(import.meta.dirname, '..', '..');
	const tempAgentDir = makeTempDir('pi-tps-verify-loader2-');
	const tempSessionDir = makeTempDir('pi-tps-verify-loader-sm-');
	try {
		const result = await discover([projectRoot], projectRoot, tempAgentDir);
		assert.equal(result.extensions.length, 1);
		const extension = result.extensions[0];

		const sm: RealSessionManagerLike = statics.create(tempSessionDir, tempSessionDir);
		// 与 Pi runner.bindCore 同层替换 appendEntry（runner.js:212 同机制）。
		result.runtime.appendEntry = (customType: string, data?: unknown) => {
			sm.appendCustomEntry(customType, data);
		};

		const statusCalls: Array<{ mode: string; key: string; text: string | undefined }> = [];
		const makeContext = (mode: string) => ({
			mode,
			ui: {
				setStatus(key: string, text: string | undefined) {
					statusCalls.push({ mode, key, text });
				},
			},
			sessionManager: { getBranch: (): RealEntryLike[] => sm.getBranch() },
		});
		const emit = async (eventName: string, event: unknown, context: unknown) => {
			for (const handler of extension.handlers.get(eventName) ?? []) {
				await handler(event as never, context);
			}
		};

		// --- rpc：完整一轮，零终端 UI；marker 经真实 appendCustomEntry 先于 assistant 落盘 ---
		const rpcContext = makeContext('rpc');
		const user = userMsg('loader round', 1_000);
		await emit('session_start', { type: 'session_start', reason: 'startup' }, rpcContext);
		await emit('message_start', { type: 'message_start', message: user }, rpcContext);
		await emit('message_end', { type: 'message_end', message: user }, rpcContext);
		sm.appendMessage(user);
		await emit('agent_start', { type: 'agent_start' }, rpcContext);
		await emit('message_start', { type: 'message_start', message: { role: 'assistant' } }, rpcContext);
		await emit(
			'message_update',
			{
				type: 'message_update',
				message: { role: 'assistant' },
				assistantMessageEvent: { type: 'text_delta', delta: 'verified by real loader' },
			},
			rpcContext,
		);
		const finalMessage = assistantMsg({
			content: [textPart('verified by real loader')],
			usageOutput: 42,
			timestamp: 1_500,
		});
		await emit('message_end', { type: 'message_end', message: finalMessage }, rpcContext);
		sm.appendMessage(finalMessage); // 真实 Pi 在扩展 message_end await 后持久化。
		// 持久化后安全边界：turn_end 按真实分支校准。
		await emit('turn_end', { type: 'turn_end', message: finalMessage }, rpcContext);
		await emit('agent_settled', { type: 'agent_settled', aborted: false }, rpcContext);

		assert.equal(statusCalls.length, 0, 'rpc 模式不得调用 setStatus');
		const lines = readSessionFileLines(sm.getSessionFile() as string);
		const markerIndex = lines.findIndex(
			(line) => line.type === 'custom' && line.customType === 'pi-session-tps.measurement',
		);
		const assistantIndex = lines.findIndex(
			(line) =>
				line.type === 'message' &&
				(line.message as { role?: unknown } | undefined)?.role === 'assistant',
		);
		assert.ok(markerIndex >= 0 && assistantIndex > markerIndex, '真实文件中 marker 必须先于 assistant');

		// --- tui：同一加载实例换 TUI 上下文，先按真实分支重建（reload 语义） ---
		const tuiContext = makeContext('tui');
		await emit('session_start', { type: 'session_start', reason: 'reload' }, tuiContext);
		const afterReload = statusCalls.at(-1);
		assert.equal(afterReload?.mode, 'tui');
		assert.equal(afterReload?.key, 'pi-session-tps');
		assert.match(
			String(afterReload?.text),
			/^当轮 -- \| 会话 \d+(?:\.\d+)? tok\/s \| 已测 1\/1$/,
			'重载后当轮应重置、会话按 marker+assistant 恢复、覆盖 1/1',
		);

		// TUI 新一轮：覆盖累计为 2/2。
		const user2 = userMsg('second round', 2_000);
		await emit('message_start', { type: 'message_start', message: user2 }, tuiContext);
		await emit('message_end', { type: 'message_end', message: user2 }, tuiContext);
		sm.appendMessage(user2);
		await emit('agent_start', { type: 'agent_start' }, tuiContext);
		await emit('message_start', { type: 'message_start', message: { role: 'assistant' } }, tuiContext);
		await emit(
			'message_update',
			{
				type: 'message_update',
				message: { role: 'assistant' },
				assistantMessageEvent: { type: 'text_delta', delta: 'second verified round' },
			},
			tuiContext,
		);
		const final2 = assistantMsg({
			content: [textPart('second verified round')],
			usageOutput: 7,
			timestamp: 2_500,
		});
		await emit('message_end', { type: 'message_end', message: final2 }, tuiContext);
		sm.appendMessage(final2);
		await emit('turn_end', { type: 'turn_end', message: final2 }, tuiContext);
		await emit('agent_settled', { type: 'agent_settled', aborted: false }, tuiContext);
		const finalStatus = statusCalls.at(-1);
		assert.equal(finalStatus?.key, 'pi-session-tps');
		assert.match(
			String(finalStatus?.text),
			/^当轮 \d+(?:\.\d+)? \| 会话 \d+(?:\.\d+)? tok\/s \| 已测 2\/2$/,
			'TUI 第二轮后应显示两个数值并覆盖 2/2',
		);

		// --- session_shutdown：清理 status（真实退出路径） ---
		await emit('session_shutdown', { type: 'session_shutdown' }, tuiContext);
		assert.deepEqual(statusCalls.at(-1), { mode: 'tui', key: 'pi-session-tps', text: undefined });
	} finally {
		removeTempDir(tempAgentDir);
		removeTempDir(tempSessionDir);
	}
});

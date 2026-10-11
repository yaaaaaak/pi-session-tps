// 独立验证（round-1 边界澄清，真实 SessionManager）：拒算/丢弃/最终校准/一致性。
// 场景全部对照 SPEC「首轮独立审查后的必要边界澄清」：
// - 流中途 reload + 后续 delta + message_end 完整 output：整条响应拒算（非仅加 ~）；
// - 最后 delta 之后 reload、仅剩 message_end：拒算但计入 coverage.total；
// - 完整 partial 流异常后被新空 failure assistant 替换（partial 未落盘）：原流丢弃；
// - 其他扩展改写最终正文：marker 不配对，turn_end 持久化后边界最终校准保守；
// - 每个场景断言两个时间点（message_end 边界 / 持久化后 turn_end 边界）的真实
//   branch 内容与 coverage，以及真实文件 reload 恢复后的状态一致性。
// 事件全部本地合成，无 LLM 请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTpsExtension } from '../../src/adapter/index.ts';
import {
	ExtensionDriver,
	FakeClock,
	type RealSessionManagerLike,
	assistantEntries,
	assistantMsg,
	importRealSessionManager,
	makeTempDir,
	markerEntries,
	removeTempDir,
	textPart,
	userMsg,
} from './harness.ts';

interface Live {
	readonly sm: RealSessionManagerLike;
	readonly driver: ExtensionDriver;
	readonly clock: FakeClock;
	readonly tempDir: string;
}

/** 真实 SessionManager + 扩展实例；appendEntry 桥到真实 appendCustomEntry。 */
async function createLive(): Promise<Live> {
	const statics = await importRealSessionManager();
	const tempDir = makeTempDir('pi-tps-verify-b1-');
	const sm = statics.create(tempDir, tempDir);
	const clock = new FakeClock(1_000);
	const driver = new ExtensionDriver({
		mode: 'tui',
		now: () => clock.now(),
		getBranch: () => sm.getBranch(),
		appendEntry: (customType, data) => {
			sm.appendCustomEntry(customType, data);
		},
	});
	createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
	await driver.emit({ type: 'session_start', reason: 'startup' });
	return { sm, driver, clock, tempDir };
}

/** 真实 Pi 消息序：user 落盘 → agent_start →（流事件由调用方驱动）。 */
async function startRound(live: Live, userText: string, timestamp: number): Promise<void> {
	const user = userMsg(userText, timestamp);
	await live.driver.emit({ type: 'message_start', message: user });
	await live.driver.emit({ type: 'message_end', message: user });
	live.sm.appendMessage(user);
	await live.driver.emit({ type: 'agent_start' });
	await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
}

/** 持久化后安全边界：assistant 落盘 → turn_end 校准。 */
async function persistAndCalibrate(live: Live, finalMessage: Record<string, unknown>): Promise<void> {
	live.sm.appendMessage(finalMessage);
	await live.driver.emit({ type: 'turn_end', message: finalMessage });
}

/** 真实文件 reload + 新扩展实例恢复。 */
async function reloadDriver(sessionFile: string, sessionDir: string): Promise<ExtensionDriver> {
	const statics = await importRealSessionManager();
	const reopened = statics.open(sessionFile, sessionDir);
	const clock = new FakeClock(100_000);
	const driver = new ExtensionDriver({
		mode: 'tui',
		now: () => clock.now(),
		getBranch: () => reopened.getBranch(),
	});
	createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
	await driver.emit({ type: 'session_start', reason: 'reload' });
	return driver;
}

test('boundary: 流中途 reload + 后续 delta + 完整 output 的 message_end → 整条响应拒算', async () => {
	const live = await createLive();
	try {
		await startRound(live, 'q1', 1_499);
		live.clock.advance(1_000); // 2000：reload 前部分内容
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		// 流中途 reload：真实分支此刻只有 user（assistant 未落盘）。
		await live.driver.emit({ type: 'session_start', reason: 'reload' });
		assert.equal(markerEntries(live.sm).length, 0);
		assert.equal(assistantEntries(live.sm).length, 0);
		live.clock.advance(100); // 2100：reload 后 delta（无 message_start）
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(200) },
		});
		live.clock.advance(100); // 2200
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(200) },
		});
		// provisional 展示允许（带 ~）：100 tokens / 100ms。
		assert.equal(live.driver.lastStatus(), '当轮 ~1000 | 会话 ~1000 tok/s | 已测 0/0');
		live.clock.advance(300); // 2500：message_end 携带完整 output=50。
		const finalMessage = assistantMsg({
			content: [textPart('x'.repeat(400) + 'y'.repeat(400))],
			usageOutput: 50,
			timestamp: 2_600,
		});
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		// 时间点 1（message_end 边界）：拒算——无 marker、不进分子/分母，仅 total。
		// 不得出现完整 usage(50)/局部窗口(400ms→125 或 300ms→167) 的伪精确值。
		assert.equal(markerEntries(live.sm).length, 0);
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		// 时间点 2（持久化后 turn_end）：真实 assistant 落盘，校准仍为 0/1。
		await persistAndCalibrate(live, finalMessage);
		assert.equal(assistantEntries(live.sm).length, 1);
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		// 真实文件 reload 恢复：无 marker → 拒算状态一致。
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('boundary: 最后 delta 后 reload、仅剩 message_end → 拒算且计入 total', async () => {
	const live = await createLive();
	try {
		await startRound(live, 'q2', 1_499);
		live.clock.advance(100); // 1100：最后一个 delta
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		await live.driver.emit({ type: 'session_start', reason: 'reload' });
		live.clock.advance(400); // 1500：只剩 message_end（完整 output=80）。
		const finalMessage = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 80, timestamp: 1_600 });
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		assert.equal(markerEntries(live.sm).length, 0);
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await persistAndCalibrate(live, finalMessage);
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('boundary: partial 流被新空 failure assistant 替换 → 原流丢弃、仅 0/1', async () => {
	const live = await createLive();
	try {
		await startRound(live, 'q3', 1_499);
		live.clock.advance(100); // 1100：partial 内容已流过（无 message_end）
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		// 真实 pi-agent-core 异常路径：生成新的空 failure assistant 打断原流
		// （原 partial 不落盘 assistant）。
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(50); // 1150
		const failure = assistantMsg({ content: [], usageOutput: 0, stopReason: 'error', timestamp: 1_200 });
		await live.driver.emit({ type: 'message_end', message: failure });
		// 原流无对应落盘 assistant：丢弃，不进 TPS/coverage；空 failure 零内容零时长
		// 只进 total（旧缺陷会显示虚假的 1/2）。
		assert.equal(markerEntries(live.sm).length, 0);
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await persistAndCalibrate(live, failure);
		assert.equal(assistantEntries(live.sm).length, 1, '只落盘空 failure assistant');
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('boundary: 其他扩展改写最终正文 → marker 不配对，turn_end 最终校准保守', async () => {
	const live = await createLive();
	try {
		await startRound(live, 'q4', 1_499);
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		live.clock.advance(1_000); // 2100
		const seenView = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 2_200 });
		await live.driver.emit({ type: 'message_end', message: seenView });
		// message_end 落盘前：一次去重的 prospective 展示（SPEC 边界澄清允许）。
		assert.equal(markerEntries(live.sm).length, 1);
		assert.equal(live.driver.lastStatus(), '当轮 100 | 会话 100 tok/s | 已测 1/1');
		// 其他扩展改写最终正文后落盘：与 marker 指纹不一致。
		const rewritten = { ...seenView, content: [{ type: 'text', text: 'REWRITTEN BY OTHER EXTENSION' }] };
		live.sm.appendMessage(rewritten);
		await live.driver.emit({ type: 'turn_end', message: rewritten });
		// 持久化后边界最终校准：marker 证伪 → live 段降级丢弃 → 不保留虚假精确已测。
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		// 真实文件 reload：孤立 marker 不配对，状态与校准后一致。
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('boundary: 重复终态（message_end/turn_end 重复）经真实文件不双算', async () => {
	const live = await createLive();
	try {
		await startRound(live, 'q5', 1_499);
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		live.clock.advance(1_000); // 2100
		const finalMessage = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 2_200 });
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		const afterFirst = live.driver.lastStatus();
		assert.equal(afterFirst, '当轮 100 | 会话 100 tok/s | 已测 1/1');
		await persistAndCalibrate(live, finalMessage);
		assert.equal(live.driver.lastStatus(), afterFirst, 'turn_end 校准不双算');
		// 重复 message_end（同消息）与重复 turn_end：均不得双计。
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		await live.driver.emit({ type: 'turn_end', message: finalMessage });
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), afterFirst);
		assert.equal(markerEntries(live.sm).length, 1);
		assert.equal(assistantEntries(live.sm).length, 1);
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 100 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

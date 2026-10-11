// 独立验证（round-3 P1 复验）：配对最终 usage 权威替换（真实 SessionManager 端到端）。
// 可达路径（官方顺序）：本扩展完整观察 message_start/deltas/message_end → 写 marker、暂显
// 自结算值；后续合法同 role handler 保留正文/匹配字段、仅改 usage → Pi 落盘替换版 assistant
// （runner.js message_end 替换 + agent-session.js 落盘在扩展事件后）；turn_end 按分支配对
// 校准必须以落盘 assistant 的最终 usage 替换 final 的 tokens/tokenSource（SPEC 契约 3/6
// 与首轮/三轮澄清），settled 与真实文件 reload 的同一会话 TPS 必须一致，生成窗口保持自测值。
// 覆盖：provider→更小/更大 provider、provider→零/缺失/非法（marker 估算回退 ~）、
// estimate→provider、多响应同 cycle 加权不双算、重复 turn_end 幂等、未测/拒算响应不复活。
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

async function createLive(): Promise<Live> {
	const statics = await importRealSessionManager();
	const tempDir = makeTempDir('pi-tps-verify-r3u-');
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

interface PersistedRound {
	readonly userText: string;
	readonly text: string;
	readonly timestamp: number;
	/** 本扩展在 message_end 观察到的 usage.output（写 marker 前的自结算值）。 */
	readonly seenUsageOutput: number;
	/** 后续 handler 落盘版本的 usage（0/undefined/非法表示替换掉）。 */
	readonly persistedUsageOutput: number | undefined;
	readonly stopReason?: string;
	readonly ttftMs?: number;
	readonly generationMs: number;
}

/**
 * 一轮完整观察 + 后续 usage 替换落盘：
 * user 落盘 → agent_start → message_start → delta → message_end（seen usage，写 marker，暂显）
 * → 落盘替换版 assistant（同正文/匹配字段，仅 usage 不同）→ turn_end（最终校准）。
 */
async function runReplacedRound(
	live: Live,
	plan: PersistedRound,
): Promise<{ seenView: Record<string, unknown>; persisted: Record<string, unknown> }> {
	const user = userMsg(plan.userText, plan.timestamp - 1);
	await live.driver.emit({ type: 'message_start', message: user });
	await live.driver.emit({ type: 'message_end', message: user });
	live.sm.appendMessage(user);
	await live.driver.emit({ type: 'agent_start' });
	await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	live.clock.advance(plan.ttftMs ?? 100);
	await live.driver.emit({
		type: 'message_update',
		message: { role: 'assistant' },
		assistantMessageEvent: { type: 'text_delta', delta: plan.text, contentIndex: 0 },
	});
	live.clock.advance(plan.generationMs);
	const seenView = assistantMsg({
		content: [textPart(plan.text)],
		usageOutput: plan.seenUsageOutput,
		stopReason: plan.stopReason ?? 'stop',
		timestamp: plan.timestamp,
	});
	await live.driver.emit({ type: 'message_end', message: seenView });
	// 后续合法同 role handler 的替换结果：仅 usage 不同，正文与匹配字段保持。
	const persisted = assistantMsg({
		content: [textPart(plan.text)],
		usageOutput: plan.persistedUsageOutput ?? 0,
		stopReason: plan.stopReason ?? 'stop',
		timestamp: plan.timestamp,
	});
	if (plan.persistedUsageOutput === undefined) {
		(persisted.usage as Record<string, unknown>).output = undefined;
	}
	live.sm.appendMessage(persisted);
	await live.driver.emit({ type: 'turn_end', message: persisted });
	return { seenView, persisted };
}

test('usage-authority: provider 100→40，turn_end/settled/reload 一致 40，窗口保持', async () => {
	const live = await createLive();
	try {
		// 完整观察：delta 'x'*400，自测窗口 1000ms。
		const r = await runReplacedRound(live, {
			userText: 'q1',
			text: 'x'.repeat(400),
			timestamp: 2_000,
			seenUsageOutput: 100,
			persistedUsageOutput: 40,
			generationMs: 1_000,
		});
		// message_end 暂显自结算 100 tok/s（prospective，落盘前一次展示）。
		assert.ok(r.seenView != null);
		// turn_end 校准后：落盘 assistant 的最终 usage=40 权威 → 40 tokens / 1000ms。
		assert.equal(live.driver.lastStatus(), '当轮 40 | 会话 40 tok/s | 已测 1/1');
		// 生成窗口保持本扩展自测值（marker 不因 usage 替换而重算）。
		assert.equal(markerEntries(live.sm).length, 1);
		const marker = markerEntries(live.sm)[0].data as { generationMs: number; estimatedTokens: number };
		assert.equal(marker.generationMs, 1_000);
		assert.equal(marker.estimatedTokens, 100);
		// settled 后仍为 40（不回落到过时 provider 值 100）。
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 40 | 会话 40 tok/s | 已测 1/1');
		// 真实文件 reload：会话 40、coverage 1/1（settled==reload 不变式）。
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 40 tok/s | 已测 1/1');
		assert.equal(assistantEntries(live.sm).length, 1);
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('usage-authority: provider→更大 provider（100→250）同样替换', async () => {
	const live = await createLive();
	try {
		await runReplacedRound(live, {
			userText: 'q2',
			text: 'x'.repeat(400),
			timestamp: 2_000,
			seenUsageOutput: 100,
			persistedUsageOutput: 250,
			generationMs: 1_000,
		});
		assert.equal(live.driver.lastStatus(), '当轮 250 | 会话 250 tok/s | 已测 1/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 250 | 会话 250 tok/s | 已测 1/1');
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 250 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('usage-authority: provider→零值/缺失/非法 → marker 累计内容估算回退并带 ~', async () => {
	for (const variant of [0, undefined, 2.5, -3] as Array<number | undefined>) {
		const live = await createLive();
		try {
			await runReplacedRound(live, {
				userText: 'q3',
				text: 'x'.repeat(400),
				timestamp: 2_000,
				seenUsageOutput: 100,
				persistedUsageOutput: variant,
				generationMs: 1_000,
			});
			// 回退 marker.estimatedTokens=100（'x'*400/4）→ ~100 tok/s（估算标记）。
			assert.equal(
				live.driver.lastStatus(),
				'当轮 ~100 | 会话 ~100 tok/s | 已测 1/1',
				`variant=${String(variant)}`,
			);
			await live.driver.emit({ type: 'agent_settled', aborted: false });
			assert.equal(live.driver.lastStatus(), '当轮 ~100 | 会话 ~100 tok/s | 已测 1/1');
			const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
			assert.equal(
				restored.lastStatus(),
				'当轮 -- | 会话 ~100 tok/s | 已测 1/1',
				`variant=${String(variant)}`,
			);
		} finally {
			removeTempDir(live.tempDir);
		}
	}
});

test('usage-authority: estimate→provider 升级（去 ~，采用落盘最终 usage）', async () => {
	const live = await createLive();
	try {
		// 自结算阶段 usage 缺失（0）→ 估算 100（~100 暂显）；落盘版本最终 usage=80。
		await runReplacedRound(live, {
			userText: 'q4',
			text: 'x'.repeat(400),
			timestamp: 2_000,
			seenUsageOutput: 0,
			persistedUsageOutput: 80,
			generationMs: 1_000,
		});
		assert.equal(live.driver.lastStatus(), '当轮 80 | 会话 80 tok/s | 已测 1/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 80 | 会话 80 tok/s | 已测 1/1');
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 80 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('usage-authority: 同 cycle 多响应 Σtokens/ΣgenerationMs 加权，替换不双算', async () => {
	const live = await createLive();
	try {
		// 段 1：自结算 60，落盘替换为 25；窗口 400ms（toolUse）。
		const user = userMsg('q5', 1_999);
		await live.driver.emit({ type: 'message_start', message: user });
		await live.driver.emit({ type: 'message_end', message: user });
		live.sm.appendMessage(user);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'a'.repeat(400), contentIndex: 0 },
		});
		live.clock.advance(400); // 1500
		const seen1 = assistantMsg({
			content: [textPart('a'.repeat(400))],
			usageOutput: 60,
			stopReason: 'toolUse',
			timestamp: 1_600,
		});
		await live.driver.emit({ type: 'message_end', message: seen1 });
		const persisted1 = assistantMsg({
			content: [textPart('a'.repeat(400))],
			usageOutput: 25,
			stopReason: 'toolUse',
			timestamp: 1_600,
		});
		live.sm.appendMessage(persisted1);
		await live.driver.emit({ type: 'turn_end', message: persisted1 });

		// 工具执行 5000ms（排除）：toolResult 事件后长间隔。
		const toolResult = {
			role: 'toolResult',
			toolCallId: 't1',
			toolName: 'bash',
			content: [],
			usage: { input: 1, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: 4_000,
		};
		await live.driver.emit({ type: 'message_start', message: toolResult });
		await live.driver.emit({ type: 'message_end', message: toolResult });
		live.sm.appendMessage(toolResult);
		live.clock.advance(5_000); // 6500

		// 段 2：自结算 40，落盘保持 40；窗口 400ms。
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 6600
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'b'.repeat(200), contentIndex: 0 },
		});
		live.clock.advance(400); // 7000
		const seen2 = assistantMsg({ content: [textPart('b'.repeat(200))], usageOutput: 40, timestamp: 7_100 });
		await live.driver.emit({ type: 'message_end', message: seen2 });
		const persisted2 = assistantMsg({ content: [textPart('b'.repeat(200))], usageOutput: 40, timestamp: 7_100 });
		live.sm.appendMessage(persisted2);
		await live.driver.emit({ type: 'turn_end', message: persisted2 });
		await live.driver.emit({ type: 'agent_settled', aborted: false });

		// (25 + 40) / (400 + 400) ms = 81.25 → 81.3 tok/s；工具 5000ms 不进分母；
		// 段 1 不双算（60+25 或 60/25 各计一次都会偏离 81.3）。
		assert.equal(live.driver.lastStatus(), '当轮 81.3 | 会话 81.3 tok/s | 已测 2/2');
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 81.3 tok/s | 已测 2/2');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('usage-authority: 重复 turn_end 校准幂等（同分支重复通知不改变数值）', async () => {
	const live = await createLive();
	try {
		const r = await runReplacedRound(live, {
			userText: 'q6',
			text: 'x'.repeat(400),
			timestamp: 2_000,
			seenUsageOutput: 100,
			persistedUsageOutput: 40,
			generationMs: 1_000,
		});
		assert.equal(live.driver.lastStatus(), '当轮 40 | 会话 40 tok/s | 已测 1/1');
		await live.driver.emit({ type: 'turn_end', message: r.persisted });
		await live.driver.emit({ type: 'turn_end', message: r.persisted });
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 40 | 会话 40 tok/s | 已测 1/1');
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 40 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('usage-authority: 存在未测/拒算响应不能被校准复活', async () => {
	const live = await createLive();
	try {
		// 轮 A：流中途 reload → 整条响应拒算（无 marker），真实落盘 assistant 只进 total。
		const userA = userMsg('qa', 1_499);
		await live.driver.emit({ type: 'message_start', message: userA });
		await live.driver.emit({ type: 'message_end', message: userA });
		live.sm.appendMessage(userA);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400), contentIndex: 0 },
		});
		await live.driver.emit({ type: 'session_start', reason: 'reload' });
		live.clock.advance(400); // 1500
		const rejectedFinal = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 50, timestamp: 1_600 });
		await live.driver.emit({ type: 'message_end', message: rejectedFinal });
		live.sm.appendMessage(rejectedFinal);
		await live.driver.emit({ type: 'turn_end', message: rejectedFinal });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');

		// 轮 B：正常完整观察 + usage 替换 → 只有该响应可测。
		await runReplacedRound(live, {
			userText: 'qb',
			text: 'y'.repeat(400),
			timestamp: 9_000,
			seenUsageOutput: 100,
			persistedUsageOutput: 40,
			generationMs: 1_000,
		});
		// 拒算响应未复活：coverage 1/2，会话仅 40 tokens / 1000ms。
		assert.equal(live.driver.lastStatus(), '当轮 40 | 会话 40 tok/s | 已测 1/2');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 40 | 会话 40 tok/s | 已测 1/2');
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 40 tok/s | 已测 1/2');
	} finally {
		removeTempDir(live.tempDir);
	}
});

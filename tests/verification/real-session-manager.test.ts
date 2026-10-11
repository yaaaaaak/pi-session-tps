// 独立验证：真实 Pi 1.1.0 SessionManager（绝对 file URL 动态导入）+ 扩展公共 API。
// 覆盖（R4/R6）：marker 前置落盘与文件顺序、reload/resume/fork 恢复、真实 getBranch
// 语义（导航到 marker 叶/兄弟分支）、compaction/context_edit/usage 元数据、未测旧历史、
// 重复/损坏 marker 不双算、message_end 重复不双写。事件全部本地合成，无 LLM 请求。

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
	readSessionFileLines,
	removeTempDir,
	textPart,
	userMsg,
} from './harness.ts';

interface RoundPlan {
	readonly userText: string;
	readonly text: string;
	readonly ttftMs: number;
	readonly generationMs: number;
	readonly usageOutput: number;
	readonly stopReason?: string;
	readonly timestamp: number;
}

interface LiveSession {
	readonly sm: RealSessionManagerLike;
	readonly driver: ExtensionDriver;
	readonly clock: FakeClock;
	readonly tempDir: string;
	readonly sessionDir: string;
	/** 按真实 Pi 顺序驱动一轮：user 落盘 → agent_start → delta → message_end(写 marker) → assistant 落盘。 */
	runRound(plan: RoundPlan): Promise<void>;
}

async function createLiveSession(): Promise<LiveSession> {
	const statics = await importRealSessionManager();
	const tempDir = makeTempDir('pi-tps-verify-sm-');
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
	const live: LiveSession = {
		sm,
		driver,
		clock,
		tempDir,
		sessionDir: tempDir,
		async runRound(plan) {
			const user = userMsg(plan.userText, plan.timestamp - 1);
			await driver.emit({ type: 'message_start', message: user });
			await driver.emit({ type: 'message_end', message: user });
			sm.appendMessage(user);
			await driver.emit({ type: 'agent_start' });
			await driver.emit({ type: 'message_start', message: { role: 'assistant' } });
			clock.advance(plan.ttftMs);
			await driver.emit({
				type: 'message_update',
				message: { role: 'assistant' },
				assistantMessageEvent: { type: 'text_delta', delta: plan.text },
			});
			clock.advance(plan.generationMs);
			const finalMessage = assistantMsg({
				content: [textPart(plan.text)],
				usageOutput: plan.usageOutput,
				stopReason: plan.stopReason ?? 'stop',
				timestamp: plan.timestamp,
			});
			await driver.emit({ type: 'message_end', message: finalMessage });
			// 真实 Pi 在扩展 message_end 事件 await 完成后才 appendMessage（agent-session.js 顺序）。
			sm.appendMessage(finalMessage);
			await driver.emit({ type: 'turn_end', message: finalMessage });
			await driver.emit({ type: 'agent_settled', aborted: false });
		},
	};
	return live;
}

/** 新扩展实例 + 指定 SM 的恢复 harness（模拟 Pi 重载/分支导航后的扩展重建）。 */
async function restoreDriver(sm: RealSessionManagerLike): Promise<ExtensionDriver> {
	const clock = new FakeClock(100_000);
	const driver = new ExtensionDriver({
		mode: 'tui',
		now: () => clock.now(),
		getBranch: () => sm.getBranch(),
	});
	createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
	return driver;
}

const ROUND1: RoundPlan = {
	userText: 'first question',
	text: 'x'.repeat(400),
	ttftMs: 1_000,
	generationMs: 4_000,
	usageOutput: 200,
	timestamp: 1_500,
};

const ROUND2: RoundPlan = {
	userText: 'second question',
	text: 'y'.repeat(200),
	ttftMs: 100,
	generationMs: 900,
	usageOutput: 100,
	timestamp: 9_000,
};

test('real-sm: marker 经真实 appendCustomEntry 前置于 assistant 落盘，reload 后恢复', async () => {
	const live = await createLiveSession();
	try {
		await live.runRound(ROUND1);
		const file = live.sm.getSessionFile();
		assert.ok(file, '会话文件应已创建');
		const lines = readSessionFileLines(file);
		const markerIndex = lines.findIndex(
			(line) => line.type === 'custom' && line.customType === 'pi-session-tps.measurement',
		);
		const assistantIndex = lines.findIndex(
			(line) =>
				line.type === 'message' &&
				(line.message as { role?: unknown } | undefined)?.role === 'assistant',
		);
		assert.ok(markerIndex >= 0, '会话文件中应存在 measurement marker');
		assert.ok(assistantIndex > markerIndex, 'marker 行必须位于 assistant 消息行之前');
		const markerData = lines[markerIndex].data as { generationMs: number; estimatedTokens: number };
		assert.equal(markerData.generationMs, 4_000);
		assert.equal(markerData.estimatedTokens, 100);

		const statics = await importRealSessionManager();
		const reopened = statics.open(file, live.sessionDir);
		const driver = await restoreDriver(reopened);
		await driver.emit({ type: 'session_start', reason: 'reload' });
		assert.equal(driver.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('real-sm: fork 到 assistant 自身（createBranchedSession）恢复前置 marker', async () => {
	const live = await createLiveSession();
	try {
		await live.runRound(ROUND1);
		await live.runRound(ROUND2);
		// 真实 API 行为：createBranchedSession 会把当前 manager 切换到新会话文件，
		// 因此必须先捕获原文件路径再 fork。
		const originalFile = live.sm.getSessionFile() as string;
		const assistant1Id = assistantEntries(live.sm)[0].id;
		const forkFile = live.sm.createBranchedSession(assistant1Id);
		assert.ok(forkFile, 'fork 会话文件应已生成');
		assert.notEqual(forkFile, originalFile);

		const statics = await importRealSessionManager();
		// 完整会话：两轮均可结算。
		const full = await restoreDriver(statics.open(originalFile, live.sessionDir));
		await full.emit({ type: 'session_start', reason: 'resume' });
		assert.equal(full.lastStatus(), '当轮 -- | 会话 61.2 tok/s | 已测 2/2');

		// fork 到第一轮 assistant：分支只含 user+marker1+assistant1。
		const forked = await restoreDriver(statics.open(forkFile, live.sessionDir));
		await forked.emit({ type: 'session_start', reason: 'fork' });
		assert.equal(forked.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('real-sm: 真实 branch() 导航到 marker 叶不含 assistant，无未存在响应', async () => {
	const live = await createLiveSession();
	try {
		await live.runRound(ROUND1);
		const markerId = markerEntries(live.sm)[0].id;
		live.sm.branch(markerId);
		assert.equal(live.sm.getLeafId(), markerId);
		const driver = await restoreDriver(live.sm);
		await driver.emit({ type: 'session_tree', newLeafId: markerId });
		assert.equal(driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/0');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('real-sm: 兄弟分支互不串扰（branch 回 user 后的新轮只按当前路径统计）', async () => {
	const live = await createLiveSession();
	try {
		await live.runRound(ROUND1);
		await live.driver.emit({ type: 'session_start', reason: 'resume' });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/1');

		const userId = live.sm.getBranch()[0].id;
		live.sm.branch(userId);
		await live.driver.emit({ type: 'session_tree', newLeafId: userId });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/0');

		// 在 user 下生成兄弟分支：marker2+assistant2 与 marker1+assistant1 平行。
		live.clock.advance(10_000);
		await live.runRound({ ...ROUND2, text: 'z'.repeat(200), generationMs: 500, usageOutput: 100 });
		await live.driver.emit({ type: 'session_tree', newLeafId: live.sm.getLeafId() });
		// 仅当前路径：(100 tokens)/(500ms) = 200 tok/s；不含兄弟分支的 50。
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 200 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('real-sm: compaction/context_edit/usage/model_change 等真实元数据条目不破坏配对', async () => {
	const statics = await importRealSessionManager();
	const tempDir = makeTempDir('pi-tps-verify-meta-');
	try {
		const sm = statics.create(tempDir, tempDir);
		const clock = new FakeClock(1_000);
		const driver = new ExtensionDriver({
			now: () => clock.now(),
			getBranch: () => sm.getBranch(),
			appendEntry: (customType, data) => {
				sm.appendCustomEntry(customType, data);
			},
		});
		createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
		await driver.emit({ type: 'session_start', reason: 'startup' });

		const round1: RoundPlan = { ...ROUND1 };
		await runRoundWith(driver, sm, clock, round1);
		const assistant1 = assistantEntries(sm)[0];
		// 真实元数据：context_edit omit 失败响应、usage(cache_warm)、model_change、compaction。
		sm.appendContextEdit(assistant1.id, null);
		sm.appendUsage('cache_warm', 'anthropic', 'claude-verification', {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		sm.appendModelChange('openai', 'gpt-verification');
		const user2 = userMsg('after compaction', 8_999);
		const user2EntryId = sm.appendMessage(user2);
		sm.appendCompaction('summary of old context', user2EntryId, 12_345);

		clock.advance(1_000);
		// 第二轮：marker 与 assistant 之间插入真实非消息元数据（usage/compaction）。
		const user3 = userMsg('third', 9_500);
		await driver.emit({ type: 'message_start', message: user3 });
		await driver.emit({ type: 'message_end', message: user3 });
		sm.appendMessage(user3);
		await driver.emit({ type: 'agent_start' });
		await driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		clock.advance(100);
		await driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'w'.repeat(400) },
		});
		clock.advance(1_000);
		const final2 = assistantMsg({
			content: [textPart('w'.repeat(400))],
			usageOutput: 100,
			timestamp: 9_600,
		});
		await driver.emit({ type: 'message_end', message: final2 });
		// message_end 后、assistant 落盘前插入非消息元数据（真实 SM 允许）。
		sm.appendUsage('cache_warm', 'anthropic', 'claude-verification', {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		sm.appendMessage(final2);
		await driver.emit({ type: 'turn_end', message: final2 });
		await driver.emit({ type: 'agent_settled', aborted: false });

		const reopened = statics.open(sm.getSessionFile() as string, tempDir);
		const restored = await restoreDriver(reopened);
		await restored.emit({ type: 'session_start', reason: 'resume' });
		// 两对都配对：(200+100)/(4000+1000) ms = 60 tok/s。
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 60 tok/s | 已测 2/2');
	} finally {
		removeTempDir(tempDir);
	}
});

test('real-sm: 未测旧历史（安装前 assistant）只进分母', async () => {
	const statics = await importRealSessionManager();
	const tempDir = makeTempDir('pi-tps-verify-old-');
	try {
		const sm = statics.create(tempDir, tempDir);
		sm.appendMessage(userMsg('old question', 100));
		const oldAssistant = assistantMsg({
			content: [textPart('old answer before install')],
			usageOutput: 999,
			timestamp: 200,
		});
		sm.appendMessage(oldAssistant);

		const clock = new FakeClock(1_000);
		const driver = new ExtensionDriver({
			now: () => clock.now(),
			getBranch: () => sm.getBranch(),
			appendEntry: (customType, data) => {
				sm.appendCustomEntry(customType, data);
			},
		});
		createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
		await driver.emit({ type: 'session_start', reason: 'startup' });
		await runRoundWith(driver, sm, clock, ROUND1);

		const reopened = statics.open(sm.getSessionFile() as string, tempDir);
		const restored = await restoreDriver(reopened);
		await restored.emit({ type: 'session_start', reason: 'resume' });
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/2');
	} finally {
		removeTempDir(tempDir);
	}
});

test('real-sm: 重复 marker 与损坏 marker 经真实文件往返不双算不抛错', async () => {
	const live = await createLiveSession();
	try {
		await live.runRound(ROUND1);
		const markerData = markerEntries(live.sm)[0].data as Record<string, unknown>;
		const finalMessage = assistantMsg({
			content: [textPart(ROUND1.text)],
			usageOutput: ROUND1.usageOutput,
			timestamp: ROUND1.timestamp,
		});

		// 1) 重复配对（同 roundId/segmentId 的 marker+assistant 追加一份）。
		live.sm.appendCustomEntry('pi-session-tps.measurement', { ...markerData });
		live.sm.appendMessage({ ...finalMessage });
		await live.driver.emit({ type: 'session_start', reason: 'reload' });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/2');

		// 2) 损坏 marker（版本号非法）+ 可匹配 assistant：不贡献。
		live.sm.appendCustomEntry('pi-session-tps.measurement', { ...markerData, v: 99 });
		live.sm.appendMessage({ ...finalMessage });
		await live.driver.emit({ type: 'session_start', reason: 'reload' });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/3');

		// 3) NaN 时长：JSON 落盘为 null，重载解析后非法：不贡献、不抛错。
		live.sm.appendCustomEntry('pi-session-tps.measurement', {
			...markerData,
			generationMs: Number.NaN,
		});
		live.sm.appendMessage({ ...finalMessage });
		await live.driver.emit({ type: 'session_start', reason: 'reload' });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/4');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('real-sm: message_end 重复触发只写一个 marker、不双计', async () => {
	const live = await createLiveSession();
	try {
		const user = userMsg('dup', 1_499);
		await live.driver.emit({ type: 'message_start', message: user });
		await live.driver.emit({ type: 'message_end', message: user });
		live.sm.appendMessage(user);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(1_000);
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		live.clock.advance(4_000);
		const finalMessage = assistantMsg({
			content: [textPart('x'.repeat(400))],
			usageOutput: 200,
			timestamp: 1_500,
		});
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		const afterFirst = live.driver.lastStatus();
		assert.equal(afterFirst, '当轮 50 | 会话 50 tok/s | 已测 1/1');
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		assert.equal(live.driver.lastStatus(), afterFirst);
		live.sm.appendMessage(finalMessage);
		await live.driver.emit({ type: 'turn_end', message: finalMessage });
		assert.equal(live.driver.lastStatus(), afterFirst, 'turn_end 校准不双算');
		await live.driver.emit({ type: 'turn_end', message: finalMessage });
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(markerEntries(live.sm).length, 1);
		assert.equal(assistantEntries(live.sm).length, 1);

		const statics = await importRealSessionManager();
		const reopened = statics.open(live.sm.getSessionFile() as string, live.sessionDir);
		const restored = await restoreDriver(reopened);
		await restored.emit({ type: 'session_start', reason: 'reload' });
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 50 tok/s | 已测 1/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

/** 与 LiveSession.runRound 相同顺序的独立实现（供自定义中间插入元数据的轮使用）。 */
async function runRoundWith(
	driver: ExtensionDriver,
	sm: RealSessionManagerLike,
	clock: FakeClock,
	plan: RoundPlan,
): Promise<void> {
	const user = userMsg(plan.userText, plan.timestamp - 1);
	await driver.emit({ type: 'message_start', message: user });
	await driver.emit({ type: 'message_end', message: user });
	sm.appendMessage(user);
	await driver.emit({ type: 'agent_start' });
	await driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	clock.advance(plan.ttftMs);
	await driver.emit({
		type: 'message_update',
		message: { role: 'assistant' },
		assistantMessageEvent: { type: 'text_delta', delta: plan.text },
	});
	clock.advance(plan.generationMs);
	const finalMessage = assistantMsg({
		content: [textPart(plan.text)],
		usageOutput: plan.usageOutput,
		stopReason: plan.stopReason ?? 'stop',
		timestamp: plan.timestamp,
	});
	await driver.emit({ type: 'message_end', message: finalMessage });
	sm.appendMessage(finalMessage);
	await driver.emit({ type: 'turn_end', message: finalMessage });
	await driver.emit({ type: 'agent_settled', aborted: false });
}

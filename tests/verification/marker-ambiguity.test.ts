// 独立验证（round-2 P1）：marker 正文指纹结构无歧义（真实 SessionManager + scanner 直证）。
// 反例：单块 text "a|t:b" 与两块 ["a","b"] 在旧裸分隔符拼接下编码相同（t:a|t:b）；
// v2 结构化序列化后必须不同 hash，且改写落盘后 turn_end / reload 三路径保守拒配。
// 同时验证正常路径不受影响：同内容不同键序配对、两轮 weighted、v2 marker 落盘形状。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	assistantFingerprint,
	createSessionTpsExtension,
	scanBranchForMeasurements,
} from '../../src/adapter/index.ts';
import type { PiMessageLike, PiSessionEntryLike } from '../../src/adapter/index.ts';
import {
	ExtensionDriver,
	FakeClock,
	type RealSessionManagerLike,
	assistantMsg,
	importRealSessionManager,
	makeTempDir,
	removeTempDir,
	textPart,
	userMsg,
} from './harness.ts';

/** 测试本地 fixture 形状：真实 Pi 条目的合法超集（携带 id；生产子集类型只声明扫描字段）。 */
type SessionEntryFixture = PiSessionEntryLike & { readonly id?: string };

const META = { provider: 'anthropic', model: 'claude-verification', timestamp: 1_234, stopReason: 'stop' };

function msgWith(content: Array<Record<string, unknown>>, usageOutput = 42): PiMessageLike {
	return assistantMsg({ content, usageOutput, ...META }) as PiMessageLike;
}

function messageEntry(id: string, message: PiMessageLike): SessionEntryFixture {
	return { id, type: 'message', message };
}

function markerEntry(id: string, match: NonNullable<ReturnType<typeof assistantFingerprint>>): SessionEntryFixture {
	return {
		id,
		type: 'custom',
		customType: 'pi-session-tps.measurement',
		data: {
			v: 2,
			roundId: 'r-1',
			segmentId: 's-1',
			generationMs: 1_000,
			estimatedTokens: 3,
			match: {
				provider: match.provider,
				model: match.model,
				timestamp: match.timestamp,
				stopReason: match.stopReason,
				contentHash: match.contentHash,
			},
		},
	};
}

test('fingerprint: 单块 "a|t:b" 与两块 ["a","b"] 的 contentHash 不同（结构无歧义）', () => {
	const single = assistantFingerprint(msgWith([textPart('a|t:b')]));
	const twoBlocks = assistantFingerprint(msgWith([textPart('a'), textPart('b')]));
	assert.ok(single != null && twoBlocks != null);
	assert.notEqual(single.contentHash, twoBlocks.contentHash);
	// 运行时 key 也不同（去重键含 contentHash）。
	assert.notEqual(single.key, twoBlocks.key);
	// 其他分隔符/结构内嵌互异（非穷举，代表性反例族）。
	const cases: Array<Array<Record<string, unknown>>> = [
		[textPart('a'), textPart('|t:b')],
		[textPart('a|t:'), textPart('b')],
		[textPart('a|k:b')],
		[textPart('a|c:b')],
		[textPart(''), textPart('a|t:b'), textPart('')],
	];
	const hashes = new Set<string>([single.contentHash, twoBlocks.contentHash]);
	for (const content of cases) {
		const fp = assistantFingerprint(msgWith(content));
		assert.ok(fp != null);
		assert.ok(!hashes.has(fp.contentHash), `歧义残留：${JSON.stringify(content)}`);
		hashes.add(fp.contentHash);
	}
});

test('fingerprint: scanner 路径——歧义反例不配对并归因 voided', () => {
	const seen = assistantFingerprint(msgWith([textPart('a|t:b')]));
	assert.ok(seen != null);
	const scan = scanBranchForMeasurements([
		markerEntry('m1', seen),
		messageEntry('a1', msgWith([textPart('a'), textPart('b')])),
	]);
	assert.equal(scan.records.length, 0, '歧义替换不得配对');
	assert.equal(scan.totalAssistantEntries, 1);
	assert.deepEqual(scan.voidedMarkerSegmentIds, ['s-1'], '证伪归因到 marker segmentId');
});

test('fingerprint: 工具参数键序不同（同内容）指纹相同并可正常配对', () => {
	const argsA = { a: 1, b: 2 };
	const argsB = { b: 2, a: 1 };
	const fpA = assistantFingerprint(
		msgWith([{ type: 'toolCall', id: 't1', name: 'bash', arguments: argsA }]),
	);
	const fpB = assistantFingerprint(
		msgWith([{ type: 'toolCall', id: 't1', name: 'bash', arguments: argsB }]),
	);
	assert.ok(fpA != null && fpB != null);
	assert.equal(fpA.contentHash, fpB.contentHash, '键序不得影响指纹（stableStringify 键排序）');
	const scan = scanBranchForMeasurements([
		markerEntry('m1', fpA),
		messageEntry('a1', msgWith([{ type: 'toolCall', id: 't1', name: 'bash', arguments: argsB }])),
	]);
	assert.equal(scan.records.length, 1, '同内容键序不同应正常配对');
	assert.equal(scan.records[0].tokens, 42);
	assert.equal(scan.records[0].tokenSource, 'provider');
	assert.deepEqual(scan.voidedMarkerSegmentIds, []);
});

interface Live {
	readonly sm: RealSessionManagerLike;
	readonly driver: ExtensionDriver;
	readonly clock: FakeClock;
	readonly tempDir: string;
}

async function createLive(): Promise<Live> {
	const statics = await importRealSessionManager();
	const tempDir = makeTempDir('pi-tps-verify-r2-');
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

test('sm-ambiguity: message_end 后正文被替换为歧义两块 → turn_end 拒配 --/0/1，reload 保持', async () => {
	const live = await createLive();
	try {
		const user = userMsg('ambiguity', 999);
		await live.driver.emit({ type: 'message_start', message: user });
		await live.driver.emit({ type: 'message_end', message: user });
		live.sm.appendMessage(user);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'a|t:b' },
		});
		live.clock.advance(400); // 1500
		// 本扩展观察到的最终消息（单块 "a|t:b"，usage 0 → 回退估算 2 tokens）。
		const seenView = msgWith([textPart('a|t:b')], 0);
		await live.driver.emit({ type: 'message_end', message: seenView });
		// 落盘前 prospective（一次去重展示）：2 tokens / 400ms = ~5 tok/s、已测 1/1。
		assert.equal(live.driver.lastStatus(), '当轮 ~5 | 会话 ~5 tok/s | 已测 1/1');
		// 其他扩展替换正文为两块后落盘（保留 provider/model/timestamp/stopReason）。
		const rewritten = { ...seenView, content: [textPart('a'), textPart('b')] };
		live.sm.appendMessage(rewritten);
		await live.driver.emit({ type: 'turn_end', message: rewritten });
		// 持久化后最终校准：歧义替换保守拒配 → 不保留旧编码会错误配对的 TPS/measured。
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(live.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
		// 真实文件 reload：孤立 marker 不配对，状态保持 --/0/1。
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('sm-ambiguity: 正常路径——同内容键序落盘 + 两轮 weighted + reload 保持', async () => {
	const live = await createLive();
	try {
		// 轮 1：工具参数 JSON（插入序 a,b）；落盘消息同内容不同键序 → 正常配对。
		const user1 = userMsg('q1', 999);
		await live.driver.emit({ type: 'message_start', message: user1 });
		await live.driver.emit({ type: 'message_end', message: user1 });
		live.sm.appendMessage(user1);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'toolcall_delta', delta: '{"a":1,"b":2}', contentIndex: 0 },
		});
		live.clock.advance(900); // 2000
		const final1 = assistantMsg({
			content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { b: 2, a: 1 } }],
			usageOutput: 60,
			stopReason: 'toolUse',
			timestamp: 2_100,
		});
		await live.driver.emit({ type: 'message_end', message: final1 });
		live.sm.appendMessage(final1);
		await live.driver.emit({ type: 'turn_end', message: final1 });
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		// 60 tokens / 900ms ≈ 66.7 tok/s（provider，无 ~）。
		assert.equal(live.driver.lastStatus(), '当轮 66.7 | 会话 66.7 tok/s | 已测 1/1');
		// marker 落盘形状：v2、match 恰五字段（无运行时 key 泄漏）。
		const branch = live.sm.getBranch();
		const markerEntryOnDisk = branch.find(
			(entry) => entry.type === 'custom' && entry.customType === 'pi-session-tps.measurement',
		);
		const data = markerEntryOnDisk?.data as { v: number; match: Record<string, unknown> };
		assert.equal(data.v, 2);
		assert.deepEqual(Object.keys(data.match).sort(), [
			'contentHash',
			'model',
			'provider',
			'stopReason',
			'timestamp',
		]);

		// 轮 2：正常文本响应，验证两轮 weighted 与 reload。
		live.clock.advance(100); // 2100
		const user2 = userMsg('q2', 2_199);
		await live.driver.emit({ type: 'message_start', message: user2 });
		await live.driver.emit({ type: 'message_end', message: user2 });
		live.sm.appendMessage(user2);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 2200
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400), contentIndex: 0 },
		});
		live.clock.advance(300); // 2500
		const final2 = assistantMsg({
			content: [textPart('x'.repeat(400))],
			usageOutput: 30,
			timestamp: 2_600,
		});
		await live.driver.emit({ type: 'message_end', message: final2 });
		live.sm.appendMessage(final2);
		await live.driver.emit({ type: 'turn_end', message: final2 });
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		// 会话加权：(60+30)/(900+300) = 75 tok/s；当轮 30/300 = 100。
		assert.equal(live.driver.lastStatus(), '当轮 100 | 会话 75 tok/s | 已测 2/2');

		// 真实文件 reload：键序不同的落盘消息与 marker 正常配对，两轮均恢复。
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 75 tok/s | 已测 2/2');
	} finally {
		removeTempDir(live.tempDir);
	}
});

test('sm-ambiguity: 旧 v1 marker 保守不配对（未测历史），真实文件 reload 保持', async () => {
	const live = await createLive();
	try {
		// 先完成一轮正常 v2 测量（marker + assistant 落盘）。
		const user = userMsg('v1', 999);
		await live.driver.emit({ type: 'message_start', message: user });
		await live.driver.emit({ type: 'message_end', message: user });
		live.sm.appendMessage(user);
		await live.driver.emit({ type: 'agent_start' });
		await live.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		live.clock.advance(100); // 1100
		await live.driver.emit({
			type: 'message_update',
			message: { role: 'assistant' },
			assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
		});
		live.clock.advance(400); // 1500
		const finalMessage = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 1_600 });
		await live.driver.emit({ type: 'message_end', message: finalMessage });
		live.sm.appendMessage(finalMessage);
		await live.driver.emit({ type: 'turn_end', message: finalMessage });
		await live.driver.emit({ type: 'agent_settled', aborted: false });
		// 追加一个 v1 时代形状的 marker 与同元数据 assistant（模拟升级前写入的旧会话段落）。
		const seen = assistantFingerprint(finalMessage as PiMessageLike);
		assert.ok(seen != null);
		live.sm.appendCustomEntry('pi-session-tps.measurement', {
			v: 1,
			roundId: 'r-old',
			segmentId: 's-old',
			generationMs: 2_000,
			estimatedTokens: 100,
			match: {
				provider: seen.provider,
				model: seen.model,
				timestamp: seen.timestamp,
				stopReason: seen.stopReason,
				contentHash: seen.contentHash,
			},
		});
		const oldAssistant = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 111, timestamp: 1_600 });
		live.sm.appendMessage(oldAssistant);
		// reload：v1 marker 拒配（保守未测）；两条真实 assistant 都进分母；v2 配对 1 条进分子。
		// v2 记录：100 tokens / 400ms = 250 tok/s；v1 后的 assistant 不贡献分子分母。
		const restored = await reloadDriver(live.sm.getSessionFile() as string, live.tempDir);
		assert.equal(restored.lastStatus(), '当轮 -- | 会话 250 tok/s | 已测 1/2');
	} finally {
		removeTempDir(live.tempDir);
	}
});

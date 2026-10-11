import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTpsKernel } from '../../src/core/index.ts';
import type { RestoredRecord } from '../../src/core/index.ts';

function record(overrides: Partial<RestoredRecord> = {}): RestoredRecord {
  return {
    segmentId: 's1',
    roundId: 'r1',
    tokens: 50,
    tokenSource: 'provider',
    generationMs: 5_000,
    outcome: 'completed',
    ...overrides,
  };
}

function seededRound(): SessionTpsKernel {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  return kernel;
}

// ---- discardSegment：无对应真实 assistant 的防御性关闭段 ----

test('contract: discard 已结算的防御关闭段——TPS 与 coverage 全部移除', () => {
  const kernel = seededRound();
  assert.equal(kernel.endSegment('s1', { outcome: 'aborted', atMs: 11_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1' }) != null);
  assert.equal(kernel.getRoundStats().tokens, 100); // 结算后仍在
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 1, total: 1 });

  assert.equal(kernel.discardSegment('s1'), true);
  let stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 0);
  assert.equal(stats.tokensPerSecond, null);
  assert.equal(stats.observedSegments, 1); // 仍被观测，但不贡献
  let session = kernel.getSessionStats();
  assert.equal(session.tokens, 0);
  assert.deepEqual(session.coverage, { measured: 0, total: 0 });

  // 幂等；不可再见、不可复活
  assert.equal(kernel.discardSegment('s1'), true);
  assert.equal(kernel.discardSegment('ghost'), false);
  assert.equal(kernel.getSegmentMeasurement('s1'), null);
  assert.equal(kernel.getSegmentMeasurement('s1', 'r1'), null);
  assert.equal(kernel.settleSegment({ segmentId: 's1', roundId: 'r1' }), null);
  assert.equal(kernel.onDelta('s1', { text: 'more' }, 12_000), false);
  assert.equal(kernel.onProviderUsage('s1', 10), false);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 12_000 }), false);
  assert.equal(kernel.startSegment('s1'), false); // 已丢弃 id 不可复用
  session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 0, total: 0 });
});

test('contract: discard 进行中/未结算段同样不贡献 provisional', () => {
  const kernel = seededRound();
  const before = kernel.getSessionStats({ nowMs: 3_000 });
  assert.equal(before.tokens, 100); // provisional 估算仍在
  assert.equal(kernel.discardSegment('s1', 'r1'), true);
  const after = kernel.getSessionStats({ nowMs: 3_000 });
  assert.equal(after.tokens, 0);
  assert.equal(after.tokensPerSecond, null);
  assert.deepEqual(after.coverage, { measured: 0, total: 0 });
  assert.equal(kernel.discardSegment('s1', 'wrong-round'), false); // roundId 校验不匹配
});

test('contract: restore 的记录段不可 discard（仅本实例 live 段）', () => {
  const kernel = new SessionTpsKernel();
  kernel.restore({ records: [record({ segmentId: 'm1' })], totalAssistantEntries: 1 });
  assert.equal(kernel.discardSegment('m1'), false); // 非 live 段不可丢弃
  assert.equal(kernel.getSessionStats().tokens, 50); // 不受影响
});

// ---- endSegmentUnmeasured：真实 message_end 但缺完整观测起点 ----

test('contract: 未观测到起点的真实 message_end 只进 coverage.total', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  // reload/晚加载后仅观察到局部 delta：内容可累计，但时钟起点缺失（atMs 非法不启表）
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, Number.NaN), true);
  assert.equal(kernel.endSegmentUnmeasured('s1', 'completed'), true);
  assert.equal(kernel.endSegmentUnmeasured('s1', 'completed'), false); // 幂等，重复结束不制造响应
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 9_000 }), false);

  let session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 0, total: 1 }); // 未测响应
  assert.equal(session.tokens, 0);
  assert.equal(session.tokensPerSecond, null);
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.equal(measurement?.unmeasured, true);
  assert.equal(measurement?.firstDeltaAtMs, null);
  assert.equal(measurement?.generationMs, null);
  assert.equal(measurement?.contentEstimateTokens, 100); // 内容仍在，仅口径拒算

  // 即便之后拿到完整 provider usage，也不得把局部窗口变成合法口径
  const settled = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 50 });
  assert.equal(settled?.tokens, 50);
  session = kernel.getSessionStats();
  assert.equal(session.tokens, 0);
  assert.equal(session.tokensPerSecond, null);
  assert.deepEqual(session.coverage, { measured: 0, total: 1 });
});

test('contract: 有观测起点的段被显式标记 unmeasured 时清除时钟并拒算', () => {
  const kernel = seededRound(); // firstDelta=1000 已观测
  assert.equal(kernel.getSessionStats({ nowMs: 2_000 }).tokens, 100);
  assert.equal(kernel.endSegmentUnmeasured('s1', 'error'), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.firstDeltaAtMs, null);
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 0);
  assert.deepEqual(session.coverage, { measured: 0, total: 1 });
});

test('contract: 仅收到 message_end（无任何 delta）也登记为未测条目', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.endSegmentUnmeasured('s1', 'completed'), true);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 0, total: 1 });
});

// ---- coverage 口径：ended 流不发明 paired 实测 ----

test('contract: ended 但未结算只有 prospective total，无 measured', () => {
  const kernel = seededRound();
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  let session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 0, total: 1 }); // 不凭 ended 发明 measured
  assert.equal(session.tokens, 100); // provisional 估算仍可展示（~）
  assert.equal(session.estimated, true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 1, total: 1 });
});

test('contract: 防御关闭后 discard 撤回 prospective total', () => {
  const kernel = seededRound();
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 0, total: 1 });
  assert.equal(kernel.discardSegment('s1'), true);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 0, total: 0 });
});

// ---- calibrateCoverage：持久化边界校准 ----

test('contract: calibrate 同步 final 到已结束未结算的 live 段，不双算', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 4_000 }), true); // 未结算：provisional 估算 100
  // 另一条进行中的多响应流不被破坏
  assert.equal(kernel.startSegment('s2'), true);
  assert.equal(kernel.onDelta('s2', { text: 'x'.repeat(400) }, 1_000), true);

  const summary = kernel.calibrateCoverage({
    records: [
      record({ segmentId: 's1', roundId: 'r1', tokens: 120, generationMs: 4_000 }),
      record({ segmentId: 'm2', roundId: 'r0', tokens: 30, generationMs: 3_000 }),
    ],
    totalAssistantEntries: 2,
  });
  assert.deepEqual(summary, {
    accepted: 1,
    syncedToLive: 1,
    duplicateRecords: 0,
    invalidRecords: 0,
    measured: 2,
    totalAssistantEntries: 2,
  });
  // 会话：s1 final 120 + m2 30（s2 进行中，未传 nowMs 不计入）
  let session = kernel.getSessionStats();
  assert.equal(session.tokens, 150);
  assert.equal(session.generationMs, 7_000);
  assert.deepEqual(session.coverage, { measured: 2, total: 2 });
  // 传 nowMs 后 s2 的 provisional 仍可用（校准不清除活动状态）
  session = kernel.getSessionStats({ nowMs: 2_000 });
  assert.equal(session.tokens, 250);
  assert.equal(session.generationMs, 8_000);
  assert.equal(session.estimated, true);
  // 当轮：s1 用同步后的 provider final，不再是估算
  const round = kernel.getRoundStats();
  assert.equal(round.observedSegments, 2);
  assert.equal(round.contributingSegments, 1);
  assert.equal(round.tokens, 120);
  assert.ok(Math.abs((round.tokensPerSecond as number) - 30) < 1e-9);
  assert.equal(round.settled, false); // 活动轮保留
  assert.equal(kernel.startRound('r1'), true); // 幂等仍成立
  assert.equal(kernel.settleRound(), true);
});

test('contract: calibrate 用配对最终 usage 替换已有 final 的 tokens/tokenSource（不追加、不留过时值）', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  const summary = kernel.calibrateCoverage({
    records: [record({ segmentId: 's1', roundId: 'r1', tokens: 999 })],
    totalAssistantEntries: 1,
  });
  assert.equal(summary.syncedToLive, 1);
  assert.equal(summary.accepted, 0);
  assert.equal(summary.measured, 1);
  assert.equal(summary.totalAssistantEntries, 1);
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 999); // 替换：非 100、非 199、非 100+999
  assert.equal(session.estimated, false);
  assert.deepEqual(session.coverage, { measured: 1, total: 1 }); // ended live 已在 base 内，不加两次
  // 保留合法自测窗口、结局与活动 round
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.equal(measurement?.finalRecord?.tokens, 999);
  assert.equal(measurement?.finalRecord?.tokenSource, 'provider');
  assert.equal(measurement?.finalRecord?.generationMs, 5_000); // live 自测窗口优先
  assert.equal(measurement?.finalRecord?.outcome, 'completed');
  const round = kernel.getRoundStats();
  assert.equal(round.tokens, 999);
  assert.ok(Math.abs((round.tokensPerSecond as number) - 199.8) < 1e-9);
  assert.equal(round.settled, false); // 活动轮保持
  assert.equal(kernel.startRound('r1'), true); // 幂等仍成立
});

test('contract: provider→更小 provider usage（100→40）替换并与 reload 口径一致', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 1_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  // message_end 暂显 100 tok/s；落盘 usage 被后续合法 handler 替换为 40
  let round = kernel.getRoundStats();
  assert.ok(Math.abs((round.tokensPerSecond as number) - 100) < 1e-9);
  const paired = record({ segmentId: 's1', roundId: 'r1', tokens: 40, generationMs: 1_000 });
  kernel.calibrateCoverage({ records: [paired], totalAssistantEntries: 1 });
  round = kernel.getRoundStats();
  assert.equal(round.tokens, 40);
  assert.ok(Math.abs((round.tokensPerSecond as number) - 40) < 1e-9);
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 40);
  assert.equal(session.generationMs, 1_000);
  assert.equal(session.estimated, false);
  // 同一会话 settled 与 reload（restore 同记录）结果一致
  const reloaded = new SessionTpsKernel();
  reloaded.restore({ records: [paired], totalAssistantEntries: 1 });
  const reloadedSession = reloaded.getSessionStats();
  assert.equal(reloadedSession.tokens, session.tokens);
  assert.equal(reloadedSession.generationMs, session.generationMs);
  assert.equal(reloadedSession.tokensPerSecond, session.tokensPerSecond);
  assert.equal(reloadedSession.estimated, session.estimated);
  assert.deepEqual(reloadedSession.coverage, session.coverage);
});

test('contract: provider→零/缺失 usage 回退 marker estimate 且带 ~', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  assert.equal(kernel.getSessionStats().estimated, false);
  // 落盘 usage 为零/缺失/非法：scanner 用 marker 回退估算（如 2 tokens）
  kernel.calibrateCoverage({
    records: [record({ segmentId: 's1', roundId: 'r1', tokens: 2, tokenSource: 'estimate', generationMs: 5_000 })],
    totalAssistantEntries: 1,
  });
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 2);
  assert.equal(session.estimated, true);
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.equal(measurement?.finalRecord?.tokenSource, 'estimate');
  assert.equal(measurement?.finalRecord?.tokens, 2);
  assert.equal(measurement?.finalRecord?.generationMs, 5_000); // 自测窗口保持
});

test('contract: estimate→provider 由配对记录升级并去除 ~', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1' }) != null); // 无 usage：估算 100
  assert.equal(kernel.getSessionStats().estimated, true);
  kernel.calibrateCoverage({
    records: [record({ segmentId: 's1', roundId: 'r1', tokens: 80, generationMs: 5_000 })],
    totalAssistantEntries: 1,
  });
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 80);
  assert.equal(session.estimated, false);
  assert.ok(Math.abs((kernel.getRoundStats().tokensPerSecond as number) - 16) < 1e-9);
});

test('contract: 多次最终 usage 切换每次整体替换、始终只计一次', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  const input = (tokens: number, tokenSource: 'provider' | 'estimate') => ({
    records: [record({ segmentId: 's1', roundId: 'r1', tokens, tokenSource, generationMs: 5_000 })],
    totalAssistantEntries: 1,
  });
  kernel.calibrateCoverage(input(40, 'provider'));
  let session = kernel.getSessionStats();
  assert.equal(session.tokens, 40);
  assert.equal(session.generationMs, 5_000);
  assert.equal(session.estimated, false);
  kernel.calibrateCoverage(input(2, 'estimate'));
  session = kernel.getSessionStats();
  assert.equal(session.tokens, 2);
  assert.equal(session.generationMs, 5_000);
  assert.equal(session.estimated, true);
  kernel.calibrateCoverage(input(120, 'provider'));
  session = kernel.getSessionStats();
  assert.equal(session.tokens, 120);
  assert.equal(session.generationMs, 5_000);
  assert.equal(session.estimated, false);
  assert.deepEqual(session.coverage, { measured: 1, total: 1 }); // 始终单段单计
});

test('contract: 重复校准幂等（同输入两次结果完全一致）', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  const input = {
    records: [record({ segmentId: 's1', roundId: 'r1', tokens: 40, generationMs: 5_000 })],
    totalAssistantEntries: 1,
  };
  const first = kernel.calibrateCoverage(input);
  const mid = kernel.getSessionStats();
  const midRound = kernel.getRoundStats();
  assert.equal(mid.tokens, 40);
  const second = kernel.calibrateCoverage(input);
  assert.deepEqual(second, first);
  assert.deepEqual(kernel.getSessionStats(), mid);
  assert.deepEqual(kernel.getRoundStats(), midRound);
});

test('contract: 无配对记录不擅自伪造 tokens', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 4_000 }), true);
  // 未结算（无最终 usage）；分支扫描只配对到别的响应
  const summary = kernel.calibrateCoverage({
    records: [record({ segmentId: 'other', roundId: 'r9' })],
    totalAssistantEntries: 1,
  });
  assert.equal(summary.syncedToLive, 0);
  assert.equal(summary.accepted, 1);
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.equal(measurement?.finalRecord, null); // 不伪造 final
  assert.equal(measurement?.provisionalTokens, 100); // provisional 估算保持
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 150); // other 记录 50 + s1 provisional 100，不双算
  assert.equal(session.estimated, true);
  assert.deepEqual(session.coverage, { measured: 1, total: 1 });
  kernel.calibrateCoverage({ records: [], totalAssistantEntries: 1 });
  assert.equal(kernel.getSegmentMeasurement('s1')?.finalRecord, null); // 空扫描同样不伪造
});

test('contract: calibrate 的 total 权威 base 之后新结束的段才累加', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 4_000 }), true);
  kernel.calibrateCoverage({ records: [record({ segmentId: 's1', roundId: 'r1', tokens: 80 })], totalAssistantEntries: 1 });
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 1, total: 1 });
  // 校准后新的真实响应结束：total 递增
  assert.equal(kernel.startSegment('s2'), true);
  assert.equal(kernel.onDelta('s2', { text: 'x'.repeat(400) }, 10_000), true);
  assert.equal(kernel.endSegment('s2', { outcome: 'completed', atMs: 14_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's2', roundId: 'r1' }) != null);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 2, total: 2 });
  assert.equal(kernel.getSessionStats().tokens, 180);
});

test('contract: calibrate 不清除既有轮与多段累计；空记录仅校准 total', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  for (const [id, offset] of [['s1', 0], ['s2', 10_000]] as const) {
    assert.equal(kernel.startSegment(id), true);
    assert.equal(kernel.onDelta(id, { text: 'x'.repeat(400) }, offset), true);
    assert.equal(kernel.endSegment(id, { outcome: 'completed', atMs: offset + 5_000 }), true);
    assert.ok(kernel.settleSegment({ segmentId: id, roundId: 'r1', providerOutputTokens: 100 }) != null);
  }
  const summary = kernel.calibrateCoverage({ records: [], totalAssistantEntries: 2 });
  assert.deepEqual(summary, {
    accepted: 0,
    syncedToLive: 0,
    duplicateRecords: 0,
    invalidRecords: 0,
    measured: 2,
    totalAssistantEntries: 2,
  });
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 200); // 两段均保留
  assert.equal(session.rounds, 1);
  assert.deepEqual(session.coverage, { measured: 2, total: 2 }); // 不重复加 base
  assert.equal(kernel.startSegment('s3'), true); // 活动轮仍可继续挂段
});

test('contract: calibrate 输入内去重与非法记录处理；非法 total 归零', () => {
  const kernel = seededRound();
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  const summary = kernel.calibrateCoverage({
    records: [
      record({ segmentId: 'm1', roundId: 'r0' }),
      record({ segmentId: 'm1', roundId: 'r0', tokens: 999 }), // 同 key 重复
      record({ segmentId: 'bad', tokens: 0 }), // 非法
    ],
    totalAssistantEntries: Number.NaN,
  });
  assert.equal(summary.accepted, 1);
  assert.equal(summary.duplicateRecords, 1);
  assert.equal(summary.invalidRecords, 1);
  assert.equal(summary.totalAssistantEntries, 0);
  // total = base 0 + 校准基线后无新增 ended → 0；但 s1 已 ended（基线内）不重复计
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 1, total: 0 });
});

test('contract: calibrate 以完整扫描替换旧 restored 集合', () => {
  const kernel = new SessionTpsKernel();
  kernel.restore({ records: [record({ segmentId: 'm1' })], totalAssistantEntries: 1 });
  kernel.calibrateCoverage({
    records: [record({ segmentId: 'm2', roundId: 'r0' })],
    totalAssistantEntries: 1,
  });
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 50); // m1 被替换，仅剩 m2
  assert.equal(kernel.getSegmentMeasurement('m1', 'r1'), null);
  assert.deepEqual(session.coverage, { measured: 1, total: 1 });
});

test('contract: calibrate 匹配已丢弃段时记录落入 restored（确定性）', () => {
  const kernel = seededRound();
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  assert.equal(kernel.discardSegment('s1'), true);
  const summary = kernel.calibrateCoverage({
    records: [record({ segmentId: 's1', roundId: 'r1' })],
    totalAssistantEntries: 1,
  });
  assert.equal(summary.syncedToLive, 0);
  assert.equal(summary.accepted, 1);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 1, total: 1 });
  assert.equal(kernel.getSessionStats().tokens, 50);
});

test('contract: calibrate 对 unmeasured 段保持保守拒算', () => {
  const kernel = seededRound();
  assert.equal(kernel.endSegmentUnmeasured('s1', 'completed'), true);
  const summary = kernel.calibrateCoverage({
    records: [record({ segmentId: 's1', roundId: 'r1', tokens: 120, generationMs: 4_000 })],
    totalAssistantEntries: 1,
  });
  assert.equal(summary.syncedToLive, 1);
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 0); // unmeasured 不因同步而复活
  assert.deepEqual(session.coverage, { measured: 0, total: 1 });
});

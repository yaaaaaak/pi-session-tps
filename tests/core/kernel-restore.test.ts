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

test('restore: 合法记录计入会话分子/分母并给出 coverage', () => {
  const kernel = new SessionTpsKernel();
  const summary = kernel.restore({
    records: [
      record({ segmentId: 's1', tokens: 50, generationMs: 5_000 }),
      record({ segmentId: 's2', roundId: 'r2', tokens: 30, tokenSource: 'estimate', generationMs: 3_000, outcome: 'aborted' }),
    ],
    totalAssistantEntries: 5,
  });
  assert.deepEqual(summary, {
    accepted: 2,
    duplicateRecords: 0,
    invalidRecords: 0,
    measured: 2,
    totalAssistantEntries: 5,
  });
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 80);
  assert.equal(session.generationMs, 8_000);
  assert.ok(Math.abs((session.tokensPerSecond as number) - 10) < 1e-9);
  assert.equal(session.estimated, true); // 含 estimate 来源记录
  assert.deepEqual(session.coverage, { measured: 2, total: 5 });
  assert.equal(session.rounds, 0); // 恢复不产生活动轮
  assert.equal(kernel.getRoundStats().roundId, null);
});

test('restore: 全部 provider 来源时不带估算标记', () => {
  const kernel = new SessionTpsKernel();
  kernel.restore({
    records: [record({ segmentId: 's1' }), record({ segmentId: 's2' })],
    totalAssistantEntries: 2,
  });
  const session = kernel.getSessionStats();
  assert.equal(session.estimated, false);
  assert.deepEqual(session.coverage, { measured: 2, total: 2 });
});

test('restore: 按 (roundId, segmentId) 去重，重复记录不重复累计', () => {
  const kernel = new SessionTpsKernel();
  const summary = kernel.restore({
    records: [
      record({ segmentId: 's1' }),
      record({ segmentId: 's1', tokens: 999 }), // 完全同 key 的重复 marker
      record({ segmentId: 's1', roundId: 'r2' }), // 不同轮，合法
    ],
    totalAssistantEntries: 3,
  });
  assert.equal(summary.accepted, 2);
  assert.equal(summary.duplicateRecords, 1);
  assert.equal(summary.measured, 2);
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 100); // 50 + 50，重复的 999 不计入
  assert.deepEqual(session.coverage, { measured: 2, total: 3 });
});

test('restore: 非法记录不贡献（孤立/非法 marker 语义）', () => {
  const kernel = new SessionTpsKernel();
  const summary = kernel.restore({
    records: [
      record({ tokens: 0 }),
      record({ tokens: -5 }),
      record({ tokens: 2.5 }),
      record({ tokens: Number.NaN }),
      record({ generationMs: 0 }),
      record({ generationMs: -1 }),
      record({ generationMs: Number.POSITIVE_INFINITY }),
      record({ outcome: 'cancelled' as unknown as RestoredRecord['outcome'] }),
      record({ tokenSource: 'guess' as unknown as RestoredRecord['tokenSource'] }),
      record({ segmentId: '' }),
      record({ roundId: '' }),
      null as unknown as RestoredRecord,
      record({ segmentId: 'ok' }),
    ],
    totalAssistantEntries: 12,
  });
  assert.equal(summary.accepted, 1);
  assert.equal(summary.invalidRecords, 12);
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 50);
  assert.deepEqual(session.coverage, { measured: 1, total: 12 });
});

test('restore: 未测历史只进 total，不进任何 TPS 分子/分母', () => {
  const kernel = new SessionTpsKernel();
  kernel.restore({
    records: [record({ segmentId: 's1' }), record({ segmentId: 's2' })],
    totalAssistantEntries: 10,
  });
  const session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 2, total: 10 });
  assert.equal(session.contributingSegments, 2); // 只有 2 条被测
  assert.equal(session.tokens, 100);
  assert.equal(session.generationMs, 10_000);
});

test('restore: 重建清除既有实时状态与活动时钟起点', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  assert.equal(kernel.settleRound(), true);

  kernel.restore({ records: [record({ segmentId: 'm1' })], totalAssistantEntries: 1 });
  // 旧实时段不得泄漏到新分支统计
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 50);
  assert.equal(session.rounds, 0);
  assert.deepEqual(session.coverage, { measured: 1, total: 1 });
  // 恢复后没有活动轮；旧 segmentId 不再可见
  assert.equal(kernel.getRoundStats().roundId, null);
  assert.equal(kernel.getSegmentMeasurement('s1'), null);
});

test('restore: 恢复后继续 live，coverage 与聚合正确衔接', () => {
  const kernel = new SessionTpsKernel();
  kernel.restore({ records: [record({ segmentId: 'm1' })], totalAssistantEntries: 1 });
  assert.equal(kernel.startRound('r9'), true);
  assert.equal(kernel.startSegment('s9'), true);
  assert.equal(kernel.onDelta('s9', { text: 'x'.repeat(400) }, 0), true);
  let session = kernel.getSessionStats({ nowMs: 2_000 });
  assert.equal(session.tokens, 150); // 50 恢复 + 100 live 估算
  assert.equal(session.generationMs, 7_000);
  assert.deepEqual(session.coverage, { measured: 1, total: 1 }); // live 未结束
  assert.equal(kernel.endSegment('s9', { outcome: 'completed', atMs: 2_000 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's9', roundId: 'r9', providerOutputTokens: 100 }) != null);
  session = kernel.getSessionStats();
  assert.equal(session.tokens, 150);
  assert.equal(session.generationMs, 7_000);
  assert.deepEqual(session.coverage, { measured: 2, total: 2 });
  assert.equal(session.rounds, 1);
});

test('restore: 非法 totalAssistantEntries 归零而不抛错', () => {
  const kernel = new SessionTpsKernel();
  const summary = kernel.restore({ records: [record()], totalAssistantEntries: Number.NaN });
  assert.equal(summary.totalAssistantEntries, 0);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 1, total: 0 });
  const fractional = kernel.restore({ records: [], totalAssistantEntries: 2.5 });
  assert.equal(fractional.totalAssistantEntries, 0);
  assert.deepEqual(fractional, {
    accepted: 0,
    duplicateRecords: 0,
    invalidRecords: 0,
    measured: 0,
    totalAssistantEntries: 0,
  });
});

test('restore: 已恢复段可按 (roundId, segmentId) 读取测量快照且不可重结算', () => {
  const kernel = new SessionTpsKernel();
  kernel.restore({ records: [record()], totalAssistantEntries: 1 });
  const measurement = kernel.getSegmentMeasurement('s1', 'r1');
  assert.ok(measurement != null);
  assert.equal(measurement.generationMs, 5_000);
  assert.equal(measurement.finalRecord?.tokens, 50);
  assert.equal(kernel.getSegmentMeasurement('s1'), null); // 不带 roundId 找不到恢复段
  const again = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 999 });
  assert.equal(again?.tokens, 50); // 幂等，不覆盖
  assert.equal(kernel.getSessionStats().tokens, 50);
});

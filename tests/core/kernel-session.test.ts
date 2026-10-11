import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTpsKernel } from '../../src/core/index.ts';

/** 在指定轮内流过一个最终结算段。 */
function finalSegment(
  kernel: SessionTpsKernel,
  roundId: string,
  segmentId: string,
  tokens: number,
  generationMs: number,
  provider = true,
): void {
  assert.equal(kernel.startRound(roundId), true);
  assert.equal(kernel.startSegment(segmentId), true);
  assert.equal(kernel.onDelta(segmentId, { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment(segmentId, { outcome: 'completed', atMs: generationMs }), true);
  const record = kernel.settleSegment({
    segmentId,
    roundId,
    providerOutputTokens: provider ? tokens : undefined,
  });
  assert.ok(record != null);
  assert.equal(kernel.settleRound(), true);
}

test('session: 不同轮不同速率按总 tokens / 总时长加权，不平均各轮 TPS', () => {
  const kernel = new SessionTpsKernel();
  finalSegment(kernel, 'r1', 's1', 100, 10_000); // 10 tok/s
  finalSegment(kernel, 'r2', 's2', 100, 1_000); // 100 tok/s
  const session = kernel.getSessionStats();
  assert.equal(session.rounds, 2);
  assert.equal(session.tokens, 200);
  assert.equal(session.generationMs, 11_000);
  const expected = (200 * 1000) / 11_000; // ≈ 18.18，而非 (10+100)/2 = 55
  assert.ok(Math.abs((session.tokensPerSecond as number) - expected) < 1e-9);
  assert.ok(Math.abs((session.tokensPerSecond as number) - 55) > 1);
});

test('session: 包含当前轮实时贡献；结束后 final 替换 live，不重复添加', () => {
  const kernel = new SessionTpsKernel();
  finalSegment(kernel, 'r1', 's1', 100, 10_000);
  // r2 进行中：估算 100 tokens / 已生成 1000ms
  assert.equal(kernel.startRound('r2'), true);
  assert.equal(kernel.startSegment('s2'), true);
  assert.equal(kernel.onDelta('s2', { text: 'x'.repeat(400) }, 0), true);
  const withLive = kernel.getSessionStats({ nowMs: 1_000 });
  assert.equal(withLive.tokens, 200);
  assert.equal(withLive.generationMs, 11_000);
  assert.equal(withLive.estimated, true); // live 贡献使聚合带 ~
  assert.ok(Math.abs((withLive.tokensPerSecond as number) - (200 * 1000) / 11_000) < 1e-9);
  // r2 结束并结算为 provider 100 / 1000ms：替换而非叠加
  assert.equal(kernel.endSegment('s2', { outcome: 'completed', atMs: 1_000 }), true);
  const record = kernel.settleSegment({ segmentId: 's2', roundId: 'r2', providerOutputTokens: 100 });
  assert.ok(record != null);
  const settled = kernel.getSessionStats();
  assert.equal(settled.tokens, 200); // 仍是 200，不是 300
  assert.equal(settled.generationMs, 11_000);
  assert.equal(settled.estimated, false);
  assert.equal(settled.contributingSegments, 2);
});

test('session: 部分使用估算的聚合也标记 ~（estimate 传染）', () => {
  const kernel = new SessionTpsKernel();
  finalSegment(kernel, 'r1', 's1', 100, 10_000); // provider
  // r2 结算走内容估算
  assert.equal(kernel.startRound('r2'), true);
  assert.equal(kernel.startSegment('s2'), true);
  assert.equal(kernel.onDelta('s2', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.endSegment('s2', { outcome: 'completed', atMs: 1_000 }), true);
  const record = kernel.settleSegment({ segmentId: 's2', roundId: 'r2' });
  assert.equal(record?.tokenSource, 'estimate');
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 200);
  assert.equal(session.estimated, true);
});

test('session: 覆盖率随已结束/已结算段增长', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  let session = kernel.getSessionStats({ nowMs: 1_000 });
  assert.deepEqual(session.coverage, { measured: 0, total: 0 }); // 未结束还不是条目
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 1_000 }), true);
  session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 0, total: 1 }); // 已结束未结算
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1' }) != null);
  session = kernel.getSessionStats();
  assert.deepEqual(session.coverage, { measured: 1, total: 1 });
});

test('session: 空会话统计健全（无 NaN/Infinity）', () => {
  const kernel = new SessionTpsKernel();
  const session = kernel.getSessionStats();
  assert.equal(session.tokensPerSecond, null);
  assert.ok(Number.isFinite(session.tokens));
  assert.ok(Number.isFinite(session.generationMs));
  assert.deepEqual(session.coverage, { measured: 0, total: 0 });
  assert.equal(session.rounds, 0);
});

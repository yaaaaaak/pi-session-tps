import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTpsKernel, computeTokensPerSecond } from '../../src/core/index.ts';

test('edge: 零时长不贡献分子也不贡献分母（不得夹成 1ms）', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 1_000 }), true); // 0ms
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 });
  assert.equal(record?.generationMs, 0);
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 0);
  assert.equal(stats.generationMs, 0);
  assert.equal(stats.tokensPerSecond, null);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 0, total: 1 });
});

test('edge: 结束时刻早于首 delta（负时长）不贡献', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 500 }), true);
  assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 }) != null);
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 0);
  assert.equal(stats.generationMs, 0);
  assert.equal(stats.tokensPerSecond, null);
});

test('edge: 非法 atMs 不启动时钟，段最终不贡献；后续合法时刻可补启时钟', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'aaa' }, Number.NaN), true); // 内容仍累计
  assert.equal(kernel.onDelta('s1', { text: 'bbb' }, Number.POSITIVE_INFINITY), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.firstDeltaAtMs, null);
  assert.equal(kernel.endSegment('s1', { outcome: 'error', atMs: 5_000 }), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.equal(record?.generationMs, 0); // 无时钟起点 → 无自测时长
  assert.equal(record?.tokens, 2); // 内容估算仍在（6 chars → ceil(6/4)），但无时长故不贡献
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 0);
  assert.equal(stats.tokensPerSecond, null);
  // 确定性补启规则：首个带合法时刻的非空 delta 启动时钟
  assert.equal(kernel.startSegment('s2'), true);
  assert.equal(kernel.onDelta('s2', { text: 'x' }, Number.NaN), true);
  assert.equal(kernel.onDelta('s2', { text: 'y'.repeat(399) }, 2_000), true);
  assert.equal(kernel.getSegmentMeasurement('s2')?.firstDeltaAtMs, 2_000);
});

test('edge: endSegment 的 atMs 非法时内容保留但时长无效', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'aborted', atMs: Number.NaN }), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.equal(record?.tokens, 100);
  assert.equal(record?.generationMs, 0);
  assert.equal(kernel.getRoundStats().tokensPerSecond, null);
});

test('edge: 无内容失败不贡献 tokens/时间，但仍是一个 assistant 条目', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'error', atMs: 9_000 }), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 0 });
  assert.equal(record?.tokens, 0);
  assert.equal(record?.tokenSource, 'estimate');
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 0);
  assert.equal(stats.contributingSegments, 0);
  assert.deepEqual(kernel.getSessionStats().coverage, { measured: 0, total: 1 });
});

test('edge: 空 delta 不启动时钟也不计内容；空白字符算非空内容', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', {}, 1_000), false);
  assert.equal(kernel.onDelta('s1', { text: '' }, 1_000), false);
  assert.equal(kernel.getSegmentMeasurement('s1')?.firstDeltaAtMs, null);
  assert.equal(kernel.onDelta('s1', { text: ' ' }, 2_000), true); // 非空即内容
  assert.equal(kernel.getSegmentMeasurement('s1')?.firstDeltaAtMs, 2_000);
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 1);
});

test('edge: 相同累计内容不同 chunk 分割得到相同统计（不能 chunk=token）', () => {
  const run = (chunks: string[]): { tokens: number; generationMs: number; estimated: boolean; tps: number } => {
    const kernel = new SessionTpsKernel();
    assert.equal(kernel.startRound('r1'), true);
    assert.equal(kernel.startSegment('s1'), true);
    let at = 1_000;
    for (const chunk of chunks) {
      assert.equal(kernel.onDelta('s1', { text: chunk }, at), true);
      at += 10;
    }
    assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 9_000 }), true);
    assert.ok(kernel.settleSegment({ segmentId: 's1', roundId: 'r1' }) != null);
    const stats = kernel.getRoundStats();
    return {
      tokens: stats.tokens,
      generationMs: stats.generationMs,
      estimated: stats.estimated,
      tps: stats.tokensPerSecond as number,
    };
  };
  const content = 'x'.repeat(800);
  const two = run([content.slice(0, 500), content.slice(500)]);
  const many = run(content.match(/.{1,7}/g) as string[]);
  const single = run([content]);
  assert.equal(two.tokens, 200); // 800 chars / 4，与 2 个 chunk 无关
  assert.deepEqual(two, many);
  assert.deepEqual(two, single);
});

test('edge: computeTokensPerSecond 输入校验与溢出防护', () => {
  assert.equal(computeTokensPerSecond(100, 10_000), 10);
  assert.equal(computeTokensPerSecond(0, 10_000), null);
  assert.equal(computeTokensPerSecond(-1, 10_000), null);
  assert.equal(computeTokensPerSecond(2.5, 10_000), null);
  assert.equal(computeTokensPerSecond(Number.NaN, 10_000), null);
  assert.equal(computeTokensPerSecond(100, 0), null);
  assert.equal(computeTokensPerSecond(100, -5), null);
  assert.equal(computeTokensPerSecond(100, Number.NaN), null);
  assert.equal(computeTokensPerSecond(100, Number.POSITIVE_INFINITY), null);
  assert.equal(computeTokensPerSecond(1e15, Number.MIN_VALUE), null); // 溢出为 Infinity
  assert.ok(Number.isFinite(computeTokensPerSecond(1e6, 1) as number));
});

test('edge: 大量段聚合保持有限数值（无 NaN/Infinity）', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  for (let i = 0; i < 500; i += 1) {
    const segmentId = `s${i}`;
    assert.equal(kernel.startSegment(segmentId), true);
    assert.equal(kernel.onDelta(segmentId, { text: 'x'.repeat(400) }, 0), true);
    assert.equal(kernel.endSegment(segmentId, { outcome: 'completed', atMs: 4_000 }), true);
    assert.ok(kernel.settleSegment({ segmentId, roundId: 'r1' }) != null);
  }
  const stats = kernel.getSessionStats();
  assert.equal(stats.tokens, 50_000);
  assert.equal(stats.generationMs, 2_000_000);
  assert.ok(Number.isFinite(stats.tokensPerSecond as number));
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 25) < 1e-9);
  assert.deepEqual(stats.coverage, { measured: 500, total: 500 });
});

test('edge: 结束但未结算段的 provider 累计值可作为 provisional 使用', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  assert.equal(kernel.onProviderUsage('s1', 80), true); // message_end 后、结算前的累计值
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 80);
  assert.equal(stats.estimated, true); // provisional 一律 ~
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 8) < 1e-9);
});

test('edge: 非法轮 id 与非法结算输入被拒绝', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound(''), false);
  assert.equal(kernel.settleRound(), false); // 无活动轮
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.settleSegment(null as never), null);
  const record = kernel.settleSegment({ segmentId: '', roundId: 'r1' });
  assert.equal(record, null);
});

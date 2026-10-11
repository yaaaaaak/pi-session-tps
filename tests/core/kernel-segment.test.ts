import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTpsKernel } from '../../src/core/index.ts';

function prepare(): { kernel: SessionTpsKernel } {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  return { kernel };
}

test('segment: provisional→final 替换，final usage 覆盖估算且不双算', () => {
  const { kernel } = prepare();
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  // provisional：估算 100 tokens / 1000ms
  const live = kernel.getRoundStats({ nowMs: 2_000 });
  assert.equal(live.tokens, 100);
  assert.ok(Math.abs((live.tokensPerSecond as number) - 100) < 1e-9);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 40 });
  assert.ok(record != null);
  assert.equal(record.tokens, 40);
  assert.equal(record.tokenSource, 'provider');
  assert.equal(record.generationMs, 10_000);
  assert.equal(record.outcome, 'completed');
  // final 后：40 tokens / 10000ms = 4 tok/s；不是 100+40 双算
  const after = kernel.getRoundStats({ nowMs: 12_000 });
  assert.equal(after.tokens, 40);
  assert.equal(after.estimated, false);
  assert.ok(Math.abs((after.tokensPerSecond as number) - 4) < 1e-9);
  // 会话口径同样只计一次
  assert.equal(kernel.getSessionStats({ nowMs: 12_000 }).tokens, 40);
});

test('segment: 重复结算幂等，返回首次记录，不重复累计', () => {
  const { kernel } = prepare();
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  const first = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 100 });
  const second = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 999 });
  assert.deepEqual(second, first);
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 100);
  assert.equal(stats.contributingSegments, 1);
});

test('segment: provider 零值/缺失/非法回退内容估算并标记 estimate', () => {
  for (const bad of [0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const kernel = new SessionTpsKernel();
    assert.equal(kernel.startRound('r1'), true);
    assert.equal(kernel.startSegment('s1'), true);
    assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
    assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
    const record = kernel.settleSegment({
      segmentId: 's1',
      roundId: 'r1',
      providerOutputTokens: bad,
    });
    assert.ok(record != null);
    assert.equal(record.tokens, 100, `provider=${String(bad)} 应回退估算`);
    assert.equal(record.tokenSource, 'estimate');
    const stats = kernel.getRoundStats();
    assert.equal(stats.tokens, 100);
    assert.equal(stats.estimated, true);
    assert.ok(Math.abs((stats.tokensPerSecond as number) - 25) < 1e-9);
  }
});

test('segment: 三类内容（text/thinking/toolArguments）都计入估算', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(120) }, 1_000), true);
  assert.equal(kernel.onDelta('s1', { thinking: 'y'.repeat(120) }, 1_100), true);
  assert.equal(kernel.onDelta('s1', { toolArguments: 'z'.repeat(160) }, 1_200), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.ok(record != null);
  assert.equal(record.tokens, 100); // 400 chars / 4
  assert.equal(record.tokenSource, 'estimate');
});

test('segment: endSegment 幂等（首次生效），结束后 delta 被忽略、final 由 settle 决定', () => {
  const { kernel } = prepare();
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 11_000 }), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'aborted', atMs: 50_000 }), false);
  assert.equal(kernel.onDelta('s1', { text: 'more' }, 12_000), false);
  // message_end 后、结算前仍接受 provider 累计值（provisional 窗口），final 由 settle 决定
  assert.equal(kernel.onProviderUsage('s1', 500), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.ok(record != null);
  assert.equal(record.generationMs, 10_000); // 用首次结束时刻
  assert.equal(record.outcome, 'completed');
  assert.equal(record.tokens, 100); // 后续内容未累计
});

test('segment: outcome 语义——aborted/error 有内容且正时长仍贡献', () => {
  for (const outcome of ['aborted', 'error'] as const) {
    const kernel = new SessionTpsKernel();
    assert.equal(kernel.startRound('r1'), true);
    assert.equal(kernel.startSegment('s1'), true);
    assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
    assert.equal(kernel.endSegment('s1', { outcome, atMs: 5_000 }), true);
    const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
    assert.ok(record != null);
    assert.equal(record.outcome, outcome);
    assert.equal(record.tokens, 100);
    assert.equal(record.generationMs, 4_000);
    const stats = kernel.getRoundStats();
    assert.equal(stats.contributingSegments, 1);
    assert.ok(Math.abs((stats.tokensPerSecond as number) - 25) < 1e-9);
    // 结算输入的 outcome 不得覆盖 end 事件结果
    const again = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', outcome: 'completed' });
    assert.equal(again?.outcome, outcome);
  }
});

test('segment: 先结算后结束的补救路径补齐时长与结局，tokens 不双算', () => {
  const { kernel } = prepare();
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 1_000), true);
  const early = kernel.settleSegment({ segmentId: 's1', roundId: 'r1', providerOutputTokens: 50 });
  assert.ok(early != null);
  assert.equal(early.generationMs, 0); // 未结束，自测时长为 0
  assert.equal(kernel.getRoundStats().tokensPerSecond, null); // 0 时长不贡献
  assert.equal(kernel.endSegment('s1', { outcome: 'aborted', atMs: 11_000 }), true);
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 50);
  assert.equal(stats.generationMs, 10_000);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 5) < 1e-9);
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.ok(measurement != null);
  assert.equal(measurement.finalRecord?.outcome, 'aborted');
});

test('segment: 未知 segment 的调用被忽略，settle 返回 null', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.onDelta('ghost', { text: 'x'.repeat(400) }, 1_000), false);
  assert.equal(kernel.onProviderUsage('ghost', 10), false);
  assert.equal(kernel.endSegment('ghost', { outcome: 'completed', atMs: 2_000 }), false);
  assert.equal(kernel.settleSegment({ segmentId: 'ghost', roundId: 'r1' }), null);
  assert.equal(kernel.settleSegment({ segmentId: 'ghost', roundId: 'nope' }), null);
  const stats = kernel.getRoundStats();
  assert.equal(stats.observedSegments, 0);
  assert.equal(stats.tokens, 0);
});

test('segment: getSegmentMeasurement 提供构建 marker 所需快照', () => {
  const { kernel } = prepare();
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400), thinking: '你' }, 1_500), true);
  assert.equal(kernel.onProviderUsage('s1', 42), true);
  let measurement = kernel.getSegmentMeasurement('s1');
  assert.ok(measurement != null);
  assert.equal(measurement.roundId, 'r1');
  assert.equal(measurement.firstDeltaAtMs, 1_500);
  assert.equal(measurement.ended, false);
  assert.equal(measurement.generationMs, null); // 进行中无自测时长
  assert.equal(measurement.contentEstimateTokens, 101); // 400/4 + ceil(1/1.5)
  assert.equal(measurement.provisionalTokens, 42); // provider 累计优先
  assert.equal(measurement.finalRecord, null);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 6_500 }), true);
  measurement = kernel.getSegmentMeasurement('s1');
  assert.ok(measurement != null);
  assert.equal(measurement.generationMs, 5_000);
  assert.equal(measurement.ended, true);
  assert.equal(measurement.outcome, 'completed');
  assert.equal(kernel.getSegmentMeasurement('ghost'), null);
});

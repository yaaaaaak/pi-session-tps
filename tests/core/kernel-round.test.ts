import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTpsKernel } from '../../src/core/index.ts';

function freshRound(kernel: SessionTpsKernel, roundId: string): void {
  assert.equal(kernel.startRound(roundId), true);
}

/** 完整流过一个 segment：内容 delta → provider usage → message_end → 结算。 */
function streamFinalSegment(
  kernel: SessionTpsKernel,
  segmentId: string,
  options: {
    text?: string;
    firstDeltaAtMs?: number;
    endedAtMs?: number;
    providerOutputTokens?: number;
    outcome?: 'completed' | 'aborted' | 'error';
  } = {},
): void {
  const text = options.text ?? 'x'.repeat(400);
  const firstDeltaAtMs = options.firstDeltaAtMs ?? 1_000;
  const endedAtMs = options.endedAtMs ?? firstDeltaAtMs + 10_000;
  assert.equal(kernel.startSegment(segmentId), true);
  assert.equal(kernel.onDelta(segmentId, { text }, firstDeltaAtMs), true);
  if (options.providerOutputTokens != null) {
    assert.equal(kernel.onProviderUsage(segmentId, options.providerOutputTokens), true);
  }
  assert.equal(
    kernel.endSegment(segmentId, { outcome: options.outcome ?? 'completed', atMs: endedAtMs }),
    true,
  );
  const record = kernel.settleSegment({
    segmentId,
    roundId: 'r1',
    providerOutputTokens: options.providerOutputTokens,
  });
  assert.ok(record != null);
}

test('round: 无任何轮时 roundId 为 null 且 TPS 为 null（显示层用 `--`）', () => {
  const kernel = new SessionTpsKernel();
  const stats = kernel.getRoundStats();
  assert.equal(stats.roundId, null);
  assert.equal(stats.settled, false);
  assert.equal(stats.observedSegments, 0);
  assert.equal(stats.tokensPerSecond, null);
  assert.equal(stats.tokens, 0);
  assert.equal(stats.generationMs, 0);
});

test('round: 单 segment provider 结算的当轮 TPS 与字段语义', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  streamFinalSegment(kernel, 's1', { providerOutputTokens: 100 });
  const stats = kernel.getRoundStats();
  assert.equal(stats.roundId, 'r1');
  assert.equal(stats.settled, false);
  assert.equal(stats.observedSegments, 1);
  assert.equal(stats.contributingSegments, 1);
  assert.equal(stats.tokens, 100);
  assert.equal(stats.generationMs, 10_000);
  assert.equal(stats.estimated, false);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 10) < 1e-9);
});

test('round: 多 segment 正确累加（tokens 与时长分别求和，非 TPS 平均）', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  // s1: 50 tokens / 5000ms = 10 tok/s；s2: 150 tokens / 5000ms = 30 tok/s
  streamFinalSegment(kernel, 's1', {
    providerOutputTokens: 50,
    firstDeltaAtMs: 0,
    endedAtMs: 5_000,
  });
  streamFinalSegment(kernel, 's2', {
    providerOutputTokens: 150,
    firstDeltaAtMs: 10_000,
    endedAtMs: 15_000,
  });
  const stats = kernel.getRoundStats();
  assert.equal(stats.contributingSegments, 2);
  assert.equal(stats.tokens, 200);
  assert.equal(stats.generationMs, 10_000);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 20) < 1e-9);
});

test('round: 轮内重复 startRound 幂等、不清零；不同 id 被拒绝', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  streamFinalSegment(kernel, 's1', { providerOutputTokens: 100 });
  const before = kernel.getRoundStats();
  assert.equal(kernel.startRound('r1'), true); // 同 id 幂等
  const afterSame = kernel.getRoundStats();
  assert.equal(afterSame.tokens, before.tokens);
  assert.equal(afterSame.observedSegments, before.observedSegments);
  assert.equal(kernel.startRound('r2'), false); // 活动轮内换 id 不清零
  const afterOther = kernel.getRoundStats();
  assert.equal(afterOther.roundId, 'r1');
  assert.equal(afterOther.tokens, before.tokens);
});

test('round: settleRound 幂等，完成后保留最近一轮值', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  streamFinalSegment(kernel, 's1', { providerOutputTokens: 100 });
  assert.equal(kernel.settleRound(), true);
  assert.equal(kernel.settleRound(), false); // 幂等
  const stats = kernel.getRoundStats();
  assert.equal(stats.roundId, 'r1');
  assert.equal(stats.settled, true);
  assert.equal(stats.tokens, 100);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 10) < 1e-9);
});

test('round: settle 后新轮从零开始，且只统计本轮 segment', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  streamFinalSegment(kernel, 's1', { providerOutputTokens: 100 });
  assert.equal(kernel.settleRound(), true);
  assert.equal(kernel.startRound('r1'), false); // 不得复用已 settled 的轮 id
  freshRound(kernel, 'r2');
  const stats = kernel.getRoundStats();
  assert.equal(stats.roundId, 'r2');
  assert.equal(stats.observedSegments, 0);
  assert.equal(stats.tokens, 0);
  assert.equal(stats.tokensPerSecond, null);
  // 会话仍保留 r1 的贡献
  const session = kernel.getSessionStats();
  assert.equal(session.tokens, 100);
  assert.equal(session.rounds, 2);
});

test('round: 进行中 segment 用注入 nowMs 计算实时 TPS，且 provisional 标记估算', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  // 不传 nowMs：进行中段不参与实时估算
  assert.equal(kernel.getRoundStats().tokensPerSecond, null);
  const stats = kernel.getRoundStats({ nowMs: 5_000 });
  assert.equal(stats.tokens, 100); // 内容估算 400/4
  assert.equal(stats.generationMs, 5_000);
  assert.equal(stats.estimated, true);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 20) < 1e-9);
  // 时间前进，实时值随之更新（内核自身无时钟）
  const later = kernel.getRoundStats({ nowMs: 10_000 });
  assert.ok(Math.abs((later.tokensPerSecond as number) - 10) < 1e-9);
});

test('round: live provider 累计值优先于内容估算（provisional 仍标估算）', () => {
  const kernel = new SessionTpsKernel();
  freshRound(kernel, 'r1');
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400) }, 0), true);
  assert.equal(kernel.onProviderUsage('s1', 60), true);
  const stats = kernel.getRoundStats({ nowMs: 2_000 });
  assert.equal(stats.tokens, 60);
  assert.equal(stats.estimated, true);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 30) < 1e-9);
});

test('round: 无活动轮时不能注册 segment；startSegment 幂等不重复计数', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startSegment('s1'), false);
  freshRound(kernel, 'r1');
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.startSegment('s1'), true); // 幂等
  assert.equal(kernel.startSegment('s1', 'r2'), false); // roundId 校验不匹配
  assert.equal(kernel.startSegment('s1', 'r1'), true);
  assert.equal(kernel.getRoundStats().observedSegments, 1);
});

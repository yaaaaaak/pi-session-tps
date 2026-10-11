// 恢复与生命周期测试：session_start/session_tree 按当前分支重建、fork/导航到
// assistant 或 marker 自身、恢复清除活动计时、会话不串、compaction/context_edit
// 原始分支口径（SPEC 契约 5/7）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTpsExtension, assistantFingerprint } from '../../src/adapter/index.ts';
import type { PiSessionEntryLike } from '../../src/adapter/index.ts';
import {
  FakeClock,
  assistantMessage,
  createFakeCtx,
  createFakePi,
  customMarkerEntry,
  messageEntry,
  metadataEntry,
  textPart,
} from './helpers.ts';

interface Harness {
  readonly fake: ReturnType<typeof createFakePi>;
  readonly ctx: ReturnType<typeof createFakeCtx>;
  readonly clock: FakeClock;
  emit(event: Record<string, unknown>): Promise<void>;
}

function harness(branch: PiSessionEntryLike[] = [], mode?: string): Harness {
  const fake = createFakePi();
  const ctx = createFakeCtx({ mode, branch });
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(fake.pi);
  return {
    fake,
    ctx,
    clock,
    emit(event) {
      return fake.emit(event, ctx.ctx);
    },
  };
}

function lastStatus(ctx: ReturnType<typeof createFakeCtx>): string | undefined {
  return ctx.statusCalls[ctx.statusCalls.length - 1]?.[1];
}

function userEntry(id: string): PiSessionEntryLike {
  return messageEntry(id, { role: 'user', content: 'hi', timestamp: 1 });
}

/** 生成一轮真实（模拟）生成的 marker 数据与最终消息，供恢复分支复用。 */
async function generateMeasuredRound(): Promise<{ markerData: unknown; finalMessage: ReturnType<typeof assistantMessage> }> {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(fake.pi);
  await fake.emit({ type: 'session_start', reason: 'startup' }, ctx.ctx);
  await fake.emit({ type: 'agent_start' }, ctx.ctx);
  await fake.emit({ type: 'message_start', message: assistantMessage() }, ctx.ctx);
  clock.advance(1_000);
  await fake.emit(
    {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
    },
    ctx.ctx,
  );
  clock.advance(4_000);
  const finalMessage = assistantMessage({
    content: [textPart('x'.repeat(400))],
    usageOutput: 200,
    stopReason: 'stop',
    timestamp: 1_500,
  });
  await fake.emit({ type: 'message_end', message: finalMessage }, ctx.ctx);
  await fake.emit({ type: 'agent_settled', aborted: false }, ctx.ctx);
  assert.equal(fake.entries.length, 1);
  return { markerData: fake.entries[0].data, finalMessage };
}

test('restore: 新运行时 session_start 按分支恢复（fork 到 assistant 自身）', async () => {
  const { markerData, finalMessage } = await generateMeasuredRound();
  const h = harness([
    userEntry('u1'),
    customMarkerEntry('m1', markerData),
    messageEntry('a1', finalMessage),
  ]);
  await h.emit({ type: 'session_start', reason: 'resume' });
  // 200 tokens / 4000ms = 50 tok/s；新轮未开始 → 当轮 --
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 50 tok/s | 已测 1/1');
});

test('restore: reload 后恢复同一分支（reason=reload）', async () => {
  const { markerData, finalMessage } = await generateMeasuredRound();
  const h = harness([userEntry('u1'), customMarkerEntry('m1', markerData), messageEntry('a1', finalMessage)]);
  await h.emit({ type: 'session_start', reason: 'reload' });
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 50 tok/s | 已测 1/1');
});

test('restore: 导航到 marker 自身不算未存在响应', async () => {
  const { markerData } = await generateMeasuredRound();
  const h = harness([userEntry('u1'), customMarkerEntry('m1', markerData)]);
  await h.emit({ type: 'session_tree', newLeafId: 'm1' });
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/0');
});

test('restore: 恢复后 live 无缝衔接同一会话统计', async () => {
  const { markerData, finalMessage } = await generateMeasuredRound();
  const h = harness([userEntry('u1'), customMarkerEntry('m1', markerData), messageEntry('a1', finalMessage)]);
  await h.emit({ type: 'session_start', reason: 'resume' });
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(200) },
  });
  h.clock.advance(900); // 2000
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('y'.repeat(200))], usageOutput: 100 }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });
  // 会话：(200 + 100) tokens / (4000 + 900) ms ≈ 61.2 tok/s；当轮：100/900 ≈ 111
  assert.equal(lastStatus(h.ctx), '当轮 111 | 会话 61.2 tok/s | 已测 2/2');
});

test('restore: 流中途 reload 后 message_end 保守拒算（不得用完整 usage 除以局部窗口）', async () => {
  // 纠错回归（首轮 P0）：旧断言曾期待“自 reload 后首 delta 重测 300ms 窗口”
  // 并果 50 tokens/300ms ≈ 167 tok/s 精确测量；已批准边界澄清后为保守拒算。
  const h = harness();
  await h.emit({ type: 'session_start', reason: 'startup' });
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100：部分内容已流过
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  // 流中途 reload：重建清除活动计时；后续 delta 属非完整观测流
  await h.emit({ type: 'session_start', reason: 'reload' });
  h.clock.advance(100); // 1200：reload 后首个观察到的 delta（provisional 展示用）
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(400) },
  });
  h.clock.advance(300); // 1500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('y'.repeat(400))], usageOutput: 50 }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });
  // 拒算：无 marker、无 TPS 贡献；真实落盘 assistant 只进 coverage.total。
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('restore: 会话切换不串（A→B 只保留 B 的分支状态）', async () => {
  const { markerData, finalMessage } = await generateMeasuredRound();
  const branchB: PiSessionEntryLike[] = [
    userEntry('u-b'),
    customMarkerEntry('m-b', {
      ...(markerData as { roundId: string; segmentId: string; generationMs: number; estimatedTokens: number; match: unknown }),
      roundId: 'r-b',
      segmentId: 's-b',
      generationMs: 500,
    }),
    messageEntry('a-b', finalMessage),
  ];
  const h = harness([userEntry('u1'), customMarkerEntry('m1', markerData), messageEntry('a1', finalMessage)]);
  await h.emit({ type: 'session_start', reason: 'resume' });
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 50 tok/s | 已测 1/1');

  h.ctx.branch.splice(0, h.ctx.branch.length, ...branchB);
  await h.emit({ type: 'session_start', reason: 'resume' });
  // B：200 tokens / 500ms = 400 tok/s
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 400 tok/s | 已测 1/1');
});

test('restore: 分支含 compaction 边界与 context_edit，原始历史仍计入', async () => {
  const { markerData, finalMessage } = await generateMeasuredRound();
  const failed = assistantMessage({
    content: [textPart('partial output')],
    usageOutput: 0,
    stopReason: 'error',
    timestamp: 1_600,
  });
  const failedMarker = {
    ...(markerData as Record<string, unknown>),
    roundId: 'r-2',
    segmentId: 's-2',
    generationMs: 200,
    estimatedTokens: 4,
    match: assistantFingerprint(failed),
  };
  const h = harness([
    userEntry('u1'),
    customMarkerEntry('m1', markerData),
    messageEntry('a1', finalMessage),
    // 失败尝试被 context_edit 从模型上下文 omit，但 raw 分支保留（SPEC 契约 5）
    metadataEntry('context_edit', 'ce1'),
    customMarkerEntry('m2', failedMarker),
    messageEntry('a2', failed),
    metadataEntry('compaction', 'c1'),
    userEntry('u2'),
  ]);
  await h.emit({ type: 'session_start', reason: 'resume' });
  // a1: 200 tokens/4000ms（provider）；a2: 4 tokens/200ms（估算）→ (204)/(4200) ≈ 48.6
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 ~48.6 tok/s | 已测 2/2');
});

test('restore: 空分支新会话归零显示占位', async () => {
  const h = harness();
  await h.emit({ type: 'session_start', reason: 'new' });
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/0');
  assert.equal(h.fake.entries.length, 0);
});

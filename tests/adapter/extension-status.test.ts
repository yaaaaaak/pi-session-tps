// UI/模式/节流/清理测试（R1/R5）：status key、-- 占位、~ 标记、节流与边界强制
// 刷新、非 TUI 不碰终端 UI、shutdown 幂等清理、无永久计时器资源。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_KEY, createSessionTpsExtension, formatStatusText } from '../../src/adapter/index.ts';
import type { RoundStats, SessionStats } from '../../src/core/index.ts';
import { FakeClock, assistantMessage, createFakeCtx, createFakePi, textPart } from './helpers.ts';

function lastStatus(ctx: ReturnType<typeof createFakeCtx>): string | undefined {
  return ctx.statusCalls[ctx.statusCalls.length - 1]?.[1];
}

test('status: 初始无数据显示占位 -- 且格式包含当轮/会话/tok/s/已测', async () => {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now() })(fake.pi);
  await fake.emit({ type: 'session_start', reason: 'startup' }, ctx.ctx);
  assert.equal(ctx.statusCalls.length, 1);
  const [key, text] = ctx.statusCalls[0];
  assert.equal(key, STATUS_KEY);
  assert.equal(key, 'pi-session-tps');
  assert.equal(text, '当轮 -- | 会话 -- tok/s | 已测 0/0');
});

test('status: 非 TUI 模式不调用终端 UI，统计与 marker 照常', async () => {
  for (const mode of ['rpc', 'json', 'print']) {
    const fake = createFakePi();
    const ctx = createFakeCtx({ mode });
    const clock = new FakeClock(1_000);
    createSessionTpsExtension({ now: () => clock.now() })(fake.pi);
    await fake.emit({ type: 'session_start', reason: 'startup' }, ctx.ctx);
    await fake.emit({ type: 'agent_start' }, ctx.ctx);
    await fake.emit({ type: 'message_start', message: assistantMessage() }, ctx.ctx);
    clock.advance(500);
    await fake.emit(
      {
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
      },
      ctx.ctx,
    );
    clock.advance(500);
    await fake.emit(
      { type: 'message_end', message: assistantMessage({ content: [textPart('x'.repeat(400))], usageOutput: 100 }) },
      ctx.ctx,
    );
    await fake.emit({ type: 'agent_settled', aborted: false }, ctx.ctx);
    assert.equal(ctx.statusCalls.length, 0, mode);
    assert.equal(fake.entries.length, 1, mode);
  }
});

test('status: delta 节流刷新，message_end/agent_start 边界强制刷新', async () => {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 250 })(fake.pi);

  await fake.emit({ type: 'session_start', reason: 'startup' }, ctx.ctx); // 初始 1 次
  await fake.emit({ type: 'agent_start' }, ctx.ctx); // 强制 +1 → 2
  await fake.emit({ type: 'message_start', message: assistantMessage() }, ctx.ctx);

  // 10 条 delta，每条间隔 10ms（节流窗口 250ms 内不刷新）
  for (let i = 0; i < 10; i += 1) {
    clock.advance(10);
    await fake.emit(
      {
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(40) },
      },
      ctx.ctx,
    );
  }
  assert.equal(ctx.statusCalls.length, 2); // 全部被节流

  clock.advance(200); // 距上次强制刷新 500ms ≥ 250 → 允许
  await fake.emit(
    {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(40) },
    },
    ctx.ctx,
  );
  assert.equal(ctx.statusCalls.length, 3);
  assert.ok(lastStatus(ctx)?.includes('~')); // 实时 provisional 带 ~

  clock.advance(10);
  await fake.emit(
    { type: 'message_end', message: assistantMessage({ content: [textPart('x'.repeat(440))], usageOutput: 110 }) },
    ctx.ctx,
  );
  assert.equal(ctx.statusCalls.length, 4); // 边界强制刷新
  assert.ok(lastStatus(ctx)?.startsWith('当轮 367')); // 110 tokens / 300ms ≈ 366.7 tok/s
});

test('status: 完成后保留最近一轮与会话值', async () => {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now() })(fake.pi);
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
  clock.advance(3_000);
  await fake.emit(
    { type: 'message_end', message: assistantMessage({ content: [textPart('x'.repeat(400))], usageOutput: 200 }) },
    ctx.ctx,
  );
  await fake.emit({ type: 'agent_settled', aborted: false }, ctx.ctx);
  assert.equal(lastStatus(ctx), '当轮 66.7 | 会话 66.7 tok/s | 已测 1/1');
  // settled 后无新事件：最后一次刷新即保留值
  assert.equal(ctx.statusCalls[ctx.statusCalls.length - 1][1], '当轮 66.7 | 会话 66.7 tok/s | 已测 1/1');
});

test('status: session_shutdown 幂等清理 status', async () => {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now() })(fake.pi);
  await fake.emit({ type: 'session_start', reason: 'startup' }, ctx.ctx);
  await fake.emit({ type: 'agent_start' }, ctx.ctx);
  await fake.emit({ type: 'session_shutdown', reason: 'quit' }, ctx.ctx);
  assert.deepEqual(ctx.statusCalls[ctx.statusCalls.length - 1], [STATUS_KEY, undefined]);
  const callsAfterFirst = ctx.statusCalls.length;
  await fake.emit({ type: 'session_shutdown', reason: 'quit' }, ctx.ctx);
  // 幂等：第二次 shutdown 不再重复清理
  assert.equal(ctx.statusCalls.length, callsAfterFirst);
});

test('status: 工厂同步返回、不注册任何计时器/进程资源', () => {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  const result = createSessionTpsExtension({ now: () => clock.now() })(fake.pi);
  assert.equal(result, undefined); // 工厂无返回值、无异步初始化
});

test('status: formatStatusText 纯函数口径', () => {
  const round = { tokensPerSecond: null, tokens: 0, generationMs: 0, estimated: false, contributingSegments: 0, roundId: null, settled: false, observedSegments: 0 } as RoundStats;
  const session = { tokensPerSecond: 48.571, tokens: 204, generationMs: 4_200, estimated: true, contributingSegments: 2, coverage: { measured: 2, total: 5 }, rounds: 1 } as SessionStats;
  assert.equal(formatStatusText(round, session), '当轮 -- | 会话 ~48.6 tok/s | 已测 2/5');
  const round2 = { ...round, tokensPerSecond: 123.4, estimated: false } as RoundStats;
  assert.equal(formatStatusText(round2, session), '当轮 123 | 会话 ~48.6 tok/s | 已测 2/5');
  const mid = { ...round, tokensPerSecond: 61.25, estimated: false } as RoundStats;
  assert.equal(formatStatusText(mid, session), '当轮 61.3 | 会话 ~48.6 tok/s | 已测 2/5');
  const big = { ...round, tokensPerSecond: 999.6, estimated: false } as RoundStats;
  assert.equal(formatStatusText(big, session), '当轮 1000 | 会话 ~48.6 tok/s | 已测 2/5');
});

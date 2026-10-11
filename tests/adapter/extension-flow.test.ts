// 适配层事件流测试：轮/段生命周期、重试幂等、多段工具往返、token 来源与边界。
// 全部为模拟事件，不发起真实 LLM 请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER_VERSION, createSessionTpsExtension } from '../../src/adapter/index.ts';
import {
  FakeClock,
  assistantMessage,
  createFakeCtx,
  createFakePi,
  textPart,
} from './helpers.ts';

interface Harness {
  readonly fake: ReturnType<typeof createFakePi>;
  readonly ctx: ReturnType<typeof createFakeCtx>;
  readonly clock: FakeClock;
  emit(event: Record<string, unknown>): Promise<void>;
}

function harness(options?: { mode?: string; throttleMs?: number }): Harness {
  const fake = createFakePi();
  const ctx = createFakeCtx({ mode: options?.mode });
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: options?.throttleMs ?? 0 })(fake.pi);
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
  const call = ctx.statusCalls[ctx.statusCalls.length - 1];
  return call?.[1];
}

test('flow: 完整一轮 provider usage 权威、marker 前置写入且不含正文', async () => {
  const h = harness();
  await h.emit({ type: 'session_start', reason: 'startup' });
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/0');

  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(1_000); // 2000：首个非空 delta
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  h.clock.advance(4_000); // 6000：message_end
  const finalMessage = assistantMessage({
    content: [textPart('x'.repeat(400))],
    usageOutput: 200,
    stopReason: 'stop',
    timestamp: 1_500,
  });
  await h.emit({ type: 'message_end', message: finalMessage });
  await h.emit({ type: 'agent_settled', aborted: false });

  assert.equal(h.fake.entries.length, 1);
  const marker = h.fake.entries[0];
  assert.equal(marker.customType, 'pi-session-tps.measurement');
  assert.equal((marker.data as { v: number }).v, MARKER_VERSION);
  assert.equal((marker.data as { generationMs: number }).generationMs, 4_000);
  assert.equal((marker.data as { estimatedTokens: number }).estimatedTokens, 100);
  assert.equal((marker.data as { match: { stopReason: string } }).match.stopReason, 'stop');
  // marker 不存正文
  assert.ok(!JSON.stringify(marker.data).includes('x'.repeat(32)));
  assert.ok(typeof (marker.data as { roundId: string }).roundId === 'string');
  assert.ok(typeof (marker.data as { segmentId: string }).segmentId === 'string');

  // 200 tokens / 4000ms = 50 tok/s，provider 来源不标 ~
  assert.equal(lastStatus(h.ctx), '当轮 50 | 会话 50 tok/s | 已测 1/1');
});

test('flow: 自动重试再次 agent_start 属同一轮（幂等不清零），两段分别计一次', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  h.clock.advance(400); // 1500：失败尝试（usage 零值 → 估算）
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('x'.repeat(400))], usageOutput: 0, stopReason: 'error' }),
  });
  // 100 tokens / 400ms = 250 tok/s（估算 → ~）
  assert.equal(lastStatus(h.ctx), '当轮 ~250 | 会话 ~250 tok/s | 已测 1/1');

  // 重试：新的 agent_start，但轮未结束，不得清零
  h.clock.advance(100); // 1600
  await h.emit({ type: 'agent_start' });
  assert.equal(lastStatus(h.ctx), '当轮 ~250 | 会话 ~250 tok/s | 已测 1/1');

  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1700
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(200) },
  });
  h.clock.advance(800); // 2500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('y'.repeat(200))], usageOutput: 30, stopReason: 'stop' }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });

  // (100 估算 + 30 provider) tokens / (400 + 800) ms ≈ 108 tok/s，含估算 → ~
  assert.equal(lastStatus(h.ctx), '当轮 ~108 | 会话 ~108 tok/s | 已测 2/2');
  assert.equal(h.fake.entries.length, 2);
});

test('flow: 一轮多段工具往返正确累加且排除工具执行时间', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });

  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(200) },
  });
  h.clock.advance(100); // 1200
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'toolcall_delta', delta: 'z'.repeat(200) },
  });
  h.clock.advance(300); // 1500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({
      content: [textPart('x'.repeat(200)), { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
      usageOutput: 60,
      stopReason: 'toolUse',
    }),
  });

  // 工具执行（含 toolResult 消息事件）：不计入生成时间，其 usage 不纳入
  await h.emit({
    type: 'message_start',
    message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [], usage: { output: 999 } },
  });
  await h.emit({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [], usage: { output: 999 } },
  });
  h.clock.advance(3_490); // 4990：工具执行 3.49s 必须排除

  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(110); // 5100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'w'.repeat(200) },
  });
  h.clock.advance(400); // 5500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('w'.repeat(200))], usageOutput: 40, stopReason: 'stop' }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });

  // (60 + 40) tokens / (400 + 400) ms = 125 tok/s
  assert.equal(lastStatus(h.ctx), '当轮 125 | 会话 125 tok/s | 已测 2/2');
  assert.equal(h.fake.entries.length, 2);
});

test('flow: 空 delta 与 *_start 事件不启动生成时钟', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_start' },
  });
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: '' },
  });
  h.clock.advance(1_000); // 2000：首个非空 delta
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'abcd'.repeat(25) },
  });
  h.clock.advance(500); // 2500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('abcd'.repeat(25))], usageOutput: 25 }),
  });

  const marker = h.fake.entries[0]?.data as { generationMs: number };
  assert.equal(marker.generationMs, 500);
});

test('flow: usage 零值/缺失/非法回退累计内容估算并标记 ~', async () => {
  for (const bad of [0, undefined, -3, 2.5, Number.NaN]) {
    const h = harness();
    await h.emit({ type: 'agent_start' });
    await h.emit({ type: 'message_start', message: assistantMessage() });
    h.clock.advance(500); // 1500
    await h.emit({
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
    });
    h.clock.advance(500); // 2000
    await h.emit({
      type: 'message_end',
      message: assistantMessage({
        content: [textPart('x'.repeat(400))],
        usageOutput: bad as number,
        stopReason: 'stop',
      }),
    });
    await h.emit({ type: 'agent_settled', aborted: false });
    // 100 tokens / 500ms = 200 tok/s（估算）
    assert.equal(lastStatus(h.ctx), '当轮 ~200 | 会话 ~200 tok/s | 已测 1/1', `usage=${String(bad)}`);
    assert.equal((h.fake.entries[0].data as { estimatedTokens: number }).estimatedTokens, 100);
  }
});

test('flow: 取消（aborted）有可观察内容且正时长仍计入', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  h.clock.advance(400); // 1500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('x'.repeat(400))], usageOutput: 30, stopReason: 'aborted' }),
  });
  await h.emit({ type: 'agent_settled', aborted: true });
  // 30 tokens / 400ms = 75 tok/s
  assert.equal(lastStatus(h.ctx), '当轮 75 | 会话 75 tok/s | 已测 1/1');
  assert.equal(h.fake.entries.length, 1);
});

test('flow: 无内容失败不贡献 tokens/时间、不写 marker', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage({ content: [] }) });
  h.clock.advance(500);
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [], usageOutput: 0, stopReason: 'error' }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(h.fake.entries.length, 0);
  // 无有效段：无 measured；空响应仍算分支 assistant 条目 → 已测 0/1
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('flow: agent_end 不重复结算 event.messages', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(200) },
  });
  h.clock.advance(300); // 1400
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('x'.repeat(200))], usageOutput: 60 }),
  });
  const before = lastStatus(h.ctx);
  await h.emit({
    type: 'agent_end',
    messages: [assistantMessage({ content: [textPart('x'.repeat(200))], usageOutput: 60 })],
  });
  assert.equal(lastStatus(h.ctx), before);
  assert.equal(h.fake.entries.length, 1);
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h.ctx), '当轮 200 | 会话 200 tok/s | 已测 1/1');
});

test('flow: 实时 provisional 值带 ~，流内 provider 累计值优先于内容估算', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  h.clock.advance(100); // 1200：流内 provider 累计 output=50
  await h.emit({
    type: 'message_update',
    message: assistantMessage({ usageOutput: 50 }),
    assistantMessageEvent: { type: 'text_delta', delta: 'x' },
  });
  // provisional：估算被 provider 累计值取代：50 tokens / 100ms = 500 tok/s（live 一律 ~）
  assert.equal(lastStatus(h.ctx), '当轮 ~500 | 会话 ~500 tok/s | 已测 0/0');
  h.clock.advance(300); // 1500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('x'.repeat(401))], usageOutput: 50 }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });
  // final：50 tokens / 400ms = 125 tok/s，provider → 无 ~
  assert.equal(lastStatus(h.ctx), '当轮 125 | 会话 125 tok/s | 已测 1/1');
});

test('flow: 非 assistant 消息（user/toolResult）不产生段', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 1 } });
  await h.emit({ type: 'message_end', message: { role: 'user', content: 'hi', timestamp: 1 } });
  await h.emit({
    type: 'message_start',
    message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', content: [] },
  });
  await h.emit({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', content: [] },
  });
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/0');
});

test('flow: text/thinking/toolArguments 三类内容都计入回退估算', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(120) },
  });
  h.clock.advance(100); // 1200
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'thinking_delta', delta: 'y'.repeat(120) },
  });
  h.clock.advance(100); // 1300
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'toolcall_delta', delta: 'z'.repeat(160) },
  });
  h.clock.advance(700); // 2000
  await h.emit({
    type: 'message_end',
    message: assistantMessage({
      content: [
        textPart('x'.repeat(120)),
        { type: 'thinking', thinking: 'y'.repeat(120) },
        { type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a' } },
      ],
      usageOutput: 0,
      stopReason: 'toolUse',
    }),
  });
  // 400 chars / 4 = 100 tokens / 900ms → ~111 tok/s
  assert.equal(lastStatus(h.ctx), '当轮 ~111 | 会话 ~111 tok/s | 已测 1/1');
  assert.equal((h.fake.entries[0].data as { estimatedTokens: number }).estimatedTokens, 100);
});

test('flow: 无 message_start 的流（中途加载/reload）保守拒算：不写 marker、只进 coverage.total', async () => {
  // 纠错回归（首轮 P0）：reload/晚加载后仅观察到局部 delta 的响应，
  // 即便随后 message_end 携带完整最终 usage，也不得用完整 tokens 除以局部窗口。
  const h = harness();
  await h.emit({ type: 'agent_start' });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  h.clock.advance(400); // 1500
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('x'.repeat(400))], usageOutput: 80 }),
  });
  await h.emit({ type: 'agent_settled', aborted: false });
  // 保守拒算：无 TPS 贡献（非仅加 ~），无 marker；真实落盘 assistant 只进 total。
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('flow: 只有 message_end 的真实 assistant（晚于流加载）登记一次未测条目', async () => {
  // 纠错回归（首轮 P0）：reload 发生在最后一个 delta 之后时，本扩展未见流，
  // 但 Pi 仍会 append 该 assistant：coverage.total 必须计 0/1，不得保持 0/0。
  const h = harness();
  await h.emit({ type: 'agent_start' });
  const message = assistantMessage({ content: [textPart('late')], usageOutput: 10 });
  await h.emit({ type: 'message_end', message });
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  // 重复结束通知不得双算
  await h.emit({ type: 'message_end', message });
  assert.equal(lastStatus(h.ctx), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

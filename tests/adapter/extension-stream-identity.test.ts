// round-2 P2 适配层回归：Pi 事件的 contentIndex 原样透传内核逻辑流身份——
// 同类多个内容块/工具调用交错时最终估算与顺序生成一致；缺省（无 contentIndex）
// 保持 legacy 兼容；text/thinking/toolcall 三类不遗漏；生成时钟与流身份无关。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTpsExtension } from '../../src/adapter/index.ts';
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
  lastMarkerData(): Record<string, unknown> | undefined;
}

function harness(): Harness {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(fake.pi);
  return {
    fake,
    ctx,
    clock,
    emit(event) {
      return fake.emit(event, ctx.ctx);
    },
    lastMarkerData() {
      return fake.entries[fake.entries.length - 1]?.data as Record<string, unknown> | undefined;
    },
  };
}

function lastStatus(h: Harness): string | undefined {
  return h.ctx.statusCalls[h.ctx.statusCalls.length - 1]?.[1];
}

interface DeltaInit {
  readonly type: 'text_delta' | 'thinking_delta' | 'toolcall_delta';
  readonly delta: string;
  readonly contentIndex?: number;
}

async function deltas(h: Harness, events: readonly DeltaInit[]): Promise<void> {
  for (const event of events) {
    await h.emit({
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: event.type,
        delta: event.delta,
        ...(event.contentIndex === undefined ? {} : { contentIndex: event.contentIndex }),
      },
    });
  }
}

const ASTRAL = '\uD840\uDC00'; // U+20000（CJK 扩展 B）
const TOOL_PREFIX = '{"x":"';
const TOOL_SUFFIX = '"}';

/** reviewer 反例：两条工具参数流 {"x":"<12×U+20000>"}，按 A high→B high→A low→B low 交错。 */
function interleavedToolDeltas(): DeltaInit[] {
  const events: DeltaInit[] = [
    { type: 'toolcall_delta', delta: TOOL_PREFIX, contentIndex: 0 },
    { type: 'toolcall_delta', delta: TOOL_PREFIX, contentIndex: 1 },
  ];
  for (let i = 0; i < 12; i += 1) {
    events.push({ type: 'toolcall_delta', delta: ASTRAL[0], contentIndex: 0 });
    events.push({ type: 'toolcall_delta', delta: ASTRAL[0], contentIndex: 1 });
    events.push({ type: 'toolcall_delta', delta: ASTRAL[1], contentIndex: 0 });
    events.push({ type: 'toolcall_delta', delta: ASTRAL[1], contentIndex: 1 });
  }
  events.push({ type: 'toolcall_delta', delta: TOOL_SUFFIX, contentIndex: 0 });
  events.push({ type: 'toolcall_delta', delta: TOOL_SUFFIX, contentIndex: 1 });
  return events;
}

/** 同样两条流，顺序（先完成 A 再完成 B）。 */
function sequentialToolDeltas(): DeltaInit[] {
  const events: DeltaInit[] = [];
  for (const index of [0, 1] as const) {
    events.push({ type: 'toolcall_delta', delta: TOOL_PREFIX, contentIndex: index });
    for (let i = 0; i < 12; i += 1) {
      events.push({ type: 'toolcall_delta', delta: ASTRAL, contentIndex: index });
    }
    events.push({ type: 'toolcall_delta', delta: TOOL_SUFFIX, contentIndex: index });
  }
  return events;
}

/** 同样两条流，每流整块单 delta。 */
function wholeBlockToolDeltas(): DeltaInit[] {
  const whole = `${TOOL_PREFIX}${ASTRAL.repeat(12)}${TOOL_SUFFIX}`;
  return [
    { type: 'toolcall_delta', delta: whole, contentIndex: 0 },
    { type: 'toolcall_delta', delta: whole, contentIndex: 1 },
  ];
}

function toolRoundMessage() {
  const args = { x: ASTRAL.repeat(12) };
  return assistantMessage({
    content: [
      { type: 'toolCall', id: 't1', name: 'write', arguments: args },
      { type: 'toolCall', id: 't2', name: 'edit', arguments: args },
    ],
    usageOutput: 0,
    stopReason: 'toolUse',
  });
}

async function runToolStream(events: readonly DeltaInit[]): Promise<Harness> {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100：首个非空 delta
  await deltas(h, events);
  h.clock.advance(400); // 1500：message_end
  await h.emit({ type: 'message_end', message: toolRoundMessage() });
  await h.emit({ type: 'agent_settled', aborted: false });
  return h;
}

test('stream: 两条 toolcall 流按 contentIndex 交错与顺序/整块估算一致（20 tokens）', async () => {
  const interleaved = await runToolStream(interleavedToolDeltas());
  const sequential = await runToolStream(sequentialToolDeltas());
  const whole = await runToolStream(wholeBlockToolDeltas());
  // 16 plain + 24 cjk → ceil(16/4 + 24/1.5) = 20（共享累加器旧行为为 18）
  for (const h of [interleaved, sequential, whole]) {
    assert.equal((h.lastMarkerData() as { estimatedTokens: number }).estimatedTokens, 20);
  }
  // 20 tokens / 400ms = 50 tok/s（估算 → ~）
  assert.equal(lastStatus(interleaved), '当轮 ~50 | 会话 ~50 tok/s | 已测 1/1');
});

test('stream: text/thinking 同类多流交错代理对不误拼（与整块一致）', async () => {
  for (const type of ['text_delta', 'thinking_delta'] as const) {
    // 流 0/1 各 2 个代理对，high/high/low/low 交错：4 cjk → ceil(4/1.5) = 3
    const interleaved: DeltaInit[] = [];
    for (let i = 0; i < 2; i += 1) {
      interleaved.push({ type, delta: ASTRAL[0], contentIndex: 0 });
      interleaved.push({ type, delta: ASTRAL[0], contentIndex: 1 });
      interleaved.push({ type, delta: ASTRAL[1], contentIndex: 0 });
      interleaved.push({ type, delta: ASTRAL[1], contentIndex: 1 });
    }
    const whole: DeltaInit[] = [
      { type, delta: ASTRAL.repeat(2), contentIndex: 0 },
      { type, delta: ASTRAL.repeat(2), contentIndex: 1 },
    ];
    const results: number[] = [];
    for (const events of [interleaved, whole]) {
      const h = harness();
      await h.emit({ type: 'agent_start' });
      await h.emit({ type: 'message_start', message: assistantMessage() });
      h.clock.advance(100);
      await deltas(h, events);
      h.clock.advance(400);
      await h.emit({
        type: 'message_end',
        message: assistantMessage({
          content: type === 'text_delta' ? [textPart(ASTRAL.repeat(2)), textPart(ASTRAL.repeat(2))] : [],
          usageOutput: 0,
        }),
      });
      results.push((h.lastMarkerData() as { estimatedTokens: number }).estimatedTokens);
    }
    assert.deepEqual(results, [3, 3], type);
  }
});

test('stream: 带 contentIndex 流与缺省（无 contentIndex）流互相隔离', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100);
  // 索引流 0 与缺省流各 2 个代理对，交错 high/low（若误拼会得到 8 plain → 2）
  await deltas(h, [
    { type: 'text_delta', delta: ASTRAL[0], contentIndex: 0 },
    { type: 'text_delta', delta: ASTRAL[0] },
    { type: 'text_delta', delta: ASTRAL[1], contentIndex: 0 },
    { type: 'text_delta', delta: ASTRAL[1] },
    { type: 'text_delta', delta: ASTRAL[0], contentIndex: 0 },
    { type: 'text_delta', delta: ASTRAL[0] },
    { type: 'text_delta', delta: ASTRAL[1], contentIndex: 0 },
    { type: 'text_delta', delta: ASTRAL[1] },
  ]);
  h.clock.advance(400);
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart(ASTRAL.repeat(4))], usageOutput: 0 }),
  });
  // 4 cjk → ceil(4/1.5) = 3
  assert.equal((h.lastMarkerData() as { estimatedTokens: number }).estimatedTokens, 3);
});

test('stream: 生成时钟与流身份无关（首非空 delta 启表，多流不重置）', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await deltas(h, [
    { type: 'text_delta', delta: 'a'.repeat(200), contentIndex: 0 },
    { type: 'text_delta', delta: 'b'.repeat(200), contentIndex: 1 },
  ]);
  h.clock.advance(900); // 2000
  await h.emit({
    type: 'message_end',
    message: assistantMessage({
      content: [textPart('a'.repeat(200)), textPart('b'.repeat(200))],
      usageOutput: 100,
    }),
  });
  // 两流合计 400 chars → 100 tokens；窗口 1100→2000 = 900ms → ≈111.1 tok/s
  assert.equal((h.lastMarkerData() as { generationMs: number }).generationMs, 900);
  assert.equal(lastStatus(h), '当轮 111 | 会话 111 tok/s | 已测 1/1');
});

test('stream: 非法 contentIndex（NaN/负/小数）归缺省流，不抛错', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100);
  await deltas(h, [
    { type: 'text_delta', delta: 'a'.repeat(8), contentIndex: Number.NaN },
    { type: 'text_delta', delta: 'b'.repeat(4), contentIndex: -1 },
    { type: 'text_delta', delta: 'c'.repeat(4), contentIndex: 1.5 },
  ]);
  h.clock.advance(400);
  await h.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart('abc'.repeat(5) + 'a')], usageOutput: 0 }),
  });
  // 16 plain 全部归缺省流 → ceil(16/4) = 4
  assert.equal((h.lastMarkerData() as { estimatedTokens: number }).estimatedTokens, 4);
});

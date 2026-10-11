// 首轮审查边界澄清的适配层回归测试（SPEC「首轮独立审查后的必要边界澄清」）：
// 三种时间点 reload、孤立 partial + 空 failure 替换、重复终态、持久化后
// turn_end 校准（prospective 去重 / 改写降级 / 不清当前 cycle / 不双算）、
// 多响应重试与工具长间隔下的校准稳定性、代理对跨 delta 估算一致性。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTpsExtension } from '../../src/adapter/index.ts';
import type { PiMessageLike, PiSessionEntryLike } from '../../src/adapter/index.ts';
import { estimateTokens } from '../../src/core/index.ts';
import {
  FakeClock,
  assistantMessage,
  createFakeCtx,
  createFakePi,
  customMarkerEntry,
  messageEntry,
  textPart,
} from './helpers.ts';

interface Harness {
  readonly fake: ReturnType<typeof createFakePi>;
  readonly ctx: ReturnType<typeof createFakeCtx>;
  readonly clock: FakeClock;
  emit(event: Record<string, unknown>): Promise<void>;
  /** 模拟真实 Pi：message_end 扩展事件返回后 append marker 与 assistant。 */
  persist(finalMessage: PiMessageLike): void;
}

function harness(): Harness {
  const fake = createFakePi();
  const ctx = createFakeCtx();
  const clock = new FakeClock(1_000);
  createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(fake.pi);
  let persistCount = 0;
  return {
    fake,
    ctx,
    clock,
    emit(event) {
      return fake.emit(event, ctx.ctx);
    },
    persist(finalMessage) {
      persistCount += 1;
      const marker = fake.entries[fake.entries.length - 1];
      if (marker != null && fake.entries.length === persistCount) {
        ctx.branch.push(customMarkerEntry(`m${persistCount}`, marker.data));
      }
      ctx.branch.push(messageEntry(`a${persistCount}`, finalMessage));
    },
  };
}

function lastStatus(h: Harness): string | undefined {
  return h.ctx.statusCalls[h.ctx.statusCalls.length - 1]?.[1];
}

function userEntry(id: string): PiSessionEntryLike {
  return messageEntry(id, { role: 'user', content: 'hi', timestamp: 1 } as PiMessageLike);
}

async function streamMeasured(
  h: Harness,
  init: { text?: string; usageOutput: number; stopReason?: string; firstDeltaAt: number; endAt: number },
): Promise<PiMessageLike> {
  const text = init.text ?? 'x'.repeat(400);
  await h.emit({ type: 'message_start', message: assistantMessage() });
  while (h.clock.now() < init.firstDeltaAt) h.clock.advance(init.firstDeltaAt - h.clock.now());
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: text },
  });
  while (h.clock.now() < init.endAt) h.clock.advance(init.endAt - h.clock.now());
  const finalMessage = assistantMessage({
    content: [textPart(text)],
    usageOutput: init.usageOutput,
    stopReason: init.stopReason ?? 'stop',
  });
  await h.emit({ type: 'message_end', message: finalMessage });
  return finalMessage;
}

test('boundary: reload 生成前——重建后完整观测正常测量并经 turn_end 校准不双算', async () => {
  const h = harness();
  h.ctx.branch.push(userEntry('u0'));
  await h.emit({ type: 'session_start', reason: 'reload' });

  await h.emit({ type: 'agent_start' });
  const finalMessage = await streamMeasured(h, { firstDeltaAt: 2_000, endAt: 6_000, usageOutput: 200 });
  // message_end 后（落盘前）：prospective 展示一次
  assert.equal(lastStatus(h), '当轮 50 | 会话 50 tok/s | 已测 1/1');
  h.persist(finalMessage);
  // 持久化后安全边界：校准不得重复累加
  await h.emit({ type: 'turn_end', message: finalMessage });
  assert.equal(lastStatus(h), '当轮 50 | 会话 50 tok/s | 已测 1/1');
  await h.emit({ type: 'turn_end', message: finalMessage });
  assert.equal(lastStatus(h), '当轮 50 | 会话 50 tok/s | 已测 1/1');
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(h.fake.entries.length, 1);
});

test('boundary: reload 流中——拒算且校准后仍只计 total', async () => {
  const h = harness();
  await h.emit({ type: 'session_start', reason: 'startup' });
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  await h.emit({ type: 'session_start', reason: 'reload' });
  h.clock.advance(100); // 1200：reload 后局部 delta（非完整观测）
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(400) },
  });
  h.clock.advance(300); // 1500
  const finalMessage = assistantMessage({ content: [textPart('y'.repeat(400))], usageOutput: 50 });
  await h.emit({ type: 'message_end', message: finalMessage });
  h.persist(finalMessage); // 无 marker：只 append assistant
  await h.emit({ type: 'turn_end', message: finalMessage });
  // 最终：无 TPS、无 measured；coverage 与分支一致（1 条真实 assistant）
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('boundary: reload 最后 delta 后——只有 message_end 也要登记未测一次', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(1_000); // 2000：全部 delta 已流过
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  // 最后 delta 之后 reload：新运行时未观察到任何流事件
  await h.emit({ type: 'session_start', reason: 'reload' });
  h.clock.advance(4_000); // 6000
  const finalMessage = assistantMessage({ content: [textPart('x'.repeat(400))], usageOutput: 200 });
  await h.emit({ type: 'message_end', message: finalMessage });
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  h.persist(finalMessage);
  await h.emit({ type: 'turn_end', message: finalMessage });
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('boundary: 孤立 partial 流被新空 failure message_start 替换——原流丢弃，只算 0/1', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
  });
  // agent-core 异常路径：未结束的流不落盘，随后生成一条新的空 failure assistant
  await h.emit({ type: 'message_start', message: assistantMessage({ content: [] }) });
  h.clock.advance(100); // 1200
  const failure = assistantMessage({ content: [], usageOutput: 0, stopReason: 'error' });
  await h.emit({ type: 'message_end', message: failure });
  h.persist(failure); // 分支只有这条空 failure assistant
  await h.emit({ type: 'turn_end', message: failure });
  // 原孤立流：不进 TPS/coverage；空 failure 无内容零时长：只进 total
  assert.equal(h.fake.entries.length, 0);
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('boundary: 重复终态（同消息重复 message_end / 重复 turn_end）不双算', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  const finalMessage = await streamMeasured(h, { firstDeltaAt: 1_100, endAt: 1_500, usageOutput: 60 });
  assert.equal(lastStatus(h), '当轮 150 | 会话 150 tok/s | 已测 1/1');
  await h.emit({ type: 'message_end', message: finalMessage }); // 重复结束通知
  assert.equal(lastStatus(h), '当轮 150 | 会话 150 tok/s | 已测 1/1');
  h.persist(finalMessage);
  await h.emit({ type: 'turn_end', message: finalMessage });
  await h.emit({ type: 'turn_end', message: finalMessage });
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h), '当轮 150 | 会话 150 tok/s | 已测 1/1');
  assert.equal(h.fake.entries.length, 1);
});

test('boundary: 后续 message_end 扩展改写使 marker 无法配对——校准降级，不显示虚假精确已测', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  const finalMessage = await streamMeasured(h, { firstDeltaAt: 1_100, endAt: 1_500, usageOutput: 60 });
  // message_end 时扩展链中后续 handler 改写了消息：落盘版本与本扩展视图不一致
  const persisted = assistantMessage({
    content: [textPart('REWRITTEN BY LATER HANDLER')],
    usageOutput: 60,
  });
  h.persist(persisted);
  // 落盘前（prospective）可展示一次；落盘后校准必须与最终分支一致
  await h.emit({ type: 'turn_end', message: persisted });
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  await h.emit({ type: 'agent_settled', aborted: false });
  // marker 无法配对：不保留 measured/TPS 贡献；coverage=真实分支口径
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('boundary: 校准不清空/拆分当前 cycle，多响应重试累计保留', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });

  // 段 1（失败尝试）：100 估算 tokens / 400ms
  const failed = await streamMeasured(h, {
    text: 'x'.repeat(400),
    usageOutput: 0,
    stopReason: 'error',
    firstDeltaAt: 1_100,
    endAt: 1_500,
  });
  h.persist(failed);
  await h.emit({ type: 'turn_end', message: failed });
  assert.equal(lastStatus(h), '当轮 ~250 | 会话 ~250 tok/s | 已测 1/1');

  // 重试（同轮）：agent_start 幂等不清零；段 2 进行中时校准不得拆分当前 cycle
  h.clock.advance(100); // 1600
  await h.emit({ type: 'agent_start' });
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1700
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(200) },
  });
  h.clock.advance(300); // 2000：provisional（段 2 未结束）
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'y' },
  });
  // (100 估算 + 51 provisional 估算) / (400 + 300) ms ≈ 215.7 → ~216（live 一律 ~）
  assert.equal(lastStatus(h), '当轮 ~216 | 会话 ~216 tok/s | 已测 1/1');

  // 段 2 继续同一流至 message_end（不再发新的 message_start）
  h.clock.advance(500); // 2500
  const retried = assistantMessage({ content: [textPart('y'.repeat(201))], usageOutput: 30 });
  await h.emit({ type: 'message_end', message: retried });
  h.persist(retried);
  await h.emit({ type: 'turn_end', message: retried });
  // (100 + 30) tokens / (400 + 800) ms ≈ 108.3 → ~108（校准不双算、不丢段 1）
  assert.equal(lastStatus(h), '当轮 ~108 | 会话 ~108 tok/s | 已测 2/2');
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h), '当轮 ~108 | 会话 ~108 tok/s | 已测 2/2');
});

test('boundary: 工具长间隔中段间校准保持稳定，工具时间不进分母', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  const first = await streamMeasured(h, {
    text: 'a'.repeat(200),
    usageOutput: 60,
    stopReason: 'toolUse',
    firstDeltaAt: 1_100,
    endAt: 1_500,
  });
  h.persist(first);
  await h.emit({ type: 'turn_end', message: first });
  assert.equal(lastStatus(h), '当轮 150 | 会话 150 tok/s | 已测 1/1');

  // 工具执行 10s（含 toolResult 消息事件）：校准与闲置都不得影响统计
  const toolResult = { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [], usage: { output: 999 } };
  await h.emit({ type: 'message_start', message: toolResult });
  await h.emit({ type: 'message_end', message: toolResult });
  h.clock.advance(10_000); // 11500
  await h.emit({ type: 'turn_end', message: first });

  const second = await streamMeasured(h, {
    text: 'b'.repeat(200),
    usageOutput: 40,
    firstDeltaAt: 11_600,
    endAt: 12_000,
  });
  h.persist(second);
  await h.emit({ type: 'turn_end', message: second });
  await h.emit({ type: 'agent_settled', aborted: false });
  // (60+40) tokens / (400+400) ms = 125 tok/s；若含工具间隔会 ≈ 8.3
  assert.equal(lastStatus(h), '当轮 125 | 会话 125 tok/s | 已测 2/2');
});

test('boundary: 恢复历史 + 新 live 测量经校准不双算（restored/live 各计一次）', async () => {
  // 先在“旧运行时”生成一轮可配对历史
  const old = harness();
  await old.emit({ type: 'agent_start' });
  const oldFinal = await streamMeasured(old, { firstDeltaAt: 1_100, endAt: 1_500, usageOutput: 60 });
  old.persist(oldFinal);
  const branch = [...old.ctx.branch];

  // 新运行时 resume 后再测一轮
  const h = harness();
  h.ctx.branch.push(...branch);
  await h.emit({ type: 'session_start', reason: 'resume' });
  assert.equal(lastStatus(h), '当轮 -- | 会话 150 tok/s | 已测 1/1');
  await h.emit({ type: 'agent_start' });
  const fresh = await streamMeasured(h, { text: 'z'.repeat(200), firstDeltaAt: 2_000, endAt: 2_800, usageOutput: 40 });
  h.persist(fresh);
  await h.emit({ type: 'turn_end', message: fresh });
  // (60 + 40) / (400 + 800) ms ≈ 83.3；coverage 2/2
  assert.equal(lastStatus(h), '当轮 50 | 会话 83.3 tok/s | 已测 2/2');
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h), '当轮 50 | 会话 83.3 tok/s | 已测 2/2');
});

test('boundary: 代理对跨 delta 分块不改变回退估算（与整块一致）', async () => {
  const astralPlane = '\uD840\uDC00'.repeat(12); // 12 个 CJK 扩展 B 码点
  const wholeBlockEstimate = estimateTokens(astralPlane); // 整块口径：ceil(12/1.5)=8

  const split = harness();
  await split.emit({ type: 'agent_start' });
  await split.emit({ type: 'message_start', message: assistantMessage() });
  split.clock.advance(100);
  for (const unit of astralPlane) {
    await split.emit({
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: { type: 'text_delta', delta: unit },
    });
  }
  split.clock.advance(400);
  await split.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart(astralPlane)], usageOutput: 0 }),
  });
  const splitMarker = split.fake.entries[0].data as { estimatedTokens: number };

  const whole = harness();
  await whole.emit({ type: 'agent_start' });
  await whole.emit({ type: 'message_start', message: assistantMessage() });
  whole.clock.advance(100);
  await whole.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: astralPlane },
  });
  whole.clock.advance(400);
  await whole.emit({
    type: 'message_end',
    message: assistantMessage({ content: [textPart(astralPlane)], usageOutput: 0 }),
  });
  const wholeMarker = whole.fake.entries[0].data as { estimatedTokens: number };

  assert.equal(wholeBlockEstimate, 8);
  assert.equal(splitMarker.estimatedTokens, wholeBlockEstimate);
  assert.equal(wholeMarker.estimatedTokens, wholeBlockEstimate);
});

test('boundary: 序列化歧义反例（单块 "a|t:b" 被替换为两块）——turn_end 降级且 reload 保持 --、0/1', async () => {
  const h = harness();
  await h.emit({ type: 'agent_start' });
  // 本扩展在 message_end 观察到的最终消息：单块 "a|t:b"（usage 0 → 估算口径）
  await h.emit({ type: 'message_start', message: assistantMessage() });
  h.clock.advance(100); // 1100
  await h.emit({
    type: 'message_update',
    message: assistantMessage(),
    assistantMessageEvent: { type: 'text_delta', delta: 'a|t:b' },
  });
  h.clock.advance(400); // 1500
  const observed = assistantMessage({
    content: [textPart('a|t:b')],
    usageOutput: 0,
    stopReason: 'stop',
  });
  await h.emit({ type: 'message_end', message: observed });
  // v2 无歧义指纹下落盘前的 prospective 展示（2 估算 tokens / 400ms = 5 tok/s）
  assert.equal(lastStatus(h), '当轮 ~5 | 会话 ~5 tok/s | 已测 1/1');
  // 后续扩展替换后落盘的消息：两个文本块（旧 v1 编码会与此同指纹）
  const persisted = assistantMessage({
    content: [textPart('a'), textPart('b')],
    usageOutput: 0,
    stopReason: 'stop',
  });
  h.persist(persisted);
  await h.emit({ type: 'turn_end', message: persisted });
  // 指纹不同 → 校准降级：不显示虚假的精确已测贡献
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  await h.emit({ type: 'agent_settled', aborted: false });
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
  // reload 路径：marker 无法配对 → 保守拒配，仍为 --、0/1
  await h.emit({ type: 'session_start', reason: 'reload' });
  assert.equal(lastStatus(h), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

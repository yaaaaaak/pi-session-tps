// marker 写入与恢复配对测试：孤立/重复/非法 marker、指纹保守匹配、中间元数据、
// 非匹配消息作废、stopReason 映射、usage 回退（SPEC 契约 6）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_VERSION,
  assistantFingerprint,
  scanBranchForMeasurements,
} from '../../src/adapter/index.ts';
import type { MeasurementMarkerData, PiMessageLike, PiSessionEntryLike } from '../../src/adapter/index.ts';
import { assistantMessage, customMarkerEntry, messageEntry, metadataEntry, textPart } from './helpers.ts';
import type { SessionEntryFixture } from './helpers.ts';

const BASE = assistantMessage({
  content: [textPart('hello world')],
  usageOutput: 42,
  stopReason: 'stop',
  timestamp: 1_234_567,
  provider: 'anthropic',
  model: 'claude-test',
});

function buildMarker(overrides: Partial<MeasurementMarkerData> = {}, message: PiMessageLike = BASE): MeasurementMarkerData {
  return {
    v: MARKER_VERSION,
    roundId: 'r-1',
    segmentId: 's-1',
    generationMs: 1_000,
    estimatedTokens: 3,
    match: assistantFingerprint(message) as MeasurementMarkerData['match'],
    ...overrides,
  };
}

function userEntry(id: string): PiSessionEntryLike {
  return messageEntry(id, { role: 'user', content: 'hi', timestamp: 1 } as PiMessageLike);
}

test('marker: 与后续 assistant 一次性配对，provider usage 优先', () => {
  const scan = scanBranchForMeasurements([
    userEntry('u1'),
    customMarkerEntry('m1', buildMarker()),
    messageEntry('a1', BASE),
  ]);
  assert.equal(scan.totalAssistantEntries, 1);
  assert.equal(scan.records.length, 1);
  assert.deepEqual(scan.records[0], {
    segmentId: 's-1',
    roundId: 'r-1',
    tokens: 42,
    tokenSource: 'provider',
    generationMs: 1_000,
    outcome: 'completed',
  });
});

test('marker: 持久化 usage 非法时使用 marker 回退估算并标 estimate', () => {
  const noUsage = assistantMessage({ content: [textPart('hello world')], usageOutput: 0, stopReason: 'stop', timestamp: 1_234_567 });
  const scan = scanBranchForMeasurements([
    userEntry('u1'),
    customMarkerEntry('m1', buildMarker({}, BASE)),
    messageEntry('a1', noUsage),
  ]);
  // BASE 与 noUsage 指纹一致（usage 不参与指纹），但 usage.output=0 → 回退
  assert.equal(scan.records.length, 1);
  assert.equal(scan.records[0].tokens, 3);
  assert.equal(scan.records[0].tokenSource, 'estimate');
});

test('marker: 孤立 marker（分支叶为 marker 自身）不贡献、不算未存在响应', () => {
  const scan = scanBranchForMeasurements([userEntry('u1'), customMarkerEntry('m1', buildMarker())]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 0);
});

test('marker: marker 后遇非 assistant 消息则作废', () => {
  const scan = scanBranchForMeasurements([
    customMarkerEntry('m1', buildMarker()),
    userEntry('u1'),
    messageEntry('a1', BASE),
  ]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 1);
});

test('marker: 中间允许非消息元数据条目（model_change/custom/compaction 等）', () => {
  const foreignCustomEntry: SessionEntryFixture = { type: 'custom', id: 'x2', customType: 'other-extension', data: { a: 1 } };
  const scan = scanBranchForMeasurements([
    customMarkerEntry('m1', buildMarker()),
    metadataEntry('model_change', 'x1'),
    foreignCustomEntry,
    metadataEntry('compaction', 'x3'),
    messageEntry('a1', BASE),
  ]);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.totalAssistantEntries, 1);
});

test('marker: 其他扩展改写最终响应（指纹不一致）则作废', () => {
  const rewritten = assistantMessage({
    content: [textPart('REWRITTEN CONTENT')],
    usageOutput: 42,
    stopReason: 'stop',
    timestamp: 1_234_567,
  });
  const scan = scanBranchForMeasurements([
    customMarkerEntry('m1', buildMarker()),
    messageEntry('a1', rewritten),
  ]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 1);
});

test('marker: provider/model/timestamp/stopReason 任一不一致都作废', () => {
  for (const override of [
    { provider: 'openai' },
    { model: 'gpt-test' },
    { timestamp: 999 },
    { stopReason: 'toolUse' },
  ]) {
    const changed = assistantMessage({
      content: [textPart('hello world')],
      usageOutput: 42,
      stopReason: 'stop',
      timestamp: 1_234_567,
      ...override,
    });
    const scan = scanBranchForMeasurements([
      customMarkerEntry('m1', buildMarker()),
      messageEntry('a1', changed),
    ]);
    assert.equal(scan.records.length, 0, String(JSON.stringify(override)));
    assert.equal(scan.totalAssistantEntries, 1);
  }
});

test('marker: 连续重复 marker 只与最新一个配对一次', () => {
  const scan = scanBranchForMeasurements([
    customMarkerEntry('m1', buildMarker({ segmentId: 's-old' })),
    customMarkerEntry('m2', buildMarker({ segmentId: 's-new' })),
    messageEntry('a1', BASE),
  ]);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.records[0].segmentId, 's-new');
  assert.equal(scan.totalAssistantEntries, 1);
});

test('marker: 非法 marker（版本/时长/字段）不贡献', () => {
  for (const overrides of [
    { v: 99 },
    { generationMs: 0 },
    { generationMs: -5 },
    { generationMs: Number.NaN },
    { estimatedTokens: 0 },
    { estimatedTokens: 2.5 },
    { roundId: '' },
    { segmentId: '' },
    { match: { provider: 'x', model: 'y', timestamp: 1, stopReason: 'stop', contentHash: '' } },
  ]) {
    const scan = scanBranchForMeasurements([
      customMarkerEntry('m1', buildMarker(overrides as Partial<MeasurementMarkerData>)),
      messageEntry('a1', BASE),
    ]);
    assert.equal(scan.records.length, 0, String(JSON.stringify(overrides)));
    assert.equal(scan.totalAssistantEntries, 1);
  }
});

test('marker: 完全损坏的 marker 数据不贡献且不抛错', () => {
  for (const data of [undefined, null, 'junk', 42, [], {}]) {
    const scan = scanBranchForMeasurements([customMarkerEntry('m1', data), messageEntry('a1', BASE)]);
    assert.equal(scan.records.length, 0, String(String(data)));
    assert.equal(scan.totalAssistantEntries, 1);
  }
});

test('marker: stopReason 映射 error/aborted/toolUse', () => {
  for (const [stopReason, outcome] of [
    ['error', 'error'],
    ['aborted', 'aborted'],
    ['toolUse', 'completed'],
    ['length', 'completed'],
    ['deferred', 'completed'],
  ] as const) {
    const message = assistantMessage({
      content: [textPart('hello world')],
      usageOutput: 42,
      stopReason,
      timestamp: 1_234_567,
    });
    const scan = scanBranchForMeasurements([
      customMarkerEntry('m1', buildMarker({}, message)),
      messageEntry('a1', message),
    ]);
    assert.equal(scan.records[0]?.outcome, outcome, stopReason);
  }
  // 未知 stopReason：保守作废
  const unknown = assistantMessage({ content: [textPart('hello world')], usageOutput: 42, stopReason: 'weird', timestamp: 1_234_567 });
  assert.equal(scanBranchForMeasurements([customMarkerEntry('m1', buildMarker({}, unknown)), messageEntry('a1', unknown)]).records.length, 0);
});

test('marker: 无 marker 的旧历史只进 total，不进分子分母', () => {
  const old = assistantMessage({ content: [textPart('old')], usageOutput: 500, timestamp: 1 });
  const scan = scanBranchForMeasurements([userEntry('u1'), messageEntry('a1', old)]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 1);
});

test('marker: custom_message 出现在 marker 与 assistant 之间则作废', () => {
  const injectedCustomMessage: SessionEntryFixture = { type: 'custom_message', id: 'cm1', customType: 'ext', content: 'injected', display: true };
  const scan = scanBranchForMeasurements([
    customMarkerEntry('m1', buildMarker()),
    injectedCustomMessage,
    messageEntry('a1', BASE),
  ]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 1);
});

test('marker: 多轮 marker/assistant 顺序配对互不串扰', () => {
  const second = assistantMessage({
    content: [textPart('second')],
    usageOutput: 7,
    stopReason: 'stop',
    timestamp: 2_000,
  });
  const scan = scanBranchForMeasurements([
    userEntry('u1'),
    customMarkerEntry('m1', buildMarker({ roundId: 'r-1', segmentId: 's-1' })),
    messageEntry('a1', BASE),
    metadataEntry('context_edit', 'e1'),
    customMarkerEntry('m2', buildMarker({ roundId: 'r-2', segmentId: 's-2', generationMs: 250 }, second)),
    messageEntry('a2', second),
  ]);
  assert.equal(scan.totalAssistantEntries, 2);
  assert.equal(scan.records.length, 2);
  assert.deepEqual(
    scan.records.map((r) => [r.segmentId, r.tokens, r.generationMs]),
    [
      ['s-1', 42, 1_000],
      ['s-2', 7, 250],
    ],
  );
});

// ---- round-2 P1 回归：正文指纹结构无歧义序列化（v2 marker） ----

function fingerprintOf(content: Array<Record<string, unknown>>): string {
  return assistantFingerprint(
    assistantMessage({ content, usageOutput: 42, stopReason: 'stop', timestamp: 1_234_567 }),
  )?.contentHash as string;
}

test('marker: 序列化边界歧义反例——单块 "a|t:b" 与两块 "a","b" 指纹不同', () => {
  const one = fingerprintOf([{ type: 'text', text: 'a|t:b' }]);
  const two = fingerprintOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  assert.notEqual(one, two);
});

test('marker: 分隔符/引号/JSON结构内嵌与块数量不产生相同编码', () => {
  const base = fingerprintOf([{ type: 'text', text: 'plain' }]);
  const variants = [
    [{ type: 'text', text: 'plain|t:plain' }],
    [{ type: 'text', text: 'plain' }, { type: 'text', text: '' }],
    [{ type: 'text', text: 'plain", "type": "text", "text": "x' }],
    [{ type: 'text', text: "plain\\" }],
    [{ type: 'text', text: 'k:plain' }],
    [{ type: 'text', text: 'c::plain' }],
    [{ type: 'thinking', thinking: 'plain' }],
    [{ type: 'text', text: 'plain' }, { type: 'text', text: 'plain' }],
  ];
  for (const content of variants) {
    assert.notEqual(fingerprintOf(content as Array<Record<string, unknown>>), base);
  }
  // 任意两两互不相同
  const all = [base, ...variants.map((v) => fingerprintOf(v as Array<Record<string, unknown>>))];
  assert.equal(new Set(all).size, all.length);
});

test('marker: 工具参数键序稳定，不同键序同指纹；工具名/参数值不同则不同', () => {
  const argsA = { b: 1, a: { y: [1, 2], x: 's' } };
  const argsB = { a: { x: 's', y: [1, 2] }, b: 1 }; // 同对象不同插入序
  const call = (over: Record<string, unknown>) => [{ type: 'toolCall', id: 't1', ...over }];
  assert.equal(fingerprintOf(call({ name: 'bash', arguments: argsA })), fingerprintOf(call({ name: 'bash', arguments: argsB })));
  assert.notEqual(fingerprintOf(call({ name: 'bash', arguments: argsA })), fingerprintOf(call({ name: 'edit', arguments: argsA })));
  assert.notEqual(fingerprintOf(call({ name: 'bash', arguments: argsA })), fingerprintOf(call({ name: 'bash', arguments: { b: 1, a: { y: [1, 2], x: 't' } } })));
  // 参数对象边界：一个两键对象 ≠ 两个单键对象
  assert.notEqual(
    fingerprintOf(call({ name: 'bash', arguments: { p: '1|q:2' } })),
    fingerprintOf([{ type: 'toolCall', id: 't1', name: 'bash', arguments: { p: '1' } }, { type: 'toolCall', id: 't2', name: 'bash', arguments: { q: '2' } }]),
  );
});

test('marker: 未知块类型确定性纳入（两侧同形则可配对）', () => {
  const withUnknown = [{ type: 'futureBlock', payload: { z: 1 } }, { type: 'text', text: 'x' }];
  const message = assistantMessage({ content: withUnknown, usageOutput: 5, timestamp: 9_999 });
  const scan = scanBranchForMeasurements([
    customMarkerEntry('m1', buildMarker({}, message)),
    messageEntry('a1', message),
  ]);
  assert.equal(scan.records.length, 1);
});

test('marker: 歧义反例经 scanner 保守拒配（voided 归因）', () => {
  const observed = assistantMessage({
    content: [{ type: 'text', text: 'a|t:b' }],
    usageOutput: 0,
    stopReason: 'stop',
    timestamp: 4_242,
  });
  const rewritten = assistantMessage({
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    usageOutput: 0,
    stopReason: 'stop',
    timestamp: 4_242,
  });
  const scan = scanBranchForMeasurements([
    userEntry('u1'),
    customMarkerEntry('m1', buildMarker({ segmentId: 's-amb' }, observed)),
    messageEntry('a1', rewritten),
  ]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 1);
  assert.deepEqual(scan.voidedMarkerSegmentIds, ['s-amb']);
});

test('marker: 旧 v1 marker（歧义编码时代）保守不配对，只计未测历史', () => {
  const legacy = { ...buildMarker(), v: 1 };
  const scan = scanBranchForMeasurements([
    userEntry('u1'),
    customMarkerEntry('m1', legacy),
    messageEntry('a1', BASE),
  ]);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.totalAssistantEntries, 1);
  assert.deepEqual(scan.voidedMarkerSegmentIds, []);
});

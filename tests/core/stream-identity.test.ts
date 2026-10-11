import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTpsKernel } from '../../src/core/index.ts';
import type { DeltaParts } from '../../src/core/index.ts';

const ASTRAL = '\uD840\uDC00'; // U+20000（CJK Ext B）
const HIGH = ASTRAL.charAt(0);
const LOW = ASTRAL.charAt(1);
const TWELVE = ASTRAL.repeat(12);
const PREFIX = '{"x":"';
const SUFFIX = '"}';

function seededKernel(): SessionTpsKernel {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  return kernel;
}

/** 完整流过一组 delta（同刻 1000），endSegment 于 5000 后按内容估算结算。 */
function runDeltas(deltas: DeltaParts[]): { tokens: number; tps: number | null; estimated: boolean } {
  const kernel = seededKernel();
  for (const parts of deltas) {
    assert.equal(kernel.onDelta('s1', parts, 1_000), true);
  }
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  const stats = kernel.getRoundStats();
  return { tokens: record?.tokens ?? -1, tps: stats.tokensPerSecond, estimated: stats.estimated };
}

// ---- 回归：两条工具参数流交错（reviewer 反例） ----

test('stream: 两条工具 JSON 流按 A high/B high/A low/B low 交错，最终估算 20 且与顺序/整块一致', () => {
  const interleaved: DeltaParts[] = [
    { toolArguments: PREFIX, contentIndex: 0 },
    { toolArguments: PREFIX, contentIndex: 1 },
  ];
  for (let i = 0; i < 12; i += 1) {
    interleaved.push({ toolArguments: HIGH, contentIndex: 0 });
    interleaved.push({ toolArguments: HIGH, contentIndex: 1 });
    interleaved.push({ toolArguments: LOW, contentIndex: 0 });
    interleaved.push({ toolArguments: LOW, contentIndex: 1 });
  }
  interleaved.push({ toolArguments: SUFFIX, contentIndex: 0 });
  interleaved.push({ toolArguments: SUFFIX, contentIndex: 1 });

  // 顺序完成：A 整体完成后 B 整体完成
  const sequential: DeltaParts[] = [
    { toolArguments: PREFIX, contentIndex: 0 },
    ...Array.from({ length: 12 }, () => ({ toolArguments: ASTRAL, contentIndex: 0 })),
    { toolArguments: SUFFIX, contentIndex: 0 },
    { toolArguments: PREFIX, contentIndex: 1 },
    ...Array.from({ length: 12 }, () => ({ toolArguments: ASTRAL, contentIndex: 1 })),
    { toolArguments: SUFFIX, contentIndex: 1 },
  ];

  // 整块：每流单条完整合法 JSON
  const whole: DeltaParts[] = [
    { toolArguments: PREFIX + TWELVE + SUFFIX, contentIndex: 0 },
    { toolArguments: PREFIX + TWELVE + SUFFIX, contentIndex: 1 },
  ];

  // 16 plain + 24 cjk → 4 + 16 = 20（共享累加器的旧行为会得 18）
  const a = runDeltas(interleaved);
  const b = runDeltas(sequential);
  const c = runDeltas(whole);
  assert.equal(a.tokens, 20);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.ok(Math.abs((a.tps as number) - 5) < 1e-9); // 20 tokens / 4000ms
  assert.equal(a.estimated, true); // 结算走内容估算
});

test('stream: 交错过程中挂起状态按流隔离，不因另流 high 提前闭合', () => {
  const kernel = seededKernel();
  assert.equal(kernel.onDelta('s1', { toolArguments: PREFIX, contentIndex: 0 }, 1_000), true);
  assert.equal(kernel.onDelta('s1', { toolArguments: PREFIX, contentIndex: 1 }, 1_000), true);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(kernel.onDelta('s1', { toolArguments: HIGH, contentIndex: 0 }, 1_000), true);
    assert.equal(kernel.onDelta('s1', { toolArguments: HIGH, contentIndex: 1 }, 1_000), true);
    // 此时流 0 的 high 仍挂起，不得被流 1 的 high 闭合
    assert.equal(kernel.onDelta('s1', { toolArguments: LOW, contentIndex: 0 }, 1_000), true);
    assert.equal(kernel.onDelta('s1', { toolArguments: LOW, contentIndex: 1 }, 1_000), true);
  }
  // 已含两条 JSON 前缀（12 plain）+ 24 cjk → ceil(3 + 16) = 19；挂起状态均已成对闭合
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 19);
  assert.equal(kernel.onDelta('s1', { toolArguments: SUFFIX, contentIndex: 0 }, 1_000), true);
  assert.equal(kernel.onDelta('s1', { toolArguments: SUFFIX, contentIndex: 1 }, 1_000), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 20);
});

// ---- 同类 text / thinking 多流 ----

test('stream: 同类 text 两流交错与整块一致（3 tokens）', () => {
  const interleaved = runDeltas([
    { text: 'a\uD840', contentIndex: 0 },
    { text: 'c\uD840', contentIndex: 1 },
    { text: '\uDC00b', contentIndex: 0 },
    { text: '\uDC00d', contentIndex: 1 },
  ]);
  const whole = runDeltas([
    { text: 'a\uD840\uDC00b', contentIndex: 0 },
    { text: 'c\uD840\uDC00d', contentIndex: 1 },
  ]);
  // 每流 2 plain + 1 cjk → 合计 4 plain + 2 cjk → ceil(1 + 4/3) = 3
  assert.equal(interleaved.tokens, 3);
  assert.deepEqual(interleaved, whole);
});

test('stream: 同类 thinking 两流交错与整块一致', () => {
  const interleaved = runDeltas([
    { thinking: 'a\uD840', contentIndex: 0 },
    { thinking: 'c\uD840', contentIndex: 2 },
    { thinking: '\uDC00b', contentIndex: 0 },
    { thinking: '\uDC00d', contentIndex: 2 },
  ]);
  const whole = runDeltas([
    { thinking: 'a\uD840\uDC00b', contentIndex: 0 },
    { thinking: 'c\uD840\uDC00d', contentIndex: 2 },
  ]);
  assert.equal(interleaved.tokens, 3);
  assert.deepEqual(interleaved, whole);
});

// ---- 三类互不拼（即使 contentIndex 相同） ----

test('stream: 相同 contentIndex 的 text/thinking/toolArguments 仍互不拼接', () => {
  const kernel = seededKernel();
  assert.equal(kernel.onDelta('s1', { text: 'x\uD840', contentIndex: 0 }, 1_000), true);
  assert.equal(kernel.onDelta('s1', { thinking: '\uDC00y', contentIndex: 0 }, 1_000), true);
  assert.equal(kernel.onDelta('s1', { toolArguments: '你\uD840\uDC00好', contentIndex: 0 }, 1_000), true);
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  // 正确：4 plain（x、闭合 high、孤立 low、y）+ 3 cjk → 1 + 2 = 3 精确整数
  // 若跨类错误拼接（text high + thinking low）：2 plain + 4 cjk → 3.167 → 4
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 3);
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.equal(record?.tokens, 3);
});

// ---- 未配对闭合（带 contentIndex 的流） ----

test('stream: 带流身份的流末尾未配对 high 在结束时确定性闭合', () => {
  const kernel = seededKernel();
  assert.equal(kernel.onDelta('s1', { toolArguments: 'xxxx\uD83D', contentIndex: 1 }, 1_000), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 1); // 挂起不计入
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 2); // ceil(5/4)
});

// ---- 缺省 / 非法 contentIndex 政策 ----

test('stream: 缺省 contentIndex 保持旧调用语义（同类共享缺省流，内部可配对）', () => {
  const result = runDeltas([{ text: 'a\uD840' }, { text: '\uDC00b' }]);
  assert.equal(result.tokens, 2); // 2 plain + 1 cjk，与旧内核完全一致
});

test('stream: 非法 contentIndex 归入缺省流（确定性兼容）', () => {
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    const result = runDeltas([{ text: 'a\uD840' }, { text: '\uDC00b', contentIndex: bad }]);
    assert.equal(result.tokens, 2, `contentIndex=${String(bad)} 应归入缺省流并完成配对`);
  }
});

test('stream: contentIndex 0 是独立流，不与缺省流拼接', () => {
  const result = runDeltas([{ text: 'a\uD840' }, { text: '\uDC00b', contentIndex: 0 }]);
  // 缺省流：a + 闭合 high（2 plain）；流 0：孤立 low + b（2 plain）→ 4 plain → 1
  assert.equal(result.tokens, 1);
});

// ---- 统一汇总后单次 ceil ----

test('stream: 多流计数统一汇总后单次 ceil，不逐流 ceil', () => {
  const twoIndexed = runDeltas([
    { text: 'a', contentIndex: 0 },
    { text: 'b', contentIndex: 1 },
  ]);
  assert.equal(twoIndexed.tokens, 1); // ceil(2/4)，而非 1 + 1
  const mixed = runDeltas([{ text: 'a' }, { text: 'b', contentIndex: 3 }]);
  assert.equal(mixed.tokens, 1);
});

// ---- 正常单流回归 ----

test('stream: 带 contentIndex 的普通 ASCII/CJK 单流估算不变', () => {
  const ascii = runDeltas([{ text: 'x'.repeat(400), contentIndex: 7 }]);
  assert.equal(ascii.tokens, 100);
  const legacy = runDeltas([{ text: 'x'.repeat(400) }]);
  assert.equal(legacy.tokens, 100);
  const cjk = runDeltas([{ toolArguments: '你好世界', contentIndex: 0 }]);
  assert.equal(cjk.tokens, 3);
});

test('stream: 生成时钟与 contentIndex 无关（首非空 delta 启表）', () => {
  const kernel = seededKernel();
  assert.equal(kernel.onDelta('s1', { text: 'x'.repeat(400), contentIndex: 5 }, 2_000), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.firstDeltaAtMs, 2_000);
  assert.equal(kernel.onDelta('s1', { toolArguments: 'y'.repeat(400), contentIndex: 1 }, 3_000), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.firstDeltaAtMs, 2_000); // 不重置
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 6_000 }), true);
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 200);
  assert.equal(stats.generationMs, 4_000);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 50) < 1e-9);
});

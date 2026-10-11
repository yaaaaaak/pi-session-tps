import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionTpsKernel,
  appendChars,
  closePendingSurrogate,
  countChars,
  createCharAccumulator,
  estimateTokens,
} from '../../src/core/index.ts';

const ASTRAL = '\uD840\uDC00'; // U+20000（CJK Ext B，属 CJK 区段）

test('surrogate: estimateTokens 跨参数分块与整块一致（便捷函数分块不变）', () => {
  assert.equal(estimateTokens('a\uD840', '\uDC00b'), estimateTokens('a\uD840\uDC00b'));
  assert.equal(estimateTokens('a\uD840', '\uDC00b'), 2); // 2 plain + 1 cjk
});

test('surrogate: 逐 UTF-16 code unit 分块与整块一致（reviewer 反例）', () => {
  const whole = ASTRAL.repeat(12);
  assert.equal(estimateTokens(whole), 8); // 12 cjk → ceil(12/1.5)
  const perUnit = whole.split(''); // 24 个单 code unit chunk
  assert.equal(perUnit.length, 24);
  assert.equal(estimateTokens(...perUnit), 8); // 不能退化成 24 plain → 6
});

test('surrogate: 累加器跨 append 配对；close 前挂起项不计入', () => {
  const accumulator = createCharAccumulator();
  appendChars(accumulator, 'a\uD840');
  assert.equal(accumulator.pendingHighSurrogate, 0xd840);
  assert.deepEqual(
    { plainChars: accumulator.plainChars, cjkChars: accumulator.cjkChars },
    { plainChars: 1, cjkChars: 0 },
  );
  appendChars(accumulator, '\uDC00b');
  assert.equal(accumulator.pendingHighSurrogate, null);
  assert.deepEqual(
    { plainChars: accumulator.plainChars, cjkChars: accumulator.cjkChars },
    { plainChars: 2, cjkChars: 1 },
  );
});

test('surrogate: 流结束未配对 high surrogate 确定性计 1 plain', () => {
  const accumulator = createCharAccumulator();
  appendChars(accumulator, 'xxxx\uD83D');
  assert.deepEqual(
    { plainChars: accumulator.plainChars, cjkChars: accumulator.cjkChars },
    { plainChars: 4, cjkChars: 0 },
  );
  closePendingSurrogate(accumulator);
  assert.equal(accumulator.plainChars, 5);
  closePendingSurrogate(accumulator); // 幂等
  assert.equal(accumulator.plainChars, 5);
  assert.equal(estimateTokens('xxxx\uD83D'), 2); // ceil(5/4)
  assert.equal(countChars('xxxx\uD83D').plainChars, 5);
});

test('surrogate: 未配对 low surrogate 计 1 plain；挂起 high 其后非 low 立即闭合', () => {
  assert.equal(estimateTokens('\uDE00x'), 1); // 2 plain
  const accumulator = createCharAccumulator();
  appendChars(accumulator, '\uD83Da');
  // 挂起 high 后跟普通字符：high 闭合为 1 plain，a 另计
  assert.deepEqual(
    { plainChars: accumulator.plainChars, cjkChars: accumulator.cjkChars },
    { plainChars: 2, cjkChars: 0 },
  );
  assert.equal(accumulator.pendingHighSurrogate, null);
});

function kernelWithDeltas(
  deltas: Array<{ text?: string; thinking?: string; toolArguments?: string }>,
): SessionTpsKernel {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  let at = 1_000;
  for (const parts of deltas) {
    assert.equal(kernel.onDelta('s1', parts, at), true);
    at += 10;
  }
  return kernel;
}

test('surrogate: 内核同逻辑流跨 delta 配对，分块不变', () => {
  const split = kernelWithDeltas([{ text: '\uD840' }, { text: '\uDC00' }]);
  assert.equal(split.getSegmentMeasurement('s1')?.contentEstimateTokens, 1); // 1 cjk
  const whole = kernelWithDeltas([{ text: ASTRAL }]);
  assert.equal(whole.getSegmentMeasurement('s1')?.contentEstimateTokens, 1);

  const perUnit = kernelWithDeltas([...ASTRAL.repeat(12)].map((unit) => ({ text: unit })));
  assert.equal(perUnit.getSegmentMeasurement('s1')?.contentEstimateTokens, 8);
  const single = kernelWithDeltas([{ text: ASTRAL.repeat(12) }]);
  assert.equal(single.getSegmentMeasurement('s1')?.contentEstimateTokens, 8);
});

test('surrogate: text/thinking/toolArguments 逻辑流边界不拼接代理对', () => {
  // text 末尾 high + thinking 开头 low：不得拼成 U+20000
  const crossed = kernelWithDeltas([{ text: 'x\uD840' }, { thinking: '\uDC00y' }]);
  assert.equal(crossed.endSegment('s1', { outcome: 'completed', atMs: 9_000 }), true);
  // 正确：x + 未配对 high(1) + 未配对 low(1) + y = 4 plain → 1 token
  assert.equal(crossed.getSegmentMeasurement('s1')?.contentEstimateTokens, 1);
  // 对照：同一逻辑流内拼接会得到 2 plain + 1 cjk → 2 tokens
  const paired = kernelWithDeltas([{ text: 'x\uD840\uDC00y' }]);
  assert.equal(paired.endSegment('s1', { outcome: 'completed', atMs: 9_000 }), true);
  assert.equal(paired.getSegmentMeasurement('s1')?.contentEstimateTokens, 2);

  // text 末尾 high + toolArguments 开头 low：同样不得拼接
  const crossedTool = kernelWithDeltas([{ text: 'x\uD840' }, { toolArguments: '\uDC00y' }]);
  assert.equal(crossedTool.endSegment('s1', { outcome: 'completed', atMs: 9_000 }), true);
  assert.equal(crossedTool.getSegmentMeasurement('s1')?.contentEstimateTokens, 1);
});

test('surrogate: 流进行中挂起项不计入估算，endSegment 闭合后计入', () => {
  const kernel = kernelWithDeltas([{ text: 'xxxx\uD83D' }]);
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 1); // 4 plain
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 5_000 }), true);
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.equal(measurement?.contentEstimateTokens, 2); // 5 plain → ceil(5/4)
  // 结算走内容估算时使用闭合后的口径
  const record = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.equal(record?.tokens, 2);
});

test('surrogate: endSegmentUnmeasured 同样闭合挂起代理项', () => {
  const kernel = kernelWithDeltas([{ text: 'xxxx\uD83D' }]);
  assert.equal(kernel.endSegmentUnmeasured('s1', 'completed'), true);
  assert.equal(kernel.getSegmentMeasurement('s1')?.contentEstimateTokens, 2);
  assert.equal(kernel.getSegmentMeasurement('s1')?.unmeasured, true);
  // 未测响应：不进分子/分母
  assert.equal(kernel.getSessionStats().tokens, 0);
});

test('surrogate: 提前结算后 endSegment 补救路径按闭合后内容重算估算 tokens', () => {
  const kernel = new SessionTpsKernel();
  assert.equal(kernel.startRound('r1'), true);
  assert.equal(kernel.startSegment('s1'), true);
  assert.equal(kernel.onDelta('s1', { text: 'xxxx\uD83D' }, 1_000), true);
  const early = kernel.settleSegment({ segmentId: 's1', roundId: 'r1' });
  assert.equal(early?.tokens, 1); // 未闭合：4 plain
  assert.equal(kernel.endSegment('s1', { outcome: 'completed', atMs: 2_000 }), true);
  const measurement = kernel.getSegmentMeasurement('s1');
  assert.equal(measurement?.finalRecord?.tokens, 2); // 闭合后：5 plain
  assert.equal(measurement?.finalRecord?.generationMs, 1_000);
  const stats = kernel.getRoundStats();
  assert.equal(stats.tokens, 2);
  assert.ok(Math.abs((stats.tokensPerSecond as number) - 2) < 1e-9);
});

test('surrogate: 正常 ASCII/CJK 估算不受影响（回归）', () => {
  assert.equal(estimateTokens('x'.repeat(400)), 100);
  assert.equal(estimateTokens('你好世界'), 3);
  assert.deepEqual(countChars('a😀你'), { plainChars: 2, cjkChars: 1 });
});

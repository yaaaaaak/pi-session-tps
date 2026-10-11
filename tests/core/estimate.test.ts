import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CJK_CHARS_PER_TOKEN,
  PLAIN_CHARS_PER_TOKEN,
  countChars,
  estimateTokens,
  estimateTokensFromCounts,
  isCjkCodePoint,
} from '../../src/core/index.ts';

test('estimate: 空输入返回 0，不产生 token', () => {
  assert.equal(estimateTokens(), 0);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('', undefined, ''), 0);
  assert.equal(estimateTokensFromCounts({ plainChars: 0, cjkChars: 0 }), 0);
});

test('estimate: 纯 ASCII 按 PLAIN_CHARS_PER_TOKEN 向上取整', () => {
  assert.equal(PLAIN_CHARS_PER_TOKEN, 4);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('hello world'), 3); // 11 chars -> ceil(2.75)
  assert.equal(estimateTokens('x'.repeat(400)), 100);
});

test('estimate: CJK 按更短比率估算', () => {
  assert.equal(CJK_CHARS_PER_TOKEN, 1.5);
  assert.equal(estimateTokens('你'), 1);
  assert.equal(estimateTokens('你好'), 2); // ceil(2/1.5) = ceil(1.333)
  assert.equal(estimateTokens('你好世界'), 3); // ceil(4/1.5) = ceil(2.667)
});

test('estimate: 混合内容合并估算', () => {
  assert.equal(estimateTokens('ab你好'), 2); // ceil(2/4 + 2/1.5) = ceil(1.833)
});

test('estimate: 分块累计与一次性输入结果一致（禁止按 chunk/delta 次数计数）', () => {
  const whole = estimateTokens('abcdefghij', '你好世界');
  const split = estimateTokensFromCounts({
    plainChars:
      countChars('ab').plainChars +
      countChars('cdef').plainChars +
      countChars('ghij').plainChars,
    cjkChars: countChars('你好').cjkChars + countChars('世界').cjkChars,
  });
  assert.equal(whole, split);
  assert.equal(whole, 6); // ceil(10/4 + 4/1.5) = ceil(5.167)
  // 反例：相同内容拆成 2 个 delta 不能被计为 2 tokens
  assert.notEqual(estimateTokens('abcdefghij你好世界'), 2);
});

test('estimate: 确定性（同输入同输出）', () => {
  const sample = 'def add(a, b):\n    return a + b  # 你好';
  assert.equal(estimateTokens(sample), estimateTokens(sample));
});

test('estimate: countChars 按 Unicode 码点计数，代理对算一个字符', () => {
  const counts = countChars('a😀你');
  assert.equal(counts.plainChars, 2);
  assert.equal(counts.cjkChars, 1);
});

test('estimate: isCjkCodePoint 覆盖常见 CJK 区段', () => {
  for (const codePoint of [0x4e2d, 0x3042, 0x30a2, 0x30fb, 0xac00, 0xf900, 0xff21, 0x20000]) {
    assert.equal(isCjkCodePoint(codePoint), true, `0x${codePoint.toString(16)} 应为 CJK`);
  }
  for (const codePoint of [0x41, 0x20, 0x7e, 0x00e9, 0x1f600, 0x10000]) {
    assert.equal(isCjkCodePoint(codePoint), false, `0x${codePoint.toString(16)} 应为非 CJK`);
  }
});

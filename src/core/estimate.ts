// 确定性 token 估算：按累计可见内容（text/thinking/tool arguments）估算，
// 不按 delta/chunk 次数计数（SPEC 契约 3）。
// 无 tokenizer 依赖；采用固定字符比率启发式，纯函数、可复现。
//
// Unicode 口径（首轮边界澄清）：估算按 Unicode 码点计数；同一逻辑流内
// high/low surrogate 跨 delta/跨 append 拆分时，最终结果必须与整块输入一致。
// 因此计数通过 CharAccumulator 增量进行：末尾未配对 high surrogate 挂起，
// 待同流后续 append 配对；流结束时由 closePendingSurrogate 确定性闭合
// （计 1 个 plain 字符）。不同逻辑流（text/thinking/toolArguments）各自独立
// 累加，绝不跨流拼接出不存在的代理对。

export interface CharClassCounts {
  readonly plainChars: number;
  readonly cjkChars: number;
}

/** 增量字符计数器：pendingHighSurrogate 保存同逻辑流末尾未配对的 high surrogate。 */
export interface CharAccumulator {
  plainChars: number;
  cjkChars: number;
  pendingHighSurrogate: number | null;
}

/** 非中日韩字符的估算比率：约 4 字符 / token。 */
export const PLAIN_CHARS_PER_TOKEN = 4;

/** 中日韩字符的估算比率：约 1.5 字符 / token。 */
export const CJK_CHARS_PER_TOKEN = 1.5;

const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals / Kangxi / CJK Symbols（含假名标点区段起点）
  [0x3041, 0x33ff], // Hiragana / Katakana / CJK Compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd], // CJK Ext B+
  [0x30000, 0x3fffd],
];

export function isCjkCodePoint(codePoint: number): boolean {
  for (const [low, high] of CJK_RANGES) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function combineSurrogatePair(high: number, low: number): number {
  return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
}

function classifyCodePoint(accumulator: CharAccumulator, codePoint: number): void {
  if (isCjkCodePoint(codePoint)) accumulator.cjkChars += 1;
  else accumulator.plainChars += 1;
}

export function createCharAccumulator(): CharAccumulator {
  return { plainChars: 0, cjkChars: 0, pendingHighSurrogate: null };
}

/**
 * 向累加器追加一段文本（同一逻辑流的下一个 chunk）。
 * - 跨 append 的 high+low surrogate 配对为一个码点；
 * - 挂起 high 其后不是 low → 立即闭合为 1 plain；
 * - 未配对 low surrogate → 1 plain；
 * - 末尾 high surrogate 挂起，不立即计数（等待配对或 closePendingSurrogate）。
 */
export function appendChars(accumulator: CharAccumulator, text: string | undefined): void {
  if (accumulator == null || typeof text !== 'string' || text.length === 0) return;
  let i = 0;
  while (i < text.length) {
    const codeUnit = text.charCodeAt(i);
    if (accumulator.pendingHighSurrogate != null) {
      if (isLowSurrogate(codeUnit)) {
        classifyCodePoint(accumulator, combineSurrogatePair(accumulator.pendingHighSurrogate, codeUnit));
        accumulator.pendingHighSurrogate = null;
        i += 1;
        continue;
      }
      // 挂起的 high surrogate 未获配对：确定性闭合为 1 个 plain 字符
      accumulator.plainChars += 1;
      accumulator.pendingHighSurrogate = null;
      // 当前 codeUnit 继续按正常流程处理
    }
    if (isHighSurrogate(codeUnit)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (isLowSurrogate(next)) {
        classifyCodePoint(accumulator, combineSurrogatePair(codeUnit, next));
        i += 2;
        continue;
      }
      accumulator.pendingHighSurrogate = codeUnit;
      i += 1;
      continue;
    }
    if (isLowSurrogate(codeUnit)) {
      accumulator.plainChars += 1; // 未配对 low surrogate
      i += 1;
      continue;
    }
    classifyCodePoint(accumulator, codeUnit);
    i += 1;
  }
}

/** 流结束：仍挂起的 high surrogate 确定性计为 1 个 plain 字符。 */
export function closePendingSurrogate(accumulator: CharAccumulator): void {
  if (accumulator == null || accumulator.pendingHighSurrogate == null) return;
  accumulator.plainChars += 1;
  accumulator.pendingHighSurrogate = null;
}

/** 按码点统计单个字符串（末尾未配对代理项各计 1 plain；等价于 append 后立即 close）。 */
export function countChars(text: string): CharClassCounts {
  const accumulator = createCharAccumulator();
  appendChars(accumulator, text);
  closePendingSurrogate(accumulator);
  return { plainChars: accumulator.plainChars, cjkChars: accumulator.cjkChars };
}

export function estimateTokensFromCounts(counts: CharClassCounts): number {
  if (counts == null) return 0;
  const plain = typeof counts.plainChars === 'number' && counts.plainChars > 0 ? counts.plainChars : 0;
  const cjk = typeof counts.cjkChars === 'number' && counts.cjkChars > 0 ? counts.cjkChars : 0;
  const units = plain / PLAIN_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN;
  if (!(units > 0)) return 0;
  return Math.ceil(units);
}

/**
 * 便捷入口：把多个文本 chunk 视为同一逻辑流合并估算。
 * 分块（含 surrogate 跨参数拆分）与整块输入结果一致；末尾未配对代理项计 1 plain。
 * 注意：text/thinking/toolArguments 是不同逻辑流，请分别估算后自行相加，
 * 不要作为多个参数传入本函数（避免跨流拼出不存在的代理对）。
 */
export function estimateTokens(...texts: (string | undefined)[]): number {
  const accumulator = createCharAccumulator();
  for (const text of texts) {
    appendChars(accumulator, text);
  }
  closePendingSurrogate(accumulator);
  return estimateTokensFromCounts(accumulator);
}

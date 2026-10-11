// message_end 前置 measurement marker：写入、校验与恢复配对。
// 依据（本机 Pi 1.1.0 源码核查）：agent-session.js 的 _handleAgentEvent 先
// await 扩展 message_end 事件、后 sessionManager.appendMessage(event.message)，
// 因此 message_end 处理器内 pi.appendEntry() 的 marker 在持久化顺序上
// 恰好位于其 assistant 消息条目之前；恢复按 getBranch() 的原始分支扫描配对。
// marker 只存 version/roundId/segmentId/自测时长/回退估算/匹配指纹，不存正文。

import type { RestoredRecord, SegmentOutcome } from '../core/index.ts';
import type { PiMessageLike, PiSessionEntryLike } from './pi-types.ts';

export const MARKER_CUSTOM_TYPE = 'pi-session-tps.measurement';
/**
 * marker 数据版本。v2（round-2 起）：正文指纹改用带类型结构数组的稳定无歧义
 * 序列化（JSON 转义 + 键排序 + 长度无关的结构化编码），消除 v1 裸 `t:/k:/c:` 与
 * `|` 拼接的确定性歧义（如单块 `"a|t:b"` 与两块 `"a","b"` 同编码）。
 * 保守兼容政策：旧 v1 marker 一律不配对（不误识为新精确配对），只计入
 * coverage.total 的未测历史；不迁移、不重算旧指纹。
 */
export const MARKER_VERSION = 2;

/** marker 持久化的匹配指纹字段（不含运行时去重键）。 */
export interface MarkerMatchInfo {
  readonly provider: string;
  readonly model: string;
  readonly timestamp: number;
  readonly stopReason: string;
  /** 正文内容摘要（FNV-1a），不存正文本身；用于发现其他扩展改写最终响应。 */
  readonly contentHash: string;
}

/** 运行时 assistant 视图指纹：匹配字段 + 完整去重键。 */
export interface AssistantFingerprint extends MarkerMatchInfo {
  /** 完整去重键（同一消息重复 message_end 只处理一次）。 */
  readonly key: string;
}

/** pi.appendEntry 写入的数据形状。 */
export interface MeasurementMarkerData {
  readonly v: typeof MARKER_VERSION;
  readonly roundId: string;
  readonly segmentId: string;
  /** 自测生成时长（ms，正有限数；非法则恢复时不贡献）。 */
  readonly generationMs: number;
  /** 按累计可见内容的回退估算 tokens（正整数）。 */
  readonly estimatedTokens: number;
  /** 与后续 assistant 保守匹配的指纹（不存正文）。 */
  readonly match: MarkerMatchInfo;
}

/** 恢复扫描结果：records 交内核 restore；total 为当前分支直接 assistant 条目数。 */
export interface BranchScanResult {
  readonly records: readonly RestoredRecord[];
  readonly totalAssistantEntries: number;
  /**
   * 已被证伪（无法与后续 assistant 配对）的合法 marker 的 segmentId：
   * 仅用于持久化后校准（turn_end）时把对应 live 段降级为不贡献；
   * 扫描结束时仍未配对的孤立 marker（分支叶为 marker 自身等截断情形）不计入，
   * 避免在 assistant 尚未落盘的边界误伤。
   */
  readonly voidedMarkerSegmentIds: readonly string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** FNV-1a 32 位哈希（十六进制输出）；只用于变更检测，不做安全用途。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 键排序的稳定序列化，保证同一 arguments 对象不同键序得到同一指纹。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'undefined' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * assistant 正文的结构无歧义规范化（仅用于哈希，不持久化）：
 * 把 content 数组归一化为带类型的结构数组后做稳定序列化——JSON 字符串转义
 * 消除内嵌分隔符/引号/反斜杠歧义，数组位置保留块边界，toolCall.arguments
 * 键排序保证同对象不同插入顺序同编码；未知块类型确定性纳入而非丢弃。
 */
function canonicalContentParts(message: PiMessageLike): unknown[] {
  const parts: unknown[] = [];
  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item == null || typeof item !== 'object') {
        parts.push({ type: 'invalid', raw: stableStringify(item) });
        continue;
      }
      const part = item as { type?: unknown };
      if (part.type === 'text') {
        parts.push({ type: 'text', text: String((item as { text?: unknown }).text ?? '') });
      } else if (part.type === 'thinking') {
        parts.push({ type: 'thinking', thinking: String((item as { thinking?: unknown }).thinking ?? '') });
      } else if (part.type === 'toolCall') {
        const call = item as { id?: unknown; name?: unknown; arguments?: unknown };
        parts.push({
          type: 'toolCall',
          id: String(call.id ?? ''),
          name: String(call.name ?? ''),
          arguments: stableStringify(call.arguments),
        });
      } else {
        parts.push({ type: String(part.type), raw: stableStringify(item) });
      }
    }
  }
  return parts;
}

/**
 * 读取 assistant 消息的匹配指纹。字段缺失/类型非法时返回 null（保守：不匹配）。
 */
export function assistantFingerprint(message: PiMessageLike | undefined): AssistantFingerprint | null {
  if (message == null || typeof message !== 'object' || message.role !== 'assistant') return null;
  if (!isNonEmptyString(message.provider) || !isNonEmptyString(message.model)) return null;
  if (!isFiniteNumber(message.timestamp)) return null;
  if (!isNonEmptyString(message.stopReason)) return null;
  // 哈希输入为单个稳定序列化的五元素数组（元数据 + 规范化块数组）：
  // 结构化 JSON 编码保证不同块数量/内嵌分隔符/参数对象边界不产生相同编码。
  const contentHash = fnv1a(
    stableStringify([
      message.provider,
      message.model,
      message.timestamp,
      message.stopReason,
      canonicalContentParts(message),
    ]),
  );
  const prefix = `${message.provider}|${message.model}|${message.timestamp}|${message.stopReason}`;
  return {
    provider: message.provider,
    model: message.model,
    timestamp: message.timestamp,
    stopReason: message.stopReason,
    contentHash,
    key: `${prefix}||${contentHash}`,
  };
}

/** 最终 usage.output：仅接受有限正整数（零值/缺失/非法一律视为不可用）。 */
export function readUsageOutput(message: PiMessageLike | undefined): number | null {
  const output = message?.usage?.output;
  return typeof output === 'number' && Number.isFinite(output) && Number.isInteger(output) && output > 0
    ? output
    : null;
}

/** stopReason → 段结局；未知值返回 null（保守：恢复配对作废）。 */
export function stopReasonToOutcome(stopReason: unknown): SegmentOutcome | null {
  if (stopReason === 'aborted') return 'aborted';
  if (stopReason === 'error') return 'error';
  if (stopReason === 'stop' || stopReason === 'length' || stopReason === 'toolUse' || stopReason === 'deferred') {
    return 'completed';
  }
  return null;
}

function fingerprintsMatch(a: MarkerMatchInfo, b: MarkerMatchInfo): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.timestamp === b.timestamp &&
    a.stopReason === b.stopReason &&
    a.contentHash === b.contentHash
  );
}

/** 校验 marker 数据（孤立/重复/非法 marker 在扫描时不贡献）。 */
export function parseMeasurementMarker(data: unknown): MeasurementMarkerData | null {
  if (data == null || typeof data !== 'object') return null;
  const candidate = data as Partial<MeasurementMarkerData> & { match?: Partial<MarkerMatchInfo> };
  if (candidate.v !== MARKER_VERSION) return null;
  if (!isNonEmptyString(candidate.roundId) || !isNonEmptyString(candidate.segmentId)) return null;
  if (!isFiniteNumber(candidate.generationMs) || candidate.generationMs <= 0) return null;
  if (
    typeof candidate.estimatedTokens !== 'number' ||
    !Number.isInteger(candidate.estimatedTokens) ||
    candidate.estimatedTokens <= 0
  ) {
    return null;
  }
  const match = candidate.match;
  if (
    match == null ||
    typeof match !== 'object' ||
    !isNonEmptyString(match.provider) ||
    !isNonEmptyString(match.model) ||
    !isFiniteNumber(match.timestamp) ||
    !isNonEmptyString(match.stopReason) ||
    !isNonEmptyString(match.contentHash)
  ) {
    return null;
  }
  return {
    v: MARKER_VERSION,
    roundId: candidate.roundId,
    segmentId: candidate.segmentId,
    generationMs: candidate.generationMs,
    estimatedTokens: candidate.estimatedTokens,
    match: {
      provider: match.provider,
      model: match.model,
      timestamp: match.timestamp,
      stopReason: match.stopReason,
      contentHash: match.contentHash,
    },
  };
}

/**
 * 扫描当前分支（getBranch() 的原始条目，不扣 context_edit）：
 * - marker 与其后首个 assistant 消息一次性配对；中间允许非消息元数据条目；
 * - 遇不匹配的消息（其他角色 message / custom_message）或指纹不一致则作废 marker；
 * - 孤立（含导航到 marker 自身）、重复、非法 marker 不贡献；
 * - totalAssistantEntries 统计分支内全部直接 assistant 条目（含未测历史）。
 */
export function scanBranchForMeasurements(entries: readonly PiSessionEntryLike[]): BranchScanResult {
  const records: RestoredRecord[] = [];
  const voidedMarkerSegmentIds: string[] = [];
  let totalAssistantEntries = 0;
  let pending: MeasurementMarkerData | null = null;

  /** 待配对 marker 被证伪：记入 voided 清单供校准降级。 */
  const voidPending = (): void => {
    if (pending != null) voidedMarkerSegmentIds.push(pending.segmentId);
    pending = null;
  };

  for (const entry of entries) {
    if (entry == null || typeof entry !== 'object') continue;
    if (entry.type === 'custom') {
      if (entry.customType === MARKER_CUSTOM_TYPE) {
        // 连续两个 marker：前一个被取代（含后被非法 marker 顶替），只保留最新一个等待配对。
        voidPending();
        pending = parseMeasurementMarker(entry.data);
      }
      continue; // 其他 custom 条目属于允许的中间元数据。
    }
    if (entry.type === 'custom_message') {
      // 参与模型上下文的消息类条目：视为不匹配的消息，作废待配对 marker。
      voidPending();
      continue;
    }
    if (entry.type !== 'message') continue; // 其余类型为非消息元数据，允许存在于中间。

    const message = entry.message;
    if (message == null || typeof message !== 'object' || message.role !== 'assistant') {
      voidPending(); // 不匹配的消息（user/toolResult 等）作废 marker。
      continue;
    }
    totalAssistantEntries += 1;
    if (pending == null) continue; // 未测历史：只进 total。

    const marker = pending;
    pending = null;
    const fingerprint = assistantFingerprint(message);
    const outcome = stopReasonToOutcome(message.stopReason);
    if (fingerprint == null || outcome == null || !fingerprintsMatch(fingerprint, marker.match)) {
      voidedMarkerSegmentIds.push(marker.segmentId);
      continue;
    }

    const providerOutput = readUsageOutput(message);
    records.push({
      segmentId: marker.segmentId,
      roundId: marker.roundId,
      tokens: providerOutput ?? marker.estimatedTokens,
      tokenSource: providerOutput != null ? 'provider' : 'estimate',
      generationMs: marker.generationMs,
      outcome,
    });
  }

  // 扫描结束时仍待配对的 marker（含分支叶就是 marker 自身的导航）为孤立 marker，不贡献；
  // 不计入 voided：该情形多见于截断/导航，无法区分“assistant 尚未落盘”。
  return { records, totalAssistantEntries, voidedMarkerSegmentIds };
}

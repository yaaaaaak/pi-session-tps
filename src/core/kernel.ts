// Pi Session TPS — 纯统计内核（round/segment 状态机 + 会话聚合 + 恢复）。
// 约束（SPEC 已批准契约 + 首轮边界澄清）：
// - 零 Pi 依赖；所有时间由调用方以 atMs/nowMs 注入，内核不启动真实时钟/计时器。
// - 当轮 = 首 agent_start→agent_settled 周期；轮内重复 startRound 幂等不清零；
//   settleRound 后保留最近一轮统计供显示。
// - 段 = 一条直接 assistant 响应；生成时长 = 首个非空 delta → message_end/取消时刻，
//   含流内停顿，天然排除 TTFT/工具执行/用户闲置/重试退避。
// - tokens：最终合法 provider usage.output 优先；零值/缺失/非法时按累计内容确定性
//   估算并标 estimate；provisional（实时）值一律视为估算（~）。
// - 聚合 = 贡献段 tokens 总和 / 正的自测 generationMs 总和；final 替换 provisional，
//   不重复累计；零/非法时长不进分子也不进分母。
// - 内容估算按 Unicode 码点口径：按（类别 text/thinking/toolArguments × 逻辑流
//   contentIndex）隔离增量累计（同流跨 delta 的 surrogate 配对，不跨流拼接；
//   缺省/非法 contentIndex 归入该类别 legacy 缺省流），流结束时全部闭合，
//   统一汇总 plain/cjk 计数后单次 ceil，不逐流 ceil 引入偏差。
// - coverage：total 以真实分支 assistant 条目/有效配对为准；ended 流本身不发明
//   paired 实测（measured 只来自合法正时长且 tokens>0 的 final/恢复记录）。
//   防御性关闭且无真实 assistant 的段用 discardSegment 丢弃（不进 TPS/coverage）；
//   真实 message_end 但缺完整观测起点的响应用 endSegmentUnmeasured 计为未测条目；
//   持久化边界用 calibrateCoverage 按分支扫描结果校准，不清空活动轮/既有段，
//   restored 与 live 不双算；合法配对记录按落盘最终 usage 替换同段 final 的
//   tokens/tokenSource（不追加、不留过时值），保留合法自测窗口与拒算标志。
// - 恢复（restore）：整体重建当前分支状态，记录按 (roundId, segmentId) 去重，
//   非法记录不贡献；未测历史只进 coverage.total。

import type {
  CalibrateSummary,
  Coverage,
  DeltaParts,
  FinalSegmentRecord,
  RestoreInput,
  RestoreSummary,
  RoundId,
  RoundStats,
  SegmentEndInput,
  SegmentId,
  SegmentMeasurement,
  SegmentOutcome,
  SessionStats,
  SettleSegmentInput,
  StatsQuery,
  TokenSource,
  TpsStats,
} from './types.ts';
import {
  appendChars,
  closePendingSurrogate,
  createCharAccumulator,
  estimateTokensFromCounts,
} from './estimate.ts';
import type { CharAccumulator, CharClassCounts } from './estimate.ts';

/**
 * 一个类别内的逻辑流集合：缺省（legacy、未提供/非法 contentIndex）共享一个累加器，
 * 每个合法 contentIndex 独立一个累加器；各流之间不拼接代理对。
 */
interface CategoryStreams {
  readonly default: CharAccumulator;
  readonly indexed: Map<number, CharAccumulator>;
}

/** text/thinking/toolArguments 三个类别各自维护逻辑流集合。 */
interface ContentStreams {
  readonly text: CategoryStreams;
  readonly thinking: CategoryStreams;
  readonly toolArguments: CategoryStreams;
}

interface SegmentState {
  readonly segmentId: SegmentId;
  readonly roundId: RoundId;
  readonly restored: boolean;
  ended: boolean;
  endedAtMs: number | null;
  firstDeltaAtMs: number | null;
  outcome: SegmentOutcome | null;
  readonly content: ContentStreams;
  providerOutputTokens: number | null;
  finalRecord: FinalSegmentRecord | null;
  /** 防御性关闭且无真实 assistant 落盘：不进 TPS/coverage（首轮边界澄清）。 */
  discarded: boolean;
  /** 真实 message_end 但缺完整观测起点：只进 coverage.total，不进任何分子/分母。 */
  unmeasured: boolean;
}

interface RoundState {
  readonly roundId: RoundId;
  settled: boolean;
  readonly segments: Map<SegmentId, SegmentState>;
}

interface Contribution {
  readonly tokens: number;
  readonly generationMs: number;
  readonly estimated: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** 合法 token 计数：有限正整数（provider usage 与估算结果均应满足）。 */
function isValidTokenCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSegmentOutcome(value: unknown): value is SegmentOutcome {
  return value === 'completed' || value === 'aborted' || value === 'error';
}

function isTokenSource(value: unknown): value is TokenSource {
  return value === 'provider' || value === 'estimate';
}

/** 纯函数：tokens/generationMs → tok/s；任一非法或结果非有限时返回 null（显示 `--`）。 */
export function computeTokensPerSecond(tokens: number, generationMs: number): number | null {
  if (!isValidTokenCount(tokens) || !isPositiveFinite(generationMs)) return null;
  const tokensPerSecond = (tokens * 1000) / generationMs;
  return Number.isFinite(tokensPerSecond) ? tokensPerSecond : null;
}

function restoredKey(roundId: RoundId, segmentId: SegmentId): string {
  return `${roundId}::${segmentId}`;
}

function createCategoryStreams(): CategoryStreams {
  return { default: createCharAccumulator(), indexed: new Map() };
}

function createContentStreams(): ContentStreams {
  return {
    text: createCategoryStreams(),
    thinking: createCategoryStreams(),
    toolArguments: createCategoryStreams(),
  };
}

/** contentIndex 合法性：有限非负整数；缺省/非法返回 undefined（归入缺省流）。 */
function normalizeContentIndex(value: unknown): number | undefined {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function resolveStream(category: CategoryStreams, contentIndex: number | undefined): CharAccumulator {
  if (contentIndex == null) return category.default;
  let accumulator = category.indexed.get(contentIndex);
  if (accumulator == null) {
    accumulator = createCharAccumulator();
    category.indexed.set(contentIndex, accumulator);
  }
  return accumulator;
}

/** 流结束：所有逻辑流的未配对 high surrogate 全部确定性闭合（各计 1 plain）。 */
function closeCategoryStreams(category: CategoryStreams): void {
  closePendingSurrogate(category.default);
  for (const accumulator of category.indexed.values()) {
    closePendingSurrogate(accumulator);
  }
}

function closeContentStreams(content: ContentStreams): void {
  closeCategoryStreams(content.text);
  closeCategoryStreams(content.thinking);
  closeCategoryStreams(content.toolArguments);
}

function categoryCounts(category: CategoryStreams): CharClassCounts {
  let plainChars = category.default.plainChars;
  let cjkChars = category.default.cjkChars;
  for (const accumulator of category.indexed.values()) {
    plainChars += accumulator.plainChars;
    cjkChars += accumulator.cjkChars;
  }
  return { plainChars, cjkChars };
}

/** 所有类别、所有逻辑流的计数统一汇总（之后才做单次 ceil，不逐流 ceil 引入偏差）。 */
function contentCounts(content: ContentStreams): CharClassCounts {
  const text = categoryCounts(content.text);
  const thinking = categoryCounts(content.thinking);
  const toolArguments = categoryCounts(content.toolArguments);
  return {
    plainChars: text.plainChars + thinking.plainChars + toolArguments.plainChars,
    cjkChars: text.cjkChars + thinking.cjkChars + toolArguments.cjkChars,
  };
}

function contentEstimate(segment: SegmentState): number {
  return estimateTokensFromCounts(contentCounts(segment.content));
}

/** 自测生成时长：首个非空 delta → 结束时刻；未结束/缺时刻/非正值为 0（不贡献）。 */
function measuredGenerationMs(segment: SegmentState): number {
  if (!segment.ended || segment.endedAtMs == null || segment.firstDeltaAtMs == null) return 0;
  const diff = segment.endedAtMs - segment.firstDeltaAtMs;
  return isPositiveFinite(diff) ? diff : 0;
}

/** provisional tokens：可用 provider 累计值优先，否则按累计内容估算（不含未闭合代理项）。 */
function provisionalTokens(segment: SegmentState): number | null {
  if (segment.finalRecord != null) return null;
  if (segment.providerOutputTokens != null && isValidTokenCount(segment.providerOutputTokens)) {
    return segment.providerOutputTokens;
  }
  const estimated = contentEstimate(segment);
  return estimated > 0 ? estimated : null;
}

/**
 * 单段贡献解析：discard/unmeasured 一律不贡献；final 优先且一经采用不再看
 * provisional（live 与 final 不双算）；provisional 仅在有正时长（已结束用 endedAt，
 * 进行中用注入的 nowMs）且 tokens 可得时贡献，且一律标记 estimated=true。
 */
function segmentContribution(segment: SegmentState, nowMs: number | undefined): Contribution | null {
  if (segment.discarded || segment.unmeasured) return null;
  const final = segment.finalRecord;
  if (final != null) {
    if (isPositiveFinite(final.generationMs) && isValidTokenCount(final.tokens)) {
      return {
        tokens: final.tokens,
        generationMs: final.generationMs,
        estimated: final.tokenSource === 'estimate',
      };
    }
    return null;
  }
  if (segment.firstDeltaAtMs == null) return null;
  let generationMs: number | null = null;
  if (segment.ended) {
    generationMs = segment.endedAtMs != null ? segment.endedAtMs - segment.firstDeltaAtMs : null;
  } else if (isFiniteNumber(nowMs)) {
    generationMs = nowMs - segment.firstDeltaAtMs;
  }
  if (generationMs == null || !isPositiveFinite(generationMs)) return null;
  const tokens = provisionalTokens(segment);
  if (tokens == null) return null;
  return { tokens, generationMs, estimated: true };
}

function aggregateContributions(contributions: Contribution[]): TpsStats {
  let tokens = 0;
  let generationMs = 0;
  let estimated = false;
  for (const contribution of contributions) {
    tokens += contribution.tokens;
    generationMs += contribution.generationMs;
    if (contribution.estimated) estimated = true;
  }
  return {
    tokensPerSecond: computeTokensPerSecond(tokens, generationMs),
    tokens,
    generationMs,
    estimated,
    contributingSegments: contributions.length,
  };
}

function isValidRestoredRecord(record: unknown): record is FinalSegmentRecord {
  if (record == null || typeof record !== 'object') return false;
  const candidate = record as Partial<FinalSegmentRecord>;
  return (
    isNonEmptyString(candidate.roundId) &&
    isNonEmptyString(candidate.segmentId) &&
    isValidTokenCount(candidate.tokens) &&
    isTokenSource(candidate.tokenSource) &&
    isPositiveFinite(candidate.generationMs) &&
    isSegmentOutcome(candidate.outcome)
  );
}

function makeRestoredSegment(record: FinalSegmentRecord): SegmentState {
  return {
    segmentId: record.segmentId,
    roundId: record.roundId,
    restored: true,
    ended: true,
    endedAtMs: null,
    firstDeltaAtMs: null,
    outcome: record.outcome,
    content: createContentStreams(),
    providerOutputTokens: null,
    finalRecord: record,
    discarded: false,
    unmeasured: false,
  };
}

export class SessionTpsKernel {
  private readonly rounds = new Map<RoundId, RoundState>();
  private readonly liveSegments = new Map<SegmentId, SegmentState>();
  private restoredSegments = new Map<string, SegmentState>();
  private currentRoundId: RoundId | null = null;
  private baseTotalAssistantEntries = 0;
  /** calibrateCoverage 时刻已结束（未丢弃）的 live 段数：此后 total 增量按超出部分计。 */
  private liveEndedBaseline = 0;

  // ---- 轮生命周期（agent_start / agent_settled） ----

  /**
   * 开始一轮。活动轮内重复调用幂等不清零（同 roundId 返回 true）；
   * 活动轮内传入不同 roundId 被拒绝（自动重试/compaction continuation 属同一周期）；
   * 复用已 settled 的 roundId 被拒绝（适配层应为每个周期提供新 id）。
   */
  startRound(roundId: RoundId): boolean {
    if (!isNonEmptyString(roundId)) return false;
    if (this.currentRoundId != null) {
      const current = this.rounds.get(this.currentRoundId);
      if (current != null && !current.settled) {
        return current.roundId === roundId;
      }
    }
    if (this.rounds.has(roundId)) return false;
    this.rounds.set(roundId, { roundId, settled: false, segments: new Map() });
    this.currentRoundId = roundId;
    return true;
  }

  /** 结束当前轮（agent_settled）。幂等；之后 getRoundStats 保留该轮值。 */
  settleRound(): boolean {
    if (this.currentRoundId == null) return false;
    const current = this.rounds.get(this.currentRoundId);
    if (current == null || current.settled) return false;
    current.settled = true;
    return true;
  }

  // ---- 段生命周期（每条直接 assistant 响应） ----

  /**
   * 注册一个段。需要活动轮；segmentId 在整个会话历史内必须唯一
   * （建议用 Pi message id）；重复注册幂等（已丢弃的段不可复用，返回 false）。
   * roundId 为可选校验参数。
   */
  startSegment(segmentId: SegmentId, roundId?: RoundId): boolean {
    if (!isNonEmptyString(segmentId)) return false;
    const existing = this.liveSegments.get(segmentId);
    if (existing != null) {
      if (existing.discarded) return false;
      return roundId == null || existing.roundId === roundId;
    }
    if (this.currentRoundId == null) return false;
    const round = this.rounds.get(this.currentRoundId);
    if (round == null || round.settled) return false;
    if (roundId != null && roundId !== round.roundId) return false;
    const segment: SegmentState = {
      segmentId,
      roundId: round.roundId,
      restored: false,
      ended: false,
      endedAtMs: null,
      firstDeltaAtMs: null,
      outcome: null,
      content: createContentStreams(),
      providerOutputTokens: null,
      finalRecord: null,
      discarded: false,
      unmeasured: false,
    };
    round.segments.set(segmentId, segment);
    this.liveSegments.set(segmentId, segment);
    return true;
  }

  /**
   * 记录一条可见内容 delta：按（类别 × parts.contentIndex）隔离的逻辑流分别累计，
   * 同流跨 delta 的 surrogate 会配对，不同流/不同类别不拼接；contentIndex 缺省或
   * 非法（非有限非负整数）时归入该类别的缺省（legacy）流。
   * 首个非空 delta 以合法有限 atMs 启动生成时钟；空 delta 不启动时钟；
   * atMs 非法时内容仍累计但时钟不启动。已结束/已丢弃的段忽略后续 delta。
   */
  onDelta(segmentId: SegmentId, parts: DeltaParts | undefined, atMs: number): boolean {
    const segment = this.liveSegments.get(segmentId);
    if (segment == null || segment.restored || segment.ended || segment.discarded) return false;
    const contentIndex = normalizeContentIndex(parts?.contentIndex);
    let hadContent = false;
    if (typeof parts?.text === 'string' && parts.text.length > 0) {
      appendChars(resolveStream(segment.content.text, contentIndex), parts.text);
      hadContent = true;
    }
    if (typeof parts?.thinking === 'string' && parts.thinking.length > 0) {
      appendChars(resolveStream(segment.content.thinking, contentIndex), parts.thinking);
      hadContent = true;
    }
    if (typeof parts?.toolArguments === 'string' && parts.toolArguments.length > 0) {
      appendChars(resolveStream(segment.content.toolArguments, contentIndex), parts.toolArguments);
      hadContent = true;
    }
    if (!hadContent) return false;
    if (segment.firstDeltaAtMs == null && isFiniteNumber(atMs)) {
      segment.firstDeltaAtMs = atMs;
    }
    return true;
  }

  /**
   * 记录供应商流内累计 output tokens（provisional）。仅接受有限正整数且
   * 单调递增的值；段已结算或已丢弃后忽略。
   */
  onProviderUsage(segmentId: SegmentId, outputTokens: number): boolean {
    const segment = this.liveSegments.get(segmentId);
    if (segment == null || segment.restored || segment.discarded || segment.finalRecord != null) {
      return false;
    }
    if (!isValidTokenCount(outputTokens)) return false;
    if (segment.providerOutputTokens != null && outputTokens <= segment.providerOutputTokens) {
      return false;
    }
    segment.providerOutputTokens = outputTokens;
    return true;
  }

  /**
   * 结束一段生成（message_end / 取消 / 出错）。首次生效，重复调用幂等
   * （重复结束通知不制造多个响应）。结束时闭合各逻辑流未配对的代理项。
   * 若适配层曾提前结算（时长为 0 的 final），此处补齐自测时长与结局；
   * estimate 来源的 tokens 按闭合后内容重算，provider 来源不改动，tokens 不重复累计。
   */
  endSegment(segmentId: SegmentId, input: SegmentEndInput): boolean {
    const segment = this.liveSegments.get(segmentId);
    if (segment == null || segment.restored || segment.ended || segment.discarded) return false;
    if (!isSegmentOutcome(input?.outcome)) return false;
    segment.ended = true;
    segment.outcome = input.outcome;
    segment.endedAtMs = isFiniteNumber(input.atMs) ? input.atMs : null;
    closeContentStreams(segment.content);
    const final = segment.finalRecord;
    if (final != null && !isPositiveFinite(final.generationMs)) {
      const recomputedTokens =
        final.tokenSource === 'estimate' ? contentEstimate(segment) : final.tokens;
      segment.finalRecord = {
        ...final,
        tokens: recomputedTokens,
        generationMs: measuredGenerationMs(segment),
        outcome: input.outcome,
      };
    }
    return true;
  }

  /**
   * 真实 message_end 但缺完整观测起点（未见 message_start/首个非空 delta）：
   * 保守拒算——清除时钟起点、闭合代理项、标记 unmeasured。
   * 该段只进 coverage.total（未测响应），不进任何 TPS 分子/分母/measured，
   * 即便之后 settleSegment 提供了完整 provider usage 也不 resurrect。
   */
  endSegmentUnmeasured(segmentId: SegmentId, outcome: SegmentOutcome): boolean {
    const segment = this.liveSegments.get(segmentId);
    if (segment == null || segment.restored || segment.ended || segment.discarded) return false;
    if (!isSegmentOutcome(outcome)) return false;
    segment.ended = true;
    segment.outcome = outcome;
    segment.endedAtMs = null;
    segment.firstDeltaAtMs = null;
    segment.unmeasured = true;
    closeContentStreams(segment.content);
    return true;
  }

  /**
   * 丢弃防御性关闭且无对应真实 assistant 落盘的段（被新消息/异常/生命周期边界打断）：
   * 不贡献 final/provisional TPS，不进 coverage（total 与 measured 都不加），
   * getSegmentMeasurement 返回 null。幂等；仅作用于本实例 live 段。
   */
  discardSegment(segmentId: SegmentId, roundId?: RoundId): boolean {
    const segment = this.liveSegments.get(segmentId);
    if (segment == null || segment.restored) return false;
    if (roundId != null && segment.roundId !== roundId) return false;
    segment.discarded = true;
    return true;
  }

  /**
   * 结算一个段：final record 替换 provisional（final usage 覆盖估算，live 与 final 不双算）。
   * providerOutputTokens 为合法正整数时 tokenSource=provider；否则零值/缺失/非法回退
   * 按累计内容估算（tokenSource=estimate）。重复结算返回首次记录，不重复累计；
   * 仅当此前 final 时长非正（提前结算补救路径）时允许重算。已丢弃段不改变状态。
   */
  settleSegment(input: SettleSegmentInput): FinalSegmentRecord | null {
    if (input == null) return null;
    const segment = this.resolveSegment(input.segmentId, input.roundId);
    if (segment == null) return null;
    const existing = segment.finalRecord;
    if (existing != null && isPositiveFinite(existing.generationMs)) {
      return existing;
    }
    if (segment.ended) closeContentStreams(segment.content);
    let tokens = 0;
    let tokenSource: TokenSource = 'estimate';
    if (isValidTokenCount(input.providerOutputTokens)) {
      tokens = input.providerOutputTokens;
      tokenSource = 'provider';
    } else {
      const estimated = contentEstimate(segment);
      if (estimated > 0) tokens = estimated;
    }
    const outcome: SegmentOutcome =
      segment.outcome != null
        ? segment.outcome
        : isSegmentOutcome(input.outcome)
          ? input.outcome
          : 'completed';
    const record: FinalSegmentRecord = {
      segmentId: segment.segmentId,
      roundId: segment.roundId,
      tokens,
      tokenSource,
      generationMs: measuredGenerationMs(segment),
      outcome,
    };
    segment.finalRecord = record;
    return record;
  }

  // ---- 恢复（session_start / session_tree 按当前分支重建） ----

  /**
   * 清空当前实时状态并按当前分支重建：恢复记录按 (roundId, segmentId) 去重，
   * 非法记录（tokens 非正整数 / 时长非正 / 枚举非法 / id 为空）不贡献；
   * totalAssistantEntries 为当前分支直接 assistant 条目数（未测历史只进 total）。
   */
  restore(input: RestoreInput): RestoreSummary {
    this.rounds.clear();
    this.liveSegments.clear();
    this.restoredSegments = new Map();
    this.currentRoundId = null;
    this.liveEndedBaseline = 0;
    const totalRaw = input?.totalAssistantEntries;
    this.baseTotalAssistantEntries =
      isFiniteNumber(totalRaw) && Number.isInteger(totalRaw) && totalRaw > 0 ? totalRaw : 0;
    let accepted = 0;
    let duplicates = 0;
    let invalid = 0;
    const records = Array.isArray(input?.records) ? input.records : [];
    for (const record of records) {
      if (!isValidRestoredRecord(record)) {
        invalid += 1;
        continue;
      }
      const key = restoredKey(record.roundId, record.segmentId);
      if (this.restoredSegments.has(key)) {
        duplicates += 1;
        continue;
      }
      this.restoredSegments.set(key, makeRestoredSegment(record));
      accepted += 1;
    }
    return {
      accepted,
      duplicateRecords: duplicates,
      invalidRecords: invalid,
      measured: accepted,
      totalAssistantEntries: this.baseTotalAssistantEntries,
    };
  }

  /**
   * 持久化边界校准（assistant 落盘后 / session_tree 等）：按当前分支扫描出的
   * 合法配对记录与真实 assistant 条目数校准 coverage，不清除活动轮、既有段或
   * provisional 状态，restored 与 live 不双算：
   * - 记录匹配到同 (roundId, segmentId) 的 live 段 → 以落盘 assistant 的最终
   *   usage 替换该段 final 的 tokens/tokenSource（provider→不同 provider、
   *   provider→estimate 回退、estimate→provider 均更新；只计一次，不追加贡献，
   *   也不保留过时 provider 值），保留 live 合法自测窗口/活动轮/多响应/provisional
   *   与未测拒算标志（unmeasured/discarded 不因同步复活），不新增 restored 条目；
   * - 其余记录替换 restored 集合（输入应为当前分支的完整配对扫描结果）；
   * - totalAssistantEntries 成为权威 base，校准时已结束的 live 段计入 base 不重复加，
   *   其后新结束的段才继续累加 total。
   */
  calibrateCoverage(input: RestoreInput): CalibrateSummary {
    const totalRaw = input?.totalAssistantEntries;
    const baseTotal =
      isFiniteNumber(totalRaw) && Number.isInteger(totalRaw) && totalRaw > 0 ? totalRaw : 0;
    let syncedToLive = 0;
    let duplicates = 0;
    let invalid = 0;
    const nextRestored = new Map<string, SegmentState>();
    const seen = new Set<string>();
    const records = Array.isArray(input?.records) ? input.records : [];
    for (const record of records) {
      if (!isValidRestoredRecord(record)) {
        invalid += 1;
        continue;
      }
      const key = restoredKey(record.roundId, record.segmentId);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      const live = this.liveSegments.get(record.segmentId);
      if (live != null && !live.restored && !live.discarded && live.roundId === record.roundId) {
        this.syncFinalFromRecord(live, record);
        syncedToLive += 1;
      } else {
        nextRestored.set(key, makeRestoredSegment(record));
      }
    }
    this.restoredSegments = nextRestored;
    this.baseTotalAssistantEntries = baseTotal;
    this.liveEndedBaseline = this.countEndedLiveSegments();
    return {
      accepted: nextRestored.size,
      syncedToLive,
      duplicateRecords: duplicates,
      invalidRecords: invalid,
      measured: this.coverage().measured,
      totalAssistantEntries: baseTotal,
    };
  }

  // ---- 查询 ----

  /** 当轮统计：活动轮的实时值（可传 nowMs 计入进行中段）或最近一轮保留值。 */
  getRoundStats(query?: StatsQuery): RoundStats {
    const round = this.currentRoundId != null ? this.rounds.get(this.currentRoundId) : undefined;
    const contributions: Contribution[] = [];
    if (round != null) {
      for (const segment of round.segments.values()) {
        const contribution = segmentContribution(segment, query?.nowMs);
        if (contribution != null) contributions.push(contribution);
      }
    }
    return {
      roundId: round != null ? round.roundId : null,
      settled: round != null ? round.settled : false,
      observedSegments: round != null ? round.segments.size : 0,
      ...aggregateContributions(contributions),
    };
  }

  /** 会话统计：恢复记录 + 全部轮的段（含当前实时贡献）；加权汇总，不平均各轮 TPS。 */
  getSessionStats(query?: StatsQuery): SessionStats {
    const contributions: Contribution[] = [];
    for (const segment of this.restoredSegments.values()) {
      const contribution = segmentContribution(segment, undefined);
      if (contribution != null) contributions.push(contribution);
    }
    for (const round of this.rounds.values()) {
      for (const segment of round.segments.values()) {
        const contribution = segmentContribution(segment, query?.nowMs);
        if (contribution != null) contributions.push(contribution);
      }
    }
    return {
      ...aggregateContributions(contributions),
      coverage: this.coverage(),
      rounds: this.rounds.size,
    };
  }

  /**
   * 覆盖率：total = 权威 base（restore/calibrate 提供）+ 校准基线之后新结束的
   * 未丢弃 live 段；measured = 有效恢复记录 + 合法正时长且 tokens>0 的 live final。
   * ended 流本身不发明 paired 实测；unmeasured 段只进 total；discarded 段都不进。
   */
  coverage(): Coverage {
    let measured = this.restoredSegments.size;
    let endedLive = 0;
    for (const round of this.rounds.values()) {
      for (const segment of round.segments.values()) {
        if (segment.discarded) continue;
        if (segment.ended) endedLive += 1;
        const final = segment.finalRecord;
        if (
          !segment.unmeasured &&
          final != null &&
          isPositiveFinite(final.generationMs) &&
          isValidTokenCount(final.tokens)
        ) {
          measured += 1;
        }
      }
    }
    const total = this.baseTotalAssistantEntries + Math.max(0, endedLive - this.liveEndedBaseline);
    return { measured, total };
  }

  /** 段测量快照（构建持久化 marker 用：自测 generationMs + 回退估算等）。已丢弃段返回 null。 */
  getSegmentMeasurement(segmentId: SegmentId, roundId?: RoundId): SegmentMeasurement | null {
    const segment = this.resolveSegment(segmentId, roundId);
    if (segment == null || segment.discarded) return null;
    let generationMs: number | null = null;
    if (segment.ended && segment.endedAtMs != null && segment.firstDeltaAtMs != null) {
      const diff = segment.endedAtMs - segment.firstDeltaAtMs;
      generationMs = isPositiveFinite(diff) ? diff : null;
    }
    if (generationMs == null && segment.finalRecord != null) {
      generationMs = isPositiveFinite(segment.finalRecord.generationMs)
        ? segment.finalRecord.generationMs
        : null;
    }
    return {
      segmentId: segment.segmentId,
      roundId: segment.roundId,
      firstDeltaAtMs: segment.firstDeltaAtMs,
      endedAtMs: segment.endedAtMs,
      generationMs,
      contentEstimateTokens: contentEstimate(segment),
      provisionalTokens: provisionalTokens(segment),
      providerOutputTokens: segment.providerOutputTokens,
      ended: segment.ended,
      outcome: segment.outcome,
      finalRecord: segment.finalRecord,
      unmeasured: segment.unmeasured,
    };
  }

  /**
   * 合法配对记录同步到同 (roundId, segmentId) 的 live 段：落盘 assistant 的最终
   * usage 是权威口径——tokens/tokenSource 一律替换（provider→不同 provider、
   * provider→estimate 回退、estimate→provider 均更新），不是追加贡献，也不保留
   * 过时值。自测窗口保留 live 合法值（缺失时退回记录值）；结局以 live 观测优先。
   * unmeasured/discarded 标志不变，拒算/丢弃段不会被此同步复活。
   */
  private syncFinalFromRecord(live: SegmentState, record: FinalSegmentRecord): void {
    const existing = live.finalRecord;
    const liveWindow = measuredGenerationMs(live);
    const generationMs =
      liveWindow > 0
        ? liveWindow
        : existing != null && isPositiveFinite(existing.generationMs)
          ? existing.generationMs
          : record.generationMs;
    live.finalRecord = {
      segmentId: live.segmentId,
      roundId: live.roundId,
      tokens: record.tokens,
      tokenSource: record.tokenSource,
      generationMs,
      outcome: live.outcome != null ? live.outcome : record.outcome,
    };
  }

  private countEndedLiveSegments(): number {
    let ended = 0;
    for (const round of this.rounds.values()) {
      for (const segment of round.segments.values()) {
        if (!segment.discarded && segment.ended) ended += 1;
      }
    }
    return ended;
  }

  private resolveSegment(segmentId: SegmentId, roundId?: RoundId): SegmentState | null {
    const live = this.liveSegments.get(segmentId);
    if (live != null) {
      if (live.discarded) return null;
      return roundId == null || live.roundId === roundId ? live : null;
    }
    if (isNonEmptyString(roundId)) {
      return this.restoredSegments.get(restoredKey(roundId, segmentId)) ?? null;
    }
    return null;
  }
}

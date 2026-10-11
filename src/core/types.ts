// Pi Session TPS — 纯统计内核公共类型。
// 语义来源：SPEC.md「已批准的统计与恢复契约（2026-10-11）」。
// 本文件只描述数据形状，不含行为；适配层只能消费，不能修改内核。

export type RoundId = string;
export type SegmentId = string;

/**
 * token 计数来源：
 * - provider：供应商最终合法 usage.output（不含 usage.reasoning）
 * - estimate：按累计可见内容确定性估算（不得按 delta/chunk 次数计数）
 */
export type TokenSource = 'provider' | 'estimate';

/** 段（一条直接 assistant 响应）的结局。 */
export type SegmentOutcome = 'completed' | 'aborted' | 'error';

/**
 * 一条 delta 的可见生成内容片段：正文 / thinking / 工具参数（可为 JSON 片段字符串）。
 * 三类都计入估算；toolResult 内嵌 usage、compaction、cache warming 不属于 delta 输入。
 */
export interface DeltaParts {
  readonly text?: string;
  readonly thinking?: string;
  readonly toolArguments?: string;
  /**
   * 稳定逻辑流身份（Pi 事件的 contentIndex）：同类不同内容块/不同工具调用是不同
   * 逻辑流，按（类别, contentIndex）隔离增量累计，交错次序不改变最终估算。
   * 缺省或非法（非有限非负整数）时归入该类别的缺省（legacy 共享）累加器，
   * 与带 contentIndex 的流互不拼接代理对。
   */
  readonly contentIndex?: number;
}

/** 结算后的最终记录：内核与适配层之间的 final record 契约（SPEC 组件契约）。 */
export interface FinalSegmentRecord {
  readonly segmentId: SegmentId;
  readonly roundId: RoundId;
  readonly tokens: number;
  readonly tokenSource: TokenSource;
  readonly generationMs: number;
  readonly outcome: SegmentOutcome;
}

/** 恢复输入记录：与 FinalSegmentRecord 同形，来自 marker+assistant 配对结果。 */
export type RestoredRecord = FinalSegmentRecord;

/** session_start / session_tree 按当前分支重建的输入；也用于持久化边界的 coverage 校准。 */
export interface RestoreInput {
  readonly records: readonly RestoredRecord[];
  /** 当前分支直接 assistant 条目数（total；未测历史只进 total，不进 measured）。 */
  readonly totalAssistantEntries: number;
}

export interface RestoreSummary {
  readonly accepted: number;
  readonly duplicateRecords: number;
  readonly invalidRecords: number;
  readonly measured: number;
  readonly totalAssistantEntries: number;
}

/** calibrateCoverage 结果：restore 语义之外额外报告同步到既有 live 段的记录数。 */
export interface CalibrateSummary extends RestoreSummary {
  readonly syncedToLive: number;
}

/** TPS 聚合口径：贡献响应 tokens 总和 / 正的自测 generationMs 总和。 */
export interface TpsStats {
  /** 无有效时长时为 null（显示层应显示 `--`，不得夹成 1ms）。 */
  readonly tokensPerSecond: number | null;
  readonly tokens: number;
  readonly generationMs: number;
  /** 任一贡献为估算或 provisional 时为 true（显示层加 `~`）。 */
  readonly estimated: boolean;
  readonly contributingSegments: number;
}

/** 当轮统计：活动轮实时值，或最近一轮的保留值（settled 后不清零）。 */
export interface RoundStats extends TpsStats {
  readonly roundId: RoundId | null;
  readonly settled: boolean;
  readonly observedSegments: number;
}

/** 会话统计：含当前实时贡献；恢复历史按 records 计入，未测历史不进分子/分母。 */
export interface SessionStats extends TpsStats {
  readonly coverage: Coverage;
  /** 本次内核实例内观测到的轮数（不含恢复的伪轮）。 */
  readonly rounds: number;
}

/** 覆盖率：measured/total，total 为当前分支直接 assistant 条目数。 */
export interface Coverage {
  readonly measured: number;
  readonly total: number;
}

/** message_end / 取消 / 出错时结束一段生成。 */
export interface SegmentEndInput {
  readonly outcome: SegmentOutcome;
  readonly atMs: number;
}

/** 结算输入：providerOutputTokens 仅在为合法正整数时生效，否则回退内容估算。 */
export interface SettleSegmentInput {
  readonly segmentId: SegmentId;
  readonly roundId: RoundId;
  readonly providerOutputTokens?: number;
  readonly outcome?: SegmentOutcome;
}

/**
 * 查询实时统计时由适配层传入的当前时间（performance.now() 等单调时钟）。
 * 内核不启动任何真实时钟/计时器；不传 nowMs 时进行中的段不参与实时估算。
 */
export interface StatsQuery {
  readonly nowMs?: number;
}

/** 适配层构建持久化 marker 所需的段测量快照（已丢弃段不可见，返回 null）。 */
export interface SegmentMeasurement {
  readonly segmentId: SegmentId;
  readonly roundId: RoundId;
  readonly firstDeltaAtMs: number | null;
  readonly endedAtMs: number | null;
  /** 已结束且为正的自测时长；未结束或非法时为 null。 */
  readonly generationMs: number | null;
  /** 按累计内容的回退估算（marker 的 fallback estimate）；未闭合代理项不计入。 */
  readonly contentEstimateTokens: number;
  /** provisional tokens（provider 累计值优先，否则内容估算）；已结算后为 null。 */
  readonly provisionalTokens: number | null;
  readonly providerOutputTokens: number | null;
  readonly ended: boolean;
  readonly outcome: SegmentOutcome | null;
  readonly finalRecord: FinalSegmentRecord | null;
  /** 真实 message_end 但缺完整观测起点：只进 coverage.total 的未测响应。 */
  readonly unmeasured: boolean;
}

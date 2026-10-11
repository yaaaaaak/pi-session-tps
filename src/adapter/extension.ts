// Pi Session TPS 扩展适配层：把 Pi 1.1.0 事件流接到纯统计内核，并负责
// marker 写入、恢复配对与 TUI status 显示。
// 事件契约（本机 Pi 1.1.0 源码核查）：
// - agent_start 在每次 runAgentLoop/runAgentLoopContinue 开头触发；自动重试、
//   compaction continuation、agent_before_settle 续跑都会再次触发，但都在
//   agent_settled 之前，因此属于同一轮（幂等，不清零）。
// - agent_settled 在重试/compaction/queued 续跑全部结束后才触发（_runAgentPrompt
//   的 finally 中 _emitAgentSettled），是本轮的结束边界；agent_end 不结算。
// - message_update 仅由九种 text/thinking/toolcall start/delta/end 事件产生；
//   message_end 携带最终 message（含最终 usage），且先于 appendMessage 持久化。
// - user/system/toolResult 消息同样有 message_start/message_end，按角色过滤。
// - turn_end 仅在该轮 assistant（及其 toolResult）落盘后才向扩展派发
//   （_dispatchTurnEndBoundary 以 _findPersistedMessageEntryId 成功为前提），
//   是持久化后安全边界：在此按当前分支校准 coverage。
// 首轮边界澄清（SPEC）：
// - 未见该响应 message_start 的流（reload/晚加载）结算时保守拒算：
//   endSegmentUnmeasured 只进 coverage.total，不写可计量 marker。
// - 防御性关闭且无真实落盘 assistant 的流用 discardSegment 丢弃，不进 TPS/coverage。
// - 同一消息重复 message_end 只处理一次；真实无流 message_end 登记一次未测条目。

import { SessionTpsKernel } from '../core/index.ts';
import type { DeltaParts } from '../core/index.ts';
import {
  MARKER_CUSTOM_TYPE,
  MARKER_VERSION,
  assistantFingerprint,
  readUsageOutput,
  scanBranchForMeasurements,
  stopReasonToOutcome,
} from './marker.ts';
import type { AssistantFingerprint } from './marker.ts';
import { formatStatusText } from './status.ts';
import type {
  PiAdapterHandler,
  PiExtensionApiLike,
  PiExtensionContextLike,
  PiMessageLike,
} from './pi-types.ts';

/** 独立 status key；不接管 footer（SPEC 契约 8）。 */
export const STATUS_KEY = 'pi-session-tps';

export interface SessionTpsOptions {
  /** 单调时钟（默认 performance.now()）；测试可注入。 */
  readonly now?: () => number;
  /** delta 期间的 status 刷新节流间隔（默认 250ms）；边界事件始终强制刷新。 */
  readonly statusThrottleMs?: number;
}

interface ActiveStream {
  readonly segmentId: string;
  readonly roundId: string;
  /** 是否观察到该响应的 message_start（完整观测起点）；reload/晚加载后为 false。 */
  readonly sawMessageStart: boolean;
}

interface RoundRef {
  id: string;
  settled: boolean;
}

function defaultNow(): number {
  return performance.now();
}

function randomId(prefix: string, counter: { value: number }): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  counter.value += 1;
  return `${prefix}-${counter.value}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 已处理过的 assistant message_end 去重键上限（FIFO，防重复结束通知双算）。 */
const ENDED_MESSAGE_KEYS_CAP = 512;

/**
 * message_update 的 delta 事件 → 内核 DeltaParts；*_start/_end 不算生成内容。
 * contentIndex（有限非负整数时）原样透传作为同类内逻辑流身份，
 * 交错的不同内容块/工具调用互不拼接代理对；缺省保持 legacy 兼容。
 */
function deltaParts(
  eventType: string,
  delta: unknown,
  contentIndex: unknown,
): DeltaParts | undefined {
  if (typeof delta !== 'string' || delta.length === 0) return undefined;
  let parts: DeltaParts;
  if (eventType === 'text_delta') parts = { text: delta };
  else if (eventType === 'thinking_delta') parts = { thinking: delta };
  else if (eventType === 'toolcall_delta') parts = { toolArguments: delta };
  else return undefined;
  return typeof contentIndex === 'number' ? { ...parts, contentIndex } : parts;
}

/**
 * 创建扩展工厂。用法：
 *   export default createSessionTpsExtension();        // 默认配置
 *   export default createSessionTpsExtension({...});   // 注入时钟等（测试）
 */
export function createSessionTpsExtension(options: SessionTpsOptions = {}) {
  const now = options.now ?? defaultNow;
  const throttleMs = options.statusThrottleMs ?? 250;

  return function sessionTpsExtension(pi: PiExtensionApiLike): void {
    const kernel = new SessionTpsKernel();
    const idCounter = { value: 0 };
    let currentRound: RoundRef | null = null;
    let activeStream: ActiveStream | null = null;
    let lastStatusAt = Number.NEGATIVE_INFINITY;
    let statusVisible = false;
    // 已处理的 assistant message_end 去重：重复结束通知不得双算（SPEC 首轮边界澄清）。
    const endedMessageKeys = new Set<string>();
    const endedMessageKeyOrder: string[] = [];
    const endedMessagesWeak = new WeakSet<object>();

    /** agent_start/首 delta 的防御路径：无活动轮时隐式开轮。 */
    function ensureRound(): string {
      if (currentRound == null || currentRound.settled) {
        currentRound = { id: randomId('round', idCounter), settled: false };
        kernel.startRound(currentRound.id);
      } else {
        // 重试/compaction 续跑的 agent_start：同 id 幂等，不清零。
        kernel.startRound(currentRound.id);
      }
      return currentRound.id;
    }

    function openStream(sawMessageStart: boolean): ActiveStream {
      if (activeStream != null) return activeStream;
      const roundId = ensureRound();
      activeStream = { segmentId: randomId('seg', idCounter), roundId, sawMessageStart };
      return activeStream;
    }

    /**
     * 防御路径：流未收到 message_end 就被新消息/轮边界/生命周期打断。该路径没有
     * 对应真实落盘的 assistant，用 discardSegment 丢弃：不进 TPS、不进 coverage。
     */
    function discardActiveStream(): void {
      const stream = activeStream;
      if (stream == null) return;
      activeStream = null;
      kernel.discardSegment(stream.segmentId, stream.roundId);
    }

    function refreshStatus(context: PiExtensionContextLike | undefined, force: boolean): void {
      if (context == null || context.mode !== 'tui') return;
      const at = now();
      if (!force && at - lastStatusAt < throttleMs) return;
      lastStatusAt = at;
      statusVisible = true;
      context.ui.setStatus(STATUS_KEY, formatStatusText(
        kernel.getRoundStats({ nowMs: at }),
        kernel.getSessionStats({ nowMs: at }),
      ));
    }

    function restoreFromBranch(context: PiExtensionContextLike | undefined): void {
      const entries = context?.sessionManager?.getBranch?.() ?? [];
      const scan = scanBranchForMeasurements(entries);
      kernel.restore({ records: scan.records, totalAssistantEntries: scan.totalAssistantEntries });
      currentRound = null;
      activeStream = null;
    }

    /**
     * 持久化后安全边界（turn_end）校准：assistant 落盘后按当前分支完整配对扫描
     * 校准 coverage——不清除活动轮、段或 provisional，restored 与 live 不双算；
     * marker 被后续 message_end 扩展改写等证伪时，把对应 live 段降级丢弃，
     * 不保留虚假的精确已测贡献。
     */
    function calibrateFromBranch(context: PiExtensionContextLike | undefined): void {
      const entries = context?.sessionManager?.getBranch?.() ?? [];
      const scan = scanBranchForMeasurements(entries);
      for (const segmentId of scan.voidedMarkerSegmentIds) {
        kernel.discardSegment(segmentId);
      }
      kernel.calibrateCoverage({
        records: scan.records,
        totalAssistantEntries: scan.totalAssistantEntries,
      });
    }

    /** assistant message_end 去重：同一消息重复结束通知只处理一次。 */
    function messageEndAlreadyProcessed(message: PiMessageLike, fingerprint: AssistantFingerprint | null): boolean {
      if (fingerprint != null) return endedMessageKeys.has(fingerprint.key);
      return typeof message === 'object' && message != null ? endedMessagesWeak.has(message) : false;
    }

    function markMessageEndProcessed(message: PiMessageLike, fingerprint: AssistantFingerprint | null): void {
      if (fingerprint != null) {
        if (endedMessageKeys.has(fingerprint.key)) return;
        endedMessageKeys.add(fingerprint.key);
        endedMessageKeyOrder.push(fingerprint.key);
        if (endedMessageKeyOrder.length > ENDED_MESSAGE_KEYS_CAP) {
          const evicted = endedMessageKeyOrder.shift();
          if (evicted != null) endedMessageKeys.delete(evicted);
        }
        return;
      }
      if (typeof message === 'object' && message != null) endedMessagesWeak.add(message);
    }

    const onSessionStart: PiAdapterHandler<{ type: 'session_start' }> = (_event, context) => {
      // startup/reload/new/resume/fork 一律按当前分支重建并清除活动计时起点。
      restoreFromBranch(context);
      lastStatusAt = Number.NEGATIVE_INFINITY;
      refreshStatus(context, true);
    };

    const onSessionTree: PiAdapterHandler<{ type: 'session_tree'; newLeafId: string | null }> = (
      _event,
      context,
    ) => {
      restoreFromBranch(context);
      refreshStatus(context, true);
    };

    const onSessionShutdown: PiAdapterHandler<{ type: 'session_shutdown' }> = (_event, context) => {
      discardActiveStream();
      currentRound = null;
      if (statusVisible && context?.mode === 'tui') {
        context.ui.setStatus(STATUS_KEY, undefined);
        statusVisible = false;
      }
      lastStatusAt = Number.NEGATIVE_INFINITY;
    };

    const onAgentStart: PiAdapterHandler<{ type: 'agent_start' }> = (_event, context) => {
      ensureRound();
      refreshStatus(context, true);
    };

    const onAgentSettled: PiAdapterHandler<{ type: 'agent_settled'; aborted: boolean }> = (
      _event,
      context,
    ) => {
      // agent_settled 才结束本轮；未收到 message_end 的流无对应落盘 assistant，丢弃。
      discardActiveStream();
      if (currentRound != null && !currentRound.settled) {
        kernel.settleRound();
        currentRound.settled = true;
      }
      refreshStatus(context, true);
    };

    const onMessageStart: PiAdapterHandler<{ type: 'message_start'; message: PiMessageLike }> = (
      event,
      _context,
    ) => {
      if (event.message?.role === 'assistant') {
        // 新的 assistant 流开始；上一条异常未关闭的流无对应落盘 assistant，丢弃。
        discardActiveStream();
        openStream(true);
      }
    };

    const onMessageUpdate: PiAdapterHandler<{
      type: 'message_update';
      message: PiMessageLike;
      assistantMessageEvent: { type: string; delta?: unknown; contentIndex?: unknown };
    }> = (event, context) => {
      if (event.message?.role !== 'assistant') return;
      // 扩展运行时于流中途替换（reload）时没有 message_start：标记为非完整观测，
      // 首个观察到的 delta 仍可作为 provisional 展示，但结算时保守拒算。
      const stream = openStream(false);
      const at = now();
      const deltaEvent = event.assistantMessageEvent;
      const parts = deltaParts(deltaEvent?.type, deltaEvent?.delta, deltaEvent?.contentIndex);
      if (parts != null) {
        kernel.startSegment(stream.segmentId, stream.roundId);
        kernel.onDelta(stream.segmentId, parts, at);
      }
      // 流内累计 provider output（provisional，单调递增校验在内核）。
      const provisional = readUsageOutput(event.message);
      if (provisional != null) {
        kernel.onProviderUsage(stream.segmentId, provisional);
      }
      refreshStatus(context, false);
    };

    const onMessageEnd: PiAdapterHandler<{ type: 'message_end'; message: PiMessageLike }> = (
      event,
      context,
    ) => {
      const message = event.message;
      if (message == null || message.role !== 'assistant') return; // user/toolResult 等不产生段。
      const fingerprint = assistantFingerprint(message);
      // 重复结束通知：同一消息只处理一次，不得双算 coverage/marker。
      if (messageEndAlreadyProcessed(message, fingerprint)) return;
      markMessageEndProcessed(message, fingerprint);
      const outcome = stopReasonToOutcome(message.stopReason) ?? 'completed';
      const stream = activeStream;
      activeStream = null;

      if (stream != null && stream.sawMessageStart) {
        kernel.startSegment(stream.segmentId, stream.roundId);
        kernel.endSegment(stream.segmentId, { outcome, atMs: now() });
        // 最终 usage.output 权威；零值/缺失/非法由内核回退累计内容估算并标 estimate。
        kernel.settleSegment({
          segmentId: stream.segmentId,
          roundId: stream.roundId,
          providerOutputTokens: readUsageOutput(message) ?? undefined,
          outcome,
        });
        const measurement = kernel.getSegmentMeasurement(stream.segmentId, stream.roundId);
        const generationMs = measurement?.generationMs;
        // 仅在完整观测且自测出正时长时写前置 marker（消息持久化紧随本事件之后）。
        if (
          fingerprint != null &&
          generationMs != null &&
          generationMs > 0 &&
          Number.isFinite(generationMs)
        ) {
          pi.appendEntry(MARKER_CUSTOM_TYPE, {
            v: MARKER_VERSION,
            roundId: stream.roundId,
            segmentId: stream.segmentId,
            generationMs,
            estimatedTokens: measurement?.contentEstimateTokens ?? 0,
            // 只持久化匹配字段（MarkerMatchInfo）；运行时去重键 key 不落盘。
            match: {
              provider: fingerprint.provider,
              model: fingerprint.model,
              timestamp: fingerprint.timestamp,
              stopReason: fingerprint.stopReason,
              contentHash: fingerprint.contentHash,
            },
          });
        }
      } else {
        // 未观察到该响应的 message_start（reload/晚加载后仅见局部 delta 或只有
        // message_end）：保守拒算——分子/分母都不纳入、不写可计量 marker，
        // 真实落盘 assistant 只进 coverage.total（endSegmentUnmeasured）。
        const segmentId = stream != null ? stream.segmentId : randomId('seg', idCounter);
        const roundId = stream != null ? stream.roundId : ensureRound();
        kernel.startSegment(segmentId, roundId);
        kernel.endSegmentUnmeasured(segmentId, outcome);
      }
      refreshStatus(context, true);
    };

    const onTurnEnd: PiAdapterHandler<{ type: 'turn_end'; message: PiMessageLike }> = (
      _event,
      context,
    ) => {
      // 持久化后安全边界：assistant 已落盘，按当前分支校准 coverage 与配对贡献。
      calibrateFromBranch(context);
      refreshStatus(context, true);
    };

    pi.on('session_start', onSessionStart);
    pi.on('session_tree', onSessionTree);
    pi.on('session_shutdown', onSessionShutdown);
    pi.on('agent_start', onAgentStart);
    pi.on('agent_settled', onAgentSettled);
    pi.on('message_start', onMessageStart);
    pi.on('message_update', onMessageUpdate);
    pi.on('message_end', onMessageEnd);
    pi.on('turn_end', onTurnEnd);
  };
}

/** 默认工厂（Pi 扩展入口的 default export 形状）。 */
export default function sessionTpsExtension(pi: PiExtensionApiLike): void {
  createSessionTpsExtension()(pi);
}

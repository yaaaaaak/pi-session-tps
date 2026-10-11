// Pi 1.1.0 ExtensionAPI 的结构性子集：仅声明本适配层实际消费的事件、上下文与入口。
// 目的：适配层零运行时依赖即可加载（jiti / node --test），同时保证与真实
// ExtensionAPI/ExtensionContext 结构兼容（真实类型是本文件的超集）。
// 依据：本机 Pi 1.1.0 dist/core/extensions/types.d.ts 与 agent-session.js 核查结果。

/** 事件 unsubscribe 函数（pi.on 的返回值；本适配层无需保存，运行时拆除时统一回收）。 */
export type PiUnsubscribe = () => void;

/** 供应商用量。只消费 output；reasoning 不读取、不叠加（SPEC 契约 3）。 */
export interface PiUsageLike {
  readonly output?: unknown;
}

export interface PiTextPartLike {
  readonly type: 'text';
  readonly text?: unknown;
}

export interface PiThinkingPartLike {
  readonly type: 'thinking';
  readonly thinking?: unknown;
}

export interface PiToolCallPartLike {
  readonly type: 'toolCall';
  readonly id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
}

/** assistant message 的 content 项（读取前全部做运行时校验）。 */
export type PiContentPartLike = PiTextPartLike | PiThinkingPartLike | PiToolCallPartLike;

/** 事件携带的 message：先按 role 判别，再由 marker.ts 的读取函数规范化。 */
export interface PiMessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly usage?: PiUsageLike;
  readonly stopReason?: unknown;
  readonly timestamp?: unknown;
}

/**
 * message_update 携带的 AssistantMessageEvent。Pi 1.1.0 中只有九种
 * text/thinking/toolcall 的 start/delta/end 事件会产生 message_update；
 * 本适配层只把三种 *_delta 当作生成内容（SPEC 契约 2：*_start 不算内容）。
 * 真实事件的 delta 均带 contentIndex（pi-ai dist/types.d.ts），原样透传内核
 * 作为逻辑流身份；缺省/非法时内核归入 legacy 缺省流（兼容旧 fixtures）。
 */
export interface PiAssistantMessageEventLike {
  readonly type: string;
  readonly delta?: unknown;
  readonly contentIndex?: unknown;
}

export interface PiSessionStartEvent {
  readonly type: 'session_start';
  readonly reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
}

export interface PiSessionTreeEvent {
  readonly type: 'session_tree';
  readonly newLeafId: string | null;
}

export interface PiSessionShutdownEvent {
  readonly type: 'session_shutdown';
}

export interface PiAgentStartEvent {
  readonly type: 'agent_start';
}

export interface PiAgentSettledEvent {
  readonly type: 'agent_settled';
  readonly aborted: boolean;
}

export interface PiMessageStartEvent {
  readonly type: 'message_start';
  readonly message: PiMessageLike;
}

export interface PiMessageUpdateEvent {
  readonly type: 'message_update';
  readonly message: PiMessageLike;
  readonly assistantMessageEvent: PiAssistantMessageEventLike;
}

export interface PiMessageEndEvent {
  readonly type: 'message_end';
  readonly message: PiMessageLike;
}

/**
 * turn_end（持久化后安全边界）：Pi 仅在该轮 assistant（及其 toolResult）已落盘后才
 * 向扩展派发 turn_end（agent-session.js _dispatchTurnEndBoundary 以
 * _findPersistedMessageEntryId 成功为前提），故在此校准当前分支 coverage。
 */
export interface PiTurnEndEvent {
  readonly type: 'turn_end';
  readonly message: PiMessageLike;
}

export type PiAdapterHandler<Event> = (
  event: Event,
  context: PiExtensionContextLike,
) => void | Promise<void>;

export interface PiExtensionContextLike {
  /** 'tui' | 'rpc' | 'json' | 'print'；仅 'tui' 调用终端 UI。 */
  readonly mode: string;
  readonly ui: {
    setStatus(key: string, text: string | undefined): void;
  };
  readonly sessionManager: {
    getBranch(): readonly PiSessionEntryLike[];
  };
}

/** getBranch() 返回的会话条目（读取子集；其余类型一律按非消息元数据对待）。 */
export interface PiSessionEntryLike {
  readonly type: string;
  readonly message?: PiMessageLike;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface PiExtensionApiLike {
  on(event: 'session_start', handler: PiAdapterHandler<PiSessionStartEvent>): PiUnsubscribe;
  on(event: 'session_tree', handler: PiAdapterHandler<PiSessionTreeEvent>): PiUnsubscribe;
  on(event: 'session_shutdown', handler: PiAdapterHandler<PiSessionShutdownEvent>): PiUnsubscribe;
  on(event: 'agent_start', handler: PiAdapterHandler<PiAgentStartEvent>): PiUnsubscribe;
  on(event: 'agent_settled', handler: PiAdapterHandler<PiAgentSettledEvent>): PiUnsubscribe;
  on(event: 'message_start', handler: PiAdapterHandler<PiMessageStartEvent>): PiUnsubscribe;
  on(event: 'message_update', handler: PiAdapterHandler<PiMessageUpdateEvent>): PiUnsubscribe;
  on(event: 'message_end', handler: PiAdapterHandler<PiMessageEndEvent>): PiUnsubscribe;
  on(event: 'turn_end', handler: PiAdapterHandler<PiTurnEndEvent>): PiUnsubscribe;
  appendEntry(customType: string, data?: unknown): void;
}

// tests/adapter 共享测试脚手架：伪造 Pi ExtensionAPI/Context 与事件驱动。
// 只模拟 Pi 1.1.0 的事件形状，不发起任何真实 LLM 请求。

import type {
  PiExtensionApiLike,
  PiExtensionContextLike,
  PiMessageLike,
  PiSessionEntryLike,
} from '../../src/adapter/index.ts';
import { MARKER_CUSTOM_TYPE } from '../../src/adapter/index.ts';

/**
 * 本地 fixture 形状（真实 Pi 1.1.0 的合法超集）：生产结构子集类型只声明
 * 扫描所需字段，fixture 额外携带真实条目/用量元数据；仅用于测试构造，
 * 不改生产类型。对 PiSessionEntryLike/PiMessageLike 均保持结构可赋值。
 */
export type SessionEntryFixture = PiSessionEntryLike & {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly timestamp?: string;
  readonly content?: string;
  readonly display?: boolean;
};

export type AssistantMessageFixture = PiMessageLike & {
  readonly usage: {
    readonly input?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly totalTokens?: number;
    readonly cost?: Record<string, number>;
  };
};

export interface RecordedEntry {
  readonly customType: string;
  readonly data: unknown;
}

export interface FakePi {
  readonly pi: PiExtensionApiLike;
  readonly entries: RecordedEntry[];
  /** 按 Pi runner 语义：以 event.type 分发给对应注册的 handler。 */
  emit(event: Record<string, unknown>, context: PiExtensionContextLike): Promise<void>;
}

export function createFakePi(): FakePi {
  const handlers = new Map<string, ((event: never, context: PiExtensionContextLike) => unknown)[]>();
  const entries: RecordedEntry[] = [];
  const pi = {
    on(event: string, handler: (event: never, context: PiExtensionContextLike) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event);
        const index = current?.indexOf(handler) ?? -1;
        if (index >= 0) current?.splice(index, 1);
      };
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as PiExtensionApiLike;
  return {
    pi,
    entries,
    async emit(event, context) {
      for (const handler of [...(handlers.get(String(event.type)) ?? [])]) {
        await handler(event as never, context);
      }
    },
  };
}

export interface FakeCtx {
  readonly ctx: PiExtensionContextLike;
  readonly statusCalls: Array<[string, string | undefined]>;
  readonly branch: PiSessionEntryLike[];
}

export function createFakeCtx(options: { mode?: string; branch?: PiSessionEntryLike[] } = {}): FakeCtx {
  const statusCalls: Array<[string, string | undefined]> = [];
  const branch: PiSessionEntryLike[] = options.branch ? [...options.branch] : [];
  const ctx = {
    mode: options.mode ?? 'tui',
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push([key, text]);
      },
    },
    sessionManager: {
      getBranch: () => branch,
    },
  };
  return { ctx, statusCalls, branch };
}

/** 可控单调时钟。 */
export class FakeClock {
  private current: number;

  constructor(start = 1_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}

export interface AssistantMessageInit {
  readonly content?: Array<Record<string, unknown>>;
  readonly usageOutput?: number;
  readonly stopReason?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timestamp?: number;
}

/** 构造 Pi AssistantMessage 形状（事件与持久化条目共用）。 */
export function assistantMessage(init: AssistantMessageInit = {}): AssistantMessageFixture {
  return {
    role: 'assistant',
    content: init.content ?? [{ type: 'text', text: '' }],
    provider: init.provider ?? 'anthropic',
    model: init.model ?? 'claude-test',
    usage: { input: 10, output: init.usageOutput ?? 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: init.stopReason ?? 'stop',
    timestamp: init.timestamp ?? 1_000,
  };
}

export function textPart(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

/** 会话条目构造（树形字段仅保留扫描所需子集）。 */
export function messageEntry(id: string, message: PiMessageLike): SessionEntryFixture {
  return { type: 'message', id, parentId: null, timestamp: '', message };
}

export function customMarkerEntry(id: string, data: unknown): SessionEntryFixture {
  return { type: 'custom', id, parentId: null, timestamp: '', customType: MARKER_CUSTOM_TYPE, data };
}

export function metadataEntry(type: string, id: string): SessionEntryFixture {
  return { type, id, parentId: null, timestamp: '' };
}

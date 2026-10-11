// 独立验证（黑盒，仅经扩展公共 API）：统计口径、排除规则、边界与资源约束。
// 覆盖（R1/R2/R3/R5）：会话加权精确数值（非各轮平均）、多响应与工具长间隔、TTFT、
// 用户闲置、chunk 数不冒充 token、usage.reasoning 不重复计数、取消/error/零时长、
// 流中途 reload 的已批准统计窗、message_end 重复、启动无计时器、非 TUI 零终端 UI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTpsExtension } from '../../src/adapter/index.ts';
import {
	ExtensionDriver,
	FakeClock,
	type RealEntryLike,
	assistantMsg,
	textPart,
} from './harness.ts';

interface ArrayHarness {
	readonly driver: ExtensionDriver;
	readonly clock: FakeClock;
	readonly markers: Array<{ customType: string; data: unknown }>;
	readonly entries: RealEntryLike[];
}

function arrayHarness(mode?: string): ArrayHarness {
	const entries: RealEntryLike[] = [];
	const markers: Array<{ customType: string; data: unknown }> = [];
	const clock = new FakeClock(1_000);
	const driver = new ExtensionDriver({
		mode,
		now: () => clock.now(),
		getBranch: () => [...entries],
		appendEntry: (customType, data) => {
			markers.push({ customType, data });
			entries.push({ id: `c-${markers.length}`, type: 'custom', customType, data });
		},
	});
	createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
	return { driver, clock, markers, entries };
}

async function assistantDelta(
	h: ArrayHarness,
	delta: string,
	eventType: 'text_delta' | 'thinking_delta' | 'toolcall_delta' = 'text_delta',
): Promise<void> {
	await h.driver.emit({
		type: 'message_update',
		message: { role: 'assistant' },
		assistantMessageEvent: { type: eventType, delta },
	});
}

/** 模拟真实 Pi 顺序：message_end（扩展先写 marker）→ appendMessage 落盘 → turn_end。 */
async function persistAndTurnEnd(h: ArrayHarness, finalMessage: Record<string, unknown>): Promise<void> {
	h.entries.push({ id: `a-${h.entries.length}`, type: 'message', message: finalMessage });
	await h.driver.emit({ type: 'turn_end', message: finalMessage });
}

test('contract: 会话为 Σtokens/ΣgenerationMs 加权（非各轮 TPS 平均），闲置不参与', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'session_start', reason: 'startup' });
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/0');

	// 轮 1：100 tokens / 4000ms = 25 tok/s。
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	await assistantDelta(h, 'x'.repeat(400));
	h.clock.advance(4_000);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 1_500 }),
	});
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h.driver.lastStatus(), '当轮 25 | 会话 25 tok/s | 已测 1/1');

	// 60s 用户闲置：不得影响任一统计（数值精确断言即证明）。
	h.clock.advance(60_000);

	// 轮 2 开始：当轮重置为占位，会话保留。
	await h.driver.emit({ type: 'agent_start' });
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 25 tok/s | 已测 1/1');
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	await assistantDelta(h, 'y'.repeat(1_200));
	h.clock.advance(1_000);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('y'.repeat(1_200))], usageOutput: 300, timestamp: 62_600 }),
	});
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	// 轮 2：300 tok/s；会话加权 (100+300)/(4000+1000) = 80（各轮平均会是 162.5）。
	assert.equal(h.driver.lastStatus(), '当轮 300 | 会话 80 tok/s | 已测 2/2');
});

test('contract: 一轮内多响应 + 工具长间隔排除（工具执行时间不进分母）', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });

	// 段 1：60 tokens / 400ms。
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	await assistantDelta(h, 'a'.repeat(200));
	h.clock.advance(400);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({
			content: [textPart('a'.repeat(200)), { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
			usageOutput: 60,
			stopReason: 'toolUse',
			timestamp: 1_600,
		}),
	});

	// 工具执行 10s（含 toolResult 消息事件与内嵌 usage）：必须排除。
	const toolResult = {
		role: 'toolResult',
		toolCallId: 't1',
		toolName: 'bash',
		content: [],
		usage: { input: 1, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: 5_000,
	};
	await h.driver.emit({ type: 'message_start', message: toolResult });
	await h.driver.emit({ type: 'message_end', message: toolResult });
	h.clock.advance(10_000);

	// 段 2：40 tokens / 400ms。
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	await assistantDelta(h, 'b'.repeat(200));
	h.clock.advance(400);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('b'.repeat(200))], usageOutput: 40, timestamp: 15_600 }),
	});
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	// (60+40)/(400+400) = 125 tok/s；若误含 10s 工具时间会得到 ~9.5。
	assert.equal(h.driver.lastStatus(), '当轮 125 | 会话 125 tok/s | 已测 2/2');
	assert.equal(h.markers.length, 2);
});

test('contract: TTFT 长间隔排除（生成时长从首个非空 delta 起测）', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	// message_start 后 5s 无任何 delta（TTFT）。
	h.clock.advance(5_000);
	await assistantDelta(h, 'x'.repeat(400));
	h.clock.advance(500);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 6_700 }),
	});
	const marker = h.markers[0].data as { generationMs: number };
	assert.equal(marker.generationMs, 500);
	assert.equal(h.driver.lastStatus(), '当轮 200 | 会话 200 tok/s | 已测 1/1');
});

test('contract: 估算按累计内容而非 delta/chunk 次数', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	// 1000 个单字符 delta：内容估算 1000 chars / 4 = 250 tokens；chunk 计数会是 1000。
	for (let i = 0; i < 1_000; i += 1) {
		if (i > 0) h.clock.advance(1);
		await assistantDelta(h, 'x');
	}
	h.clock.advance(101);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(1_000))], usageOutput: 0, timestamp: 3_000 }),
	});
	const marker = h.markers[0].data as { estimatedTokens: number };
	assert.equal(marker.estimatedTokens, 250);
	// 250 tokens / 1100ms ≈ 227.3 tok/s（估算 → ~）；chunk 计数会显示 ~910。
	assert.equal(h.driver.lastStatus(), '当轮 ~227 | 会话 ~227 tok/s | 已测 1/1');
});

test('contract: usage.reasoning 是 output 子集，不重复计数', async () => {
	// 1) provider output=100 且 reasoning=60：tokens 应为 100。
	const h1 = arrayHarness();
	await h1.driver.emit({ type: 'agent_start' });
	await h1.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h1.clock.advance(100);
	await assistantDelta(h1, 'x'.repeat(400));
	h1.clock.advance(1_000);
	await h1.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, reasoning: 60, timestamp: 2_200 }),
	});
	await h1.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h1.driver.lastStatus(), '当轮 100 | 会话 100 tok/s | 已测 1/1');

	// 2) output=0、reasoning=90：回退按累计内容（100 tokens）估算，不采用 reasoning。
	const h2 = arrayHarness();
	await h2.driver.emit({ type: 'agent_start' });
	await h2.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h2.clock.advance(100);
	await assistantDelta(h2, 'x'.repeat(400));
	h2.clock.advance(1_000);
	await h2.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 0, reasoning: 90, timestamp: 2_200 }),
	});
	await h2.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h2.driver.lastStatus(), '当轮 ~100 | 会话 ~100 tok/s | 已测 1/1');
});

test('contract: 取消（有内容正时长）计入；error 回退估算；零时长不贡献不写 marker', async () => {
	// 1) aborted：30 tokens / 400ms = 75 tok/s。
	const h1 = arrayHarness();
	await h1.driver.emit({ type: 'agent_start' });
	await h1.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h1.clock.advance(100);
	await assistantDelta(h1, 'x'.repeat(400));
	h1.clock.advance(400);
	await h1.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 30, stopReason: 'aborted', timestamp: 1_600 }),
	});
	await h1.driver.emit({ type: 'agent_settled', aborted: true });
	assert.equal(h1.driver.lastStatus(), '当轮 75 | 会话 75 tok/s | 已测 1/1');
	assert.equal(h1.markers.length, 1);

	// 2) error 有内容且 usage 不可用：估算 100 tokens / 400ms = ~250 tok/s。
	const h2 = arrayHarness();
	await h2.driver.emit({ type: 'agent_start' });
	await h2.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h2.clock.advance(100);
	await assistantDelta(h2, 'x'.repeat(400));
	h2.clock.advance(400);
	await h2.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 0, stopReason: 'error', timestamp: 1_600 }),
	});
	await h2.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h2.driver.lastStatus(), '当轮 ~250 | 会话 ~250 tok/s | 已测 1/1');
	assert.equal(h2.markers.length, 1);

	// 3) 零时长（delta 与 message_end 同一时刻）：不进分子分母、不写 marker、显示 --。
	const h3 = arrayHarness();
	await h3.driver.emit({ type: 'agent_start' });
	await h3.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h3.clock.advance(100);
	await assistantDelta(h3, 'x'.repeat(400));
	await h3.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 80, timestamp: 1_100 }),
	});
	await h3.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h3.markers.length, 0);
	assert.equal(h3.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	assert.ok(!String(h3.driver.lastStatus()).includes('NaN'));
	assert.ok(!String(h3.driver.lastStatus()).includes('Infinity'));
});

test('contract: 流中途 reload：未见 message_start 的响应保守拒算（非仅加 ~）', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'session_start', reason: 'startup' });
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100); // 1100：reload 前已有部分内容流过
	await assistantDelta(h, 'x'.repeat(400));
	await h.driver.emit({ type: 'session_start', reason: 'reload' });
	h.clock.advance(100); // 1200：reload 后首个观察到的 delta（无 message_start）
	await assistantDelta(h, 'y'.repeat(200));
	h.clock.advance(100); // 1300
	await assistantDelta(h, 'y'.repeat(200));
	// provisional 展示允许（带 ~），但不是合法结算口径。
	assert.equal(h.driver.lastStatus(), '当轮 ~1000 | 会话 ~1000 tok/s | 已测 0/0');
	h.clock.advance(200); // 1500
	const finalMessage = assistantMsg({ content: [textPart('x'.repeat(400) + 'y'.repeat(400))], usageOutput: 50, timestamp: 1_600 });
	await h.driver.emit({ type: 'message_end', message: finalMessage });
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	// 首轮边界澄清：reload/晚加载后未见 message_start 的响应保守拒算——
	// 分子/分母都不纳入、不写可计量 marker，真实落盘 assistant 只进 coverage.total。
	// 不得把完整 provider usage（50）除以局部窗口（300ms→167）冒充精确，也不得仅加 ~。
	assert.equal(h.markers.length, 0, '不得写可计量 marker');
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	// 真实落盘 + 持久化后边界校准：coverage 仍为 0/1（拒算不变，不双算）。
	await persistAndTurnEnd(h, finalMessage);
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('contract: 最后一个 delta 之后 reload、仅剩 message_end：同样拒算且计入 total', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'session_start', reason: 'startup' });
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100); // 1100
	await assistantDelta(h, 'x'.repeat(400));
	// reload 发生在最后一个 delta 之后：活动流被清除，之后仅收到 message_end。
	await h.driver.emit({ type: 'session_start', reason: 'reload' });
	h.clock.advance(400); // 1500
	const finalMessage = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 80, timestamp: 1_600 });
	await h.driver.emit({ type: 'message_end', message: finalMessage });
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h.markers.length, 0);
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	await persistAndTurnEnd(h, finalMessage);
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('contract: partial 流被新 empty failure assistant 替换：原流丢弃、空失败仅进 total', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });
	// partial 流：有内容但未正常结束（真实 pi-agent-core 异常路径不为其落盘 assistant）。
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100); // 1100
	await assistantDelta(h, 'x'.repeat(400));
	// 异常后 agent-core 生成新的空 failure assistant：其 message_start 打断原流。
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(50); // 1150
	const failureMessage = assistantMsg({ content: [], usageOutput: 0, stopReason: 'error', timestamp: 1_200 });
	await h.driver.emit({ type: 'message_end', message: failureMessage });
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	// 原流无对应落盘 assistant：丢弃，不进 TPS/coverage；空 failure 无内容零时长：
	// 只进 total（旧缺陷会显示虚假的 1/2）。
	assert.equal(h.markers.length, 0);
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
	// 真实只落盘空 failure assistant（partial 未落盘）：校准后仍 0/1。
	await persistAndTurnEnd(h, failureMessage);
	assert.equal(h.driver.lastStatus(), '当轮 -- | 会话 -- tok/s | 已测 0/1');
});

test('contract: 重复终态（message_end 与 turn_end 重复）不双算', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	await assistantDelta(h, 'x'.repeat(400));
	h.clock.advance(400);
	const finalMessage = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 1_600 });
	await h.driver.emit({ type: 'message_end', message: finalMessage });
	const afterFirst = h.driver.lastStatus();
	assert.equal(afterFirst, '当轮 250 | 会话 250 tok/s | 已测 1/1');
	// 模拟真实落盘后持久化边界，以及重复的 message_end / turn_end 通知。
	await persistAndTurnEnd(h, finalMessage);
	assert.equal(h.driver.lastStatus(), afterFirst);
	await h.driver.emit({ type: 'message_end', message: finalMessage });
	await h.driver.emit({ type: 'turn_end', message: finalMessage });
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal(h.driver.lastStatus(), afterFirst);
	assert.equal(h.markers.length, 1);
});

test('contract: 启动与完整生命周期不注册任何计时器/进程资源', async () => {
	const originals = {
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		setImmediate: globalThis.setImmediate,
	};
	let timerCalls = 0;
	const count = <T extends (...args: never[]) => unknown>(fn: T) =>
		((...args: never[]) => {
			timerCalls += 1;
			return fn(...args);
		}) as T;
	globalThis.setTimeout = count(originals.setTimeout);
	globalThis.setInterval = count(originals.setInterval);
	globalThis.setImmediate = count(originals.setImmediate);
	try {
		const h = arrayHarness();
		const factoryResult = createSessionTpsExtension({ now: () => h.clock.now() })(h.driver.pi);
		assert.equal(factoryResult, undefined, '工厂应同步返回且无返回值');
		await h.driver.emit({ type: 'session_start', reason: 'startup' });
		await h.driver.emit({ type: 'agent_start' });
		await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		h.clock.advance(100);
		await assistantDelta(h, 'x'.repeat(400));
		h.clock.advance(400);
		await h.driver.emit({
			type: 'message_end',
			message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 1_600 }),
		});
		await h.driver.emit({ type: 'agent_settled', aborted: false });
		await h.driver.emit({ type: 'session_shutdown' });
		assert.equal(timerCalls, 0, '不得调用 setTimeout/setInterval/setImmediate');
	} finally {
		globalThis.setTimeout = originals.setTimeout;
		globalThis.setInterval = originals.setInterval;
		globalThis.setImmediate = originals.setImmediate;
	}
});

test('contract: 非 TUI 模式零终端 UI 调用，统计与 marker 照常', async () => {
	for (const mode of ['rpc', 'json', 'print']) {
		const h = arrayHarness(mode);
		await h.driver.emit({ type: 'session_start', reason: 'startup' });
		await h.driver.emit({ type: 'agent_start' });
		await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		h.clock.advance(100);
		await assistantDelta(h, 'x'.repeat(400));
		h.clock.advance(400);
		await h.driver.emit({
			type: 'message_end',
			message: assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 100, timestamp: 1_600 }),
		});
		await h.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(h.driver.statusCalls.length, 0, `mode=${mode} 不应调用 setStatus`);
		assert.equal(h.markers.length, 1, `mode=${mode} 统计与 marker 照常`);
	}
});

test('contract: Unicode 代理对任意分割与整块最终估算一致（同一逻辑流内配对）', async () => {
	// 12 个 CJK 扩展 B 星面字符（surrogate pair）：整块 = 12 cjk → ceil(12/1.5) = 8 tokens；
	// 若按 code unit 拆开各计 plain：24 plain → ceil(24/4) = 6（旧缺陷值）。
	const astral = '\uD840\uDC00'.repeat(12);
	const expectedTokens = 8;

	/** 按给定切分尺寸循环切块，逐 delta 发送（每 delta 间隔 1ms）。 */
	async function runSplit(sizes: number[]): Promise<number> {
		const h = arrayHarness();
		await h.driver.emit({ type: 'agent_start' });
		await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
		h.clock.advance(100);
		let index = 0;
		let sizeIndex = 0;
		while (index < astral.length) {
			const size = sizes[sizeIndex % sizes.length];
			const chunk = astral.slice(index, index + size);
			await assistantDelta(h, chunk);
			h.clock.advance(1);
			index += chunk.length;
			sizeIndex += 1;
		}
		const finalMessage = assistantMsg({ content: [textPart(astral)], usageOutput: 0, timestamp: 2_000 });
		await h.driver.emit({ type: 'message_end', message: finalMessage });
		await h.driver.emit({ type: 'agent_settled', aborted: false });
		assert.equal(h.markers.length, 1);
		return (h.markers[0].data as { estimatedTokens: number }).estimatedTokens;
	}

	// 整块单 delta。
	assert.equal(await runSplit([astral.length]), expectedTokens);
	// 逐 code unit（每个 high/low 各自成 delta，切在代理对中间）。
	assert.equal(await runSplit([1]), expectedTokens);
	// 任意确定性切法：切在代理对中间/对齐交替、大块、重复事1+2+3 循环。
	assert.equal(await runSplit([3, 1, 2]), expectedTokens);
	assert.equal(await runSplit([5, 2]), expectedTokens);
	assert.equal(await runSplit([7]), expectedTokens);
	assert.equal(await runSplit([2, 2, 1, 4]), expectedTokens);
});

test('contract: 相邻逻辑流不拼出不存在的代理对', async () => {
	// text 末尾挂起 high surrogate，thinking 开头 low surrogate：
	// 正确（不跨流拼接）：8 plain + 8 plain = 16 → ceil(16/4) = 4；
	// 错误（跨流拼成代理对）：7+7 plain + 1 cjk → ceil(3.5+0.667) = 5。
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
	await assistantDelta(h, 'a'.repeat(7) + '\uD840'); // text 流末尾挂起 high
	h.clock.advance(100);
	await assistantDelta(h, '\uDC00' + 'b'.repeat(7), 'thinking_delta'); // thinking 流 low 开头
	h.clock.advance(300);
	const finalMessage = assistantMsg({
		content: [
			{ type: 'text', text: 'a'.repeat(7) + '\uD840' },
			{ type: 'thinking', thinking: '\uDC00' + 'b'.repeat(7) },
		],
		usageOutput: 0,
		stopReason: 'stop',
		timestamp: 1_700,
	});
	await h.driver.emit({ type: 'message_end', message: finalMessage });
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal((h.markers[0].data as { estimatedTokens: number }).estimatedTokens, 4);

	// toolArguments 流同理：末尾未配对 high surrogate 结束时闭合为 1 plain
	// （与整块 countChars 一致：'z'*7+'\uD842' = 8 plain → 2 tokens）。
	const h2 = arrayHarness();
	await h2.driver.emit({ type: 'agent_start' });
	await h2.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h2.clock.advance(100);
	await assistantDelta(h2, 'z'.repeat(7) + '\uD842', 'toolcall_delta');
	h2.clock.advance(100);
	await h2.driver.emit({
		type: 'message_end',
		message: assistantMsg({
			content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'z'.repeat(7) + '\uD842' } }],
			usageOutput: 0,
			stopReason: 'toolUse',
			timestamp: 1_300,
		}),
	});
	await h2.driver.emit({ type: 'agent_settled', aborted: false });
	assert.equal((h2.markers[0].data as { estimatedTokens: number }).estimatedTokens, 2);
});

test('contract: 重试幂等回归（后续 agent_start 不清零，两段分别计一次）', async () => {
	const h = arrayHarness();
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100); // 1100
	await assistantDelta(h, 'x'.repeat(400));
	h.clock.advance(400); // 1500：失败尝试（usage 零值 → 估算 100 tokens）
	const failure1 = assistantMsg({ content: [textPart('x'.repeat(400))], usageOutput: 0, stopReason: 'error', timestamp: 1_600 });
	await h.driver.emit({ type: 'message_end', message: failure1 });
	await persistAndTurnEnd(h, failure1);
	// 重试：新的 agent_start，轮未结束，不得清零。
	h.clock.advance(100); // 1600
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100); // 1700
	await assistantDelta(h, 'y'.repeat(200));
	h.clock.advance(800); // 2500
	const success = assistantMsg({ content: [textPart('y'.repeat(200))], usageOutput: 30, stopReason: 'stop', timestamp: 2_600 });
	await h.driver.emit({ type: 'message_end', message: success });
	await persistAndTurnEnd(h, success);
	await h.driver.emit({ type: 'agent_settled', aborted: false });
	// (100 估算 + 30 provider) / (400 + 800) ms ≈ 108 tok/s，含估算 → ~
	assert.equal(h.driver.lastStatus(), '当轮 ~108 | 会话 ~108 tok/s | 已测 2/2');
	assert.equal(h.markers.length, 2);
});

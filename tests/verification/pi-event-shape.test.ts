// 独立验证（round-2 P2）：真实 Pi 事件形状的 contentIndex 逻辑流身份（经适配层端到端）。
// 真实 pi-ai AssistantMessageEvent 的 text/thinking/toolcall delta 均携带 contentIndex:number
// （pi-ai dist/types.d.ts），本文件按该形状驱动扩展公共 API，验证：
// - 两条工具参数 JSON 流按 high/low 交错分割：估算与顺序发送、整块发送完全一致（20 tokens，
//   共享累加器的旧行为 18 已排除）；
// - 同类 text / thinking 独立块（不同 contentIndex）之间、以及相同 contentIndex 的
//   text/thinking/toolArguments 类别之间均不误拼代理对（不止单类别三桶比较）。
// 事件全部本地合成，无 LLM 请求。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTpsExtension } from '../../src/adapter/index.ts';
import {
	ExtensionDriver,
	FakeClock,
	type RealEntryLike,
	assistantMsg,
} from './harness.ts';

interface Harness {
	readonly driver: ExtensionDriver;
	readonly clock: FakeClock;
	readonly markers: Array<{ customType: string; data: unknown }>;
}

function harness(): Harness {
	const entries: RealEntryLike[] = [];
	const markers: Array<{ customType: string; data: unknown }> = [];
	const clock = new FakeClock(1_000);
	const driver = new ExtensionDriver({
		mode: 'tui',
		now: () => clock.now(),
		getBranch: () => [...entries],
		appendEntry: (customType, data) => {
			markers.push({ customType, data });
			entries.push({ id: `c-${markers.length}`, type: 'custom', customType, data });
		},
	});
	createSessionTpsExtension({ now: () => clock.now(), statusThrottleMs: 0 })(driver.pi);
	return { driver, clock, markers };
}

type DeltaKind = 'text_delta' | 'thinking_delta' | 'toolcall_delta';

/** 按真实 Pi 事件形状发送一条 delta（携带 contentIndex）。 */
async function piDelta(
	h: Harness,
	kind: DeltaKind,
	delta: string,
	contentIndex: number | undefined,
): Promise<void> {
	const event: Record<string, unknown> = {
		type: 'message_update',
		message: { role: 'assistant' },
		assistantMessageEvent: {
			type: kind,
			delta,
			...(contentIndex != null ? { contentIndex } : {}),
		},
	};
	h.clock.advance(1);
	await h.driver.emit(event);
}

async function startStream(h: Harness): Promise<void> {
	await h.driver.emit({ type: 'agent_start' });
	await h.driver.emit({ type: 'message_start', message: { role: 'assistant' } });
	h.clock.advance(100);
}

async function endStream(
	h: Harness,
	content: Array<Record<string, unknown>>,
	timestamp = 2_000,
): Promise<void> {
	h.clock.advance(100);
	await h.driver.emit({
		type: 'message_end',
		message: assistantMsg({ content, usageOutput: 0, stopReason: 'toolUse', timestamp }),
	});
	await h.driver.emit({ type: 'agent_settled', aborted: false });
}

function estimatedTokensOf(h: Harness): number {
	assert.equal(h.markers.length, 1, '应恰好写出一个 marker');
	const data = h.markers[0].data as { v: number; estimatedTokens: number };
	assert.equal(data.v, 2, 'marker 应为 v2');
	return data.estimatedTokens;
}

/** reviewer 反例内容：两条完整合法工具参数 JSON {"x":"<12×U+20000>"}。 */
const ASTRAL_PAIR = '\uD840\uDC00'; // U+20000（CJK 扩展 B，1 cjk 码点）
const ASTRAL_12 = ASTRAL_PAIR.repeat(12);
const JSON_PREFIX = '{"x":"';
const JSON_SUFFIX = '"}';

function toolCallPart(argsJson: string, id: string): Record<string, unknown> {
	return { type: 'toolCall', id, name: 'write', arguments: JSON.parse(argsJson) };
}

test('pi-shape: 两工具调用 JSON 参数 high/low 交错分割 = 顺序 = 整块，均为 20 tokens', async () => {
	const fullJson = `${JSON_PREFIX}${ASTRAL_12}${JSON_SUFFIX}`;
	// 正确独立累计：每流 8 plain + 12 cjk → 16 plain + 24 cjk → ceil(4+16)=20。
	// 共享累加器旧行为（A high→B high→A low→B low 交错）≈18，已排除。
	const expected = 20;

	// 送法 1：整块——每流一个 delta（contentIndex 0/1）。
	{
		const h = harness();
		await startStream(h);
		await piDelta(h, 'toolcall_delta', fullJson, 0);
		await piDelta(h, 'toolcall_delta', fullJson, 1);
		await endStream(h, [toolCallPart(fullJson, 't0'), toolCallPart(fullJson, 't1')]);
		assert.equal(estimatedTokensOf(h), expected, '整块');
	}

	// 送法 2：顺序——先完成流 0 的全部 code unit，再完成流 1。
	{
		const h = harness();
		await startStream(h);
		for (const unit of fullJson) await piDelta(h, 'toolcall_delta', unit, 0);
		for (const unit of fullJson) await piDelta(h, 'toolcall_delta', unit, 1);
		await endStream(h, [toolCallPart(fullJson, 't0'), toolCallPart(fullJson, 't1')]);
		assert.equal(estimatedTokensOf(h), expected, '顺序');
	}

	// 送法 3：reviewer 交错——两流前缀，再按 A high→B high→A low→B low 逐对交错，最后两流后缀。
	{
		const h = harness();
		await startStream(h);
		await piDelta(h, 'toolcall_delta', JSON_PREFIX, 0);
		await piDelta(h, 'toolcall_delta', JSON_PREFIX, 1);
		for (let i = 0; i < 12; i += 1) {
			const high = ASTRAL_12.charCodeAt(i * 2);
			const low = ASTRAL_12.charCodeAt(i * 2 + 1);
			await piDelta(h, 'toolcall_delta', String.fromCharCode(high), 0);
			await piDelta(h, 'toolcall_delta', String.fromCharCode(high), 1);
			await piDelta(h, 'toolcall_delta', String.fromCharCode(low), 0);
			await piDelta(h, 'toolcall_delta', String.fromCharCode(low), 1);
		}
		await piDelta(h, 'toolcall_delta', JSON_SUFFIX, 0);
		await piDelta(h, 'toolcall_delta', JSON_SUFFIX, 1);
		await endStream(h, [toolCallPart(fullJson, 't0'), toolCallPart(fullJson, 't1')]);
		assert.equal(estimatedTokensOf(h), expected, '交错');
		// 结算 status：估算 20 tokens / 窗口，~ 标记（usage 0 回退）。
		assert.match(String(h.driver.lastStatus()), /^当轮 ~\d+(\.\d+)? \| 会话 ~\d+(\.\d+)? tok\/s \| 已测 1\/1$/);
	}
});

test('pi-shape: 同类 text 两独立块（contentIndex 0/1）不互拼代理对', async () => {
	// text0='a'*7+'\uD840'（末尾挂起 high），text1='\uDC00'+'b'*7（开头 low）：
	// 独立流 → 8+8=16 plain → ceil(16/4)=4；误拼（跨流配成代理对）会是 5。
	const text0 = 'a'.repeat(7) + '\uD840';
	const text1 = '\uDC00' + 'b'.repeat(7);
	// 交错送达顺序也不得改变结果。
	{
		const h = harness();
		await startStream(h);
		for (let i = 0; i < 8; i += 1) {
			await piDelta(h, 'text_delta', text0[i], 0);
			await piDelta(h, 'text_delta', text1[i], 1);
		}
		await endStream(h, [
			{ type: 'text', text: text0 },
			{ type: 'text', text: text1 },
		]);
		assert.equal(estimatedTokensOf(h), 4, '交错');
	}
	{
		const h = harness();
		await startStream(h);
		await piDelta(h, 'text_delta', text0, 0);
		await piDelta(h, 'text_delta', text1, 1);
		await endStream(h, [
			{ type: 'text', text: text0 },
			{ type: 'text', text: text1 },
		]);
		assert.equal(estimatedTokensOf(h), 4, '整块');
	}
});

test('pi-shape: 同类 thinking 两独立块（contentIndex 0/2）不互拼代理对', async () => {
	const think0 = 'c'.repeat(7) + '\uD841';
	const think1 = '\uDF00' + 'd'.repeat(7);
	const h = harness();
	await startStream(h);
	// 交错：thinking 流 0 与流 2 逐字符交错。
	for (let i = 0; i < 8; i += 1) {
		await piDelta(h, 'thinking_delta', think0[i], 0);
		await piDelta(h, 'thinking_delta', think1[i], 2);
	}
	await endStream(h, [
		{ type: 'thinking', thinking: think0 },
		{ type: 'thinking', thinking: think1 },
	]);
	assert.equal(estimatedTokensOf(h), 4);
});

test('pi-shape: 相同 contentIndex 的 text/thinking/toolArguments 类别之间不误拼', async () => {
	// 三类别都用 contentIndex=0：text 末尾 high、thinking 开头 low、toolcall 末尾挂起 high。
	// 正确（类别隔离）：8+8+8=24 plain → ceil(24/4)=6；任何跨类别误拼会得 7。
	const text0 = 'e'.repeat(7) + '\uD840';
	const think0 = '\uDC00' + 'f'.repeat(7);
	const tool0 = 'g'.repeat(7) + '\uD842';
	const h = harness();
	await startStream(h);
	// 交错送达：text 流、thinking 流、toolcall 流交替推进。
	for (let i = 0; i < 8; i += 1) {
		await piDelta(h, 'text_delta', text0[i], 0);
		await piDelta(h, 'thinking_delta', think0[i], 0);
		await piDelta(h, 'toolcall_delta', tool0[i], 0);
	}
	await endStream(h, [
		{ type: 'text', text: text0 },
		{ type: 'thinking', thinking: think0 },
		{ type: 'toolCall', id: 't0', name: 'bash', arguments: { command: tool0 } },
	]);
	assert.equal(estimatedTokensOf(h), 6);
});

test('pi-shape: 带 contentIndex 的流与缺省流隔离；非法 contentIndex 归缺省流不抛错', async () => {
	// 流 0（text，带 contentIndex）末尾 high；缺省流（不传 contentIndex）开头 low：
	// 二者是不同逻辑流，不得配对 → 8+8=16 plain → 4。
	const indexed = 'h'.repeat(7) + '\uD840';
	const legacy = '\uDC00' + 'i'.repeat(7);
	{
		const h = harness();
		await startStream(h);
		await piDelta(h, 'text_delta', indexed, 0);
		await piDelta(h, 'text_delta', legacy, undefined);
		await endStream(h, [
			{ type: 'text', text: indexed },
			{ type: 'text', text: legacy },
		]);
		assert.equal(estimatedTokensOf(h), 4);
	}
	// 非法 contentIndex（NaN/-1/1.5/Infinity）确定性归入缺省流：与本流其余部分照常配对。
	{
		const h = harness();
		await startStream(h);
		await piDelta(h, 'text_delta', ASTRAL_PAIR[0], Number.NaN);
		await piDelta(h, 'text_delta', ASTRAL_PAIR[1], -1);
		await piDelta(h, 'text_delta', 'j'.repeat(5), 1.5);
		await piDelta(h, 'text_delta', 'k'.repeat(5), Number.POSITIVE_INFINITY);
		await endStream(h, [
			{ type: 'text', text: ASTRAL_PAIR + 'j'.repeat(5) + 'k'.repeat(5) },
		]);
		// 缺省流合并：1 cjk + 10 plain → ceil(10/4 + 1/1.5) = ceil(2.5+0.667) = 4。
		assert.equal(estimatedTokensOf(h), 4);
	}
});

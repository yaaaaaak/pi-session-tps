// TUI status 文本格式化（纯函数，便于针对 R1/R2 断言）。
// 口径：两个值清晰命名（当轮/会话）+ 单位 tok/s + 估算标记 ~ + measured/total 覆盖；
// 无有效时长显示 --（不夹成 1ms）；完成后保留最近一轮由内核保证。

import type { RoundStats, SessionStats, TpsStats } from '../core/index.ts';

function formatTps(stats: TpsStats): string {
  const { tokensPerSecond, estimated } = stats;
  if (tokensPerSecond == null || !Number.isFinite(tokensPerSecond)) return '--';
  const rounded = tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : Math.round(tokensPerSecond * 10) / 10;
  return estimated ? `~${rounded}` : `${rounded}`;
}

/** 组装一行 status 文本；初始/无数据显示 `当轮 -- | 会话 -- tok/s | 已测 0/0`。 */
export function formatStatusText(round: RoundStats, session: SessionStats): string {
  return `当轮 ${formatTps(round)} | 会话 ${formatTps(session)} tok/s | 已测 ${session.coverage.measured}/${session.coverage.total}`;
}

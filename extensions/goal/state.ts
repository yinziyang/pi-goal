// /goal 的命令解析、会话记录与状态还原，全部是纯函数。
//
// 目标的生命周期记在会话里，每次变化写一条 customType 为 GOAL_ENTRY 的条目：
//   - set：设定目标。
//   - end：目标结束，outcome 取 achieved（达成）、failed（被判定为不可能）、cleared（用户清除）、error（遇到必须人工处理的错误）。
// 会话条目随分支走，所以恢复会话、/tree 切换分支后，从当前分支的条目就能还原出目标状态。
// 轮数、耗时、token 这些计数不写进会话：与 Claude Code 一致，恢复会话时它们从零重新计。

import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

/** 会话条目的 customType。 */
export const GOAL_ENTRY = "pi-goal";

/** 条件长度上限，与 Claude Code 一致。 */
export const MAX_CONDITION_CHARS = 4000;

/** 清除目标的子命令及其别名，与 Claude Code 一致。 */
export const CLEAR_ALIASES = ["clear", "stop", "off", "reset", "none", "cancel"];

/**
 * 查看状态的别名，这是相对 Claude Code 有意增加的一处。
 * Claude Code 只把无参数的 /goal 当作查看状态，其余文字一律视为新条件。
 * 实测用户会输入「/goal 查看进度」来查询，结果被设成了一个无意义的新目标，已有目标还会被它替换掉。
 * 这些词不可能是有意义的完成条件，按查看状态处理不会误伤正常的目标。
 */
export const STATUS_ALIASES = ["status", "show", "progress", "状态", "进度", "查看", "查看进度", "查看状态", "进展", "查看进展"];

export type GoalCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "set"; condition: string }
	| { kind: "invalid"; message: string };

/** 解析 `/goal` 之后的参数：空或查看别名为查看状态，清除别名为清除，其余整段作为条件。 */
export function parseGoalCommand(args: string): GoalCommand {
	const text = args.trim();
	if (!text || STATUS_ALIASES.includes(text.toLowerCase())) return { kind: "status" };
	if (CLEAR_ALIASES.includes(text.toLowerCase())) return { kind: "clear" };
	if (text.length > MAX_CONDITION_CHARS) {
		return { kind: "invalid", message: `条件有 ${text.length} 个字符，超过上限 ${MAX_CONDITION_CHARS}。较长的要求请写进文件，在条件里引用文件路径。` };
	}
	return { kind: "set", condition: text };
}

export type GoalOutcome = "achieved" | "failed" | "cleared" | "error";

/** 一次目标运行的统计，只在内存里累计，写进 end 记录供状态查看。 */
export interface GoalStats {
	turns: number;
	tokens: number;
	durationMs: number;
}

export type GoalRecord =
	| { type: "set"; id: string; condition: string; at: number }
	| ({ type: "end"; id: string; condition: string; outcome: GoalOutcome; reason?: string; at: number } & Partial<GoalStats>);

/** 会话条目里本模块用到的最小结构，与 pi 的 SessionEntry 兼容。 */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function isGoalRecord(data: unknown): data is GoalRecord {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return (d.type === "set" || d.type === "end") && typeof d.id === "string" && typeof d.condition === "string";
}

/**
 * 从当前分支的条目还原目标状态。
 * active 是最后一个设定了、却还没有对应 end 记录的目标。
 * lastAchieved 是最近一次达成的目标，没有进行中的目标时，查看状态会展示它。
 */
export function restoreGoal(entries: EntryLike[]): { active?: { id: string; condition: string }; lastAchieved?: Extract<GoalRecord, { type: "end" }> } {
	let active: { id: string; condition: string } | undefined;
	let lastAchieved: Extract<GoalRecord, { type: "end" }> | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY || !isGoalRecord(entry.data)) continue;
		const record = entry.data;
		if (record.type === "set") {
			active = { id: record.id, condition: record.condition };
		} else {
			if (active?.id === record.id) active = undefined;
			if (record.outcome === "achieved") lastAchieved = record;
		}
	}
	return { active, lastAchieved };
}

/**
 * 判断一次失败是否属于必须由用户处理、自动重试也没用的错误。
 * 对齐 Claude Code 清除目标的四类：认证失败、额度耗尽、压缩后仍然上下文溢出、模型不可用。
 * 其余错误（限流、网络抖动、服务过载等）由 pi 自己的重试机制处理，重试仍失败时目标只暂停、不清除。
 * 返回命中的类别说明，未命中返回 null。
 *
 * pi 的错误只有文本、没有状态码，pi 自己判断重试与溢出也靠文本匹配，所以这里同样只能按文本归类。
 * 误判为清除的代价（目标丢失，要重新 /goal）高于误判为暂停（发条消息即可继续），拿不准的写法宁可不收。
 * 溢出直接用 pi-ai 的 isContextOverflow：它覆盖二十多家 provider 的写法，并排除了 Bedrock 限流「Too many tokens」这类假溢出，随 pi 升级同步更新。
 * 额度类的关键字对齐 pi-ai 不再重试的额度错误（utils/retry.ts 的 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN）。
 */
export function unrecoverableCause(errorMessage: string): string | null {
	if (isContextOverflow({ stopReason: "error", errorMessage } as AssistantMessage)) return "上下文溢出且压缩未能解决";
	const text = errorMessage.toLowerCase();
	const causes: Array<[RegExp, string]> = [
		[/\b(401|403)\b|unauthori[sz]ed|authentication|invalid[_ ]api[_ ]key|incorrect api key|not logged in|login required|expired token|invalid token/, "认证失败"],
		[/insufficient[_ ]quota|credit balance|out of credits|billing|payment required|\b402\b|usage limit|usagelimiterror|quota exceeded|out of budget|available balance/, "额度耗尽"],
		[/model[_ ]not[_ ]found|model .*does not exist|unknown model|unsupported model|model is not available|no such model|model is not supported|not_found_error.*\bmodel\b/, "模型不可用"],
	];
	for (const [re, cause] of causes) if (re.test(text)) return cause;
	return null;
}

/** 统计一组消息里助手发起的工具调用次数，用于判断这一轮是否有实际进展。 */
export function countToolCalls(messages: Array<{ role?: string; content?: unknown }>): number {
	let n = 0;
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall") n++;
	}
	return n;
}

/** 累计一组消息里助手回复的 token 用量。 */
export function sumTokens(messages: Array<{ role?: string; usage?: { totalTokens?: unknown } }>): number {
	let n = 0;
	for (const m of messages) if (m.role === "assistant" && typeof m.usage?.totalTokens === "number") n += m.usage.totalTokens;
	return n;
}

/** 把毫秒格式化成「3m 20s」这类短文本。 */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${sec}s`;
	return `${sec}s`;
}

/** 输入框下方右侧的目标指示文本，写法对齐 Claude Code 的「◎ /goal active」。 */
export function indicatorText(paused: boolean, elapsedMs: number): string {
	return `◎ /goal ${paused ? "paused" : "active"} · ${formatDuration(elapsedMs)}`;
}

/** 把 token 数格式化成「12.3k」这类短文本。 */
export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * 生成 `/goal` 无参数时展示的状态文本，内容与 Claude Code 一致。
 * 有进行中的目标：条件、已运行时长、已评估轮数、token 用量、最近一次评估理由；后两项在第一次评估后才出现。
 * 没有进行中的目标但本会话达成过：展示达成的条件及其时长、轮数、token。
 */
export function renderStatus(input: {
	active?: { condition: string; startedAt: number; stats: GoalStats; lastReason?: string; paused?: string };
	lastAchieved?: Extract<GoalRecord, { type: "end" }>;
	now: number;
}): string {
	const { active, lastAchieved, now } = input;
	if (active) {
		const lines = [`◎ /goal ${active.paused ? "已暂停" : "进行中"}：${active.condition}`, `已运行：${formatDuration(now - active.startedAt)}`];
		if (active.stats.turns > 0) {
			lines.push(`已评估：${active.stats.turns} 轮`);
			lines.push(`token：${formatTokens(active.stats.tokens)}`);
		}
		if (active.lastReason) lines.push(`最近一次评估：${active.lastReason}`);
		if (active.paused) lines.push(`已暂停：${active.paused}。发送任意消息即可继续。`);
		return lines.join("\n");
	}
	if (lastAchieved) {
		const parts = [lastAchieved.durationMs !== undefined ? formatDuration(lastAchieved.durationMs) : "", lastAchieved.turns !== undefined ? `${lastAchieved.turns} 轮` : "", lastAchieved.tokens !== undefined ? `${formatTokens(lastAchieved.tokens)} token` : ""].filter(Boolean);
		return `没有进行中的目标。本会话已达成：${lastAchieved.condition}${parts.length ? `（${parts.join("，")}）` : ""}`;
	}
	return "没有设定目标。用 /goal <完成条件> 设定一个。";
}

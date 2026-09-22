import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLEAR_ALIASES,
	countToolCalls,
	formatDuration,
	GOAL_ENTRY,
	indicatorText,
	MAX_CONDITION_CHARS,
	parseGoalCommand,
	renderStatus,
	restoreGoal,
	STATUS_ALIASES,
	sumTokens,
	unrecoverableCause,
} from "../extensions/goal/state.ts";

const entry = (data: unknown) => ({ type: "custom", customType: GOAL_ENTRY, data });

test("parseGoalCommand：空为状态，清除别名为清除，其余为条件", () => {
	assert.deepEqual(parseGoalCommand("  "), { kind: "status" });
	for (const alias of STATUS_ALIASES) assert.deepEqual(parseGoalCommand(` ${alias.toUpperCase()} `), { kind: "status" }, alias);
	assert.deepEqual(parseGoalCommand("查看进度并修复所有失败的测试"), { kind: "set", condition: "查看进度并修复所有失败的测试" }, "只有整段恰好是查看词时才算查看");
	for (const alias of CLEAR_ALIASES) assert.deepEqual(parseGoalCommand(alias.toUpperCase()), { kind: "clear" });
	assert.deepEqual(parseGoalCommand(" all tests pass "), { kind: "set", condition: "all tests pass" });
	assert.equal(parseGoalCommand("x".repeat(MAX_CONDITION_CHARS + 1)).kind, "invalid");
	assert.equal(parseGoalCommand("x".repeat(MAX_CONDITION_CHARS)).kind, "set");
});

test("restoreGoal：最后一个未结束的 set 为进行中，已结束的不恢复", () => {
	const r = restoreGoal([
		entry({ type: "set", id: "a", condition: "A", at: 1 }),
		entry({ type: "end", id: "a", condition: "A", outcome: "achieved", at: 2, turns: 3 }),
		entry({ type: "set", id: "b", condition: "B", at: 3 }),
	]);
	assert.deepEqual(r.active, { id: "b", condition: "B" });
	assert.equal(r.lastAchieved?.condition, "A");
	assert.equal(restoreGoal([entry({ type: "set", id: "c", condition: "C", at: 1 }), entry({ type: "end", id: "c", condition: "C", outcome: "cleared", at: 2 })]).active, undefined);
});

test("restoreGoal 忽略其他扩展的条目与格式不对的数据", () => {
	const r = restoreGoal([{ type: "custom", customType: "other", data: { type: "set", id: "x", condition: "X" } }, entry({ type: "set" }), entry(null)]);
	assert.deepEqual(r, { active: undefined, lastAchieved: undefined });
});

test("unrecoverableCause 只认四类必须人工处理的错误", () => {
	assert.equal(unrecoverableCause("401 Unauthorized: invalid api key"), "认证失败");
	assert.equal(unrecoverableCause("You exceeded your current quota: insufficient_quota"), "额度耗尽");
	assert.equal(unrecoverableCause("context_length_exceeded: prompt is too long"), "上下文溢出且压缩未能解决");
	assert.equal(unrecoverableCause("The model gpt-x does not exist"), "模型不可用");
	assert.equal(unrecoverableCause("429 Too Many Requests: rate limit reached"), null);
	assert.equal(unrecoverableCause("socket hang up"), null);
});

test("countToolCalls 与 sumTokens 只统计助手消息", () => {
	const msgs = [
		{ role: "user", content: [{ type: "toolCall" }] },
		{ role: "assistant", content: [{ type: "text" }, { type: "toolCall" }, { type: "toolCall" }], usage: { totalTokens: 100 } },
		{ role: "assistant", content: "纯文本", usage: { totalTokens: 50 } },
	];
	assert.equal(countToolCalls(msgs), 2);
	assert.equal(sumTokens(msgs), 150);
});

test("renderStatus：首次评估前不显示轮数与 token，暂停时说明如何继续", () => {
	const base = { condition: "测试通过", startedAt: 0, stats: { turns: 0, tokens: 0, durationMs: 0 } };
	const fresh = renderStatus({ active: base, now: 65_000 });
	assert.match(fresh, /进行中：测试通过/);
	assert.match(fresh, /已运行：1m 5s/);
	assert.doesNotMatch(fresh, /已评估/);
	const later = renderStatus({ active: { ...base, stats: { turns: 2, tokens: 12_345, durationMs: 0 }, lastReason: "还有 1 个用例失败", paused: "你中断了本轮" }, now: 1_000 });
	assert.match(later, /已评估：2 轮/);
	assert.match(later, /token：12\.3k/);
	assert.match(later, /最近一次评估：还有 1 个用例失败/);
	assert.match(later, /发送任意消息即可继续/);
	assert.match(later, /^◎ \/goal 已暂停：测试通过/, "暂停时开头不能写「进行中」");
	assert.match(renderStatus({ lastAchieved: { type: "end", id: "a", condition: "A", outcome: "achieved", at: 1, turns: 3, tokens: 2000, durationMs: 90_000 }, now: 0 }), /已达成：A（1m 30s，3 轮，2\.0k token）/);
	assert.match(renderStatus({ now: 0 }), /没有设定目标/);
});

test("formatDuration", () => {
	assert.equal(formatDuration(5_400), "5s");
	assert.equal(formatDuration(3_725_000), "1h 2m");
});

test("indicatorText 对齐 Claude Code 的写法，区分进行中与暂停", () => {
	assert.equal(indicatorText(false, 200_000), "◎ /goal active · 3m 20s");
	assert.equal(indicatorText(true, 5_000), "◎ /goal paused · 5s");
});

// pi-goal：为 pi 提供与 Claude Code 语义一致的 /goal。
//
// 设定一个完成条件后，agent 自动一轮接一轮地工作，每轮结束由一个独立的、不带工具的模型对照对话判断条件是否成立：
//   - 未达成：把评估理由作为指引，自动开始下一轮。
//   - 达成：清除目标，在会话里记一条达成记录。
//   - 不可能达成：清除目标，记一条失败记录及理由。
// 循环还会在以下情况停下：
//   - 连续 NO_PROGRESS_TURNS 轮没有工具调用：暂停，目标保留，用户下次发消息后恢复评估。
//   - 用户中断：暂停，同上。
//   - 必须人工处理的错误（认证、额度、上下文溢出、模型不可用）：清除目标并提示修复后重设。
//   - 其他错误：先交给 pi 自己的重试机制，重试仍失败则暂停。
//
// 事件时序是本扩展最关键的约束：
//   - 评估与续跑放在 agent_end。实测 pi -p 在 agent_settled 之后就拆掉会话，那时再续跑会因 ctx 失效而报错。
//   - 出错的轮次在 agent_end 时 pi 可能还会自动重试，所以错误留到 agent_settled 才做最终判定，那里只做同步记录、不再续跑。
//   - 同在 agent_end 续跑的其他扩展（例如收尾检查）也会排入消息，所以只为「用户」排队的消息让路，不为其他扩展的消息让路，与加载顺序无关。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { buildEvaluatorPrompt, EVALUATOR_SYSTEM_PROMPT, parseVerdict, resolveEvaluatorModel, serializeTranscript, type TranscriptEntry, type Verdict } from "./evaluator.ts";
import {
	countToolCalls,
	formatDuration,
	formatTokens,
	GOAL_ENTRY,
	type GoalOutcome,
	indicatorText,
	type GoalRecord,
	type GoalStats,
	parseGoalCommand,
	renderStatus,
	restoreGoal,
	sumTokens,
	unrecoverableCause,
} from "./state.ts";

/** 目标指示的小部件与状态键。 */
const INDICATOR_KEY = "pi-goal";

/** 续跑消息的 customType。评估时跳过这类消息，它们只是转述上一次的结论。 */
const CONTINUE_TYPE = "pi-goal-continue";

/** 连续多少轮没有工具调用就判定为没有进展，与社区实现 @narumitw/pi-goal 的默认值一致。 */
const NO_PROGRESS_TURNS = 3;

/** 无界面模式下等待指令轮开始的上限（毫秒）。正常在几十毫秒内开始，超时说明指令没有发出，命令直接返回。 */
const AGENT_START_TIMEOUT_MS = 30_000;

/**
 * 评估模型，形如 provider/modelId；不设置时用当前会话的模型。
 * 用环境变量配置，对应 Claude Code 的 ANTHROPIC_DEFAULT_HAIKU_MODEL，且只影响 /goal 评估。
 */
const EVALUATOR_MODEL_SPEC = process.env.PI_GOAL_MODEL;

interface ActiveGoal {
	id: string;
	condition: string;
	startedAt: number;
	stats: GoalStats;
	lastReason?: string;
	/** 暂停原因；有值表示循环已停、目标仍保留，用户下次发消息后恢复。 */
	paused?: string;
	noToolStreak: number;
}

type AgentMessageLike = { role?: string; content?: unknown; usage?: { totalTokens?: unknown }; stopReason?: string; errorMessage?: string; timestamp?: number };

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

export default function goal(pi: ExtensionAPI) {
	let active: ActiveGoal | undefined;
	let lastAchieved: Extract<GoalRecord, { type: "end" }> | undefined;
	let lifecycle = new AbortController();
	// 本轮运行期间用户是否排了消息（steer 或 followUp），agent_start 时清零。
	let userQueued = false;
	// 最近一轮以错误结束时的错误文本，留到 agent_settled 判定。
	let lastRunError: string | undefined;
	let modelWarningShown = false;
	// 等待下一次 agent_start 的回调，供无界面模式下的 /goal 命令确认指令轮已经开始。
	const startWaiters: Array<(started: boolean) => void> = [];

	const now = () => Date.now();

	/** 等下一次 agent_start；超时返回 false，避免指令因故没有发出时命令一直挂着。 */
	const nextAgentStart = (timeoutMs: number) =>
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				const i = startWaiters.indexOf(done);
				if (i >= 0) startWaiters.splice(i, 1);
				resolve(false);
			}, timeoutMs);
			const done = (started: boolean) => {
				clearTimeout(timer);
				resolve(started);
			};
			startWaiters.push(done);
		});

	/**
	 * 目标指示：交互界面里放在输入框正下方、右对齐，位置与 Claude Code 的「◎ /goal active」一致。
	 * 没有用 setStatus，因为内置底栏只会把扩展状态靠左拼成一行；也没有用 setFooter，那会替换整个内置底栏。
	 * 已运行时长在每次重绘时现算，不另起定时器。
	 * RPC 模式不支持组件类的小部件，改用 setStatus，让 RPC 客户端仍能拿到状态。
	 */
	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.setStatus(INDICATOR_KEY, active ? indicatorText(Boolean(active.paused), now() - active.startedAt) : undefined);
			return;
		}
		if (!active) {
			ctx.ui.setWidget(INDICATOR_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			INDICATOR_KEY,
			(_tui, theme) => ({
				render(width: number): string[] {
					if (!active) return [];
					const label = indicatorText(Boolean(active.paused), now() - active.startedAt);
					const styled = theme.fg(active.paused ? "warning" : "accent", label);
					const w = visibleWidth(label);
					return [w >= width ? truncateToWidth(styled, width) : `${" ".repeat(width - w)}${styled}`];
				},
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
	};

	/** 给用户的提示：有界面时用通知，print 模式写到 stderr，避免混进模型的最终输出。 */
	const say = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else if (ctx.mode === "print") process.stderr.write(`${text}\n`);
	};

	/** 目标结束的提示。交互界面里对话中已经有结束卡片，再弹通知是重复信息，所以只在没有卡片可看的模式下提示。 */
	const sayResult = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.mode !== "tui") say(ctx, text, level);
	};

	/**
	 * 命令的直接回显：有界面时用通知，print 模式写到 stdout。
	 * 实测 pi 在 print 模式下会把扩展写到 stdout 的内容转到 stderr，保证 stdout 只有模型的最终回答，所以在终端里可见，重定向 stdout 时不会混进去。
	 */
	const reply = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else if (ctx.mode === "print") process.stdout.write(`${text}\n`);
	};

	const endGoal = (ctx: ExtensionContext, outcome: GoalOutcome, reason?: string) => {
		if (!active) return;
		const record: GoalRecord = {
			type: "end",
			id: active.id,
			condition: active.condition,
			outcome,
			reason,
			at: now(),
			turns: active.stats.turns,
			tokens: active.stats.tokens,
			durationMs: now() - active.startedAt,
		};
		pi.appendEntry(GOAL_ENTRY, record);
		if (outcome === "achieved") lastAchieved = record;
		active = undefined;
		updateStatus(ctx);
	};

	const restore = (ctx: ExtensionContext) => {
		const restored = restoreGoal(ctx.sessionManager.getBranch());
		lastAchieved = restored.lastAchieved;
		// 与 Claude Code 一致：恢复时保留条件，轮数、计时与 token 基线从零重新计。
		active = restored.active ? { ...restored.active, startedAt: now(), stats: { turns: 0, tokens: 0, durationMs: 0 }, noToolStreak: 0 } : undefined;
		updateStatus(ctx);
	};

	/** 评估当前目标。模型调用失败、回复无法解析都抛异常，由调用方决定如何暂停。 */
	const evaluate = async (ctx: ExtensionContext, runMessages: AgentMessageLike[]): Promise<Verdict> => {
		if (!active) throw new Error("没有进行中的目标");
		const { model, warning } = resolveEvaluatorModel(EVALUATOR_MODEL_SPEC, ctx.model, (p, id) => ctx.modelRegistry.find(p, id));
		if (warning && !modelWarningShown) {
			modelWarningShown = true;
			say(ctx, `[goal] ${warning}`, "warning");
		}
		if (!model) throw new Error("当前没有可用的模型");

		const entries = ctx.sessionManager.buildContextEntries() as unknown as TranscriptEntry[];
		// 本轮最后一条助手消息是否已经写进会话不依赖事件时序：没找到就把本轮消息补在后面。
		const lastTs = [...runMessages].reverse().find((m) => m.role === "assistant")?.timestamp;
		const persisted = lastTs !== undefined && entries.some((e) => e.type === "message" && (e.message as AgentMessageLike | undefined)?.timestamp === lastTs);
		const all = persisted ? entries : [...entries, ...runMessages.map((message) => ({ type: "message", message }) as TranscriptEntry)];

		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: EVALUATOR_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: buildEvaluatorPrompt(active.condition, serializeTranscript(all, CONTINUE_TYPE)) }], timestamp: now() }],
			},
			{ signal: lifecycle.signal },
		);
		if (active) active.stats.tokens += response.usage?.totalTokens ?? 0;
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? `评估请求${response.stopReason === "aborted" ? "被中止" : "失败"}`);
		const verdict = parseVerdict(textOf(response.content));
		if (!verdict) throw new Error(`评估结果无法解析：${textOf(response.content).slice(0, 200)}`);
		return verdict;
	};

	pi.registerEntryRenderer(GOAL_ENTRY, (entry, _options, theme) => {
		const r = entry.data as GoalRecord;
		if (r.type === "set") return new Text(theme.fg("accent", `◎ 目标已设定：${r.condition}`), 0, 0);
		const stats = [r.durationMs !== undefined ? formatDuration(r.durationMs) : "", r.turns ? `${r.turns} 轮` : "", r.tokens ? `${formatTokens(r.tokens)} token` : ""].filter(Boolean).join("，");
		const suffix = stats ? `（${stats}）` : "";
		switch (r.outcome) {
			case "achieved":
				return new Text(theme.fg("success", `✓ 目标达成：${r.condition}${suffix}${r.reason ? `\n  ${r.reason}` : ""}`), 0, 0);
			case "failed":
				return new Text(theme.fg("error", `✗ 目标无法达成：${r.condition}${suffix}${r.reason ? `\n  ${r.reason}` : ""}`), 0, 0);
			case "error":
				return new Text(theme.fg("error", `✗ 目标因不可恢复的错误被清除：${r.reason ?? ""}\n  修复后重新执行 /goal 即可继续。`), 0, 0);
			default:
				return new Text(theme.fg("muted", `目标已清除：${r.condition}${r.reason ? `（${r.reason}）` : ""}`), 0, 0);
		}
	});

	pi.registerCommand("goal", {
		description: "设定完成条件并自动持续工作直到达成：/goal <条件> 设定；/goal 或 /goal status 查看进度；/goal clear 清除",
		handler: async (args, ctx) => {
			const cmd = parseGoalCommand(args);
			if (cmd.kind === "invalid") return reply(ctx, `[goal] ${cmd.message}`, "error");
			if (cmd.kind === "status") {
				return reply(ctx, renderStatus({ active: active && { ...active, stats: { ...active.stats } }, lastAchieved, now: now() }));
			}
			if (cmd.kind === "clear") {
				if (!active) return reply(ctx, "没有设定目标");
				const condition = active.condition;
				endGoal(ctx, "cleared");
				return reply(ctx, `已清除目标：${condition}`);
			}
			// 设定新目标：已有目标时被新目标替换。
			if (active) endGoal(ctx, "cleared", "被新目标替换");
			const record: GoalRecord = { type: "set", id: randomUUID(), condition: cmd.condition, at: now() };
			pi.appendEntry(GOAL_ENTRY, record);
			active = { id: record.id, condition: record.condition, startedAt: record.at, stats: { turns: 0, tokens: 0, durationMs: 0 }, noToolStreak: 0 };
			updateStatus(ctx);
			// 与 Claude Code 一致：设定目标立即开始一轮，条件本身就是指令。
			const directive =
				`${cmd.condition}\n\n` +
				"（以上是用 /goal 设定的完成条件。请持续工作直到它成立。每轮结束后，会有一个独立的评估者只根据对话内容判断是否达成，所以请把测试输出、命令结果等证据呈现在对话里。）";
			// print 与 json 模式在命令处理器返回后就结束运行，pi.sendUserMessage 不会被等待，发出的这一轮会被截断。
			// 所以这两种模式下先等这一轮开始，再等 agent 完全停下（含续跑），让 pi -p "/goal …" 一次跑完整个循环，与 Claude Code 一致。
			const headless = ctx.mode === "print" || ctx.mode === "json";
			const started = headless ? nextAgentStart(AGENT_START_TIMEOUT_MS) : undefined;
			if (ctx.isIdle()) pi.sendUserMessage(directive);
			else pi.sendUserMessage(directive, { deliverAs: "followUp" });
			if (started && (await started)) await ctx.waitForIdle();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lifecycle = new AbortController();
		userQueued = false;
		lastRunError = undefined;
		restore(ctx);
	});

	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("session_shutdown", () => {
		lifecycle.abort();
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		// 用户的新输入：恢复被暂停的评估，并重新计算无进展轮数。
		if (active) {
			active.paused = undefined;
			active.noToolStreak = 0;
			updateStatus(ctx);
		}
		if (event.streamingBehavior) userQueued = true;
		return { action: "continue" };
	});

	pi.on("agent_start", () => {
		userQueued = false;
		for (const resolve of startWaiters.splice(0)) resolve(true);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!active || active.paused) return;
		const messages = event.messages as unknown as AgentMessageLike[];
		const last = [...messages].reverse().find((m) => m.role === "assistant");
		if (last?.stopReason === "aborted") {
			active.paused = "你中断了本轮";
			updateStatus(ctx);
			say(ctx, "[goal] 已暂停：你中断了本轮，目标保留。发送任意消息即可继续。", "warning");
			return;
		}
		if (last?.stopReason === "error") {
			// pi 可能还会自动重试，留到 agent_settled 再做最终判定。
			lastRunError = last.errorMessage ?? "未知错误";
			return;
		}
		lastRunError = undefined;
		// 用户排了消息时让用户的消息先走，那一轮结束后再评估。
		if (userQueued && ctx.hasPendingMessages()) return;

		const goalId = active.id;
		active.stats.turns++;
		active.stats.tokens += sumTokens(messages);
		active.noToolStreak = countToolCalls(messages) > 0 ? 0 : active.noToolStreak + 1;

		let verdict: Verdict;
		try {
			verdict = await evaluate(ctx, messages);
		} catch (e) {
			if (lifecycle.signal.aborted || active?.id !== goalId) return;
			active.paused = `评估失败：${(e as Error).message}`;
			updateStatus(ctx);
			say(ctx, `[goal] 已暂停：评估失败（${(e as Error).message}），目标保留。发送任意消息即可继续。`, "warning");
			return;
		}
		// 等待评估期间会话被替换、目标被清除或替换，这次结果作废。
		if (lifecycle.signal.aborted || active?.id !== goalId) return;
		active.lastReason = verdict.reason;

		if (verdict.verdict === "met") {
			endGoal(ctx, "achieved", verdict.reason);
			sayResult(ctx, `[goal] ✓ 目标达成：${verdict.reason}`);
			return;
		}
		if (verdict.verdict === "impossible") {
			endGoal(ctx, "failed", verdict.reason);
			sayResult(ctx, `[goal] ✗ 评估者判定目标无法达成，已清除：${verdict.reason}`, "warning");
			return;
		}
		if (active.noToolStreak >= NO_PROGRESS_TURNS) {
			active.paused = `连续 ${active.noToolStreak} 轮没有调用任何工具，看起来没有进展`;
			updateStatus(ctx);
			say(ctx, `[goal] 已暂停：${active.paused}。目标保留，发送任意消息即可继续。`, "warning");
			return;
		}
		pi.sendMessage(
			{
				customType: CONTINUE_TYPE,
				content:
					`[/goal] 第 ${active.stats.turns} 轮评估：尚未达成。${verdict.reason}\n` +
					"继续朝下面的完成条件工作，不需要等待用户确认。评估者只根据对话内容判断，请把证据（测试输出、命令结果、文件内容）呈现在对话里。\n" +
					`<goal_condition>\n${active.condition}\n</goal_condition>`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		updateStatus(ctx);
	});

	// 出错轮次的最终判定。只做同步记录：print 模式在这之后就会拆掉会话，这里不能再等待或续跑。
	pi.on("agent_settled", (_event, ctx) => {
		if (!active || lastRunError === undefined) return;
		const error = lastRunError;
		lastRunError = undefined;
		const cause = unrecoverableCause(error);
		if (cause) {
			endGoal(ctx, "error", `${cause}：${error.slice(0, 300)}`);
			sayResult(ctx, `[goal] 目标因不可恢复的错误被清除（${cause}）。修复后重新执行 /goal 即可继续。`, "error");
			return;
		}
		active.paused = `本轮出错：${error.slice(0, 200)}`;
		updateStatus(ctx);
		say(ctx, `[goal] 已暂停：${active.paused}。目标保留，发送任意消息即可继续。`, "warning");
	});
}

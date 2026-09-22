// index.ts 事件时序的集成测试：在真实的 pi AgentSession 里加载扩展，用 pi-ai 的 faux provider 按脚本回复，跑完整个 /goal 循环。
//
// 覆盖的是 docs/knowledge.md「事件时序」一节依赖的 pi 行为：agent_end 续跑、出错轮次留到 agent_settled 判定、自动重试期间不误判、无界面模式下命令等循环结束才返回。
// 升级 pi 版本后先跑这里；这里通不过，说明 pi 的事件顺序或扩展 API 变了。
// 测不到的部分：TUI 渲染，以及 pi -p 在 agent_settled 之后拆掉会话的行为，这两处仍需手工回归。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { EVALUATOR_SYSTEM_PROMPT } from "../extensions/goal/evaluator.ts";
import { GOAL_ENTRY, type GoalRecord } from "../extensions/goal/state.ts";

const EXTENSION = new URL("../extensions/goal/index.ts", import.meta.url).pathname;
const EVALUATOR_MARK = EVALUATOR_SYSTEM_PROMPT.split("\n")[0];
const dir = mkdtempSync(join(tmpdir(), "pi-goal-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

interface RunResult {
	/** 按顺序记录的 agent 生命周期事件。 */
	events: string[];
	/** 本扩展写进会话的目标记录，end 记为 `end:<outcome>`。 */
	goal: string[];
	agentCalls: number;
	/** 每次评估请求收到的完整上下文文本。 */
	evalInputs: string[];
}

/**
 * 以无界面模式执行 `/goal <条件>`，干活轮与评估请求各按自己的脚本回复。
 * 脚本用完后干活轮回一句纯文本，评估回 not_met，避免测试因脚本写短而挂住。
 */
async function runGoal(agentSteps: AssistantMessage[], evalSteps: AssistantMessage[]): Promise<RunResult> {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
	const result: RunResult = { events: [], goal: [], agentCalls: 0, evalInputs: [] };
	const step = (context: unknown) => {
		const input = JSON.stringify(context);
		if (input.includes(EVALUATOR_MARK)) {
			result.evalInputs.push(input);
			return evalSteps[result.evalInputs.length - 1] ?? fauxAssistantMessage('{"verdict":"not_met","reason":"脚本已用完"}');
		}
		return agentSteps[result.agentCalls++] ?? fauxAssistantMessage("脚本已用完");
	};
	faux.setResponses(Array.from({ length: 50 }, () => step));

	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test");
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, additionalExtensionPaths: [EXTENSION], noSkills: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, [], "扩展加载失败");

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } }),
	});
	try {
		session.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "agent_settled" || event.type === "auto_retry_start") result.events.push(event.type);
			else if (event.type === "agent_end") result.events.push(`agent_end${event.willRetry ? "(willRetry)" : ""}`);
		});
		const extensionErrors: unknown[] = [];
		await session.bindExtensions({ mode: "print", commandContextActions: { waitForIdle: () => session.waitForIdle() }, onError: (e) => extensionErrors.push(e.error) });
		await session.prompt("/goal 完成任务");
		assert.deepEqual(extensionErrors, [], "扩展运行时报错");
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
			const record = entry.data as GoalRecord;
			result.goal.push(record.type === "end" ? `end:${record.outcome}` : "set");
		}
	} finally {
		session.dispose();
	}
	return result;
}

const verdict = (v: string, reason = "理由") => fauxAssistantMessage(JSON.stringify({ verdict: v, reason }));
const failed = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });
const withTool = (text: string) => fauxAssistantMessage([fauxText(text), fauxToolCall("ls", { path: "." })]);

test("未达成时在 agent_end 续跑，达成后清除目标；评估者看不到本扩展的续跑消息", async () => {
	const r = await runGoal([withTool("第一轮"), fauxAssistantMessage("工具结果已看"), withTool("第二轮"), fauxAssistantMessage("完成")], [verdict("not_met", "还差一步"), verdict("met")]);
	assert.deepEqual(r.goal, ["set", "end:achieved"]);
	assert.equal(r.evalInputs.length, 2);
	assert.deepEqual(r.events, ["agent_start", "agent_end", "agent_start", "agent_end", "agent_settled"], "续跑发生在同一次 settle 之前");
	assert.doesNotMatch(r.evalInputs[1], /第 1 轮评估/);
});

test("评估理由里含 } 时照常解析，不会暂停", async () => {
	const r = await runGoal([withTool("a"), fauxAssistantMessage("b"), withTool("c"), fauxAssistantMessage("d")], [verdict("not_met", "函数体 {} 还是空的"), verdict("met")]);
	assert.deepEqual(r.goal, ["set", "end:achieved"]);
});

test("可重试的错误交给 pi 自动重试，重试成功后照常评估", async () => {
	const r = await runGoal([failed("503 Service Unavailable"), fauxAssistantMessage("完成")], [verdict("met")]);
	assert.deepEqual(r.events, ["agent_start", "agent_end(willRetry)", "auto_retry_start", "agent_start", "agent_end", "agent_settled"]);
	assert.deepEqual(r.goal, ["set", "end:achieved"]);
	assert.equal(r.evalInputs.length, 1, "出错的那一轮不评估");
});

test("认证失败在 agent_settled 判定为不可恢复，清除目标", async () => {
	const r = await runGoal([failed('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')], []);
	assert.deepEqual(r.goal, ["set", "end:error"]);
	assert.equal(r.evalInputs.length, 0);
});

test("Bedrock 限流不算上下文溢出，只暂停、保留目标", async () => {
	const r = await runGoal([failed("Throttling error: Too many tokens, please wait before trying again.")], []);
	assert.deepEqual(r.goal, ["set"]);
});

test("连续 3 轮没有工具调用时暂停，不再续跑", async () => {
	const r = await runGoal([fauxAssistantMessage("想想"), fauxAssistantMessage("再想想"), fauxAssistantMessage("还在想")], [verdict("not_met"), verdict("not_met"), verdict("not_met")]);
	assert.deepEqual(r.goal, ["set"]);
	assert.equal(r.agentCalls, 3);
	assert.equal(r.evalInputs.length, 3);
});

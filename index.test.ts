/**
 * Tests for the tool layer against a mock `pi`, covering the parts that a
 * process-level test cannot reach: which tools get registered, what the model
 * actually reads back, and whether a promoted task reports itself when it ends.
 */
import assert from "node:assert";
import activate from "./index.ts";

const keepalive = setInterval(() => undefined, 1000);

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${name}`);
		console.log(`       ${error instanceof Error ? error.message : String(error)}`);
	}
}

interface SentMessage {
	message: { customType: string; content: string; display?: string; details?: unknown };
	options?: { triggerTurn?: boolean };
}

function mockPi() {
	const tools = new Map<string, any>();
	const sent: SentMessage[] = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: any, options?: any) {
			sent.push({ message, options });
		},
	};
	activate(pi as any);
	return { tools, sent };
}

function run(tool: any, args: Record<string, unknown>, signal?: AbortSignal) {
	const params = tool.prepareArguments ? tool.prepareArguments(args) : args;
	return tool.execute("call-1", params, signal, undefined, { cwd: process.cwd() });
}

/** Wait for a condition, so tests do not depend on fixed sleeps. */
async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("condition not met before timeout");
}

await test("registers bash, overriding the built-in, plus its companions", () => {
	const { tools } = mockPi();
	assert.ok(tools.has("bash"), "must register a tool literally named bash");
	assert.ok(tools.has("bash_bg_logs"));
	assert.ok(tools.has("bash_bg_kill"));
	// No "wait for task" tool: waiting is the behaviour being removed.
	assert.ok(!tools.has("bash_bg_wait"));
});

await test("fast command returns real output and is not promoted", async () => {
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "10000";
	const { tools } = mockPi();
	const result = await run(tools.get("bash"), { command: "echo quick-result" });
	assert.match(result.output, /quick-result/);
	assert.equal(result.details.promoted, false);
	assert.equal(result.details.exitCode, 0);
	assert.doesNotMatch(result.output, /STILL RUNNING/);
});

await test("slow command is promoted with an unmistakable result", async () => {
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "300";
	const { tools } = mockPi();
	const result = await run(tools.get("bash"), { command: "echo partial-line; sleep 3" });
	assert.equal(result.details.promoted, true);
	// The exact wording is the safety mechanism, so assert on it.
	assert.match(result.output, /STILL RUNNING/);
	assert.match(result.output, /has NOT finished/);
	assert.match(result.output, /exit code is NOT known/);
	assert.match(result.output, /Do not sleep or poll/);
	assert.match(result.output, /partial-line/, "partial output must be handed back");
	assert.match(result.output, new RegExp(result.details.taskId));
	tools.get("bash_bg_kill").execute("c", { taskId: result.details.taskId });
});

await test("a promoted task announces its own completion and wakes a turn", async () => {
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "200";
	const { tools, sent } = mockPi();
	const result = await run(tools.get("bash"), { command: "sleep 1; echo finished-later; exit 7" });
	assert.equal(result.details.promoted, true);
	assert.equal(sent.length, 0, "nothing should be announced while it is still running");

	await until(() => sent.length > 0);
	const [notification] = sent;
	assert.equal(notification.options?.triggerTurn, true, "completion must start a new turn");
	assert.equal(notification.message.customType, "bash-autobg-notification");
	assert.match(notification.message.content, /exit code 7/);
	assert.match(notification.message.content, /finished-later/, "output after promotion must reach the model");
	assert.match(notification.message.content, new RegExp(result.details.taskId));
});

await test("background:true skips the wait entirely", async () => {
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "60000";
	const { tools } = mockPi();
	const started = Date.now();
	const result = await run(tools.get("bash"), { command: "sleep 5", background: true });
	assert.ok(Date.now() - started < 1000, "must not wait for the threshold");
	assert.equal(result.details.promoted, true);
	tools.get("bash_bg_kill").execute("c", { taskId: result.details.taskId });
});

await test("an explicit short timeout still kills, and is not silently backgrounded", async () => {
	// The model asked for the command to die at that point; turning that into
	// backgrounding would override a direct instruction.
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "60000";
	const { tools } = mockPi();
	const result = await run(tools.get("bash"), { command: "sleep 10", timeout: 1 });
	assert.equal(result.details.promoted, false, "an explicit timeout must not promote");
	assert.match(result.output, /killed after the requested 1s timeout/);
});

await test("threshold of 0 disables promotion and restores blocking behaviour", async () => {
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "0";
	const { tools } = mockPi();
	const result = await run(tools.get("bash"), { command: "sleep 1; echo blocked-through" });
	assert.equal(result.details.promoted, false);
	assert.match(result.output, /blocked-through/);
});

await test("bash_bg_logs reports a running task and refuses to invent one", async () => {
	process.env.PI_BASH_AUTOBG_THRESHOLD_MS = "200";
	const { tools } = mockPi();
	const result = await run(tools.get("bash"), { command: "echo visible-now; sleep 3" });
	const logs = await tools.get("bash_bg_logs").execute("c", { taskId: result.details.taskId });
	assert.match(logs.output, /visible-now/);
	assert.match(logs.output, /still running/);
	const missing = await tools.get("bash_bg_logs").execute("c", { taskId: "bg_does_not_exist" });
	assert.match(missing.output, /No running background task/);
	tools.get("bash_bg_kill").execute("c", { taskId: result.details.taskId });
});

await test("empty commands are rejected before anything is spawned", () => {
	const { tools } = mockPi();
	const bash = tools.get("bash");
	assert.throws(() => bash.prepareArguments({ command: "   " }), /non-empty command/);
	assert.throws(() => bash.prepareArguments({}), /non-empty command/);
	assert.throws(() => bash.prepareArguments(null), /must be an object/);
});

delete process.env.PI_BASH_AUTOBG_THRESHOLD_MS;
clearInterval(keepalive);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

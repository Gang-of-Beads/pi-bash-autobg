/**
 * Tests for the process layer. These cover the four failure modes that make
 * promotion dangerous rather than merely convenient.
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { awaitWithDeadline, readOutputTail, startTask } from "./runner.ts";

// Promoted tasks are unref'd so a background command never holds pi hostage at
// exit. A bare test process has no other handles, so it would drain its event
// loop and exit mid-await. This keepalive stands in for the live pi session
// that keeps the loop alive in production.
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Is the process still alive? Signal 0 probes without delivering anything. */
function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

await test("fast command completes before the deadline and captures output", async () => {
	const handle = startTask({ command: "echo hello-from-task", cwd: process.cwd() });
	const outcome = await awaitWithDeadline(handle, 5000);
	assert.equal(outcome.done, true, "should finish inside the deadline");
	assert.equal(handle.record.exitCode, 0);
	assert.equal(handle.record.state, "exited");
	const { text } = readOutputTail(handle.record.outputPath, 4096);
	assert.match(text, /hello-from-task/);
});

await test("stderr lands in the same log as stdout", async () => {
	const handle = startTask({ command: "echo out; echo err 1>&2", cwd: process.cwd() });
	await awaitWithDeadline(handle, 5000);
	const { text } = readOutputTail(handle.record.outputPath, 4096);
	assert.match(text, /out/);
	assert.match(text, /err/);
});

await test("non-zero exit is reported as failed with its code", async () => {
	const handle = startTask({ command: "exit 3", cwd: process.cwd() });
	await awaitWithDeadline(handle, 5000);
	assert.equal(handle.record.exitCode, 3);
	assert.equal(handle.record.state, "failed");
});

await test("slow command misses the deadline and stays running", async () => {
	const handle = startTask({ command: "sleep 5", cwd: process.cwd() });
	const outcome = await awaitWithDeadline(handle, 150);
	assert.equal(outcome.done, false, "deadline should win");
	assert.equal(handle.record.state, "running");
	assert.ok(alive(handle.record.pid), "process must survive the missed deadline");
	handle.kill();
	await handle.completion;
});

await test("output written before promotion is preserved, and later output is appended", async () => {
	// The continuity guarantee: capture is file-backed from the first byte, so
	// promotion never has to hand over an in-memory buffer.
	const handle = startTask({ command: "echo early; sleep 1; echo late", cwd: process.cwd() });
	await awaitWithDeadline(handle, 300);
	const before = readOutputTail(handle.record.outputPath, 4096).text;
	assert.match(before, /early/, "output before promotion must already be on disk");
	assert.doesNotMatch(before, /late/);
	handle.detachFromTurn();
	await handle.completion;
	const after = readFileSync(handle.record.outputPath, "utf8");
	assert.match(after, /early/, "pre-promotion output must not be lost");
	assert.match(after, /late/, "post-promotion output must be appended to the same log");
});

await test("promoted task survives the turn being aborted", async () => {
	// The lifetime guarantee: without detachFromTurn the abort listener kills
	// the process the moment the turn ends, defeating the whole feature.
	const controller = new AbortController();
	const handle = startTask({ command: "sleep 5", cwd: process.cwd(), signal: controller.signal });
	await awaitWithDeadline(handle, 150);
	handle.detachFromTurn();
	controller.abort();
	await sleep(200);
	assert.ok(alive(handle.record.pid), "detached task must outlive the aborted turn");
	assert.notEqual(handle.record.state, "killed");
	handle.kill();
	await handle.completion;
});

await test("a non-promoted task is still killed when the turn aborts", async () => {
	const controller = new AbortController();
	const handle = startTask({ command: "sleep 5", cwd: process.cwd(), signal: controller.signal });
	await sleep(100);
	controller.abort();
	const record = await handle.completion;
	assert.equal(record.state, "killed", "an un-promoted task must not leak");
	assert.ok(!alive(record.pid));
});

await test("a command that reads stdin exits instead of hanging forever", async () => {
	// The zombie guarantee: stdin is closed, so an interactive command fails
	// fast rather than becoming a task that can never finish.
	const handle = startTask({ command: "cat", cwd: process.cwd() });
	const outcome = await awaitWithDeadline(handle, 3000);
	assert.equal(outcome.done, true, "reading stdin must not block forever");
});

await test("kill terminates the whole process group, not just the shell", async () => {
	const handle = startTask({ command: "sleep 30 & sleep 30", cwd: process.cwd() });
	await sleep(300);
	handle.kill();
	await handle.completion;
	await sleep(200);
	assert.ok(!alive(handle.record.pid));
});

await test("output tail is bounded and cut on a line boundary", async () => {
	const handle = startTask({ command: "for i in $(seq 1 4000); do echo line-$i; done", cwd: process.cwd() });
	await awaitWithDeadline(handle, 10_000);
	const { text, truncated, size } = readOutputTail(handle.record.outputPath, 1024);
	assert.equal(truncated, true);
	assert.ok(text.length <= 1024);
	assert.ok(size > 1024);
	assert.ok(!text.startsWith("ine-"), "tail must not start mid-line");
	assert.match(text, /line-4000/, "tail must keep the most recent output");
});

await test("a failure to spawn is reported, not thrown", async () => {
	const handle = startTask({ command: "true", cwd: "/definitely/not/a/real/directory" });
	const record = await handle.completion;
	assert.notEqual(record.state, "running");
	assert.ok(existsSync(record.outputPath));
});

await test("zero deadline promotes immediately", async () => {
	const handle = startTask({ command: "sleep 2", cwd: process.cwd() });
	const outcome = await awaitWithDeadline(handle, 0);
	assert.equal(outcome.done, false);
	handle.kill();
	await handle.completion;
});

clearInterval(keepalive);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

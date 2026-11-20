/**
 * The process side: run a shell command with file-backed output from the
 * first byte, so that handing it to the background later costs nothing.
 *
 * The whole point of this extension is that a command must be promotable
 * *while it runs*. That rules out capturing output in memory and switching
 * to a file at promotion time: the switch would drop whatever arrived in
 * between, and the promoted task would start with a truncated log. So output
 * goes to a file from the start, and promotion is nothing more than "stop
 * waiting for it".
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type TaskState = "running" | "exited" | "failed" | "killed";

export interface TaskRecord {
	id: string;
	command: string;
	cwd: string;
	outputPath: string;
	startedAt: number;
	/** Set once the process is no longer being awaited by the tool call. */
	promotedAt?: number;
	endedAt?: number;
	state: TaskState;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	pid?: number;
}

export interface RunHandle {
	record: TaskRecord;
	/** Resolves when the process exits. Never rejects. */
	completion: Promise<TaskRecord>;
	/** Stop the abort wiring so the process survives the end of the turn. */
	detachFromTurn(): void;
	kill(): void;
}

/** Where task output lives. One directory per session-agnostic install. */
export function tasksDir(): string {
	const base = process.env.PI_BASH_AUTOBG_DIR
		|| join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "bash-autobg");
	try {
		mkdirSync(base, { recursive: true });
		return base;
	} catch {
		const fallback = join(tmpdir(), "pi-bash-autobg");
		mkdirSync(fallback, { recursive: true });
		return fallback;
	}
}

/** Drop a task log. A missing file is the desired end state too. */
export function removeLog(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone; a missing log is the desired end state either way.
	}
}

/** Logs are only worth keeping while someone can still be told about them. */
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop stale logs left behind by earlier sessions (crash, quit, reload).
 *
 * Best-effort on purpose: it runs on every activation, so a single unreadable
 * entry must never be able to break the session. A task that has been running
 * with no output at all for a week goes too; the log is empty anyway.
 */
export function pruneLogs(maxAgeMs: number = LOG_MAX_AGE_MS): void {
	let dir: string;
	let names: string[];
	try {
		dir = tasksDir();
		names = readdirSync(dir);
	} catch {
		// An unreadable tasks directory is not a reason to fail activation.
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
		} catch {
			// Raced with a write or already removed; skip it.
		}
	}
}

function newTaskId(): string {
	return `bg_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/**
 * Read the tail of a task's output.
 *
 * Bounded on purpose: this feeds a tool result, and an unbounded read of a
 * multi-hundred-megabyte log would blow the context window that the promotion
 * was supposed to protect.
 */
export function readOutputTail(path: string, maxBytes: number): { text: string; truncated: boolean; size: number } {
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		return { text: "", truncated: false, size: 0 };
	}
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return { text: "", truncated: false, size };
	}
	if (raw.length <= maxBytes) return { text: raw.toString("utf8"), truncated: false, size };
	// Cut on a line boundary so the tail does not start mid-escape-sequence.
	const slice = raw.subarray(raw.length - maxBytes);
	const firstNewline = slice.indexOf(0x0a);
	const trimmed = firstNewline >= 0 && firstNewline < slice.length - 1 ? slice.subarray(firstNewline + 1) : slice;
	return { text: trimmed.toString("utf8"), truncated: true, size };
}

export interface StartOptions {
	command: string;
	cwd: string;
	/** Abort signal owned by the tool call; dropped on promotion. */
	signal?: AbortSignal;
	shell?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Start a command. The returned handle is awaited by the tool for as long as
 * the caller wants; promotion is `detachFromTurn()` plus walking away.
 */
export function startTask(options: StartOptions): RunHandle {
	const id = newTaskId();
	const outputPath = join(tasksDir(), `${id}.log`);
	const record: TaskRecord = {
		id,
		command: options.command,
		cwd: options.cwd,
		outputPath,
		startedAt: Date.now(),
		state: "running",
	};

	const fd = openSync(outputPath, "a");
	let child: ChildProcess;
	try {
		child = spawn(options.shell ?? process.env.SHELL ?? "/bin/bash", ["-lc", options.command], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			// stdin is closed, not inherited: a promoted command that asks for
			// input would otherwise wait forever with nobody able to answer it,
			// and "no output, never exits" is indistinguishable from a long
			// computation. Closing it turns that case into a fast, visible failure.
			stdio: ["ignore", fd, fd],
			detached: true,
		});
	} catch (error) {
		closeSync(fd);
		record.state = "failed";
		record.endedAt = Date.now();
		appendFileSync(outputPath, `pi-bash-autobg: failed to start: ${String(error)}\n`, "utf8");
		return {
			record,
			completion: Promise.resolve(record),
			detachFromTurn: () => undefined,
			kill: () => undefined,
		};
	}
	record.pid = child.pid;
	closeSync(fd);

	let onAbort: (() => void) | undefined;
	const detachFromTurn = (): void => {
		if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
		onAbort = undefined;
		record.promotedAt ??= Date.now();
		// Let the parent exit without waiting on this child.
		child.unref();
	};

	const kill = (): void => {
		if (child.pid === undefined) return;
		try {
			// Negative pid: the whole process group, because `bash -lc` almost
			// always has children of its own and killing only the shell leaves
			// them running.
			process.kill(-child.pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
		}
	};

	if (options.signal) {
		onAbort = () => {
			record.state = "killed";
			kill();
		};
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const completion = new Promise<TaskRecord>((resolve) => {
		child.once("exit", (code, signal) => {
			record.endedAt = Date.now();
			record.exitCode = code;
			record.signal = signal;
			if (record.state !== "killed") record.state = code === 0 ? "exited" : "failed";
			resolve(record);
		});
		child.once("error", (error) => {
			record.endedAt = Date.now();
			record.state = "failed";
			appendFileSync(outputPath, `\npi-bash-autobg: ${error.message}\n`, "utf8");
			resolve(record);
		});
	});

	return { record, completion, detachFromTurn, kill };
}

/** Wait for completion, or report that the deadline passed first. */
export async function awaitWithDeadline(
	handle: RunHandle,
	deadlineMs: number,
): Promise<{ done: true; record: TaskRecord } | { done: false }> {
	if (deadlineMs <= 0) return { done: false };
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<{ done: false }>((resolve) => {
		timer = setTimeout(() => resolve({ done: false }), deadlineMs);
		timer.unref?.();
	});
	const finished = handle.completion.then((record) => ({ done: true as const, record }));
	const result = await Promise.race([finished, deadline]);
	if (timer) clearTimeout(timer);
	return result;
}

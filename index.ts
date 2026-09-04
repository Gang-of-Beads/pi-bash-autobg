/**
 * pi-bash-autobg
 *
 * Overrides the built-in `bash` tool so a command that outlives a threshold is
 * handed to the background instead of blocking the agent.
 *
 * Why override rather than add another tool: the problem is precisely that the
 * model does *not* predict which commands are slow. A separate "run this in the
 * background" tool only helps when the model already knows, which is the case
 * that was never broken. Promotion has to happen on the call the model actually
 * made, so it has to be `bash`.
 *
 * pi merges extension tools over built-ins by name (agent-session builds a
 * definition registry from the built-ins, then `set`s every registered tool on
 * top), so registering `bash` here replaces the built-in for this session.
 */
import { Type, type Static } from "typebox";
import {
	awaitWithDeadline,
	readOutputTail,
	startTask,
	type RunHandle,
	type TaskRecord,
} from "./runner.ts";

const DEFAULT_THRESHOLD_MS = 60_000;
/** Bound on output echoed into a tool result or a completion notification. */
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_NOTIFY_BYTES = 8 * 1024;

const BashParams = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Force background execution immediately, returning a task handle without waiting. Omit to let the automatic threshold decide.",
		}),
	),
});
type BashParamsValue = Static<typeof BashParams>;

interface BashDetails {
	command: string;
	taskId: string;
	promoted: boolean;
	exitCode?: number | null;
	outputPath: string;
	elapsedMs: number;
}

function resolveThresholdMs(): number {
	const raw = process.env.PI_BASH_AUTOBG_THRESHOLD_MS;
	if (raw === undefined) return DEFAULT_THRESHOLD_MS;
	const parsed = Number(raw);
	// 0 disables promotion entirely, which is the documented escape hatch for
	// anyone who wants the stock blocking behaviour back.
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_THRESHOLD_MS;
	return parsed;
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m ${rem}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function describeExit(record: TaskRecord): string {
	if (record.state === "killed") return "killed";
	if (record.signal) return `terminated by ${record.signal}`;
	return `exit code ${record.exitCode ?? "unknown"}`;
}

/** Body of a normal, non-promoted result: identical in spirit to built-in bash. */
function renderCompleted(record: TaskRecord): string {
	const { text, truncated, size } = readOutputTail(record.outputPath, MAX_RESULT_BYTES);
	const head = `${describeExit(record)} in ${formatDuration((record.endedAt ?? Date.now()) - record.startedAt)}`;
	const body = text.length > 0 ? text : "(no output)";
	if (!truncated) return `${head}\n\n${body}`;
	return `${head}\n\n[output truncated to last ${MAX_RESULT_BYTES / 1024}KB of ${size} bytes; full log: ${record.outputPath}]\n${body}`;
}

/**
 * Body of a promoted result.
 *
 * This text is the whole safety story of the feature. The model asked for the
 * output of a command and is instead being told the command is still running,
 * so the result has to be impossible to misread as success. It states the
 * non-terminal state first, labels the partial output as partial, and says
 * plainly that the only correct next step is to stop waiting.
 */
function renderPromoted(record: TaskRecord, elapsedMs: number): string {
	const { text, truncated } = readOutputTail(record.outputPath, MAX_RESULT_BYTES);
	const lines = [
		`STILL RUNNING — moved to the background after ${formatDuration(elapsedMs)}.`,
		"",
		`This command has NOT finished and its exit code is NOT known yet. Do not report`,
		`it as passed, failed, or complete, and do not draw conclusions from the partial`,
		`output below.`,
		"",
		`task id: ${record.id}`,
		`pid: ${record.pid ?? "unknown"}`,
		`log: ${record.outputPath}`,
		"",
		`A <bash-autobg-notification> will arrive when it exits and will start a new turn.`,
		`Do not sleep or poll waiting for it. Continue with independent work, or end the`,
		`turn. Use bash_bg_logs only if you need the output produced so far.`,
		"",
		truncated ? "--- partial output (tail) ---" : "--- partial output so far ---",
		text.length > 0 ? text : "(nothing on stdout/stderr yet)",
	];
	return lines.join("\n");
}

export default function activate(pi: any): void {
	/** Tasks still running after promotion, so the companion tools can see them. */
	const promoted = new Map<string, { handle: RunHandle; record: TaskRecord }>();

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a shell command in the current working directory. Returns stdout and stderr. "
			+ `If the command is still running after ${formatDuration(resolveThresholdMs())}, it is automatically moved to the background: `
			+ "the call returns a task id and the partial output instead of blocking, and a notification starts a new turn when the command exits. "
			+ "Optionally provide a timeout in seconds, or set background:true to skip waiting entirely.",
		promptSnippet:
			"Run a shell command; long-running commands move to the background automatically instead of blocking",
		promptGuidelines: [
			"A STILL RUNNING result means the command has not finished. Never report its outcome; wait for the notification.",
			"Do not sleep or poll to wait for a promoted task; the completion notification starts a new turn on its own.",
			"Set background:true when you already know a command is long-running, to skip the waiting period.",
			"An explicit timeout shorter than the promotion threshold still kills the command, matching ordinary bash behaviour.",
		],
		parameters: BashParams,
		prepareArguments(args: unknown): BashParamsValue {
			if (!args || typeof args !== "object") throw new Error("bash arguments must be an object");
			const input = args as Record<string, unknown>;
			if (typeof input.command !== "string" || input.command.trim().length === 0) {
				throw new Error("bash requires a non-empty command string");
			}
			const prepared: BashParamsValue = { command: input.command };
			if (typeof input.timeout === "number") prepared.timeout = input.timeout;
			if (typeof input.background === "boolean") prepared.background = input.background;
			return prepared;
		},
		async execute(
			_toolCallId: string,
			params: BashParamsValue,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: any,
		) {
			const cwd = ctx?.cwd ?? process.cwd();
			const handle = startTask({ command: params.command, cwd, signal });
			const record = handle.record;

			const thresholdMs = resolveThresholdMs();
			const explicitTimeoutMs =
				typeof params.timeout === "number" && params.timeout > 0 ? params.timeout * 1000 : undefined;

			// An explicit timeout that fires before the promotion threshold keeps
			// its original meaning: the model asked for the command to be killed
			// at that point, and silently backgrounding it instead would ignore a
			// direct instruction.
			const hardTimeoutWins =
				explicitTimeoutMs !== undefined && (thresholdMs === 0 || explicitTimeoutMs <= thresholdMs);

			if (params.background === true) {
				handle.detachFromTurn();
				watchPromoted(handle);
				return result(renderPromoted(record, 0), record, true, 0);
			}

			const waitMs = hardTimeoutWins ? explicitTimeoutMs : thresholdMs;
			const outcome = await awaitWithDeadline(handle, waitMs);

			if (outcome.done) {
				return result(renderCompleted(outcome.record), outcome.record, false, elapsed(record));
			}

			if (hardTimeoutWins) {
				handle.kill();
				await handle.completion;
				const text = `${renderCompleted(record)}\n\n[killed after the requested ${params.timeout}s timeout]`;
				return result(text, record, false, elapsed(record));
			}

			// Promotion: drop the turn's abort wiring first, otherwise the process
			// is killed the moment this turn ends — which is exactly the thing the
			// promotion exists to prevent.
			handle.detachFromTurn();
			watchPromoted(handle);
			return result(renderPromoted(record, elapsed(record)), record, true, elapsed(record));
		},
	});

	function elapsed(record: TaskRecord): number {
		return Date.now() - record.startedAt;
	}

	function result(text: string, record: TaskRecord, wasPromoted: boolean, elapsedMs: number) {
		return {
			output: text,
			details: {
				command: record.command,
				taskId: record.id,
				promoted: wasPromoted,
				exitCode: record.exitCode,
				outputPath: record.outputPath,
				elapsedMs,
			} satisfies BashDetails,
		};
	}

	/** Deliver the terminal state of a promoted task and wake a turn. */
	function watchPromoted(handle: RunHandle): void {
		promoted.set(handle.record.id, { handle, record: handle.record });
		void handle.completion.then((record) => {
			promoted.delete(record.id);
			const { text, truncated } = readOutputTail(record.outputPath, MAX_NOTIFY_BYTES);
			const content = [
				`<bash-autobg-notification>`,
				`task ${record.id} finished: ${describeExit(record)} after ${formatDuration((record.endedAt ?? Date.now()) - record.startedAt)}.`,
				`command: ${record.command}`,
				`log: ${record.outputPath}`,
				"",
				truncated ? `--- output (last ${MAX_NOTIFY_BYTES / 1024}KB) ---` : "--- output ---",
				text.length > 0 ? text : "(no output)",
				`</bash-autobg-notification>`,
			].join("\n");
			try {
				pi.sendMessage(
					{
						customType: "bash-autobg-notification",
						content,
						display: `bash task ${record.id}: ${describeExit(record)}`,
						details: { taskId: record.id, state: record.state, exitCode: record.exitCode },
					},
					{ triggerTurn: true },
				);
			} catch {
				// A session that has already gone away is not an error worth
				// crashing a completion handler over.
			}
		});
	}

	const TaskIdParams = Type.Object({ taskId: Type.String({ description: "Task id from a promoted bash call" }) });

	pi.registerTool({
		name: "bash_bg_logs",
		label: "Background Logs",
		description:
			"Read the output produced so far by a bash call that was moved to the background. Inspection only; the completion notification arrives on its own.",
		parameters: TaskIdParams,
		async execute(_id: string, params: Static<typeof TaskIdParams>) {
			const entry = promoted.get(params.taskId);
			if (!entry) {
				return { output: `No running background task ${params.taskId}. It may have already finished; check the notification.` };
			}
			const { text, truncated, size } = readOutputTail(entry.record.outputPath, MAX_RESULT_BYTES);
			const head = `task ${params.taskId} still running for ${formatDuration(elapsed(entry.record))}`;
			return {
				output: `${head}${truncated ? ` (tail of ${size} bytes)` : ""}\n\n${text || "(no output yet)"}`,
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_kill",
		label: "Background Kill",
		description: "Stop a bash call that was moved to the background.",
		parameters: TaskIdParams,
		async execute(_id: string, params: Static<typeof TaskIdParams>) {
			const entry = promoted.get(params.taskId);
			if (!entry) return { output: `No running background task ${params.taskId}.` };
			entry.handle.kill();
			return { output: `Sent SIGTERM to task ${params.taskId} (pid ${entry.record.pid ?? "unknown"}).` };
		},
	});
}

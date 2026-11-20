# pi-bash-autobg

A pi extension that moves a long-running `bash` call to the background instead of
blocking the agent.

## The problem

An agent calls `bash` for a test suite. Twenty-four minutes later the tool call is
still `PENDING`, the session has done nothing else, and the only way out is to
interrupt it. Background-task tools do exist, but they only help when the model
*predicts* that a command will be slow — and the case that hurts is exactly the
one where it did not.

## What it does

It replaces the built-in `bash` tool. Short commands behave exactly as before.
If a command is still running after a threshold (60s by default), the call
returns instead of blocking:

```
STILL RUNNING — moved to the background after 1m 0s.

This command has NOT finished and its exit code is NOT known yet. Do not report
it as passed, failed, or complete, and do not draw conclusions from the partial
output below.

task id: bg_m8x2k1f3a9
log: ~/.pi/agent/bash-autobg/bg_m8x2k1f3a9.log
...
```

The command keeps running. When it exits, a `<bash-autobg-notification>` is
delivered with the output and starts a new turn.

Replacing `bash` rather than adding another tool is the point: promotion has to
happen on the call the model actually made. pi merges extension tools over
built-ins by name, so registering `bash` takes over for the session.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BASH_AUTOBG_THRESHOLD_MS` | `60000` | Promotion threshold. `0` disables promotion (stock blocking behaviour). |
| `PI_BASH_AUTOBG_DIR` | `~/.pi/agent/bash-autobg` | Where task logs are written. |

Per call:

- `background: true` — skip the wait and promote immediately.
- `timeout: <seconds>` — if shorter than the threshold, the command is **killed**
  at that point, as with ordinary `bash`. An explicit instruction to kill is not
  quietly turned into backgrounding.

## Log retention

A task log is deleted once its completion notification has been delivered and its
output tail was read in full. It is kept when the task failed (non-zero exit,
killed) or when the tail was truncated, because the log then still holds more
than the notification did. Whatever is left over from a crash, a quit or an
older session is pruned once it is more than seven days old, on startup.

## Companion tools

- `bash_bg_logs(taskId)` — output produced so far by a promoted task.
- `bash_bg_kill(taskId)` — stop one.

There is deliberately no "wait for task" tool. Waiting is the behaviour this
extension exists to remove; the completion notification arrives on its own.

## Design notes

Four things make promotion dangerous rather than merely convenient. Each has a
test in `runner.test.ts`.

**The model can misread the result.** It asked for output and gets "still
running". If that is phrased loosely it will be read as success and the agent
will confidently report passing tests it never saw. The result states the
non-terminal state first, labels partial output as partial, and says the only
correct next step is to stop waiting.

**Output continuity.** Capture is file-backed from the first byte. Buffering in
memory and switching to a file at promotion time would drop whatever arrived
during the switch, so the promoted task would start with a truncated log.
Promotion is nothing more than "stop waiting".

**Process lifetime.** The turn's abort signal kills the command — correct while
the tool is waiting, fatal immediately after promotion. Promotion detaches the
abort wiring first. An *un-promoted* task is still killed on abort, so nothing
leaks.

**Interactive commands.** A command blocked on stdin looks exactly like a long
computation: no output, never exits. Backgrounding one creates a task that can
never finish. stdin is closed, so such a command fails fast and visibly instead.

**Reload and shutdown.** A reload rebuilds the extension but not the process, so
the registry of promoted tasks is hung off a global symbol instead of the
closure: the reloaded instance still sees, and can kill, the tasks the old one
started. `session_shutdown` kills every task still running, since afterwards
nothing is left that could signal them.

## Tests

```
npx jiti ./runner.test.ts
```

## License

MIT. Original work; not derived from another extension.

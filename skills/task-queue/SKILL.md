---
name: task-queue
description: Decompose a user request into a queue of small tasks that each run in a fresh pi session, driven by the `task_queue` tool (or the /tasks slash commands) with actions add/list/remove/clear/next/retry/start/stop. Use when planning multi-step work, breaking a large request into steps, delegating steps to fresh sessions, or resuming interrupted work — keeps every session shallow so tokens-per-second stays fast.
---

# Task Queue: shallow-session planning with the `task_queue` tool

The `task-queue` extension (`~/.pi/agent/extensions/task-queue.ts`) runs queued
prompts **one at a time, each in a brand-new session** (cleared context, same
cwd / AGENTS.md / model). A task only starts after the previous one fully
settles. State persists in a JSON file under `~/.pi/agent/task-queue/` keyed by
cwd, so queues survive crashes and session reloads.

**You drive it with the `task_queue` tool.** It is the first-class, agent-facing
entry point; the `/tasks` slash commands are the same actions for a human at the
keyboard. Both hit the same queue.

### Why this beats one long session

Output tokens get slower and more expensive as context depth grows. One long
session accumulates every tool call, file read, and dead end from the whole job.
With the queue, **each task starts with near-zero context** and pays the
shallow-context speed premium again. The cost: a fresh session knows *nothing*
about previous tasks except what you put in its prompt and what earlier tasks
wrote to disk. Design for that.

## The tool

```jsonc
task_queue({ "action": "add", "prompt": "Read TASKLOG.md, then add retry() to src/client.ts; npm test -- retry must pass. Append a ≤5-line handoff entry to TASKLOG.md." })
```

| `action` | Args | Effect |
|---|---|---|
| `add` | `prompt`, or `prompts: [...]` for a batch in FIFO order | Queue work. If the queue is active and nothing else is running, the first task starts as soon as **this** turn settles — each in its own fresh session. |
| `list` | — | Show running `▶` + pending `•` with ids (returned after every action, so call `list` only when you need to re-read it). |
| `remove` | `id` | Drop a pending task. Refuses to drop the running one. |
| `clear` | — | Drop all pending tasks; the running task finishes on its own. |
| `next` | — | Start the next pending task now. Also takes over a **stale** claim left by a dead session. |
| `retry` | — | Requeue the running task (after Esc / crash / bad edit) and start it again. |
| `start` | — | Re-enable auto-run after a failure paused the queue. |
| `stop` | — | Let the running task finish, then stop. |

Each call returns plain text (the queue, with ids) plus structured
`details.queue` (`running`, `pending`, `autoStart`, `startWhenIdle`). Bad
arguments throw — read the message, fix the args, call again.

Batching a whole plan in one call is the normal move:

```jsonc
task_queue({ "action": "add", "prompts": [
  "Task 1 — scaffold: ... done when `npm run build` is clean. Append a ≤5-line handoff entry to TASKLOG.md.",
  "Task 2 — wire it: read TASKLOG.md, then ... done when ... Append ... TASKLOG.md.",
  "Task 3 — verify: run `npm test` and the smoke script; fix only what fails. Append ... TASKLOG.md."
]})
```

## The same actions as slash commands (for the human)

| Command | Effect |
|---|---|
| `/tasks add "..."` | Queue a prompt (starts immediately if idle and the queue is active) |
| `/tasks list` | Show running + pending tasks |
| `/tasks next` | Start the next pending task now, taking over a stale claim |
| `/tasks retry` | Requeue the running task and start it |
| `/tasks start` | Re-enable auto-run after a failure pause |
| `/tasks stop` | Finish the running task, then stop the queue |
| `/tasks remove [id]` | Drop a pending task by id |
| `/tasks clear` | Drop all pending tasks |

(`/tasks advance` exists too, but it is reserved for the extension's own
deferred dispatch — it advances only when nothing else owns the queue.)

## Workflow: decompose, enqueue, hand off via disk

### 1. Decompose the user's request

Break the request into tasks sized so each one **fits in a single short agent
turn-cycle** (roughly: one file, one function, one command, one check). Rules:

- **One observable outcome per task.** "Add `retry()` to client.ts with tests
  passing" — not "improve reliability".
- **Sequenced by dependency**, smallest first. A task may only depend on
  outputs of earlier tasks *as they exist on disk* (files, commits, logs).
- **End with a verification task** (run tests, smoke-check the flow) and, if
  useful, a cleanup/docs task.
- Typically 3–10 tasks. More than ~10 means a task is actually two.
- Prefer tasks that **commit their work** (git) so later sessions can see and
  revert state without any conversational memory.

### 2. Write each prompt as a self-contained brief

A fresh session sees only AGENTS.md + the task prompt. Every task prompt must
include, in this order:

1. **Goal** — one sentence, imperative.
2. **Inputs** — exact file paths / commands / error messages to look at. Never
   "as discussed before".
3. **Definition of done** — a checkable condition ("`npm test -- retry`
   passes", "endpoint returns 200 for the sample payload").
4. **Handoff instruction** — append a ≤5-line summary of what changed and any
   follow-ups to `TASKLOG.md` (see below), and *do not* start work from any
   later task.

Keep each prompt under ~150 words. If a prompt needs more, the decomposition
is wrong — the extra detail is either a missing earlier task or belongs in a
spec file the prompt points to.

### 3. Hand off with a minimal state file, not context

Sessions communicate through **one small file**, not through shared memory:

```markdown
<!-- TASKLOG.md at repo root; created by task 1 if absent -->
# Task log
## #1 done 2026-05-01
Added `retry()` in src/client.ts. Tests green.
Next-task notes: timeout budget is 5s; server returns 429 w/ Retry-After.
```

Rules that keep sessions efficient:

- **≤ ~30 lines total.** Each entry ≤5 lines: outcome + only the facts the
  *next* task needs. Details live in code, commits, and tests — link, don't
  paste.
- Each task reads `TASKLOG.md` first (one `read`), appends its entry last.
- This file is the entire inter-session protocol. If a fact isn't worth
  writing there, no later session needs it.

### 4. Enqueue, then stay out of the way

Queue the plan from the project directory (FIFO order) with one `add` call, then
**let the queue own the work**. Do not also perform those steps in the session
that queued them — its context is the supervising one and should stay shallow.
Watch progress in the TUI widget (running `▶`, pending `•`); re-read state with
`task_queue({ "action": "list" })` only when you need to act on it.

Recovery:

- Task failed/interrupted → queue pauses (auto-run off). Inspect, then
  `retry` (redo it) or `start` (skip ahead).
- Crash or orphaned claim → `next` requeues it and takes the queue over.
- Scope changed mid-flight → `remove`/`clear` the pending tail and re-plan;
  already-run tasks persist as real edits + `TASKLOG.md` entries.

## Semantics worth knowing

- **Failure pauses the queue.** If a task's last assistant message has stop
  reason `aborted` or `error`, auto-start is disabled and you get a notice —
  don't silently re-plan over it.
- **One runner per queue.** A running task is claimed by its session id. A
  queued `add` never steals it; only an explicit `next` / `retry` / `start`
  takes a stale claim over.
- **A task session must not nest.** The session running task #N can enqueue
  follow-ups, but they run after #N settles — it cannot start a sub-queue.
- **Busy defers, not blocks.** Queueing while the agent is streaming marks
  `startWhenIdle`; the task launches once things settle.
- **State is keyed by cwd** — queue and consume from the same project directory.

## Anti-patterns

- ❌ A task prompt referencing conversation history ("use the approach we
  agreed on") — it doesn't exist in the fresh session.
- ❌ Giant "do everything" tasks — defeats the shallow-context benefit.
- ❌ Pasting file contents or full diffs into subsequent prompts; point at
  paths/commits instead.
- ❌ Re-reading the whole repo per task to "get up to speed" — the prompt's
  Inputs section should scope exactly what to read.
- ❌ Letting `TASKLOG.md` grow into a journal; it is a handoff buffer, not a
  diary.
- ❌ Queueing two or three trivial steps that a single inline `edit` would
  finish — queueing has per-task startup cost, so it pays off for real steps,
  not for one-liners.

## Troubleshooting

- **No `task_queue` tool in the list:** the extension isn't loaded. Check
  `pi list`, and that the session didn't start with `--no-extensions` /
  `--no-tools` (those disable extension tools by design).
- **Tool is named `task_queue_2`:** another extension already claimed
  `task_queue`; use the suffixed name (it is what appears in the system prompt).
- **Nothing starts:** `list` the queue — `autoStart: false` means `start` it,
  and a `running` entry owned by another session means that session drives it.

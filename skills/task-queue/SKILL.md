---
name: task-queue
description: Decompose a user request into a queue of small tasks that each run in a fresh pi session via the task-queue extension (/tasks add|list|next|retry|start|stop|clear|remove). Use when planning multi-step work, breaking a large request into steps, or resuming interrupted work — keeps every session shallow so tokens-per-second stays fast.
---

# Task Queue: shallow-session planning with `/tasks`

The `task-queue` extension (`~/.pi/agent/extensions/task-queue.ts`) runs queued
prompts **one at a time, each in a brand-new session** (cleared context, same
cwd / AGENTS.md / model). A task only starts after the previous one fully
settles. State persists in a JSON file under `~/.pi/agent/task-queue/` keyed by
cwd, so queues survive crashes and session reloads.

## Why this beats one long session

Output tokens get slower and more expensive as context depth grows. One long
session accumulates every tool call, file read, and dead end from the whole
job. With the queue, **each task starts with near-zero context** and pays the
shallow-context speed premium again. The cost: a fresh session knows *nothing*
about previous tasks except what you put in its prompt and what earlier tasks
wrote to disk. Design for that.

## Commands

| Command | Effect |
|---|---|
| `/tasks add "..."` | Queue a prompt; starts immediately if idle and queue is active |
| `/tasks list` | Show running + pending tasks |
| `/tasks next` | Start the next pending task now (also takes over a stale claim from a dead session) |
| `/tasks retry` | Requeue the running task (e.g. after a crash/Esc) and start it |
| `/tasks start` | Re-enable auto-run after a failure pause |
| `/tasks stop` | Finish the running task, then stop the queue |
| `/tasks remove [id]` | Drop a pending task by id |
| `/tasks clear` | Drop all pending tasks (running task finishes on its own) |

Notes from the implementation:

- **Failure pauses the queue.** If a task's last assistant message has stop
  reason `aborted` or `error`, auto-start is disabled. Fix, then `/tasks start`
  (or `/tasks retry` for the failed task).
- **One runner per queue.** A running task is claimed by its session ID. From a
  second session, `/tasks next` requeues the stale claim and takes over.
- **Busy agent defers, not blocks.** Adding a task while the agent is busy
  marks `startWhenIdle`; it launches in a fresh session once things settle.
- State is **keyed by cwd** — queue and consume from the same project directory.

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

### 4. Enqueue and supervise

From the project directory, add tasks in dependency order (they run in FIFO
order):

```
/tasks add "Read TASKLOG.md, then ..."   # repeat per task
```

Then monitor with `/tasks list` (the TUI widget shows running ▶ and pending •).
If you are *delegating* the whole queue from a supervising session, do not also
do the work yourself in that session — its context should stay empty.

Recovery:

- Task failed/interrupted → queue paused → inspect, then `/tasks retry` (redo
  it) or `/tasks start` (skip ahead).
- Crash or orphaned claim → `/tasks next` takes over the queue.
- Scope changed mid-flight → `/tasks remove <id>` / `/tasks clear` pending and
  re-plan; already-run tasks persist as real edits + TASKLOG entries.

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

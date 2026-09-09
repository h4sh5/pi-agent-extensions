/**
 * task-queue: queue prompts that each run in a fresh session (cleared context).
 *
 * Two front doors onto one queue, so a human and the agent can drive the same
 * plan without stepping on each other:
 *
 *   - the `task_queue` tool      — the agent's obvious entry point (see below)
 *   - `/tasks ...`                — the human's slash command
 *
 * 1. Agent tool — `task_queue({ action, prompt?, prompts?, id? })`. Registered
 *    with `promptSnippet` + `promptGuidelines` so it is visible (and obvious)
 *    in the system prompt. Actions, identical to the slash subcommands:
 *
 *      add      queue `prompt` (or `prompts[]`, FIFO). Starts when this turn
 *               settles if the queue is active and nothing else runs it.
 *      list     show running ▶ + pending • with ids
 *      remove   drop a pending task by `id`
 *      clear    drop all pending tasks (running task finishes on its own)
 *      next     start the next pending task now, taking over a stale claim
 *      retry    requeue the running task (e.g. after a crash) and start it
 *      start    enable auto-run and resume
 *      stop     finish the running task, then stop the queue
 *
 *    Every action returns the current queue plus structured `details.queue`.
 *
 * 2. Human command — `/tasks add|list|remove|clear|next|retry|start|stop`, with
 *    `/tasks advance` reserved for pi's own deferred dispatch (auto-advance
 *    never steals a task another session is running; only explicit `next` /
 *    `retry` / `start` take a stale claim over).
 *
 * Neither event handlers nor tool execution own a command context (no
 * `newSession`), so starting from those paths dispatches a `/tasks …` user
 * message with `expandPromptTemplates`, which pi runs as a command context.
 *
 * State lives in a JSON file under the agent dir keyed by cwd, because the
 * extension runtime is torn down and reloaded on every session replacement.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Task {
  id: number;
  prompt: string;
}

interface RunningTask extends Task {
  sessionId: string | null;
}

interface QueueState {
  nextId: number;
  pending: Task[];
  running: RunningTask | null;
  autoStart: boolean;
  startWhenIdle: boolean;
}

/**
 * `/tasks next` is an explicit takeover (it may reclaim a stale claim from
 * another session), so it is only dispatched for explicit actions. Automatic
 * advances use `/tasks advance`, which never steals a running task.
 */
const ADVANCE_COMMAND = "/tasks advance";
const NEXT_COMMAND = "/tasks next";
const TOOL_BASE_NAME = "task_queue";
const QUEUE_ACTIONS = ["add", "list", "remove", "clear", "next", "retry", "start", "stop"] as const;
type QueueAction = (typeof QUEUE_ACTIONS)[number];

function emptyState(): QueueState {
  return { nextId: 1, pending: [], running: null, autoStart: true, startWhenIdle: false };
}

function stateFile(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  const base =
    cwd
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-24) || "root";
  return join(getAgentDir(), "task-queue", `${base}-${hash}.json`);
}

function load(cwd: string): QueueState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(cwd), "utf8"));
    return {
      ...emptyState(),
      ...raw,
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      running: raw.running && typeof raw.running === "object" ? raw.running : null,
    };
  } catch {
    return emptyState();
  }
}

function save(cwd: string, state: QueueState): void {
  const file = stateFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function mutate(cwd: string, fn: (state: QueueState) => void): QueueState {
  const state = load(cwd);
  fn(state);
  save(cwd, state);
  return state;
}

function truncate(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function updateWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui">, state: QueueState): void {
  if (!ctx.hasUI) return;
  const lines: string[] = [];
  if (state.running) lines.push(`▶ #${state.running.id} ${truncate(state.running.prompt)}`);
  for (const task of state.pending) lines.push(`• #${task.id} ${truncate(task.prompt)}`);
  ctx.ui.setWidget("task-queue", lines.length > 0 ? ["Tasks:", ...lines] : []);
}

function summarize(state: QueueState): string {
  const parts: string[] = [];
  if (state.running) parts.push(`running #${state.running.id} "${truncate(state.running.prompt, 40)}"`);
  if (state.pending.length > 0) {
    parts.push(`pending: ${state.pending.map((t) => `#${t.id}`).join(", ")}`);
  }
  if (!state.autoStart) parts.push("queue stopped");
  else if (state.startWhenIdle) parts.push("starts when idle");
  return parts.length > 0 ? parts.join(" · ") : "queue empty";
}

/** Machine-readable queue state, returned in the tool result `details`. */
function snapshot(state: QueueState) {
  return {
    running: state.running ? { id: state.running.id, prompt: state.running.prompt } : null,
    pending: state.pending.map((t) => ({ id: t.id, prompt: t.prompt })),
    autoStart: state.autoStart,
    startWhenIdle: state.startWhenIdle,
  };
}

/**
 * Render the queue the way both front doors show it: one line per task, ids
 * included so the agent can `remove` / `retry` by id without asking.
 */
function renderQueue(state: QueueState): string {
  const lines: string[] = [];
  if (state.running) lines.push(`▶ #${state.running.id} [running] ${truncate(state.running.prompt)}`);
  for (const task of state.pending) lines.push(`• #${task.id} ${truncate(task.prompt)}`);
  if (lines.length === 0) return "Queue is empty.";
  const footer = !state.autoStart
    ? "\n(queue stopped — action \"start\" resumes it)"
    : state.startWhenIdle
      ? "\n(starts as soon as this session is idle)"
      : "";
  return `${lines.length === 1 ? "1 entry" : `${lines.length} entries`}\n${lines.join("\n")}${footer}`;
}

function stripMatchingQuotes(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Ask pi to dispatch a `/tasks …` command. Neither event handlers nor tool
 * execution have a command context (no `newSession`), so the start happens in
 * the dispatched command, after the current turn settles.
 */
function requestCommand(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
  opts: { deliverAs?: "steer" | "followUp" } = {},
): void {
  try {
    pi.sendUserMessage(command, {
      expandPromptTemplates: true,
      ...(opts.deliverAs ? { deliverAs: opts.deliverAs } : {}),
    });
  } catch {
    // Could not dispatch; leave a breadcrumb for the next `agent_settled`.
    mutate(cwd, (state) => {
      state.autoStart = true;
      state.startWhenIdle = true;
    });
  }
}

/** Automatic advance: starts the next task only when nothing else owns the queue. */
function requestAdvance(pi: ExtensionAPI, cwd: string, opts: { deliverAs?: "steer" | "followUp" } = {}): void {
  requestCommand(pi, cwd, ADVANCE_COMMAND, opts);
}

/** Context `startNextTask` needs: a command context satisfies it, tests can fake it. */
type StartContext = Pick<
  ExtensionCommandContext,
  "cwd" | "hasUI" | "isIdle" | "sessionManager" | "ui" | "newSession"
>;

/** Claim the next pending task and run it in a brand-new session. */
async function startNextTask(
  ctx: StartContext,
  opts: { requeueStale?: boolean } = {},
): Promise<void> {
  const cwd = ctx.cwd;
  const state = load(cwd);
  const currentSessionId = ctx.sessionManager.getSessionId();

  if (state.running) {
    if (state.running.sessionId === currentSessionId) {
      ctx.ui.notify(`Task #${state.running.id} is already running in this session`, "warning");
      return;
    }
    if (!opts.requeueStale) {
      ctx.ui.notify(
        `Task #${state.running.id} is running in another session (${(state.running.sessionId ?? "?").slice(0, 8)}…). Remaining tasks will continue there. Use /tasks next here to take over the queue.`,
        "info",
      );
      return;
    }
    // The claim belongs to another (or dead) session. Since /tasks next and
    // /tasks start are explicit user actions, treat it as stale and requeue.
    const requeued = state.running;
    mutate(cwd, (s) => {
      s.running = null;
      if (!s.pending.some((t) => t.id === requeued.id)) {
        s.pending.unshift({ id: requeued.id, prompt: requeued.prompt });
      }
    });
    ctx.ui.notify(`Requeued stale task #${requeued.id} from another session.`, "info");
  }

  if (!ctx.isIdle()) {
    mutate(cwd, (s) => {
      s.autoStart = true;
      s.startWhenIdle = true;
    });
    updateWidget(ctx, load(cwd));
    ctx.ui.notify("Agent busy — task will start in a fresh session when idle", "info");
    return;
  }

  const fresh = load(cwd);
  const task = fresh.pending[0];
  if (!task) {
    updateWidget(ctx, fresh);
    ctx.ui.notify("No pending tasks", "info");
    return;
  }

  const result = await ctx.newSession({
    withSession: async (newCtx) => {
      const sessionId = newCtx.sessionManager.getSessionId();
      mutate(cwd, (s) => {
        s.pending = s.pending.filter((t) => t.id !== task.id);
        s.running = { id: task.id, prompt: task.prompt, sessionId };
      });
      try {
        await newCtx.sendUserMessage(task.prompt);
      } catch (err) {
        mutate(cwd, (s) => {
          s.running = null;
          s.pending.unshift(task);
          s.startWhenIdle = false;
        });
        try {
          newCtx.ui.notify(`Could not start task #${task.id}: ${err instanceof Error ? err.message : String(err)}`, "error");
        } catch {
          // ignore
        }
      }
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("New session cancelled — task stays queued. Use /tasks next to retry.", "warning");
  }
}

/**
 * Tool-path equivalent of `startNextTask`: a tool context has no `newSession`
 * (session control lives in command contexts only), so hand the start back to
 * pi by dispatching `/tasks next` as a command once this turn settles. If pi
 * refuses the dispatch, leave a `startWhenIdle` breadcrumb so the next
 * `agent_settled` advances the queue.
 */
function requestToolStart(pi: ExtensionAPI, cwd: string, mode: "advance" | "takeover"): void {
  if (mode === "advance") {
    if (load(cwd).running) return; // another session is driving; do not hijack it
    requestAdvance(pi, cwd, { deliverAs: "followUp" });
    return;
  }
  requestCommand(pi, cwd, NEXT_COMMAND, { deliverAs: "followUp" });
}

/** Detect whether the last assistant message aborted or errored. */
function detectFailure(ctx: ExtensionContext): "aborted" | "error" | null {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type: string; message?: { role?: string; stopReason?: string } };
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const reason = entry.message.stopReason;
        if (reason === "aborted") return "aborted";
        if (reason === "error") return "error";
        return null;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Queue operations — shared by the slash command and the agent tool so both
// front doors behave identically. Each op mutates state and reports in lines.
// ---------------------------------------------------------------------------

interface OpResult {
  /** Human/agent readable report (already user-facing text). */
  lines: string[];
  state: QueueState;
  /** `advance` = start next if free; `takeover` = reclaim a stale claim first. */
  wantsStart?: "advance" | "takeover";
}

function opList(cwd: string): OpResult {
  return { lines: [renderQueue(load(cwd))], state: load(cwd) };
}

function opAdd(cwd: string, prompts: string[]): OpResult {
  const clean = prompts.map((p) => stripMatchingQuotes(p ?? "")).filter((p) => p.length > 0);
  if (clean.length === 0) throw new Error('task_queue "add" needs a non-empty prompt (or prompts) string.');

  let firstId = 0;
  const state = mutate(cwd, (s) => {
    for (const prompt of clean) {
      if (firstId === 0) firstId = s.nextId;
      s.pending.push({ id: s.nextId, prompt });
      s.nextId += 1;
    }
  });

  const ids = clean.map((_, i) => `#${firstId + i}`).join(", ");
  const lines = [
    clean.length === 1
      ? `Queued task ${ids}: ${truncate(clean[0], 80)}`
      : `Queued ${clean.length} tasks (${ids}) in FIFO order.`,
  ];
  const started = !state.autoStart ? "queue stopped — use action \"start\"" : summarize(state);
  lines.push(`Queue: ${started}`);
  return { lines, state, wantsStart: state.autoStart ? "advance" : undefined };
}

function opRemove(cwd: string, id: number): OpResult {
  if (!Number.isFinite(id)) throw new Error('task_queue "remove" needs an integer id — check action "list" first.');
  const current = load(cwd);
  if (current.running?.id === id) {
    return {
      lines: [
        `Task #${id} is running and cannot be removed. Interrupt it with Esc (then action "stop"), or drop only the pending tasks with action "clear".`,
        renderQueue(current),
      ],
      state: current,
    };
  }
  let removed = false;
  const state = mutate(cwd, (s) => {
    const before = s.pending.length;
    s.pending = s.pending.filter((t) => t.id !== id);
    removed = s.pending.length < before;
  });
  return {
    lines: [removed ? `Removed task #${id}.` : `No pending task #${id}.`, renderQueue(state)],
    state,
  };
}

function opClear(cwd: string): OpResult {
  const state = mutate(cwd, (s) => {
    s.pending = [];
    s.startWhenIdle = false;
  });
  return {
    lines: [
      state.running
        ? "Pending tasks cleared. The running task finishes on its own."
        : "Task queue cleared.",
      renderQueue(state),
    ],
    state,
  };
}

function opStop(cwd: string): OpResult {
  const state = mutate(cwd, (s) => {
    s.autoStart = false;
    s.startWhenIdle = false;
  });
  return {
    lines: [
      state.running
        ? `Queue will stop after task #${state.running.id} finishes.`
        : "Queue stopped. Use action \"start\" to resume.",
      renderQueue(state),
    ],
    state,
  };
}

function opStart(cwd: string): OpResult {
  const state = mutate(cwd, (s) => {
    s.autoStart = true;
  });
  return {
    lines: [state.pending.length > 0 ? `Queue resumed — ${state.pending.length} task(s) pending.` : "Queue resumed.", renderQueue(state)],
    state,
    wantsStart: state.pending.length > 0 || state.running ? "takeover" : undefined,
  };
}

function opRetry(cwd: string): OpResult {
  const current = load(cwd);
  let requeued: RunningTask | null = null;
  if (current.running) {
    requeued = current.running;
    mutate(cwd, (s) => {
      s.running = null;
      if (!s.pending.some((t) => t.id === requeued!.id)) {
        s.pending.unshift({ id: requeued!.id, prompt: requeued!.prompt });
      }
    });
  }
  const state = load(cwd);
  return {
    lines: [
      requeued ? `Requeued task #${requeued.id} to run again.` : "No running task to retry — starting the next pending task instead.",
      renderQueue(state),
    ],
    state,
    wantsStart: state.pending.length > 0 || state.running ? "takeover" : undefined,
  };
}

function opNext(cwd: string): OpResult {
  const state = load(cwd);
  return {
    lines: [state.pending.length > 0 ? `Starting next pending task #${state.pending[0].id}.` : "No pending tasks.", renderQueue(state)],
    state,
    wantsStart: state.pending.length > 0 || state.running ? "takeover" : undefined,
  };
}

function runOp(action: QueueAction, cwd: string, args: { prompt?: string; prompts?: string[]; id?: number }): OpResult {
  switch (action) {
    case "list":
      return opList(cwd);
    case "add":
      return opAdd(cwd, [args.prompt, ...(args.prompts ?? [])].filter((p): p is string => typeof p === "string" && p.trim().length > 0));
    case "remove":
      return opRemove(cwd, args.id as number);
    case "clear":
      return opClear(cwd);
    case "next":
      return opNext(cwd);
    case "retry":
      return opRetry(cwd);
    case "start":
      return opStart(cwd);
    case "stop":
      return opStop(cwd);
    default:
      throw new Error(`Unknown task_queue action "${String(action)}". Use one of: ${QUEUE_ACTIONS.join(", ")}.`);
  }
}

/**
 * Pick a tool name that no other extension claimed. If `task_queue` is taken,
 * fall back to `task_queue_2`, `task_queue_3`, … so the queue stays drivable
 * instead of silently replacing someone else's tool.
 */
function resolveToolName(pi: ExtensionAPI, base: string): string {
  const taken = new Set<string>();
  try {
    for (const tool of pi.getAllTools()) taken.add(tool.name);
  } catch {
    return base; // tool registry not queryable yet
  }
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 20; n += 1) {
    if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }
  return `${base}_queue`;
}

export default function (pi: ExtensionAPI) {
  const toolName = resolveToolName(pi, TOOL_BASE_NAME);

  pi.on("session_start", async (_event, ctx) => {
    const state = load(ctx.cwd);
    updateWidget(ctx, state);
    if (state.running && state.running.sessionId === ctx.sessionManager.getSessionId()) {
      ctx.ui.notify(
        `Task #${state.running.id} belongs to the task queue. If it is stalled, use /tasks next to requeue it.`,
        "info",
      );
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const state = load(cwd);
    const sessionId = ctx.sessionManager.getSessionId();

    if (state.running && state.running.sessionId === sessionId) {
      const done = state.running;
      const failure = detectFailure(ctx);
      const next = mutate(cwd, (s) => {
        s.running = null;
      });
      updateWidget(ctx, next);

      if (failure) {
        mutate(cwd, (s) => {
          s.autoStart = false;
          s.startWhenIdle = false;
        });
        ctx.ui.notify(
          `Task #${done.id} ${failure === "aborted" ? "was interrupted" : "failed"} — queue paused. /tasks start to resume, /tasks clear to drop the rest.`,
          "warning",
        );
        return;
      }

      const remaining = load(cwd);
      if (remaining.autoStart && remaining.pending.length > 0) {
        ctx.ui.notify(`Task #${done.id} done. Starting #${remaining.pending[0].id} in a fresh session…`, "info");
        requestAdvance(pi, cwd);
      } else if (remaining.pending.length > 0) {
        ctx.ui.notify(`Task #${done.id} done. Queue is stopped — ${remaining.pending.length} task(s) remain. /tasks start`, "info");
      } else {
        ctx.ui.notify(`Task #${done.id} done. Queue complete ✔`, "info");
      }
      return;
    }

    if (!state.running && state.autoStart && state.startWhenIdle && state.pending.length > 0) {
      mutate(cwd, (s) => {
        s.startWhenIdle = false;
      });
      requestAdvance(pi, cwd);
    }
  });

  // -------------------------------------------------------------------------
  // Agent entry point: one tool, same actions as the slash command.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: toolName,
    label: "Task queue",
    description:
      "Queue work items that each run in a brand-new pi session (cleared context, same cwd/model), one at a time, FIFO. " +
      "Use it to hand a decomposed plan to fresh sessions instead of doing every step in one long session. " +
      "Actions: add (queue one prompt, or several via prompts[] in FIFO order; the first one starts as soon as this turn settles if the queue is active), " +
      "list (show running + pending with ids), remove (drop a pending task by id), clear (drop all pending tasks; the running task finishes on its own), " +
      "next (start the next pending task now, taking over a stale claim from a dead session), retry (re-run the running task after an interrupt/crash), " +
      "start (enable auto-run and resume after a failure paused the queue), stop (finish the running task, then stop). " +
      "Every action returns the current queue, so read ids from it before remove/retry.",
    promptSnippet: "Queue plan steps that each run in a fresh pi session (add/list/remove/clear/next/retry/start/stop)",
    promptGuidelines: [
      `Use ${toolName} when a request decomposes into several small steps: one ${toolName} add per step, each prompt self-contained (goal, exact file paths / commands, definition of done), because a queued task starts with zero memory of this session.`,
      `Queue with ${toolName} action "add" rather than doing every step inline, and keep each queued prompt to one observable outcome ending in a checkable condition.`,
      `After queueing with ${toolName}, do not also perform those same steps in this session — the queue owns them; keep this session shallow.`,
      `Use ${toolName} action "list" to read task ids before "remove", and action "start" after a failure paused the queue.`,
    ],
    parameters: Type.Object({
      action: StringEnum(QUEUE_ACTIONS, {
        description: `Queue operation to perform: ${QUEUE_ACTIONS.join(", ")}`,
      }),
      prompt: Type.Optional(
        Type.String({
          description: 'Self-contained prompt for action "add": goal, exact inputs (paths/commands), definition of done, and an instruction to append a ≤5-line handoff summary to TASKLOG.md.',
        }),
      ),
      prompts: Type.Optional(
        Type.Array(Type.String(), {
          description: `Multiple prompts for action "add", enqueued in FIFO order (equivalent to several ${toolName} add calls).`,
        }),
      ),
      id: Type.Optional(Type.Number({ description: 'Task id for action "remove" (see action "list").' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const currentSessionId = ctx.sessionManager.getSessionId();
      const result = runOp(params.action as QueueAction, cwd, {
        prompt: params.prompt,
        prompts: params.prompts,
        id: params.id,
      });

      updateWidget(ctx, result.state);

      // Running-task ownership is per session: never let a task session drive a
      // nested queue, and never steal another session's claim implicitly.
      let wantsStart = result.wantsStart;
      if (wantsStart && result.state.running?.sessionId === currentSessionId) {
        wantsStart = undefined;
        result.lines.push(
          `Not starting it from here: task #${result.state.running.id} is running in this session. Keep this prompt short, or let the task finish and advance the queue from a supervising session.`,
        );
      } else if (wantsStart === "advance" && result.state.running) {
        wantsStart = undefined;
        result.lines.push(`Another session is driving the queue; new tasks continue there. Use action "next" only to take the queue over.`);
      }

      if (wantsStart) requestToolStart(pi, cwd, wantsStart);

      return {
        content: [{ type: "text", text: result.lines.join("\n") }],
        details: { action: params.action, queue: snapshot(result.state) },
      };
    },
  });

  // Make sure the queue is drivable even in sessions that started with an
  // explicit tool allowlist (dispatch/background sessions, restricted presets).
  try {
    const active = pi.getActiveTools();
    const codingTools = ["read", "bash", "edit", "write"];
    const toolsEnabled = Array.isArray(active) && active.length > 0 && codingTools.some((t) => active.includes(t));
    if (toolsEnabled && !active.includes(toolName)) pi.setActiveTools([...active, toolName]);
  } catch {
    // setActiveTools is not bound yet; the default tool set includes custom tools.
  }

  pi.registerCommand("tasks", {
    description:
      "Queue prompts to run one-by-one in fresh sessions: /tasks add|list|remove|clear|next|start|stop",
    getArgumentCompletions: (prefix: string): { value: string; label: string }[] | null => {
      // Only complete the subcommand itself. As soon as the user starts typing
      // the task text (e.g. `/tasks add hello`), stop offering completions so
      // Enter submits the message instead of picking a completion.
      const typed = prefix.replace(/^\s+/, "");
      if (typed.includes(" ") || typed === "add") return null;
      const subs: string[] = [...QUEUE_ACTIONS];
      const items = subs
        .filter((s) => s.startsWith(typed))
        .map((s) => ({ value: `${s} `, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(" ");
      const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

      // Internal: dispatched by pi itself to continue the queue. Never takes
      // over a task another session is running.
      if (sub === "advance") {
        await startNextTask(ctx);
        return;
      }

      // `add` keeps its own argument handling: the whole remainder is the
      // prompt, quotes and all, so `/tasks add "a; b; c"` works verbatim.
      if (sub === "add") {
        const prompt = stripMatchingQuotes(rest);
        if (!prompt) {
          ctx.ui.notify('Usage: /tasks add "next task..."', "warning");
          return;
        }
        const report = opAdd(cwd, [prompt]);
        updateWidget(ctx, report.state);
        const position = report.state.running
          ? `after #${report.state.running.id}`
          : report.state.pending.length === 1
            ? "immediately"
            : `position ${report.state.pending.length}`;
        ctx.ui.notify(`Queued task #${report.state.pending[report.state.pending.length - 1]?.id ?? "?"} (${position}).`, "info");
        if (report.state.autoStart) await startNextTask(ctx);
        return;
      }

      if (sub === "" || sub === "list" || sub === "status") {
        const report = opList(cwd);
        updateWidget(ctx, report.state);
        if (renderQueue(report.state) === "Queue is empty.") {
          ctx.ui.notify('Task queue is empty. Add one with /tasks add "..."', "info");
          return;
        }
        ctx.ui.notify(report.lines.join("\n"), "info");
        return;
      }

      const action = QUEUE_ACTIONS.includes(sub as QueueAction) ? (sub as QueueAction) : null;
      if (!action) {
        ctx.ui.notify(
          `Unknown subcommand "${sub}". Try: ${[...QUEUE_ACTIONS].join(", ")} [id for remove]`,
          "error",
        );
        return;
      }

      const idArg = Number.parseInt(rest.trim(), 10);
      if (action === "remove" && !Number.isFinite(idArg)) {
        ctx.ui.notify("Usage: /tasks remove <id> (see /tasks list)", "warning");
        return;
      }
      const report = runOp(action, cwd, { id: idArg });
      updateWidget(ctx, report.state);
      for (const line of report.lines) ctx.ui.notify(line, "info");

      if (report.wantsStart) await startNextTask(ctx, { requeueStale: true });
    },
  });
}

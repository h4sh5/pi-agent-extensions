/**
 * task-queue: queue prompts that each run in a fresh session (cleared context).
 *
 * /tasks add "..."    Queue a prompt. If idle and queue is active, the queue
 *                     starts immediately: each task runs in a brand-new session
 *                     (same environment, AGENTS.md, model), after the previous
 *                     task has fully settled.
 * /tasks list         Show the queue.
 * /tasks remove [id]  Remove a pending task by id.
 * /tasks clear        Remove all pending tasks.
 * /tasks next         Start the next pending task now (also used internally).
 * /tasks retry        Requeue the running task (e.g. after a crash) and start it.
 * /tasks start        Enable auto-run and start the next task when idle.
 * /tasks stop         Stop the queue after the currently running task.
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

const ADVANCE_COMMAND = "/tasks next";

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

function updateWidget(ctx: ExtensionContext, state: QueueState): void {
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

/** Ask pi to dispatch `/tasks next` as a command (only context we have from events). */
function requestAdvance(pi: ExtensionAPI, cwd: string): void {
  try {
    pi.sendUserMessage(ADVANCE_COMMAND, { expandPromptTemplates: true });
  } catch {
    mutate(cwd, (state) => {
      state.startWhenIdle = true;
    });
  }
}

/** Claim the next pending task and run it in a brand-new session. */
async function startNextTask(
  ctx: ExtensionCommandContext,
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

export default function (pi: ExtensionAPI) {
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

  pi.registerCommand("tasks", {
    description:
      "Queue prompts to run one-by-one in fresh sessions: /tasks add|list|remove|clear|next|start|stop",
    getArgumentCompletions: (prefix: string): { value: string; label: string }[] | null => {
      // Only complete the subcommand itself. As soon as the user starts typing
      // the task text (e.g. `/tasks add hello`), stop offering completions so
      // Enter submits the message instead of picking a completion.
      const typed = prefix.replace(/^\s+/, "");
      if (typed.includes(" ") || typed === "add") return null;
      const subs = ["add", "list", "remove", "clear", "next", "retry", "start", "stop"];
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

      switch (sub) {
        case "":
        case "list":
        case "status": {
          const state = load(cwd);
          updateWidget(ctx, state);
          const lines: string[] = [];
          if (state.running) {
            const inThisSession = state.running.sessionId === ctx.sessionManager.getSessionId();
            lines.push(`▶ #${state.running.id} [running${inThisSession ? "" : " elsewhere"}] ${truncate(state.running.prompt)}`);
          }
          for (const task of state.pending) {
            lines.push(`• #${task.id} ${truncate(task.prompt)}`);
          }
          if (lines.length === 0) {
            ctx.ui.notify("Task queue is empty. Add one with /tasks add \"...\"", "info");
          } else {
            ctx.ui.notify(
              `${lines.length === 1 ? "" : `${lines.length} entries\n`}${lines.join("\n")}${state.autoStart ? "" : "\n(queue stopped — /tasks start)"}`,
              "info",
            );
          }
          return;
        }

        case "add": {
          const prompt = stripMatchingQuotes(rest);
          if (!prompt) {
            ctx.ui.notify('Usage: /tasks add "next task..."', "warning");
            return;
          }
          const state = mutate(cwd, (s) => {
            s.pending.push({ id: s.nextId, prompt });
            s.nextId += 1;
          });
          updateWidget(ctx, state);
          const position = state.running ? `after #${state.running.id}` : state.pending.length === 1 ? "immediately" : `position ${state.pending.length}`;
          ctx.ui.notify(`Queued task #${state.nextId - 1} (${position}).`, "info");
          if (!state.autoStart) return;
          await startNextTask(ctx);
          return;
        }

        case "remove": {
          const id = Number.parseInt(rest.trim(), 10);
          if (!Number.isFinite(id)) {
            ctx.ui.notify("Usage: /tasks remove [id] — see /tasks list", "warning");
            return;
          }
          const state = load(cwd);
          if (state.running?.id === id) {
            ctx.ui.notify(`Task #${id} is running — interrupt it with Esc first, or /tasks stop to halt the queue.`, "warning");
            return;
          }
          let removed = false;
          const next = mutate(cwd, (s) => {
            const before = s.pending.length;
            s.pending = s.pending.filter((t) => t.id !== id);
            removed = s.pending.length < before;
          });
          updateWidget(ctx, next);
          ctx.ui.notify(
            removed ? `Removed task #${id}.` : `No pending task #${id}.`,
            removed ? "info" : "warning",
          );
          return;
        }

        case "clear": {
          const next = mutate(cwd, (s) => {
            s.pending = [];
            s.startWhenIdle = false;
          });
          updateWidget(ctx, next);
          ctx.ui.notify(
            next.running ? "Pending tasks cleared. The running task finishes on its own." : "Task queue cleared.",
            "info",
          );
          return;
        }

        case "next": {
          await startNextTask(ctx, { requeueStale: true });
          return;
        }

        case "retry": {
          const state = load(cwd);
          if (state.running) {
            const stale = state.running;
            mutate(cwd, (s) => {
              s.running = null;
              if (!s.pending.some((t) => t.id === stale.id)) {
                s.pending.unshift({ id: stale.id, prompt: stale.prompt });
              }
            });
            ctx.ui.notify(`Requeued task #${stale.id}.`, "info");
          }
          await startNextTask(ctx, { requeueStale: true });
          return;
        }

        case "start": {
          mutate(cwd, (s) => {
            s.autoStart = true;
          });
          await startNextTask(ctx, { requeueStale: true });
          return;
        }

        case "stop": {
          const next = mutate(cwd, (s) => {
            s.autoStart = false;
            s.startWhenIdle = false;
          });
          updateWidget(ctx, next);
          ctx.ui.notify(
            next.running
              ? `Queue will stop after task #${next.running.id} finishes.`
              : "Queue stopped. /tasks start to resume.",
            "info",
          );
          return;
        }

        default:
          ctx.ui.notify(
            `Unknown subcommand "${sub}". Try: add, list, remove [id], clear, next, retry, start, stop`,
            "error",
          );
      }
    },
  });
}

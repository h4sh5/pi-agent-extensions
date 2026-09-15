# Pi Agent Extensions

To use them, copy files from this repo into your ~/.pi/agent/

## Task Queue

Allows you to queue tasks that run one after the other with fresh context each time (to keep session contexts shallow).

This is especially useful for situations when you have small context (say 80k to 262k context), for example when using a single small locally hosted LLM.

Both the user and the agent can queue tasks. Agents can read skills/task-queue to learn how.

## Session Elapsed Time Extension

Prints the total elapsed time of the session (minutes:seconds, e.g. 120:30) at the end of each turn, shown as a widget line above the editor.

---

These extensions are written using Qwen 3.8 Flash Next.

/**
 * Session Elapsed Time Extension
 *
 * Prints the total elapsed time of the session (minutes:seconds, e.g. 120:30)
 * at the end of each turn, shown as a widget line above the editor.
 *
 * The clock is reset whenever a session starts (startup / new / resume / fork /
 * reload), so the value is the wall-clock time of the current session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "session-elapsed-time";

/** Format milliseconds as minutes:seconds (e.g. 7230s -> "120:30"). */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	// Wall-clock start of the current session; refreshed on every session_start.
	let sessionStart: number = Date.now();

	pi.on("session_start", async () => {
		sessionStart = Date.now();
	});

	pi.on("turn_end", async (_event, ctx) => {
		const elapsed = formatElapsed(Date.now() - sessionStart);
		const label = ctx.ui.theme.fg("dim", "⏱ session");
		const time = ctx.ui.theme.fg("accent", elapsed);
		ctx.ui.setWidget(WIDGET_KEY, [`${label} ${time}`]);
	});
}

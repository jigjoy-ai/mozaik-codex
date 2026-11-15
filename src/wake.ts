import { execFile } from "node:child_process"

/** Starts a turn in an idle session, so something that arrived is looked at without the user typing. */
export interface Wake {
	wake(sessionId: string, text: string): void
}

/**
 * `codex queue --thread <session> --message <text>` queues a message for an existing session
 * (Codex CLI reference). It is the one documented way to reach a session that is not in a turn.
 * What is queued arrives as the user's message, so it is only ever a note that there is something
 * to read: what a peer wrote is read with a tool, where it is someone else's words.
 */
export class CodexQueue implements Wake {
	constructor(private readonly command: string = process.env.MOZAIK_CODEX_COMMAND ?? "codex") {}

	wake(sessionId: string, text: string): void {
		// Not through a shell: neither the id nor the text is ever read as a command.
		execFile(this.command, ["queue", "--thread", sessionId, "--message", text], (error) => {
			if (error) console.error(`codex queue failed: ${error.message}`)
		})
	}
}

import { Message } from "./network-view"

/** What reached the session and Codex has not read yet. */
export type Unread = { messages: Message[]; notices: string[] }

/**
 * What reached this session from the network. Codex has no way for a server to put something
 * in front of the model, so nothing here shows by itself: the model reads it with a tool
 * (read_messages, wait_for_message), and is told that there is something to read at the points
 * Codex gives a server a say (its hooks).
 */
export class Inbox {
	private messages: Message[] = []
	/** What the network told the session itself: a refusal, or that it had to join again. */
	private notices: string[] = []
	/** How much of what is unread the model was already told about, so it is told once. */
	private told = { messages: 0, notices: 0 }
	private readonly waiting = new Set<() => void>()
	private readonly listeners = new Set<() => void>()

	received(message: Message): void {
		this.messages.push(message)
		this.arrived()
	}

	notice(text: string): void {
		this.notices.push(text)
		this.arrived()
	}

	hasUnread(): boolean {
		return this.messages.length > 0 || this.notices.length > 0
	}

	/** Everything unread, which is then read. */
	take(): Unread {
		const unread = { messages: this.messages, notices: this.notices }
		this.messages = []
		this.notices = []
		this.told = { messages: 0, notices: 0 }
		return unread
	}

	/** What is unread and the model has not been told about; telling it marks it as told. */
	untold(): Unread {
		const untold = {
			messages: this.messages.slice(this.told.messages),
			notices: this.notices.slice(this.told.notices),
		}
		this.told = { messages: this.messages.length, notices: this.notices.length }
		return untold
	}

	/** Resolves as soon as there is something unread, or with false once the time is up. */
	wait(ms: number): Promise<boolean> {
		if (this.hasUnread()) return Promise.resolve(true)

		return new Promise((resolve) => {
			const arrived = () => {
				clearTimeout(timer)
				this.waiting.delete(arrived)
				resolve(true)
			}
			const timer = setTimeout(() => {
				this.waiting.delete(arrived)
				resolve(false)
			}, ms)
			this.waiting.add(arrived)
		})
	}

	/** Calls `listener` whenever something arrives. */
	onArrival(listener: () => void): void {
		this.listeners.add(listener)
	}

	clear(): void {
		this.take()
	}

	private arrived(): void {
		for (const waiting of [...this.waiting]) waiting()
		for (const listener of this.listeners) listener()
	}
}

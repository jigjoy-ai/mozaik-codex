import { Condition, directiveRegistry, Input } from "@mozaik-ai/network-client"
import { BehaviorPolicyDefinition } from "@mozaik-ai/network-client/network-client"
import { ConditionSpecification } from "@mozaik-ai/network-client/peer/condition-specification"
import { Directive } from "@mozaik-ai/network-client/peer/directive"
import { Envelope } from "@mozaik-ai/network-client/peer/envelope"
import { InputResolver } from "@mozaik-ai/network-client/peer/input-resolver"
import { Inbox } from "./inbox"
import { Message, NetworkView, PeerInfo } from "./network-view"

type MessageSent = Envelope<{ message: string; to?: string }>

type Refusal = { code: string; message: string }

/** How a Codex session acts on what happens in the network. */
export const codexPolicy: BehaviorPolicyDefinition = {
	rules: [
		{ condition: "message.received", input: "message", directive: "codex.keep" },
		{ condition: "membership.changed", input: "envelope", directive: "network.observe" },
		{ condition: "request.refused", input: "refusal", directive: "codex.report" },
	],
}

@Condition({ name: "message.received" })
export class MessageReceivedCondition extends ConditionSpecification {
	isSatisfiedBy(envelope: Envelope<any>) {
		return envelope.type === "message.sent"
	}
}

@Condition({ name: "membership.changed" })
export class MembershipChangedCondition extends ConditionSpecification {
	isSatisfiedBy(envelope: Envelope<any>) {
		return ["peer.welcomed", "peer.joined", "peer.left"].includes(envelope.type)
	}
}

@Condition({ name: "request.refused" })
export class RequestRefusedCondition extends ConditionSpecification {
	isSatisfiedBy(envelope: Envelope<any>) {
		return envelope.type === "error"
	}
}

@Input({ name: "message" })
export class MessageInput implements InputResolver<MessageSent, Message> {
	resolve(envelope: MessageSent): Promise<Message> {
		return Promise.resolve(toMessage(envelope))
	}
}

@Input({ name: "envelope" })
export class EnvelopeInput implements InputResolver<Envelope<unknown>, Envelope<unknown>> {
	resolve(envelope: Envelope<unknown>): Promise<Envelope<unknown>> {
		return Promise.resolve(envelope)
	}
}

@Input({ name: "refusal" })
export class RefusalInput implements InputResolver<Envelope<Refusal>, Refusal> {
	resolve(envelope: Envelope<Refusal>): Promise<Refusal> {
		return Promise.resolve(envelope.payload)
	}
}

/** Keeps a peer's message for Codex to read: it can't be shown to the model as it arrives. */
export class KeepForCodex implements Directive {
	readonly id = "codex.keep"

	constructor(
		private readonly view: NetworkView,
		private readonly inbox: Inbox,
	) {}

	async invoke(input: unknown): Promise<void> {
		const message = input as Message

		this.view.heard(message)
		this.inbox.received(message)
	}
}

/** Keeps up with who is in the network. Nobody's coming or going is told to Codex: list_peers answers that. */
export class ObserveNetwork implements Directive {
	readonly id = "network.observe"

	constructor(
		private readonly view: NetworkView,
		private readonly inbox: Inbox,
	) {}

	async invoke(input: unknown): Promise<void> {
		const envelope = input as Envelope<any>

		switch (envelope.type) {
			case "peer.welcomed": {
				const { peers, messages } = envelope.payload as { peers: PeerInfo[]; messages: MessageSent[] }
				// Welcomed again after the connection dropped: what was said meanwhile is unread now.
				for (const missed of this.view.welcomed(peers, messages.map(toMessage))) this.inbox.received(missed)
				break
			}

			case "peer.joined":
				this.view.joined(envelope.payload as PeerInfo)
				break

			case "peer.left":
				this.view.left((envelope.payload as { peerId: string }).peerId)
				break
		}
	}
}

/**
 * Keeps what the network refused for Codex to read: a message that wasn't sent would otherwise
 * look sent. A network that no longer knows the session is not left for Codex to sort out: the
 * session comes back by itself, and Codex is told how that went.
 */
export class ReportRefusal implements Directive {
	readonly id = "codex.report"

	constructor(
		private readonly inbox: Inbox,
		private readonly comeBack: () => Promise<boolean>,
	) {}

	async invoke(input: unknown): Promise<void> {
		const { code, message } = input as Refusal

		if (code !== "unauthorized") {
			this.inbox.notice(`The Mozaik network refused the last request: ${message}`)
			return
		}

		const back = await this.comeBack()
		this.inbox.notice(
			back
				? "The Mozaik network no longer knew this session, so it joined again as a new peer. What was sent just before may not have arrived: send it again if it matters."
				: "The Mozaik network no longer knows this session, and the saved invite no longer lets it in. Ask your user for a new invite link and call join_network with it.",
		)
	}
}

export function registerDirectives(view: NetworkView, inbox: Inbox, comeBack: () => Promise<boolean>): void {
	const directives = [
		new KeepForCodex(view, inbox),
		new ObserveNetwork(view, inbox),
		new ReportRefusal(inbox, comeBack),
	]

	for (const directive of directives) directiveRegistry.register(directive.id, directive)
}

function toMessage(envelope: MessageSent): Message {
	return {
		id: envelope.id,
		senderId: envelope.senderId,
		text: envelope.payload.message,
		to: envelope.payload.to,
		at: new Date(envelope.createdAt),
	}
}

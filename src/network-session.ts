import { join, leave, sendMessage } from "@mozaik-ai/network-client"
import { NetworkClient } from "@mozaik-ai/network-client/network-client"
import { Peer } from "@mozaik-ai/network-client/peer/peer"
import { readInviteLink, writeInviteLink } from "@mozaik-ai/network-client/invite-link"
import { mozaikCloudKey } from "./mozaik-cloud-key"
import { NetworkSettings, SavedNetwork } from "./network-settings"
import { NetworkView } from "./network-view"
import { codexPolicy } from "./rules"
import { SendLimit } from "@mozaik-ai/network-client/send-limit"

type Membership = { peer: Peer; networkId: string }

/**
 * A link that came through a chat or a document can arrive with its underscore escaped
 * (`nt\_…`) or a space where a line broke. An invite link holds neither, so both are dropped.
 */
const asWritten = (link: string): string => link.replace(/[\\\s]/g, "")

/** This Codex session in a network: it is a peer of its own, there for as long as the session runs. */
export class NetworkSession {
	private membership: Membership | undefined

	constructor(
		private readonly settings: NetworkSettings,
		private readonly view: NetworkView,
		private readonly limit: SendLimit,
		private readonly peerName: string,
		private readonly defaultOrigin: string,
	) {}

	getMembership(): Membership | undefined {
		return this.membership
	}

	/** Makes a network, joins it, and returns the link that lets others in. */
	async create(name: string): Promise<string> {
		this.mustBeOutside()

		const origin = this.defaultOrigin
		const client = new NetworkClient({ origin, apiKey: mozaikCloudKey() })
		const network = await client.createNetwork({ name })
		const invite = await client.createInvite(network.id)

		await this.enter({ origin, invite, name })
		return writeInviteLink({ origin, invite })
	}

	/**
	 * Joins the network of an invite link, or the saved one when there is no link. A session
	 * that is in a network leaves it first: with a link it moves to that network, without one
	 * it comes back to its own as a new peer.
	 */
	async join(link?: string): Promise<void> {
		const network = link ? readInviteLink(asWritten(link), this.defaultOrigin) : this.settings.read()
		if (!network) {
			throw new Error(
				link ? "That is not an invite link" : "No network is saved: pass an invite link, or create a network",
			)
		}

		await this.depart()
		await this.enter(network).catch((error: Error) => {
			// One wrong character is enough, and a link retyped by a model is the usual way to get one.
			if (link && error.message.includes("Unknown invite")) {
				throw new Error(
					"The network does not know this invite. Pass the link exactly as the user wrote it, character for character; if it was, ask them to copy it again",
				)
			}
			throw error
		})
	}

	/** Leaves for this session; with `forget`, the sessions to come don't join either. */
	async leave(forget: boolean): Promise<void> {
		await this.depart()

		if (forget) this.settings.forget()
	}

	/**
	 * The network no longer knows this session's peer (peers are kept for a while, not for good):
	 * the session comes back as a new peer through the saved invite. False when that invite no
	 * longer lets it in.
	 */
	async comeBack(): Promise<boolean> {
		const network = this.settings.read()
		await this.depart()
		if (!network) return false

		try {
			await this.enter(network)
			return true
		} catch {
			return false
		}
	}

	/** With `to`, a peer's id or name, the message goes to that peer only. */
	async send(text: string, to?: string): Promise<void> {
		if (!this.membership) throw new Error("Not in a network: join one first")
		const { peer, networkId } = this.membership

		const recipient = to === undefined ? undefined : this.view.find(to)
		if (to !== undefined && !recipient) throw new Error(`No peer "${to}" in the network`)

		this.limit.take()
		await sendMessage(peer, networkId, text, recipient?.id)

		// The network doesn't send a peer its own messages back.
		this.view.heard({ id: crypto.randomUUID(), senderId: peer.id, text, to: recipient?.id, at: new Date() })
	}

	/** The invite makes a new peer for this session, and the network is saved for the sessions to come. */
	private async enter(network: SavedNetwork): Promise<void> {
		const client = new NetworkClient({ origin: network.origin })
		const peer = await client.createPeer({
			name: this.peerName,
			role: "agent",
			capabilities: ["message"],
			invite: network.invite,
			policy: codexPolicy,
		})
		if (!peer.invitedTo) throw new Error("The network didn't say which network the invite is for")

		await join(peer, peer.invitedTo, client)

		this.membership = { peer, networkId: peer.invitedTo }
		this.settings.save(network)
	}

	private async depart(): Promise<void> {
		if (!this.membership) return

		const { peer, networkId } = this.membership
		this.membership = undefined
		this.view.clear()
		// A network that no longer knows the peer has nothing to be told.
		await leave(peer, networkId).catch(() => {})
	}

	private mustBeOutside(): void {
		if (this.membership) throw new Error("Already in a network: leave it first")
	}
}

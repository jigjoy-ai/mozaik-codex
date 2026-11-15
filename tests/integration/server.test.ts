import { afterAll, beforeAll, describe, expect, test } from "@rstest/core"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createApp } from "mozaik-network/src/app"
import { initNetworkModule, resolveNetworkModule } from "mozaik-network/src/network-module"

type Session = {
	/** Everything the server sent without being asked: Codex shows none of it, so there must be none. */
	pushed: unknown[]
	instructions: string | undefined
	tools(): Promise<string[]>
	call(tool: string, args?: Record<string, unknown>): Promise<{ text: string; failed: boolean }>
	/** A hook of Codex's, calling the server's tool with what the event carries. */
	hook(event: string, more?: Record<string, unknown>): Promise<string>
}

let server: Server
let origin: string
const clients: Client[] = []

beforeAll(async () => {
	initNetworkModule()
	server = createApp()
	await new Promise<void>((resolve) => server.listen(0, resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
	await Promise.all(clients.map((client) => client.close()))
	await new Promise((resolve) => server.close(resolve))
})

const stateDir = () => mkdtempSync(join(tmpdir(), "mozaik-codex-"))

/** The server as Codex runs it: over stdio, as an MCP server of the session. */
async function session(name: string, dir: string, env: Record<string, string> = {}): Promise<Session> {
	const client = new Client({ name: "codex", version: "0.0.0" })
	const pushed: unknown[] = []
	client.fallbackNotificationHandler = async (notification) => void pushed.push(notification)

	await client.connect(
		new StdioClientTransport({
			command: "node_modules/.bin/tsx",
			args: ["src/server.ts"],
			env: {
				...(process.env as Record<string, string>),
				NETWORK_ORIGIN: origin,
				MOZAIK_PEER_NAME: name,
				MOZAIK_NETWORK_STATE_DIR: dir,
				// Waking runs the real `codex`: only the test of it does, with a stand-in.
				MOZAIK_CODEX_WAKE: "0",
				...env,
			},
		}),
	)
	clients.push(client)

	const call = async (tool: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name: tool, arguments: args })
		const [{ text }] = result.content as { text: string }[]
		return { text, failed: result.isError === true }
	}

	return {
		pushed,
		instructions: client.getInstructions(),
		tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
		call,
		hook: async (event, more = {}) =>
			(await call("on_session_event", { event, session_id: "thread-1", ...more })).text,
	}
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let waited = 0; !(await condition()); waited += 20) {
		if (waited > 4000) throw new Error("waited 4s for nothing")
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

/** Two sessions in one network: the first made it, the second joined with its link. */
async function pair(env: Record<string, string> = {}) {
	const [ana, marko] = await Promise.all([session("ana@api", stateDir()), session("marko@web", stateDir(), env)])
	const link = (await ana.call("create_network", { name: "team" })).text.split("\n").pop()!
	const joined = await marko.call("join_network", { invite: link })
	return { ana, marko, link, joined }
}

describe("Codex on a Mozaik network", () => {
	test("the server says what it is for, and offers its tools", async () => {
		const codex = await session("ana@api", stateDir())
		expect(codex.instructions!.slice(0, 512)).toContain("not your user")
		expect(codex.instructions!.slice(0, 512)).toContain("read_messages")
		expect(await codex.tools()).toEqual([
			"join_network",
			"create_network",
			"leave_network",
			"send_message",
			"list_peers",
			"read_messages",
			"wait_for_message",
			"on_session_event",
		])
	})

	test("one session makes a network, another joins with its link, and each reads what the other says", async () => {
		const { ana, marko, link, joined } = await pair()
		expect(link).toMatch(new RegExp(`^${origin}#nt_`))
		expect(joined.text).toContain("ana@api")
		expect(joined.text).toContain("marko@web")

		await ana.call("send_message", { text: "who is on the login bug?" })
		// Nothing shows by itself: Codex is told at a hook that there is something, and not what.
		await until(async () => (await marko.call("read_messages", { recent: 5 })).text.includes("login bug"))
		await marko.call("send_message", { text: "me", to: "ana@api" })

		const answer = await ana.call("wait_for_message", { seconds: 5 })
		expect(answer.text).toMatch(/marko@web \([\w-]+\) → ana@api: me$/)
		expect((await ana.call("read_messages")).text).toBe("Nothing new.")
		expect((await ana.call("read_messages", { recent: 5 })).text).toMatch(
			/ana@api \([\w-]+\): who is on the login bug\?\n.* marko@web \([\w-]+\) → ana@api: me$/,
		)
		expect((await marko.call("send_message", { text: "hi", to: "nobody" })).failed).toBe(true)
		expect([...ana.pushed, ...marko.pushed]).toEqual([])
	})

	test("at its hooks Codex is told there are messages, once, and reads them with a tool", async () => {
		const { ana, marko } = await pair()
		expect(await marko.hook("PostToolUse")).toBe("{}")

		await ana.call("send_message", { text: "deploying in five minutes" })
		let told = "{}"
		await until(async () => (told = await marko.hook("PostToolUse")) !== "{}")
		const note = JSON.parse(told).hookSpecificOutput.additionalContext as string
		expect(note).toMatch(/^1 new message on the Mozaik network from ana@api\. Call read_messages to read it\./)
		expect(note).not.toContain("deploying")
		expect(await marko.hook("PostToolUse")).toBe("{}")
		expect(await marko.hook("UserPromptSubmit")).toBe("")

		expect((await marko.call("read_messages")).text).toMatch(/ana@api \([\w-]+\): deploying in five minutes$/)
		expect((await marko.call("read_messages")).text).toBe("Nothing new.")
	})

	test("a turn that would end with an unread message is kept going once", async () => {
		const { ana, marko } = await pair()
		await ana.call("send_message", { text: "can you check the port?", to: "marko@web" })

		let kept: { decision?: string; reason?: string } = {}
		await until(async () => (kept = JSON.parse(await marko.hook("Stop"))).decision === "block")
		expect(kept.reason).toMatch(/1 new message on the Mozaik network from ana@api \(1 sent to this session only\)/)
		expect(kept.reason).not.toContain("port")
		expect(await marko.hook("Stop", { stop_hook_active: true })).toBe("{}")
	})

	test("waiting for a message ends when one comes, and says so when none does", async () => {
		const { ana, marko } = await pair()
		const waiting = marko.call("wait_for_message", { seconds: 10 })
		await ana.call("send_message", { text: "8080", to: "marko@web" })
		expect((await waiting).text).toMatch(/ana@api \([\w-]+\) → marko@web: 8080$/)

		expect((await marko.call("wait_for_message", { seconds: 1 })).text).toBe("Nothing arrived in 1 seconds.")
		const outside = await session("cara@ops", stateDir())
		expect((await outside.call("wait_for_message")).failed).toBe(true)
	})

	test("a later session on the same machine is told a network is saved, and joins it without the link", async () => {
		const dir = stateDir()
		const first = await session("ana@api", dir)
		expect(await first.hook("SessionStart")).toBe("")
		await first.call("create_network", { name: "team" })
		expect(existsSync(join(dir, "network.json"))).toBe(true)

		const later = await session("ana@web", dir)
		expect(await later.hook("SessionStart")).toBe(
			'The Mozaik network "team" is saved on this machine. Call join_network to connect this session to it.',
		)
		const joined = await later.call("join_network")
		expect(joined.text).toContain("ana@api")
		expect(joined.text).toContain("ana@web")
		expect(await later.hook("SessionStart")).toBe("")
	})

	test("a session the network forgot comes back by itself, and says so where Codex reads", async () => {
		const { ana, marko } = await pair()

		// The network forgets its peers and drops their connections: what happens once the ones it kept have gone.
		const { peerRepository, envelopeDelivery } = resolveNetworkModule()
		const forgotten = peerRepository as unknown as { peers: Map<string, unknown> }
		const delivery = envelopeDelivery as unknown as { connections: Map<string, Set<{ terminate(): void }>> }
		forgotten.peers.clear()
		for (const sockets of delivery.connections.values()) for (const socket of sockets) socket.terminate()

		let told = ""
		await until(async () => (told = await marko.hook("UserPromptSubmit")) !== "")
		expect(told).toMatch(/joined again as a new peer/)
		await until(async () => (await ana.hook("UserPromptSubmit")) !== "")
		// The note is what the session reads first; once read, it is gone.
		expect((await ana.call("read_messages")).text).toMatch(/joined again as a new peer/)
		await marko.call("read_messages")

		// Both are in the network again, under their names, and hear each other.
		await marko.call("send_message", { text: "still here?" })
		const heard = await ana.call("wait_for_message", { seconds: 5 })
		expect(heard.text).toMatch(/marko@web \([\w-]+\): still here\?$/)
	})

	test("joining from inside a network leaves it first: the same one again, or another", async () => {
		const { ana, marko } = await pair()
		const cara = await session("cara@ops", stateDir())
		const ops = (await cara.call("create_network", { name: "ops" })).text.split("\n").pop()!

		const again = await marko.call("join_network")
		expect(again.failed).toBe(false)
		expect(again.text).toContain("ana@api")

		const moved = await marko.call("join_network", { invite: ops })
		expect(moved.text).toContain("cara@ops")
		expect(moved.text).not.toContain("ana@api")
		await ana.call("leave_network")
		expect((await ana.call("list_peers")).text).toBe("Not in a network.")
	})

	test("a link whose underscore was escaped on its way to the user still lets the session in", async () => {
		const ana = await session("ana@api", stateDir())
		const link = (await ana.call("create_network", { name: "team" })).text.split("\n").pop()!
		const marko = await session("marko@web", stateDir())

		const joined = await marko.call("join_network", { invite: link.replace("#nt_", "//#nt\\_") })
		expect(joined.failed).toBe(false)
		expect(joined.text).toContain("ana@api")
	})

	test("a link with a wrong character is refused, and the session is told to pass it as it was written", async () => {
		const ana = await session("ana@api", stateDir())
		const link = (await ana.call("create_network", { name: "team" })).text.split("\n").pop()!
		const marko = await session("marko@web", stateDir())

		const refused = await marko.call("join_network", { invite: `${link.slice(0, -1)}${link.endsWith("A") ? "B" : "A"}` })
		expect(refused.failed).toBe(true)
		expect(refused.text).toContain("exactly as the user wrote it")
	})

	test("an idle session has a note queued for its thread, and not the message", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mozaik-codex-"))
		const out = join(dir, "argv.json")
		// A stand-in for the codex command that writes down what it was called with.
		const codex = join(dir, "codex")
		writeFileSync(
			codex,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`,
		)
		chmodSync(codex, 0o755)

		const { ana, marko } = await pair({ MOZAIK_CODEX_WAKE: "", MOZAIK_CODEX_COMMAND: codex })
		await marko.hook("SessionStart")
		expect(await marko.hook("Stop")).toBe("{}")
		await ana.call("send_message", { text: "are you there?", to: "marko@web" })

		await until(() => existsSync(out))
		const [command, flag, thread, , text] = JSON.parse(readFileSync(out, "utf8")) as string[]
		expect([command, flag, thread]).toEqual(["queue", "--thread", "thread-1"])
		expect(text).toMatch(/^1 new message on the Mozaik network from ana@api \(1 sent to this session only\)/)
		expect(text).not.toContain("are you there")
		expect((await marko.call("read_messages")).text).toMatch(/→ marko@web: are you there\?$/)
	})

	test("with waking turned off, an idle session is left alone until its user writes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mozaik-codex-"))
		const out = join(dir, "argv.json")
		const codex = join(dir, "codex")
		writeFileSync(codex, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, "ran")\n`)
		chmodSync(codex, 0o755)

		const { ana, marko } = await pair({ MOZAIK_CODEX_WAKE: "0", MOZAIK_CODEX_COMMAND: codex })
		await marko.hook("SessionStart")
		await marko.hook("Stop")
		await ana.call("send_message", { text: "are you there?", to: "marko@web" })

		let told = ""
		await until(async () => (told = await marko.hook("UserPromptSubmit")) !== "")
		expect(told).toMatch(/^1 new message on the Mozaik network from ana@api/)
		expect(existsSync(out)).toBe(false)
	})

	test("without a saved network or a link there is nothing to join", async () => {
		const codex = await session("ana@api", stateDir())
		const refused = await codex.call("join_network")
		expect(refused.failed).toBe(true)
		expect(refused.text).toContain("No network is saved")
	})
})

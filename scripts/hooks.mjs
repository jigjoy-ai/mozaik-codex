#!/usr/bin/env node
// Adds this repository's hooks (hooks/hooks.json) to Codex's own hooks file, or with --remove
// takes them out again. Codex reads ~/.codex/hooks.json (CODEX_HOME moves it); what is already
// there is kept. Codex asks to review and trust new hooks: open /hooks in a session after this.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SERVER = "mozaik-network"
const file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json")
const ours = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json"), "utf8"),
)
const remove = process.argv.includes("--remove")

const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
const hooks = current.hooks ?? {}

/** A matcher group of this server's: every handler in it calls the server's tool. */
const isOurs = (group) =>
	Array.isArray(group.hooks) &&
	group.hooks.length > 0 &&
	group.hooks.every((hook) => hook.type === "mcp_tool" && hook.server === SERVER)

for (const event of new Set([...Object.keys(hooks), ...Object.keys(ours.hooks)])) {
	const kept = (hooks[event] ?? []).filter((group) => !isOurs(group))
	const added = remove ? [] : (ours.hooks[event] ?? [])
	if (kept.length + added.length > 0) hooks[event] = [...kept, ...added]
	else delete hooks[event]
}

mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, JSON.stringify({ ...current, hooks }, null, "\t") + "\n")
console.log(
	remove
		? `Removed the Mozaik Network hooks from ${file}`
		: `Added the Mozaik Network hooks to ${file}. Open /hooks in Codex to review and trust them.`,
)

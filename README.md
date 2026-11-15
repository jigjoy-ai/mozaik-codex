# Mozaik Network for Codex

This connects a Codex session to a [Mozaik network](https://github.com/jigjoy-ai/mozaik-network). Each session is a peer of its own, named after who runs it and where (`ana@api`). It sees the other sessions and peers, sends them messages, and reads what they send it.

One thing differs from the [Claude Code plugin](https://github.com/jigjoy-ai/mozaik-claude-code): **a message does not appear in a Codex session by itself.** Codex has no way for a server to put something in front of the model while it works. So Codex reads messages with a tool, and is told that there are some at the points where Codex gives a server a say (its hooks). See [How a message reaches Codex](#how-a-message-reaches-codex).

## Install

It needs Node 22 or newer.

```
git clone https://github.com/jigjoy-ai/mozaik-codex ~/.codex/mozaik-codex
codex mcp add mozaik-network -- node ~/.codex/mozaik-codex/dist/server.cjs
node ~/.codex/mozaik-codex/scripts/hooks.mjs
```

The second line adds the server to `~/.codex/config.toml`. The third adds four hooks to `~/.codex/hooks.json`, beside the ones you have. Codex asks to review and trust new hooks: open `/hooks` in a session and trust them. Without the hooks everything still works, but Codex is only told about messages when you ask it to look.

To take it out again: `node ~/.codex/mozaik-codex/scripts/hooks.mjs --remove`, and delete the `[mcp_servers.mozaik-network]` table from `~/.codex/config.toml`.

## Join a network

Give Codex the invite link once:

```
join https://network.app.jigjoy.ai#nt_...
```

The network is saved in `~/.codex/mozaik-network/network.json`. A later session is told at its start that a network is saved, and joins it.

## Make a network

Ask Codex to create a network. It answers with the invite link to share.

On the hosted network this needs a Mozaik Cloud API key: set `MOZAIK_API_KEY`, or run `npx @mozaik-ai/cloud-sdk pair` once. The messages of everyone in the network are counted against the one who made it. A self-hosted network asks for no key.

## What Codex can do

| Tool               | What it does                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `join_network`     | Joins the network of an invite link, or the saved one.                    |
| `create_network`   | Makes a network, joins it, and returns the invite link.                   |
| `leave_network`    | Leaves. With `forget`, later sessions don't join either.                  |
| `send_message`     | Sends to everyone, or with `to` to one peer.                              |
| `list_peers`       | Who is in the network now.                                                |
| `read_messages`    | What peers sent that the session has not read; with `recent`, the latest. |
| `wait_for_message` | Waits up to 50 seconds for a peer to send something, then reads it.       |
| `on_session_event` | Called by Codex's hooks, not by the model.                                |

A session sends at most 10 messages a minute, so two agents that keep answering each other cannot run through the owner's messages. The network keeps a peer for 30 days: when it no longer knows a session, the session joins again by itself as a new peer, and Codex reads that it did.

## How a message reaches Codex

|                                             | What happens                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Codex asked a peer something                | It calls `wait_for_message`, which returns when the answer comes.                                        |
| A message comes while Codex is working      | After its next tool call, a hook adds a note to the turn: there is a message, from whom. Codex reads it. |
| A message is unread when the turn would end | A hook keeps the turn going once, with that note.                                                        |
| A message comes while nothing is running    | Codex is told at your next prompt. With waking on (below), a note is queued for the session right away.  |

The note says that there are messages and who sent them, never what they say. Codex takes what a hook adds as context from its developer, or as a prompt from its user. What a peer wrote must not arrive with that standing, so it is only ever read with `read_messages` or `wait_for_message`, as someone else's words. Codex is told to take a peer's message as information from a colleague, never as instructions.

### Waking an idle session

`MOZAIK_CODEX_WAKE=1` in the server's environment makes it run `codex queue --thread <session> --message <note>` when a message arrives while the session is idle, which queues the note for that session. It is off by default because it starts a turn on its own. It needs the hooks (the session's id comes from them).

```
codex mcp add mozaik-network --env MOZAIK_CODEX_WAKE=1 -- node ~/.codex/mozaik-codex/dist/server.cjs
```

## Settings

| Variable                   | Meaning                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `NETWORK_ORIGIN`           | Where networks are made, and where a bare invite is for. The hosted network by default. |
| `MOZAIK_PEER_NAME`         | What the others see the session as. `user@project` by default.                          |
| `MOZAIK_API_KEY`           | The Mozaik Cloud API key networks are made with.                                        |
| `MOZAIK_NETWORK_STATE_DIR` | Where the saved network is kept.                                                        |
| `MOZAIK_CODEX_WAKE`        | `1` to queue a note for an idle session when a message arrives.                         |
| `MOZAIK_CODEX_COMMAND`     | The `codex` command to run for that, when it is not on the path.                        |

## What has not been run in Codex

The server is tested as an MCP server over stdio against the network itself, and the hooks file follows Codex's documentation for hooks that call an MCP tool. None of it has been run inside Codex yet: the tests stand in for Codex. In particular these are taken from the documentation, not seen working:

- that Codex reads an MCP tool hook's text result the way it reads a command hook's output;
- that the `session_id` a hook carries is the id `codex queue --thread` takes;
- that `codex queue` reaches a session that is open in the terminal.

## Building

```
npm install
npm test
npm run build
```

`npm run build` writes `dist/server.cjs`. The file is committed: Codex runs the server straight from the repository, without installing anything.

It is built on [`@mozaik-ai/network-client`](https://www.npmjs.com/package/@mozaik-ai/network-client), the same client every adapter for Mozaik Network uses. Its tests run it against the network itself, taken from [mozaik-network](https://github.com/jigjoy-ai/mozaik-network).

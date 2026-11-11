# Architecture

Four ideas, and the rest follows.

## 1. Agents are processes that speak ACP

The engine spawns an agent, talks [Agent Client Protocol](https://agentclientprotocol.com) over stdio,
and never learns anything else about it. Adding Claude Code, Codex, OpenCode or Hermes is adding a
`{command, args, cwd}` row to `agents.json` — there is no adapter layer and no branch on agent identity.

```
acp-host  ──initialize──▶  <agent>  acp
          ◀─session/update─
          ──session/prompt─▶
```

A session is created lazily, cached by conversation id, and dropped when the process dies. Permission
requests that arrive mid-run are answered in-band (`allow_once` when offered, else refused) because
nobody is watching a prompt in a background run; `permission: "deny"` per agent forces refusal.

## 2. Two front doors, one run loop

The same `run()` generator feeds both lanes:

| Downstream | Protocol | Who uses it |
|---|---|---|
| `POST /ag-ui/:agent` | AG-UI over SSE | any workspace product that registers remote agents by URL |
| `POST /rpc` + `GET /events` | JSON-RPC 2.0 + SSE | the board module, which calls `host.request` / `host.onEvent` |

AG-UI translates ACP updates into `RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `RUN_FINISHED`.
The board lane translates them into `message.complete`, `tool.start`, `error`, each carrying a
`payload` object — the shape a board module's event handler reads.

## 3. The board module is a guest with a fixed contract

A module exports `register(ctx)`. The host gives it exactly six things — storage, a REST lane, an OS
facade, lifecycle, UI areas, and the RPC/event pair — and renders whatever it registers into
`ROUTES_AREA`, `SIDEBAR_NAV_AREA` and `PALETTE_AREA`. The module never imports app internals, so the
host can change everything around it without touching the module.

Consequences worth knowing:

- **Storage is synchronous** (`hydrate()` runs inside `register`), so it is browser storage, not IndexedDB.
- **Icons are a Proxy.** An unknown icon name draws a placeholder and logs once — a missing glyph must
  never take the page down (an `undefined` component unmounts the whole tree).
- **Gestures can be rewritten at the host.** The shell's wheel listener captures the event and
  re-dispatches it with the modifier the page reads as zoom. Same page code, different default.

## 4. One board, one conversation

The board id is never in an RPC payload, but the module writes its board index through `ctx.storage` on
every save and every board switch. The host reads `activeId` from that write, stamps
`X-Canvas-Board` on every RPC, and the engine keys its sessions by `${boardId}:${agent}`.

So: successive commands on a board continue one conversation; a new board starts a new one; switching
back resumes. `session.reset` drops the mapping for an explicit fresh start.

## What is deliberately absent

- **No auth.** Every route is unauthenticated: bind `127.0.0.1` (the default) and treat `--host 0.0.0.0`
  as "I meant to expose this". An agent run can write files in its `cwd`.
- **No board module in the repo.** The host is the product; the board is a module you supply.
- **No database requirement.** Boards persist to disk under `.throughline/`; sessions are in-memory.

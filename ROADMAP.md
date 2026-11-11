# Where this is going

## Done

- Engine: ACP agents over stdio, one session per board, AG-UI + RPC lanes
- Board host: the contract a module is written against (atoms, host verbs, icons, areas)
- App: loads a module, renders it, gives it storage / rest / os, scroll-to-zoom, agent picker
- Three headless suites that drive the real page

## Next

- **`down`** to match `up`, and a single `npm start` at the root
- **Approvals on the board** — a permission request becomes a card you accept or refuse, instead of
  being answered in-band
- **Attach a running agent** — reconnect to a session after the engine restarts (`session/load` instead
  of a cold start)
- **Board import/export** — Markdown/CSV out, and a board as a file you can commit
- **A reference board module** in this repo, so the quick start works with no extra input

## Later

- Multi-user boards (the current model is one person, one board)
- A desktop shell (Tauri) around the same engine
- Budget guardrails per agent: token ceilings, tool-call ceilings, and a stop that actually stops

## Not doing

- A hosted service. This runs on your machine, against your agents.
- Bundling an agent runtime. ACP is the seam; pick the agent.

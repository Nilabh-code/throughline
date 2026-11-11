# Contributing

Issues and pull requests are welcome. This is a small codebase on purpose — read
[ARCHITECTURE.md](ARCHITECTURE.md) before proposing anything structural.

## Ground rules

1. **Agents are data.** Never branch on an agent's identity in the engine. If a behaviour is
   agent-specific, it belongs in `agents.json` (a flag, an env var) or in the agent.
2. **The board module is a guest.** The host may not import the module's internals, and the module may
   not import the host's. Everything crosses the `ctx` / `host` contract.
3. **Failures name the layer.** A spawn failure, a transport failure and a model-config failure are
   three different errors. Do not collapse them into one string.
4. **No new dependency without a reason.** The engine has two (`@agentclientprotocol/sdk`,
   `@ag-ui/core`, both for protocol types). The app has React and Vite.

## Before a pull request

```sh
npm --prefix packages/acp-host install
npm --prefix packages/app install
BOARD_MODULE=./vendored/board/plugin.js npm --prefix packages/app run build

node scripts/up.mjs
cd packages/app && node scripts/journey.mjs && node scripts/interact.mjs && node scripts/session-check.mjs
```

All three suites drive a real headless browser against the served app. A green run is the bar —
"it rendered once" is not.

Run them in the **foreground**. They take minutes and spawn Chromium; redirecting their output to a
file or running them detached can have the process reaped mid-run with no message. Each suite writes
its verdict next to itself (`scripts/session-check.json`) and now leaves a `{crashed: …}` verdict behind
if it dies, so a silent exit is visible instead of invisible.

## Style

- Two spaces, no semicolons, single quotes. Match the file you are in.
- Comments explain *why*, never *what*. If a line needs a *what* comment, rename something.
- Commit messages: `<area>: <what changed>` — imperative, no trailing period.

## Conventions

- Commits are authored as **Nilabh Yadav <agrobothex@gmail.com>**.
- Squash on merge. No generated files (`dist/`, logs, screenshots other than `docs/`) in commits.
- `main` always builds and passes all three suites.

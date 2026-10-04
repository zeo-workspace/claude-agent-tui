# claude-agent-tui

[![npm](https://img.shields.io/npm/v/@lucascouts/claude-agent-tui)](https://www.npmjs.com/package/@lucascouts/claude-agent-tui)

An [ACP](https://agentclientprotocol.com)-compatible agent that drives the **Claude Code subscription TUI** over a PTY, so your Claude Code threads render natively in [Zed](https://zed.dev) and other ACP clients.

> **Fork** of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.57.0, with later upstream changes ported on top. Where the upstream adapter calls the Claude Agent **SDK**, this fork spawns the `claude` **subscription CLI** in a pseudo-terminal and translates its JSONL transcript into ACP `session/update` notifications. See [`.fork-provenance.json`](.fork-provenance.json) for the exact fork point.

## Status

**Maintained for parity, not as an active product.** Development as a product stopped on 2026-06-24, for two reasons the code cannot resolve:

- **Billing.** The premise below — that bridge-driven TUI use counts against your subscription — is a server-side behaviour this project cannot verify. It was closed on the assumption that the billing split takes effect and such use is _not_ covered.
- **Terms.** Driving the subscription `claude` TUI from an unofficial client may not conform to Anthropic's Terms of Service.

Since 2026-08-28 the adapter is kept in step with upstream `claude-agent-acp` as engineering work, and releases continue. Use it knowing both points above.

## Why this exists

On **June 15, 2026**, [Anthropic split Claude subscription billing](https://zed.dev/blog/anthropic-subscription-changes) into two pools: Anthropic's **first-party tools** (chat and the official **Claude Code CLI**) keep using your **Pro/Max subscription**, while **third-party agents and SDK usage** are billed separately at **API rates** — roughly **15–30× more expensive** (separate monthly credits: $20 Pro / $100 Max 5x / $200 Max 20x).

In practice, Zed's built-in Claude integration now draws from those expensive third-party credits instead of your subscription. The official `claude` CLI/TUI, however, **still runs on your subscription**.

This project bridges the two: it drives the **official Claude Code TUI** over a PTY and exposes it through the **ACP** protocol, so Zed renders it as a native agent panel — giving you the full Claude Code experience inside Zed **on your existing subscription**, not API credits.

### Update notice

"Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription's usage limits. The previously announced monthly credit, which would have been available to eligible claimants in connection with these changes, isn't available. We’re working to update the plan to better support how users build with Claude subscriptions. When we have an update, we'll share it before anything takes effect."

[`https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

> Not affiliated with or endorsed by Anthropic or Zed Industries. Use of the `claude` CLI remains subject to Anthropic's terms.

## Requirements

- The **`claude` CLI** (Claude Code subscription) available on your `PATH`.
- **Node.js ≥ 24** — the runtime and test suite use native TypeScript type-stripping (`node --experimental-strip-types`). Raising this floor from the previous `>=20` is a **breaking change** for consumers still on Node 20–23.

> **Why 24, and not upstream's `>=22`?** The floor is a support policy, not a measured minimum: this project targets the **active LTS** line, which is Node 24. It is verified rather than copied — a fresh clone with no host `node_modules` or `dist/`, then `npm ci` → `npm run build` → `npm test`, inside `node:24` pinned by digest `sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584` (Node v24.19.0). Green in both the fork and mirror trees: 1222 tests in the fork, 1183 here, 0 failures.
>
> A bare `>=22` cannot keep its own promise: `--experimental-strip-types` only landed in Node 22.6, so `>=22` still admits 22.0–22.5, where `npm install` succeeds and `npm test` cannot start. Any floor of 23 or higher closes that gap.

## Register in Zed

Install the agent, then point Zed's `agent_servers` at it:

```sh
npm install -g @lucascouts/claude-agent-tui
```

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "Claude Agent TUI": {
      "type": "custom",
      "command": "claude-agent-tui",
      "args": [],
      "env": {},
    },
  },
}
```

From a source checkout instead, build it and use `"command": "node"` with `"args": ["/absolute/path/to/claude-agent-tui/dist/index.js"]`.

Open the Agent Panel in Zed and select **Claude Agent TUI**.

## Build & test

```sh
npm install
npm run build
npm test
```

## Capabilities

- Renders Claude Code threads: text, thinking, tool calls, structured diffs, TODO plans, and nested sub-agents
- Token-usage updates
- Prompt input, cancellation, and session load/replay

## Supply-chain notes

[Socket](https://socket.dev/npm/package/@lucascouts/claude-agent-tui) flags some
dependency alerts (`Native code`, `Install scripts`, `Shell access`, plus
heuristic flags on the Anthropic SDK tree). **None are CVEs or malware** — they
are expected capability flags:

- `node-pty` (the same PTY that powers VS Code) needs `Native code` /
  `Install scripts` / `Shell access` — driving the `claude` TUI in a real PTY is
  the whole point of this bridge.
- The remaining flags come from the minified bundles inside
  `@anthropic-ai/claude-agent-sdk`, of which this fork uses only two pure,
  billing-free functions (`getSessionMessages`, `resolveSettings`).

All direct dependencies are first-party publishers (Microsoft, Anthropic, Zed).

## License

[Apache-2.0](LICENSE). This is a derivative work; original copyright belongs to Zed Industries and the Agent Client Protocol authors.

// Story 038 / Task 1.1 — `startZedSim`: spawn the BUILT fork and drive it over the REAL
// ND-JSON stdio transport, exactly as Zed would (§ACP-wire harness).
//
// This is the OVER-THE-WIRE analogue of the in-process client used in
// e2e-session-load-replay.test.ts. Instead of `new ClaudeAcpAgent(client, ...)` in the
// same process, we `spawn("node dist/index.js")` (its no-`--cli` branch boots runAcp →
// AgentSideConnection over ndJsonStream(stdin/stdout)) and connect with the SDK's own
// ClientSideConnection over ndJsonStream(child.stdin/child.stdout). The SDK owns JSON-RPC
// framing + response correlation, so every call (initialize/newSession/loadSession) and
// every sessionUpdate notification crosses the genuine transport — never an in-process
// method call (R1.1, R1.2).
//
// Stream conversion REUSES the fork's own nodeToWebReadable/nodeToWebWritable so the
// byte path is identical to production; the wiring is the server's, inverted: the client
// WRITES to the child's stdin and READS from the child's stdout.
//
// R5.1: no `claude`/PTY is spawned and no network is touched here — only `initialize`
// over stdio. R5.2: every spawned child is torn down by an idempotent `dispose()`.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Agent, Client } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../../dist/utils.js";

// The built fork root (…/fork) — the spawn cwd so `dist/index.js` resolves and the agent
// boots against the built tree, mirroring initialize-smoke.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const FORK_ROOT = join(here, "..", "..");

/**
 * Options for {@link startZedSim}. Designed as an object up front so later sub-tasks can
 * extend it without changing the call sites:
 *   - `home`      — (sub-task 1.2) point the spawned child's `HOME` at an isolated dir so the
 *                   transcript discovery never touches the user's real `~/.claude`.
 *   - `configDir` — (sub-task 1.2) point the spawned child's `CLAUDE_CONFIG_DIR` at the planter's
 *                   isolated `.claude` so the SDK's `getSessionMessages` disk reader resolves the
 *                   PLANTED transcript and never the user's real `~/.claude` (R1.4). This is the
 *                   robust override — it takes precedence over homedir in the SDK's resolution.
 *   - `env`       — extra env vars merged onto the sanitized base (wins on key collision).
 *   - `cwd`       — spawn cwd; defaults to the built fork root.
 *   - `cleanup`   — (sub-task 1.2) a teardown hook (e.g. the planter's temp-dir `rmSync`) that
 *                   {@link ZedSim.dispose} runs once, after killing the child.
 *   - `onSessionUpdate` — (sub-task 3.2) a hook the test client `await`s for EVERY `sessionUpdate`
 *                   notification BEFORE buffering it into `captured`. Lets a test model a real ACP
 *                   client that THROWS on a particular update (e.g. rejecting the UNSTABLE
 *                   `usage_update`): the hook's throw becomes the client handler's rejection over the
 *                   genuine transport, exactly as Zed rejecting an update would. A passive (or absent)
 *                   hook is a no-op — every notification is still captured as before.
 */
export interface ZedSimOptions {
  home?: string;
  configDir?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  cleanup?: () => void;
  onSessionUpdate?: (params: any) => void | Promise<void>;
}

export interface ZedSim {
  /** The SDK ClientSideConnection — the agent proxy (initialize / newSession / loadSession). */
  agent: Agent;
  /** Every `sessionUpdate` notification param, in arrival order. */
  captured: any[];
  /** The spawned fork child process (stderr is piped and accumulated for diagnostics). */
  child: ChildProcess;
  /**
   * The `CLAUDE_CONFIG_DIR` actually handed to the child (undefined when none was set). Exposed so a
   * test can ASSERT isolation: the effective config dir is the planter's temp dir, NOT under the
   * user's real HOME (R1.4).
   */
  configDir: string | undefined;
  /**
   * Idempotent teardown: kills the child once, then runs the optional `cleanup` hook (e.g. removes
   * the planter's temp dir). Safe to call repeatedly.
   */
  dispose: () => void;
}

/**
 * Build the child env from {@link ZedSimOptions}. We do NOT blindly forward the parent's
 * full environment in a way that could reach the user's real `~/.claude`; instead we pass
 * through only the keys the spawned Node + fork actually need (PATH and friends), then
 * layer `opts.home` (HOME/USERPROFILE) and `opts.env` on top. `opts.env` wins last.
 */
function buildChildEnv(opts: ZedSimOptions): NodeJS.ProcessEnv {
  // Minimal, explicit allow-list so an isolated HOME (sub-task 1.2) is not undermined by a
  // stray inherited credential/path var. PATH lets `node`/`spawn` resolve as in production.
  const PASS_THROUGH = ["PATH", "NODE_PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS_THROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Never let the spawned adapter read the model catalogue from the real CLI: that read is a full
  // `claude` session. The built-in list is enough for every wire test; `opts.env` can still override.
  env.CLAUDE_TUI_MODEL_CATALOG = "builtin";
  if (opts.home !== undefined) {
    // Override HOME so transcript discovery is isolated (POSIX HOME, Windows USERPROFILE).
    env.HOME = opts.home;
    env.USERPROFILE = opts.home;
  }
  if (opts.configDir !== undefined) {
    // The SDK's `getSessionMessages` reader resolves `configDir = CLAUDE_CONFIG_DIR ?? ~/.claude`,
    // so this points disk discovery at the PLANTED transcript and away from the real `~/.claude`
    // (R1.4). It has precedence over homedir, making it the robust isolation lever (HOME above is
    // defense-in-depth for the fork's OWN homedir()-based tail glob).
    env.CLAUDE_CONFIG_DIR = opts.configDir;
  }
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

/**
 * Spawn the built fork and complete the ACP handshake plumbing over real stdio. The
 * returned `agent` is ready for `initialize` (and, in later sub-tasks, newSession /
 * loadSession). Always pair with `t.after(() => sim.dispose())` so the child is reaped on
 * completion OR failure.
 */
export function startZedSim(opts: ZedSimOptions = {}): ZedSim {
  const cwd = opts.cwd ?? FORK_ROOT;

  // No `--cli`: that branch would re-exec the real `claude`. We want the ACP-over-stdio
  // branch (runAcp). Array args ⇒ no shell. stderr piped: the fork redirects console.* to
  // stderr, so a boot failure shows up in diagnostics instead of hanging the handshake.
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildEnv(opts),
  });

  // Accumulate child stderr so a deadlocked/failed handshake can be explained by the
  // caller (see attachStderr-aware error surfacing in the smoke test).
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  // Expose the captured stderr without widening the public type — handy on failures.
  (child as ChildProcess & { collectedStderr?: () => string }).collectedStderr = () => stderr;

  const captured: any[] = [];

  // The client handler the agent talks back to. Mirrors the in-process stub: notifications
  // are buffered; the request callbacks are inert defaults (READ-ONLY `initialize` never
  // triggers them — a later prompt sub-task can override them). The optional `onSessionUpdate`
  // hook (sub-task 3.2) runs BEFORE the buffer push: if it throws, the throw propagates as the
  // client handler's rejection over the genuine transport (a real ACP client error), and the
  // notification is NOT captured — exactly how a rejecting Zed would behave for that update.
  const testClient: Client = {
    async sessionUpdate(params) {
      if (opts.onSessionUpdate) await opts.onSessionUpdate(params);
      captured.push(params);
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
    async readTextFile() {
      return { content: "" };
    },
    async writeTextFile() {
      return {};
    },
  };

  // Inverted server wiring: write to the child's stdin, read from the child's stdout. Order
  // is ndJsonStream(writable, readable); a swapped order or Node-vs-Web streams deadlocks
  // the JSON-RPC handshake — hence the reuse of the production helpers.
  const stream = ndJsonStream(nodeToWebWritable(child.stdin!), nodeToWebReadable(child.stdout!));
  const agent = new ClientSideConnection(() => testClient, stream);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (!child.killed) child.kill();
    // Run the caller's teardown (e.g. the planter temp-dir removal) AFTER reaping the child, and
    // never let a best-effort cleanup throw out of an idempotent dispose.
    if (opts.cleanup) {
      try {
        opts.cleanup();
      } catch {
        /* best-effort cleanup — the child is already reaped */
      }
    }
  };

  return { agent, captured, child, configDir: opts.configDir, dispose };
}

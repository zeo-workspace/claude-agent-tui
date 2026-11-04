// Story 071, task 5.1 — `initialize` advertises the same capabilities before and after the move to
// ACP SDK 2.x, agent SDK 0.3.30x and @anthropic-ai/sdk 1.x, field for field (R1.2, R1.3).
//
// The oracle is `fixtures/initialize-baseline.json`, recorded on the 1.x line BEFORE the move (fork
// 94a95db: ACP SDK 1.8.0, agent SDK 0.3.296). Each case spawns the BUILT adapter (`node
// dist/index.js`, built by `npm run test:fork`) and speaks raw JSON-RPC over its stdio — no ACP SDK
// on the client side, so the client cannot move with the dependency it is judging. What crosses the
// wire is compared with the baseline both ways: a field dropped, a field added and a value changed
// are each a difference.
//
// Normalised, because they are not capabilities: the node binary and the adapter's own argv inside
// `_meta["terminal-auth"]` (they vary per machine), and `agentInfo.name`/`version` (they change on
// every release and differ fork vs mirror) — each only after checking it is exactly the expected
// value, so a wrong one is still a difference.
//
// Re-recording: `UPDATE_INITIALIZE_BASELINE=1 node --experimental-strip-types --test
// test/initialize-wire-parity.test.ts` writes the fixture, and refuses unless the installed ACP SDK
// is still 1.x — the baseline is taken before the move, never after it. Offline: no `claude`, no
// PTY, no network.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Variant = {
  clientCapabilities: Record<string, Json>;
  env?: Record<string, string>;
  args?: string[];
  entry?: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const FIXTURE = path.join(ROOT, "test", "fixtures", "initialize-baseline.json");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const NODE = "<node>";
const ADAPTER_ARGV = "<adapter-argv>";

// Every client shape that changes the answer: the auth flags, the gateway, a remote shell and the
// hide flag, plus the exact capability set `zed-patches/scripts/acp-probe.mjs init` sends.
const VARIANTS: Record<string, Variant> = {
  bare: { clientCapabilities: {} },
  "terminal-auth": { clientCapabilities: { auth: { terminal: true } } },
  "meta-terminal-auth": { clientCapabilities: { _meta: { "terminal-auth": true } } },
  gateway: { clientCapabilities: { auth: { _meta: { gateway: true } } } },
  "acp-probe": {
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      _meta: { terminal_output: true, "terminal-auth": true },
    },
  },
  elicitation: { clientCapabilities: { elicitation: { form: {} } } },
  remote: {
    clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } },
    env: { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
  },
  "hide-claude-auth": {
    clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } },
    args: ["--hide-claude-auth"],
  },
};

// The child sees only these from the developer's environment: a stray SSH_* or CLAUDE_CODE_REMOTE
// would flip the auth methods and read as a regression. The built-in model catalogue keeps the
// adapter from spawning `claude` (see test/helpers/test-setup.ts).
function childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, CLAUDE_TUI_MODEL_CATALOG: "builtin", ...extra };
}

async function captureInitialize(variant: Variant): Promise<Json> {
  const args = [variant.entry ?? ENTRY, ...(variant.args ?? [])];
  const child = spawn(process.execPath, args, {
    cwd: os.tmpdir(),
    env: childEnv(variant.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    const raw = await new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`initialize timed out; adapter stderr:\n${stderr}`)),
        15_000,
      );
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== 1) continue;
          clearTimeout(timer);
          if (msg.error) reject(new Error(`initialize answered ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`adapter exited (${code}) before answering; stderr:\n${stderr}`));
      });
      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: variant.clientCapabilities },
      };
      child.stdin.write(JSON.stringify(request) + "\n");
    });
    return normalize(raw, args);
  } finally {
    child.kill();
  }
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces the machine- and release-specific values with placeholders, each only when it is
 *  exactly what the adapter must have sent; anything else is left as it is and so differs. */
function normalize(response: Json, adapterArgv: string[]): Json {
  const copy: Json = JSON.parse(JSON.stringify(response));
  if (!isObject(copy)) return copy;
  const info = copy.agentInfo;
  if (isObject(info)) {
    if (info.name === PACKAGE.name) info.name = "<package.name>";
    if (info.version === PACKAGE.version) info.version = "<package.version>";
  }
  const methods = Array.isArray(copy.authMethods) ? copy.authMethods : [];
  for (const method of methods) {
    const meta = isObject(method) ? method._meta : undefined;
    const auth = isObject(meta) ? meta["terminal-auth"] : undefined;
    if (!isObject(auth)) continue;
    if (auth.command === process.execPath) auth.command = NODE;
    const argv = auth.args;
    const prefixed =
      Array.isArray(argv) &&
      adapterArgv.length > 0 &&
      adapterArgv.every((arg, i) => argv[i] === arg);
    if (prefixed) auth.args = [ADAPTER_ARGV, ...(argv as Json[]).slice(adapterArgv.length)];
  }
  return copy;
}

/** Every difference between two wire values, by JSON path. Arrays are ordered: the client shows
 *  `authMethods` in the order sent. */
function wireDiff(actual: Json | undefined, expected: Json | undefined, at = "$"): string[] {
  if (isObject(actual) && isObject(expected)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].sort().flatMap((key) => {
      const where = `${at}.${key}`;
      if (!(key in actual)) return [`dropped ${where}`];
      if (!(key in expected)) return [`added ${where}`];
      return wireDiff(actual[key], expected[key], where);
    });
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const length = Math.max(actual.length, expected.length);
    return Array.from({ length }, (_, i) => {
      if (i >= actual.length) return [`dropped ${at}[${i}]`];
      if (i >= expected.length) return [`added ${at}[${i}]`];
      return wireDiff(actual[i], expected[i], `${at}[${i}]`);
    }).flat();
  }
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [`changed ${at}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`];
}

function installedAcpSdkMajor(): number {
  // Read from disk: the SDK's `exports` map does not expose its package.json.
  const file = path.join(ROOT, "node_modules", "@agentclientprotocol", "sdk", "package.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { version: string };
  return Number(manifest.version.split(".")[0]);
}

function clone(value: Json): any {
  return JSON.parse(JSON.stringify(value));
}

const live: Record<string, Json> = {};
let baseline: Record<string, Json> = {};
const scratch: string[] = [];

before(async () => {
  for (const [name, variant] of Object.entries(VARIANTS)) {
    live[name] = await captureInitialize(variant);
  }
  if (process.env.UPDATE_INITIALIZE_BASELINE) {
    if (installedAcpSdkMajor() !== 1) {
      throw new Error("the initialize baseline is recorded before the ACP SDK 2.x move, never after");
    }
    const recorded = {
      recordedOn: "ACP SDK 1.x, before story 071's dependency move",
      variants: live,
    };
    fs.writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + "\n");
  }
  baseline = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).variants;
});

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// Hostile half 1: a response that is NOT the same must never read as the same.
describe("initialize parity — a changed answer is reported (R1.3)", () => {
  test("reports a dropped capability by its path", () => {
    const changed = clone(live.bare);
    delete changed.agentCapabilities.sessionCapabilities.delete;
    assert.deepEqual(wireDiff(changed, baseline.bare), [
      "dropped $.agentCapabilities.sessionCapabilities.delete",
    ]);
  });

  test("reports an added capability by its path", () => {
    const changed = clone(live.bare);
    changed.agentCapabilities.sessionCapabilities.stop = {};
    assert.deepEqual(wireDiff(changed, baseline.bare), [
      "added $.agentCapabilities.sessionCapabilities.stop",
    ]);
  });

  test("reports a value whose type changed, and an empty object that became null", () => {
    const changed = clone(live.bare);
    changed.agentCapabilities.loadSession = "true";
    changed.agentCapabilities.sessionCapabilities.close = null;
    assert.deepEqual(wireDiff(changed, baseline.bare), [
      'changed $.agentCapabilities.loadSession: true -> "true"',
      "changed $.agentCapabilities.sessionCapabilities.close: {} -> null",
    ]);
  });

  test("reports auth methods sent in another order", () => {
    const changed = clone(live["terminal-auth"]);
    assert.ok(changed.authMethods.length > 1, "the terminal-auth shape offers two methods");
    changed.authMethods.reverse();
    assert.notDeepEqual(wireDiff(changed, baseline["terminal-auth"]), []);
  });

  test("reports a terminal-auth command that lost the adapter's own argv", () => {
    const changed = clone(live["meta-terminal-auth"]);
    const auth = changed.authMethods[0]._meta["terminal-auth"];
    assert.equal(auth.args[0], ADAPTER_ARGV);
    auth.args = auth.args.slice(1);
    assert.notDeepEqual(wireDiff(changed, baseline["meta-terminal-auth"]), []);
  });

  test("leaves an agentInfo that is not this package's unnormalised, so it differs", () => {
    const raw = clone(live.bare);
    raw.agentInfo = { ...raw.agentInfo, name: "claude-agent-acp", version: "0.0.0" };
    assert.deepEqual(wireDiff(normalize(raw, [ENTRY]), baseline.bare), [
      'changed $.agentInfo.name: "<package.name>" -> "claude-agent-acp"',
      'changed $.agentInfo.version: "<package.version>" -> "0.0.0"',
    ]);
  });
});

// Hostile half 2: a response that IS the same must never read as a change.
describe("initialize parity — an equivalent answer is not a change (R1.3)", () => {
  test("ignores key order", () => {
    const reordered = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(reordered);
      if (!isObject(value)) return value;
      const entries = Object.entries(value).reverse();
      return Object.fromEntries(entries.map(([k, v]) => [k, reordered(v)]));
    };
    assert.deepEqual(wireDiff(reordered(live["acp-probe"]), baseline["acp-probe"]), []);
  });

  test("treats the adapter reached through another path and argv as the same adapter", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "initialize-parity-"));
    scratch.push(dir);
    const entry = path.join(dir, "claude-agent-acp-tui.js");
    fs.symlinkSync(ENTRY, entry);
    const variant = VARIANTS["meta-terminal-auth"];
    const moved: any = await captureInitialize({ ...variant, entry, args: ["--unused-probe-flag"] });
    assert.equal(moved.authMethods[0]._meta["terminal-auth"].args[0], ADAPTER_ARGV);
    assert.deepEqual(wireDiff(moved, baseline["meta-terminal-auth"]), []);
  });

  test("treats another release number of this package as the same answer", () => {
    const raw = clone(live.bare);
    raw.agentInfo.name = PACKAGE.name;
    raw.agentInfo.version = PACKAGE.version;
    assert.deepEqual(wireDiff(normalize(raw, [ENTRY]), baseline.bare), []);
  });
});

// Benign: every captured client shape answers exactly as the 1.x line did.
describe("initialize parity — field for field with the 1.x baseline (R1.2, R1.3)", () => {
  test("records a baseline for exactly the client shapes probed", () => {
    assert.deepEqual(Object.keys(baseline).sort(), Object.keys(VARIANTS).sort());
  });

  for (const name of Object.keys(VARIANTS)) {
    test(`answers ${name} exactly as before the move`, () => {
      assert.deepEqual(wireDiff(live[name], baseline[name]), []);
    });
  }
});

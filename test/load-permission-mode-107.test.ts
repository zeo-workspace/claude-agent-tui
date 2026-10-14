// Item 107 — `session/load` restores the permission mode the transcript last recorded.
//
// A load is replay-only: no `claude` runs, so the live pump that reconciles the mode from
// `permission-mode` records (story 046) never runs either, and a loaded thread used to advertise the
// settings `defaultMode` instead. Measured 2026-10-14 over real ACP stdio on a COPY of an interactive
// CLI 2.1.299 transcript whose `permission-mode` record says "auto": the load answered
// `currentModeId: "default"` and sent no `current_mode_update`. The plus adapter fixed the same gap
// in its 0.23.5 (`readResumedPermissionMode`, upstream #1218's mode half); this ports it.
//
// The tui's transcripts are written by the INTERACTIVE CLI, which records the mode in two places: a
// `permission-mode` record (several per session) and, on some prompts, a user record's
// `permissionMode`. The tail-most of either is the mode.
//
// node:test (build first): node --experimental-strip-types --import ./test/helpers/test-setup.ts \
//   --test test/load-permission-mode-107.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTranscriptPermissionMode } from "../dist/resumed-permission-mode.js";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { projectSlug } from "./helpers/plant-transcript.ts";

function tmpFile(lines: unknown[]): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-107-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const prompt = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content: text },
  ...extra,
});
const modeRecord = (permissionMode: string) => ({ type: "permission-mode", permissionMode, sessionId: "s" });

// --- the tail reader -------------------------------------------------------------------------------

test("107: the tail-most `permission-mode` record is the mode (interactive CLI shape)", async (t) => {
  const { file, cleanup } = tmpFile([modeRecord("default"), prompt("a"), modeRecord("acceptEdits"), prompt("b")]);
  t.after(cleanup);
  assert.equal(await readTranscriptPermissionMode(file), "acceptEdits");
});

test("107: a later prompt's `permissionMode` outranks an earlier record, and vice versa", async (t) => {
  const a = tmpFile([modeRecord("default"), prompt("a", { permissionMode: "plan" })]);
  const b = tmpFile([prompt("a", { permissionMode: "plan" }), modeRecord("auto")]);
  t.after(() => (a.cleanup(), b.cleanup()));
  assert.equal(await readTranscriptPermissionMode(a.file), "plan");
  assert.equal(await readTranscriptPermissionMode(b.file), "auto");
});

test("107: a sidechain record is not the session's mode", async (t) => {
  const { file, cleanup } = tmpFile([modeRecord("acceptEdits"), prompt("sub", { isSidechain: true, permissionMode: "plan" })]);
  t.after(cleanup);
  assert.equal(await readTranscriptPermissionMode(file), "acceptEdits");
});

test("107: a `plan` before a later plan exit is not the current mode", async (t) => {
  const { file, cleanup } = tmpFile([
    prompt("p", { permissionMode: "plan" }),
    { type: "attachment", isSidechain: false, attachment: { type: "plan_mode_exit" } },
  ]);
  t.after(cleanup);
  assert.equal(await readTranscriptPermissionMode(file), undefined);
});

test("107: the search stops at a human prompt that records no mode (an older transcript)", async (t) => {
  const { file, cleanup } = tmpFile([modeRecord("acceptEdits"), prompt("old", { origin: { kind: "human" } })]);
  t.after(cleanup);
  assert.equal(await readTranscriptPermissionMode(file), undefined);
});

test("107: a record split across the 64 KiB read boundary is still read; junk lines are skipped", async (t) => {
  const big = "x".repeat(200 * 1024);
  const { file, cleanup } = tmpFile([modeRecord("plan"), "{not json", prompt(big), prompt(big, { permissionMode: "acceptEdits" }), prompt("tail")]);
  t.after(cleanup);
  assert.equal(await readTranscriptPermissionMode(file), "acceptEdits");
});

test("107: a missing file or a transcript with no mode gives undefined, never a throw", async (t) => {
  assert.equal(await readTranscriptPermissionMode("/nonexistent/tui-107.jsonl"), undefined);
  const { file, cleanup } = tmpFile([prompt("a")]);
  t.after(cleanup);
  assert.equal(await readTranscriptPermissionMode(file), undefined);
});

// --- session/load over real ACP stdio, isolated HOME -----------------------------------------------

const SIM_CWD = "/zedsim/proj107";

function plant(lines: unknown[]) {
  const sessionId = crypto.randomUUID();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zedsim-107-"));
  const configDir = path.join(home, ".claude");
  const dir = path.join(configDir, "projects", projectSlug(SIM_CWD));
  fs.mkdirSync(dir, { recursive: true });
  let parentUuid: string | null = null;
  const body = lines.map((l: any, i) => {
    if (l.type !== "user" && l.type !== "assistant") return JSON.stringify(l);
    const uuid = `m${i}`;
    const rec = { ...l, uuid, parentUuid, sessionId, cwd: SIM_CWD, timestamp: new Date(Date.UTC(2026, 9, 14, 10, 0, i)).toISOString() };
    parentUuid = uuid;
    return JSON.stringify(rec);
  });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body.join("\n") + "\n");
  return { sessionId, home, configDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

async function load(lines: unknown[], t: any) {
  const p = plant(lines);
  const sim = startZedSim({ configDir: p.configDir, home: p.home, cleanup: p.cleanup });
  t.after(() => sim.dispose());
  await sim.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const res: any = await sim.agent.loadSession({ sessionId: p.sessionId, cwd: SIM_CWD, mcpServers: [] });
  const modeOption = (res.configOptions ?? []).find((o: any) => o.id === "mode");
  return { res, modeOption };
}

const ASSISTANT = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };

test("107 wire: a loaded thread advertises the mode its transcript last recorded", async (t) => {
  const { res, modeOption } = await load([modeRecord("default"), prompt("hi"), ASSISTANT, modeRecord("acceptEdits")], t);
  assert.equal(res.modes.currentModeId, "acceptEdits", "the load response carries the transcript's mode");
  assert.equal(modeOption?.currentValue, "acceptEdits", "the mode config option agrees");
});

test("107 wire: a recorded mode the session does not offer leaves the settings default", async (t) => {
  const { res, modeOption } = await load([prompt("hi"), ASSISTANT, modeRecord("notAMode")], t);
  assert.equal(res.modes.currentModeId, "default");
  assert.equal(modeOption?.currentValue, "default");
});

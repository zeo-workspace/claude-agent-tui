// Parity round 26 (item 238): the `--add-dir` trust dialog of claude 2.1.326+.
//
// The watcher reads the PTY from spawn, names the folder an open dialog asks about, settles once the
// main screen shows, and answers with the keystrokes measured live on claude 2.1.330 (`2` keeps the
// folder, Esc ends claude). Fully OFFLINE — a fake PTY, no claude.
//
// node:test: build first, then
//   node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/add-dir-trust.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../dist/add-dir-trust.js";

class FakeTrustPty {
  listeners: Array<(d: string) => void> = [];
  written: string[] = [];
  disposed = 0;
  onData(listener: (d: string) => void) {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.disposed += 1;
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }
  write(data: string) {
    this.written.push(data);
  }
  emit(data: string) {
    for (const l of [...this.listeners]) l(data);
  }
}

// What claude 2.1.330 drew for an untrusted --add-dir (ANSI cursor moves between the words).
const DIALOG = (dir: string) =>
  `\x1b[2J\x1b[1;1H ${T.TRUST_DIALOG_MARKER}\x1b[2;3H${dir}\x1b[4;1HThis session hasn't worked here before.` +
  `\x1b[8;3H No, exit\x1b[9;3H Yes, add it\x1b[11;1HEnter to confirm · Esc to cancel`;
const MAIN = "\x1b[30;1H ⏵⏵ auto mode on ◐ medium · /effort (shift+tab to cycle)";
const now = (fn: () => void) => fn();
const never = () => {};

test("names the folder an open dialog asks about, also when claude prints it as ~/…", () => {
  assert.equal(T.dialogDirectory(T.screenText(DIALOG("/tmp/u.abc")), ["/tmp/u.abc"], "/home/x"), "/tmp/u.abc");
  assert.equal(
    T.dialogDirectory(T.screenText(DIALOG("~/proj/b")), ["/home/x/proj", "/home/x/proj/b"], "/home/x"),
    "/home/x/proj/b",
    "the longest folder that matches wins",
  );
  assert.equal(T.dialogDirectory("nothing here", ["/tmp/a"], "/home/x"), undefined);
});

test("an open dialog settles the wait and is answered `2` for yes", async () => {
  const pty = new FakeTrustPty();
  const w = new T.AddDirTrustWatcher(pty, ["/tmp/u.abc"], "/home/x");
  const settled = w.settled(10_000, never);
  pty.emit(DIALOG("/tmp/u.abc"));
  await settled;
  assert.equal(w.pending(), "/tmp/u.abc");
  w.answer(true);
  assert.deepEqual(pty.written, ["2"]);
  assert.equal(w.pending(), undefined, "an answered dialog is forgotten");
  pty.emit(MAIN);
  assert.equal(w.done(), true);
  assert.equal(pty.disposed, 1, "the tap goes away once the main screen shows");
});

test("no answers Esc (claude's own cancel)", () => {
  const pty = new FakeTrustPty();
  const w = new T.AddDirTrustWatcher(pty, ["/tmp/u.abc"], "/home/x");
  pty.emit(DIALOG("/tmp/u.abc"));
  w.answer(false);
  assert.deepEqual(pty.written, ["\x1b"]);
});

test("a trusted folder: the main screen settles the wait with no dialog", async () => {
  const pty = new FakeTrustPty();
  const w = new T.AddDirTrustWatcher(pty, ["/tmp/ok"], "/home/x");
  pty.emit(MAIN);
  await w.settled(10_000, never);
  assert.equal(w.pending(), undefined);
  assert.equal(w.done(), true);
});

test("silence settles after the timeout, leaving nothing pending", async () => {
  const pty = new FakeTrustPty();
  const w = new T.AddDirTrustWatcher(pty, ["/tmp/ok"], "/home/x");
  await w.settled(5, now);
  assert.equal(w.pending(), undefined);
  assert.equal(w.done(), false);
});

test("a second folder's dialog after the first is answered is recognised on its own", () => {
  const pty = new FakeTrustPty();
  const w = new T.AddDirTrustWatcher(pty, ["/tmp/a", "/tmp/b"], "/home/x");
  pty.emit(DIALOG("/tmp/a"));
  assert.equal(w.pending(), "/tmp/a");
  w.answer(true);
  pty.emit(DIALOG("/tmp/b"));
  assert.equal(w.pending(), "/tmp/b");
});

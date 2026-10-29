// Story 063 — tool titles survive a non-string path and show the CLI's input aliases.
//
// Ports of claude-agent-plus's fixes for upstream #1308 (a model can emit `{"file_path": 12345}`;
// `path.resolve` throws on it), #1271 (Grep `file_path` for `path`, CLI 2.1.292) and #1330 (Grep
// `-l`/`-c` for `output_mode`, Bash `command_description` for `description`, CLI 2.1.295).
//   node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/tool-titles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { toolInfoFromToolUse, toDisplayPath } from "../dist/tools.js";

const cwd = "/home/u/project";
const info = (name: string, input: unknown) => toolInfoFromToolUse({ id: "t1", name, input } as never, false, cwd);

// ---- hostile first: a non-string path never throws and never reaches a path function ----------

const NON_STRING_PATHS: unknown[] = [12345, { evil: "../../etc/passwd" }, ["/etc/passwd"], null, true];

for (const tool of ["Read", "Edit", "Write"]) {
  test(`063 hostile: ${tool} with a non-string file_path does not throw`, () => {
    for (const value of NON_STRING_PATHS) {
      assert.doesNotThrow(() => info(tool, { file_path: value, old_string: "a", new_string: "b" }), String(value));
    }
  });

  test(`063 hostile: ${tool} with a non-string file_path sends no location`, () => {
    for (const value of NON_STRING_PATHS) {
      const result = info(tool, { file_path: value, old_string: "a", new_string: "b", content: "x" });
      assert.deepEqual(result.locations ?? [], [], `${tool} ${JSON.stringify(value)}`);
    }
  });
}

test("063 hostile: Grep with a non-string path or file_path does not throw", () => {
  for (const value of NON_STRING_PATHS) {
    assert.doesNotThrow(() => info("Grep", { pattern: "x", path: value }), String(value));
    assert.doesNotThrow(() => info("Grep", { pattern: "x", file_path: value }), String(value));
  }
});

test("063 hostile: a non-string path never reaches path.resolve", (t) => {
  const resolve = t.mock.method(path, "resolve");
  info("Read", { file_path: 12345 });
  info("Edit", { file_path: { a: 1 } });
  assert.equal(resolve.mock.callCount(), 0);
});

test("063 hostile: toDisplayPath itself refuses a non-string instead of throwing", () => {
  assert.doesNotThrow(() => toDisplayPath(12345 as unknown as string, cwd));
  assert.equal(toDisplayPath(12345 as unknown as string, cwd), "12345");
  assert.equal(toDisplayPath({ a: 1 } as unknown as string, cwd), "");
});

test("063 a scalar non-string path shows as its text; an object or null shows nothing", () => {
  assert.equal(info("Read", { file_path: 12345 }).title, "Read 12345");
  assert.equal(info("Read", { file_path: { a: 1 } }).title, "Read File");
  assert.equal(info("Read", { file_path: null }).title, "Read File");
  assert.equal(info("Edit", { file_path: 7 }).title, "Edit 7");
});

// ---- Grep aliases ------------------------------------------------------------------------------

test("063 Grep reads file_path when path is absent", () => {
  assert.match(info("Grep", { pattern: "foo", file_path: "src/a.ts" }).title, /src\/a\.ts/);
});

test("063 Grep: path wins over file_path when both are present (plus #1271)", () => {
  const title = info("Grep", { pattern: "foo", path: "src/canon", file_path: "src/alias" }).title;
  assert.match(title, /src\/canon/);
  assert.doesNotMatch(title, /src\/alias/);
});

test("063 Grep: -l and -c read as output_mode when it is unset", () => {
  assert.equal(
    info("Grep", { pattern: "foo", "-l": true }).title,
    info("Grep", { pattern: "foo", output_mode: "files_with_matches" }).title,
  );
  assert.equal(
    info("Grep", { pattern: "foo", "-c": "true" }).title,
    info("Grep", { pattern: "foo", output_mode: "count" }).title,
  );
});

test("063 Grep: output_mode wins over -l/-c", () => {
  assert.equal(
    info("Grep", { pattern: "foo", output_mode: "count", "-l": true }).title,
    info("Grep", { pattern: "foo", output_mode: "count" }).title,
  );
});

// ---- Bash alias --------------------------------------------------------------------------------

test("063 Bash shows command_description when description is absent", () => {
  const result = info("Bash", { command: "ls", command_description: "List the files" });
  assert.equal(JSON.stringify(result.content).includes("List the files"), true);
});

test("063 Bash: description wins over command_description", () => {
  const result = info("Bash", { command: "ls", description: "canon", command_description: "alias" });
  const text = JSON.stringify(result.content);
  assert.ok(text.includes("canon"));
  assert.ok(!text.includes("alias"));
});

// ---- unchanged: string paths -------------------------------------------------------------------

test("063 unchanged: a string path inside cwd renders relative", () => {
  assert.equal(info("Read", { file_path: "/home/u/project/src/a.ts" }).title, "Read src/a.ts");
});

test("063 unchanged: a string path outside cwd renders absolute", () => {
  assert.equal(info("Read", { file_path: "/etc/hosts" }).title, "Read /etc/hosts");
});

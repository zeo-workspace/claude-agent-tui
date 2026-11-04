// Story 063 / Task 1.2 (R1.1, R2, R3, R5) — OFFLINE discovery of custom slash-commands for the ACP
// fork's `available_commands` advertisement.
//
// The command analog of {@link file://./agent-catalog.ts}: PURE + dependency-injectable, sharing the
// exact style — a minimal inline frontmatter line-parser (NO YAML dep), graceful `readdirMd`/`readFile`
// seams (try/catch → the empty-state, NEVER a throw), an ordered `Map<name, entry>` first-wins dedup,
// and an alphabetical sort. Unlike `agent-catalog.ts` this surface is FULLY OFFLINE — no subprocess,
// no probe, no network: slash-commands live on disk (`<cwd>/.claude/commands/*.md`, `~/.claude/commands/
// *.md`) plus a curated built-in tier. The only `node:` builtins are os/fs/path; the single non-`node:`
// import is TYPE-ONLY (`AvailableCommand`), so it is erased at runtime and adds no runtime dependency
// (FORK.md pins node-pty + the SDK as the only runtime deps; this file adds none).
//
// PRECEDENCE (R1.1 / R7 / R8.1). Four disk surfaces are consulted, highest precedence first — commands
// out-scope skills at the SAME scope, and any cwd surface out-scopes any user surface:
//   1. `<cwd>/.claude/commands/*.md`    (cwd commands)
//   2. `<cwd>/.claude/skills/*/SKILL.md` (cwd skills — R7)
//   3. `~/.claude/commands/*.md`         (user commands)
//   4. `~/.claude/skills/*/SKILL.md`      (user skills — R7)
// then the built-in tier (R9, populated in Task 1.5) is the LOWEST precedence: a built-in whose name
// collides with a disk entry loses. One entry per name (first-wins across the ordered surfaces). The
// visible result is FLAT ALPHABETICAL by `name` — tiers govern collision dedup ONLY, not grouping
// (determinism + parity with `agent-catalog.ts`'s `sortByValue`).
//
// SKILLS (R7 / R7.1): a skill lives at `<scope>/.claude/skills/<name>/SKILL.md`; the command `name` is
// the DIRECTORY name (same R3 allowlist as a command) and `description` comes from the `SKILL.md`
// frontmatter. A skills subdir WITHOUT a `SKILL.md` is NOT a command (the `readFile` throw skips it).
// Skills carry no `argument-hint`, so a skill entry is `{ name, description }` with no `input`.
//
// SECURITY (R3): a command `name` is the file's basename sans `.md`; it is checked against
// {@link SAFE_COMMAND_NAME} = `/^[a-z0-9_-]+$/` and the entry is DROPPED on any failure (a name with
// spaces, quotes, path separators, uppercase, … never renders). A missing/unreadable dir or file yields
// `[]` for that surface — discovery NEVER throws or crashes the session (R3 / R5).
//
// PURE + dependency-injectable (R5): all fs/home access goes through the {@link DiscoverCommandsDeps}
// seams so the unit tests inject an in-memory fs and never touch the real `~/.claude`; the built-in tier
// is likewise an injectable seam (`builtins`) defaulting to {@link BUILTIN_COMMANDS}.
//
// node:test runner: `node --experimental-strip-types --test test/command-catalog.test.ts`
import { homedir as osHomedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// TYPE-ONLY import — erased at runtime, adds no runtime dependency.
import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";

/**
 * The curated built-in slash-command tier (R9) — the interactive `claude` TUI's own built-ins, which are
 * baked into the binary and therefore NOT disk-discoverable. This is a CURATED APPROXIMATION (C1), NOT a
 * live probe: it stands beside the same static-curation idea as `MODEL_CATALOG`. It is the LOWEST-
 * precedence tier, so any disk command/skill of the same name shadows a built-in (R1/R9). Names are
 * lowercase (R3) and every entry carries a non-empty `description` (the SDK requires it). The list is
 * intentionally small and conservative — a documented approximation, not an exhaustive enumeration.
 */
export const BUILTIN_COMMANDS: readonly AvailableCommand[] = [
  { name: "clear", description: "Clear the conversation history and free up context" },
  { name: "compact", description: "Summarize and compact the current conversation" },
  { name: "config", description: "Open the settings / configuration panel" },
  { name: "cost", description: "Show token usage and cost for the current session" },
  { name: "help", description: "List available slash commands and usage help" },
  { name: "init", description: "Initialize a CLAUDE.md with codebase documentation" },
  { name: "memory", description: "Edit the project or user memory (CLAUDE.md) files" },
  { name: "model", description: "Switch the active model for the session" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "review", description: "Review a pull request or the pending changes" },
];

/**
 * Injectable seams for {@link discoverCommands} — defaults wire the `node:` stdlib and the built-in
 * tier. Tests pass fakes so discovery is exercised against an in-memory fs and an isolated (`[]`)
 * built-in tier, never the real disk or the real `~/.claude` (R5).
 */
export interface DiscoverCommandsDeps {
  /** Resolve the user's home directory (default: `os.homedir`). */
  homedir?: () => string;
  /** List the `*.md` filenames in `dir`; MUST return `[]` when `dir` is missing/unreadable. */
  readdirMd?: (dir: string) => string[];
  /**
   * List the IMMEDIATE sub-directory names of `dir` (for the skills tier — R7); MUST return `[]` when
   * `dir` is missing/unreadable. Default: {@link defaultReaddirDirs}.
   */
  readdirDirs?: (dir: string) => string[];
  /** Read a file's UTF-8 contents (default: `fs.readFileSync(p, "utf8")`). */
  readFile?: (path: string) => string;
  /** The built-in command tier (lowest precedence). Default: {@link BUILTIN_COMMANDS}. */
  builtins?: readonly AvailableCommand[];
}

/**
 * The command-name allowlist (R3). A single un-namespaced segment: LOWERCASE letters/digits/underscore/
 * hyphen only (no spaces, no uppercase, no shell metacharacters, no path separators). Slash-command
 * names are conventionally lowercase, so — unlike `agent-catalog.ts`'s {@link SAFE_AGENT_NAME} — this
 * allowlist excludes uppercase.
 */
export const SAFE_COMMAND_NAME = /^[a-z0-9_-]+$/;

/** True iff `name` is a non-empty string matching {@link SAFE_COMMAND_NAME} (R3). */
export function isSafeCommandName(name: unknown): name is string {
  return typeof name === "string" && SAFE_COMMAND_NAME.test(name);
}

/**
 * Default `readdirMd`: list `*.md` filenames in `dir`, returning `[]` when the directory is missing or
 * unreadable (the empty-state — never throws). Sorted for a stable first-wins ordering within a dir.
 * Mirrors `agent-catalog.ts`'s `defaultReaddirMd`.
 */
function defaultReaddirMd(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Default `readdirDirs`: list the IMMEDIATE sub-directory names of `dir`, returning `[]` when the
 * directory is missing or unreadable (the empty-state — never throws). Sorted for a stable first-wins
 * ordering within the skills tier. Mirrors the graceful try/catch style of {@link defaultReaddirMd}.
 */
function defaultReaddirDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Default `readFile`: UTF-8 file read via the `node:fs` stdlib. */
function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** The leading `name` (sans `.md`) of a command file — the command's name. */
function baseName(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

/** The frontmatter fields we extract — `description` and (hyphenated) `argument-hint`. */
interface CommandFrontmatter {
  description?: string;
  argumentHint?: string;
}

/**
 * Minimal `---`-fenced frontmatter line-parser (NOT a full YAML dep). Reads the leading `---\n … \n---`
 * block and pulls the `description` and `argument-hint` `key: value` lines; a single pair of surrounding
 * quotes on a value is stripped. The frontmatter key `argument-hint` (a HYPHEN) is returned as the
 * camelCase {@link CommandFrontmatter.argumentHint}. A file whose first line is not `---` yields `{}`.
 * Tiny + pure on purpose, mirroring `agent-catalog.ts`'s `parseFrontmatter` — the command frontmatter we
 * consume is flat `key: value`.
 */
export function parseCommandFrontmatter(content: string): CommandFrontmatter {
  // The opening fence must be the very first line. Bail to `{}` when there is no fenced block.
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  const out: CommandFrontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break; // closing fence — stop
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue; // not a `key: value` line — skip (lists/comments/blanks)
    const key = m[1].toLowerCase();
    if (key !== "description" && key !== "argument-hint") continue;
    let value = m[2].trim();
    // Strip a single pair of matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    if (key === "description") out.description = value;
    else out.argumentHint = value; // `argument-hint` → camelCase `argumentHint`
  }
  return out;
}

/**
 * Resolve a single command `*.md` file into an {@link AvailableCommand}, or `null` when it cannot
 * contribute a SAFE entry. The name is the filename stem, run through the R3 allowlist — the file is
 * DROPPED (→ `null`) on any failure, including an unreadable file (NEVER throws). `description` defaults
 * to `""` (the SDK REQUIRES it) when absent; an `argument-hint` maps to `input: { hint }`, which is
 * OMITTED entirely when there is none.
 */
function resolveEntry(
  dir: string,
  filename: string,
  readFile: (p: string) => string,
): AvailableCommand | null {
  const name = baseName(filename);

  // SECURITY (R3): drop any entry whose name escapes the allowlist — optional debug log, never a throw.
  if (!isSafeCommandName(name)) {
    if (process.env.FORK_COMMAND_DEBUG === "1") {
      process.stderr.write(
        `[command-catalog] dropped unsafe command name: ${JSON.stringify(name)}\n`,
      );
    }
    return null;
  }

  let fm: CommandFrontmatter;
  try {
    fm = parseCommandFrontmatter(readFile(join(dir, filename)));
  } catch {
    return null; // unreadable file — skip it, never throw (R3 / R5 graceful)
  }

  const description = fm.description ?? ""; // AvailableCommand.description is REQUIRED
  return {
    name,
    description,
    ...(fm.argumentHint ? { input: { hint: fm.argumentHint } } : {}), // OMIT `input` when no hint
  };
}

/**
 * Resolve a single skill sub-directory into an {@link AvailableCommand}, or `null` when it cannot
 * contribute a SAFE entry (R7 / R7.1). The name is the DIRECTORY name `subdirName`, run through the R3
 * allowlist — DROPPED (→ `null`, same optional `FORK_COMMAND_DEBUG` log as {@link resolveEntry}) on any
 * failure. The skill's `SKILL.md` is REQUIRED: `join(skillsDir, subdirName, "SKILL.md")` is read inside
 * a try/catch and a subdir WITHOUT one (`readFile` throws) is NOT a skill (→ `null`, never throws).
 * `description` is the `SKILL.md` frontmatter `description` (default `""` when absent). Skills carry NO
 * `argument-hint`, so the entry is `{ name, description }` — no `input`.
 */
function resolveSkillEntry(
  skillsDir: string,
  subdirName: string,
  readFile: (p: string) => string,
): AvailableCommand | null {
  const name = subdirName;

  // SECURITY (R3): drop any skill whose dir name escapes the allowlist — optional debug log, never a throw.
  if (!isSafeCommandName(name)) {
    if (process.env.FORK_COMMAND_DEBUG === "1") {
      process.stderr.write(
        `[command-catalog] dropped unsafe skill name: ${JSON.stringify(name)}\n`,
      );
    }
    return null;
  }

  let fm: CommandFrontmatter;
  try {
    fm = parseCommandFrontmatter(readFile(join(skillsDir, subdirName, "SKILL.md")));
  } catch {
    return null; // no readable SKILL.md — NOT a skill, skip it, never throw (R7 guard / R5 graceful)
  }

  const description = fm.description ?? ""; // AvailableCommand.description is REQUIRED
  return { name, description }; // skills have no argument-hint → no `input`
}

/** Sort entries by `name` for a stable, scope-independent ordering (parity with `sortByValue`). */
function sortByName(entries: AvailableCommand[]): AvailableCommand[] {
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Read the set of ENABLED plugin MARKETPLACES from `~/.claude/plugins/installed_plugins.json` (R8). The
 * gate is intentionally PRESENCE-in-the-manifest: per R8's explicitly-named source, an INSTALLED plugin
 * == an ENABLED plugin for this story (a finer `settings.json` → `enabledPlugins` gate is out of scope).
 *
 * The real manifest shape is `{ version, plugins: { "<name>@<marketplace>": [ { installPath, … }, … ] } }`
 * — a marketplace is enabled iff at least one `<name>@<marketplace>` key maps to a NON-EMPTY install
 * array. Everything here is DEFENSIVE against manifest-shape drift (R8 risk): a MISSING or MALFORMED
 * manifest, a non-object `plugins`, or any key/value that doesn't fit is treated as "disabled" and simply
 * contributes nothing — this NEVER throws (an unreadable/parse failure degrades to the empty set → all
 * plugins skipped).
 *
 * @param home     the resolved home dir (the manifest lives under `home/.claude/plugins`).
 * @param readFile the injectable UTF-8 file reader (throws on a missing manifest — caught here).
 * @returns the set of enabled marketplace names (EMPTY when the manifest is absent/malformed).
 */
function readEnabledMarketplaces(home: string, readFile: (p: string) => string): Set<string> {
  const path = join(home, ".claude", "plugins", "installed_plugins.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    return new Set(); // missing or malformed manifest → no enabled marketplaces (plugins skipped)
  }

  const enabled = new Set<string>();
  // `plugins` must be a plain, non-null object; anything else (array, primitive, null, absent) → empty.
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return enabled;

  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    // An installed plugin: a `<name>@<marketplace>` key mapping to a NON-EMPTY install array.
    if (!Array.isArray(value) || value.length === 0) continue; // treat "not installed" as disabled
    const at = key.lastIndexOf("@"); // marketplace = substring AFTER the last `@`
    if (at < 0) continue;
    const marketplace = key.slice(at + 1);
    if (marketplace.length > 0) enabled.add(marketplace);
  }
  return enabled;
}

/**
 * One ordered disk surface consulted by {@link discoverCommands}: a `commands` dir (scanned with
 * `readdirMd`+`resolveEntry`) or a `skills` dir (scanned with `readdirDirs`+`resolveSkillEntry`). The
 * surface ORDER encodes precedence (cwd before user, command before skill at a scope — R1.1 / R7 / R8.1).
 */
type DiskSource = { kind: "commands"; dir: string } | { kind: "skills"; dir: string };

/**
 * Discover the custom slash-commands to advertise via ACP `available_commands` — FULLY OFFLINE (no
 * subprocess, no network).
 *
 * TIERS, highest precedence first:
 *   1. `<cwd>/.claude/commands/*.md`      (cwd commands — R1.1 precedence)
 *   2. `<cwd>/.claude/skills/<name>/SKILL.md` (cwd skills — R7)
 *   3. `~/.claude/commands/*.md`           (user commands)
 *   4. `~/.claude/skills/<name>/SKILL.md`   (user skills — R7)
 *   5. `~/.claude/plugins/marketplaces/<m>/{commands,skills}` (ENABLED-plugin tier — R8; a plugin
 *      surface loses a name collision to any higher tier — R8.1)
 *   6. {@link DiscoverCommandsDeps.builtins} (the R9 built-in tier — LOWEST; a built-in loses a name
 *      collision to any disk entry)
 *
 * Each command `*.md` file yields `{ name, description, input? }` (R2): `name` = basename sans `.md`,
 * `description` = frontmatter `description` (else `""`), `input: { hint }` from `argument-hint` (omitted
 * when absent). Each skill `<name>/SKILL.md` yields `{ name, description }` (no `input`): `name` = the
 * DIRECTORY name, `description` = the `SKILL.md` frontmatter (R7 / R7.1). Every name is dropped if it
 * fails the R3 {@link SAFE_COMMAND_NAME} allowlist. Names are deduped FIRST-WINS across the ordered
 * surfaces — so a cwd command out-ranks a cwd skill (cmd > skill, same scope), any cwd surface
 * out-ranks any user surface, an enabled-plugin surface out-ranks the built-ins but LOSES to any
 * cwd/user surface (R8.1) — then the merged set is returned FLAT ALPHABETICAL by `name`.
 *
 * Never throws (R3 / R5): a missing/unreadable dir or file yields `[]` for that surface; a skills subdir
 * without a readable `SKILL.md` is skipped.
 *
 * @param cwd  the SESSION cwd (project dir) whose `.claude/{commands,skills}` take precedence.
 * @param deps injectable fs/home/builtins seams (default: `node:` stdlib + {@link BUILTIN_COMMANDS}).
 */
export function discoverCommands(cwd: string, deps: DiscoverCommandsDeps = {}): AvailableCommand[] {
  const homedir = deps.homedir ?? osHomedir;
  const readdirMd = deps.readdirMd ?? defaultReaddirMd;
  const readdirDirs = deps.readdirDirs ?? defaultReaddirDirs;
  const readFile = deps.readFile ?? defaultReadFile;
  const builtins = deps.builtins ?? BUILTIN_COMMANDS;

  const home = homedir();
  // Ordered disk surfaces (highest precedence first) — commands scanned via `readdirMd`+`resolveEntry`,
  // skills via `readdirDirs`+`resolveSkillEntry`. A cwd command outranks a cwd skill; any cwd surface
  // outranks any user surface (R1.1 / R7). The plugin tier (R8) slots in AFTER these, before builtins.
  const userSources: readonly DiskSource[] = [
    { kind: "commands", dir: join(cwd, ".claude", "commands") }, // cwd commands — highest
    { kind: "skills", dir: join(cwd, ".claude", "skills") }, // cwd skills
    { kind: "commands", dir: join(home, ".claude", "commands") }, // user commands
    { kind: "skills", dir: join(home, ".claude", "skills") }, // user skills
  ];

  const byName = new Map<string, AvailableCommand>();
  const add = (entry: AvailableCommand | null): void => {
    if (entry && !byName.has(entry.name)) byName.set(entry.name, entry);
  };
  // Fold one ordered disk surface into `byName` (first-wins): a commands dir via `readdirMd`, a skills
  // dir via `readdirDirs`. Shared by the user tier and the per-marketplace plugin tier.
  const foldSource = (source: DiskSource): void => {
    if (source.kind === "commands") {
      for (const filename of readdirMd(source.dir))
        add(resolveEntry(source.dir, filename, readFile));
    } else {
      for (const subdir of readdirDirs(source.dir))
        add(resolveSkillEntry(source.dir, subdir, readFile));
    }
  };

  for (const source of userSources) foldSource(source);

  // Plugin tier (R8), AFTER the user surfaces and BEFORE builtins — gated to ENABLED marketplaces per
  // `installed_plugins.json`. For each enabled marketplace (dirs already sorted), fold its `commands`
  // then its `skills`; first-wins means any plugin name already claimed by a cwd/user surface is DROPPED
  // (R8.1). A missing marketplaces dir / manifest degrades to skipping plugins (never throws).
  const marketplacesDir = join(home, ".claude", "plugins", "marketplaces");
  const enabled = readEnabledMarketplaces(home, readFile);
  for (const m of readdirDirs(marketplacesDir)) {
    if (!enabled.has(m)) continue; // treat a not-installed marketplace as disabled
    foldSource({ kind: "commands", dir: join(marketplacesDir, m, "commands") });
    foldSource({ kind: "skills", dir: join(marketplacesDir, m, "skills") });
  }

  // Built-in tier LAST (lowest precedence): a built-in whose name already appeared on disk is dropped.
  for (const cmd of builtins) {
    if (isSafeCommandName(cmd.name) && !byName.has(cmd.name)) byName.set(cmd.name, cmd);
  }

  return sortByName([...byName.values()]);
}

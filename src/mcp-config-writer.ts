// Story 057 / Task 2.1 — translate ACP MCP servers → claude `--mcp-config` JSON + scratch-file seam.
//
// The fork spawns the real `claude` TUI; claude consumes externally-declared MCP servers via a
// `--mcp-config <file.json>` flag (a `{ mcpServers: { <name>: { … } } }` document). The Zed client,
// however, declares its MCP servers over ACP as a `McpServer[]` array (a discriminated union). This
// module is the standalone, OFFLINE-testable translation + scratch-file seam between the two:
//
//   translateMcpServers(servers) → ClaudeMcpConfig   (PURE — array → claude `{mcpServers:{…}}` shape)
//   writeMcpScratch(config)      → Promise<string>   (DURABLE 0600 write → returns the scratch path)
//   removeMcpScratch(path)       → Promise<void>     (idempotent unlink on teardown)
//
// It owns NO engine wiring — the before-spawn `--mcp-config` plumbing into acp-agent.ts/the engine is
// a separate Task (2.2/2.3). The scratch-JSON discipline (temp-file → fsync → atomic rename, with a
// guaranteed 0600 mode) mirrors `gate/settings-writer.ts`'s private `durableWrite`; that pattern is
// copied here rather than imported (it is not exported there).
//
// SECRETS (R2.3): the scratch file may carry MCP auth headers / env / URLs. Its mode is forced to
// `0600` (owner-only) and it is removable on teardown. The config object, headers, env, and url are
// NEVER logged — the ONLY log this module emits is a one-line note when an `acp`-transport server is
// dropped, and that note carries no secret-bearing field.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer, HttpHeader, EnvVariable } from "@agentclientprotocol/sdk/unstable";

/**
 * A single entry under claude's `--mcp-config` `mcpServers` map. A discriminated union over the
 * transport claude understands:
 *   - http/sse → `{ type, url, headers? }` (headers as a plain `{ [name]: value }` object)
 *   - stdio    → `{ command, args?, env? }` (NO `type` — claude infers stdio from `command`)
 * ACP-transport servers have no `--mcp-config` equivalent and are dropped before this shape.
 */
export type ClaudeMcpEntry =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

/** The full claude `--mcp-config` document: a name-keyed map of {@link ClaudeMcpEntry}. */
export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpEntry>;
}

/** Convert an ACP `{name,value}[]` list into a plain `{ [name]: value }` object. */
function pairsToObject(pairs: ReadonlyArray<HttpHeader | EnvVariable>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of pairs) {
    out[name] = value;
  }
  return out;
}

/**
 * Translate the ACP `McpServer[]` union into claude's `--mcp-config` `{ mcpServers: { … } }` shape
 * (R2.1). PURE and total — never throws; empty/undefined input yields `{ mcpServers: {} }`.
 *
 * Discriminator (per the ACP schema): `type === "http"|"sse"|"acp"` selects that transport; a server
 * with NO `type` field is the bare stdio variant. Per-transport mapping:
 *   - http / sse → `{ type, url, headers? }`; `headers` is OMITTED when the ACP array is empty.
 *   - stdio      → `{ command, args?, env? }`; `args` and `env` are each OMITTED when empty; NO `type`.
 *   - acp        → DROPPED (ACP-channel transport has no `--mcp-config` equivalent); a one-line note
 *                  is emitted to stderr (no url/headers/env — R2.3).
 *
 * Duplicate names collapse onto the same key (last wins) — claude's map is name-keyed, so this matches
 * how claude itself would resolve a repeated server name.
 *
 * @param servers the ACP-declared MCP servers, or `undefined`/`[]` when the client declared none.
 * @returns the claude `--mcp-config` document (possibly with an empty `mcpServers`).
 */
export function translateMcpServers(servers: readonly McpServer[] | undefined): ClaudeMcpConfig {
  const mcpServers: Record<string, ClaudeMcpEntry> = {};
  if (!servers) {
    return { mcpServers };
  }

  for (const server of servers) {
    // The ACP union is NOT a uniform discriminated union: http/sse/acp carry a `type` tag, but the
    // stdio variant has NO `type` field at all. So a `"type" in server` guard (not `server.type`)
    // first splits the tagged members from the bare stdio variant; within the tagged set, `type`
    // then selects http/sse vs acp.
    if ("type" in server) {
      if (server.type === "http" || server.type === "sse") {
        const entry: ClaudeMcpEntry = { type: server.type, url: server.url };
        if (server.headers.length > 0) {
          entry.headers = pairsToObject(server.headers);
        }
        mcpServers[server.name] = entry;
      } else {
        // type === "acp": ACP-transport servers ride the ACP channel (mcp/connect…); claude's
        // --mcp-config cannot express them, so drop. Log ONLY the (non-secret) name — never
        // id/url/headers/env (R2.3).
        console.error(
          `[mcp-config-writer] dropping ACP-transport MCP server ${JSON.stringify(server.name)}: ` +
            `no --mcp-config equivalent (ACP-channel transport is not supported by the claude CLI).`,
        );
      }
      continue;
    }

    // No `type` field → the bare stdio variant: `{ command, args, env }`. NO `type` is emitted
    // (claude infers stdio from `command`); empty `args`/`env` are omitted.
    const entry: ClaudeMcpEntry = { command: server.command };
    if (server.args.length > 0) {
      entry.args = [...server.args];
    }
    if (server.env.length > 0) {
      entry.env = pairsToObject(server.env);
    }
    mcpServers[server.name] = entry;
  }

  return { mcpServers };
}

/**
 * Durably write `text` to `filePath` with mode `0600` via a temp-file → fsync → atomic `rename` so a
 * reader (claude on startup) never observes a partial file. The 0600 mode is GUARANTEED twice: the
 * temp is created with `mode: 0o600`, and `chmod(0o600)` is re-applied after the rename so a permissive
 * umask cannot loosen it. On any failure the partial temp is removed before the error propagates.
 *
 * Mirrors `gate/settings-writer.ts`'s private `durableWrite` (copied — that helper is not exported),
 * with the added 0600 guarantee this scratch file requires (R2.3).
 */
async function durableWrite0600(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.fork-tmp-${process.pid}-${Date.now()}`);
  let handle: fs.FileHandle | null = null;
  try {
    // Create the temp owner-only from the outset so its bytes are never world-readable, even briefly.
    handle = await fs.open(tmp, "w", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync(); // flush the file's own bytes to disk before the rename
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath); // atomic swap into place
    // Re-assert 0600 AFTER the rename so the active umask cannot have loosened the open() mode.
    await fs.chmod(filePath, 0o600);
    // Best-effort fsync of the directory entry so the rename itself is durable.
    try {
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Some platforms reject O_RDONLY dir fsync; the file fsync above is the load-bearing one.
    }
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      // ignore — nothing durable to clean
    }
    throw err;
  }
}

/**
 * DURABLY write `config` to a fresh uuid-namespaced scratch file under the OS temp dir with mode
 * `0600`, and RETURN its absolute path (R2.1, R2.3). The file is `JSON.stringify(config, null, 2)`
 * plus a trailing newline. The caller passes the returned path to `claude --mcp-config <path>` and
 * is responsible for removing it on teardown via {@link removeMcpScratch}.
 *
 * The file may carry MCP auth headers/env (secrets), so it is created owner-only (0600) and is NEVER
 * logged here (R2.3).
 *
 * @param config the document from {@link translateMcpServers}.
 * @returns the absolute path of the written scratch file.
 * @throws {Error} if the durable write fails — the partial temp is cleaned up first (no residue).
 */
export async function writeMcpScratch(config: ClaudeMcpConfig): Promise<string> {
  const filePath = path.join(os.tmpdir(), `fork-acp-mcp-${randomUUID()}.json`);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  await durableWrite0600(filePath, text);
  return filePath;
}

/**
 * Idempotently remove a scratch file written by {@link writeMcpScratch} (R2.3 teardown). Uses
 * `fs.rm(filePath, { force: true })`, so a missing/already-removed path is a no-op and NEVER throws.
 *
 * @param filePath the path returned by {@link writeMcpScratch}.
 */
export async function removeMcpScratch(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

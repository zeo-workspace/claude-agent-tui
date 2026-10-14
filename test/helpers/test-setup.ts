// Preloaded into every test process by `npm run test:fork` (`node --import`), before any test file.
//
// WHY. `createSession` reads its model picker from the PATH `claude` unless a test injects
// `deps.modelCatalogSource`, and most suites do not. Each test file runs in its own process with an
// empty cache, so before this file one suite run spawned ~50 real CLI sessions — each loading the
// user's hooks, plugins and MCP servers — and five runs made 248 SDK sessions in 17 minutes
// (measured 2026-10-14). This makes the stub the DEFAULT for every in-process session instead.
//
// Two layers, because a test can reach the catalogue two ways:
//   - in process: the stub replaces the default source (`setDefaultModelCatalogSource`);
//   - in a spawned adapter (`node dist/index.js` inheriting this env): `CLAUDE_TUI_MODEL_CATALOG=builtin`
//     serves the built-in list with nothing spawned. `zed-sim-client.ts` sets it explicitly, because it
//     builds its child env from an allow-list.
// The tripwire behind both is `LiveCatalogInTestsError`: the live read refuses to run under
// `node --test` unless `CLAUDE_TUI_LIVE_CATALOG_TESTS=1`. See test/live-catalog-guard.test.ts.
import { setDefaultModelCatalogSource, MODEL_CATALOG_ENV } from "../../dist/live-model-catalog.js";
import { stubModelCatalogSource } from "./stub-model-catalog.ts";

setDefaultModelCatalogSource(stubModelCatalogSource);
process.env[MODEL_CATALOG_ENV] ??= "builtin";

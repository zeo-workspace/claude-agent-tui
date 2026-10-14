// Item 93 — a hermetic model catalogue for agent-level tests.
//
// `createSession` reads its model picker live from the PATH `claude` (live-model-catalog.ts). A test
// that relies on that read is not hermetic: it asserts whatever the HOST CLI serves today. Three
// suites broke that way on 2026-10-14, when CLI 2.1.293 made Haiku 5.5 (effort-capable) the default
// Haiku and the "non-effort model" those suites switched to stopped existing on this machine.
//
// Inject {@link stubModelCatalogSource} through `deps.modelCatalogSource` instead. Its rows copy the
// SHAPE the CLI's `supportedModels()` returns, with one deliberate non-effort row: `haiku` stands for
// a model without effort levels (the shape `claude-haiku-4-5` still has in CLI 2.1.299), so the
// "a non-effort model hides the effort option" contract stays testable whatever the host runs.
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

const LEVELS: NonNullable<ModelInfo["supportedEffortLevels"]> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const STUB_MODEL_CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Stub Opus",
    supportsEffort: true,
    supportedEffortLevels: LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "opus",
    displayName: "Stub Opus",
    description: "Stub Opus",
    supportsEffort: true,
    supportedEffortLevels: LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Stub Sonnet",
    description: "Stub Sonnet",
    supportsEffort: true,
    supportedEffortLevels: LEVELS,
    supportsAutoMode: true,
  },
  {
    // An effort-capable model WITHOUT xhigh: Ultracode needs xhigh, so the option must hide here.
    value: "lowcap",
    displayName: "Stub capped",
    description: "Stub model whose effort stops at high",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    // The non-effort row. See the header for why it is called `haiku`.
    value: "haiku",
    displayName: "Stub Haiku (no effort)",
    description: "Stub non-effort model",
  },
];

/** The injectable `SupportedModelsSource`: no spawn, no CLI, the same rows every time. */
export const stubModelCatalogSource = async (): Promise<ModelInfo[]> => STUB_MODEL_CATALOG;

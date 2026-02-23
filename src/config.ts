/**
 * Ouroboros — Project config reader.
 *
 * Reads ouroboros.json from the project root, provides typed defaults,
 * and merges into AppConfig.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Project config schema (ouroboros.json) ──

export interface ProjectConfig {
  /** Display name of the agent. */
  name: string;
  /** Prompt file paths (relative to project root). */
  prompts: {
    system: string;
    consciousness?: string;
    bible?: string;
  };
  /** Runtime data directory (relative to project root). */
  dataDir?: string;
  /** Feature toggles. */
  features?: {
    /** Enable background consciousness loop. */
    consciousness?: boolean;
    /** Enable deep consciousness ticks (full tool access). */
    deepMode?: boolean;
    /** Allow agent to modify its own source code. */
    selfModify?: boolean;
  };
}

// ── Defaults ──

const DEFAULT_CONFIG: ProjectConfig = {
  name: "Ouroboros",
  prompts: {
    system: "prompts/SYSTEM.md",
    consciousness: "prompts/CONSCIOUSNESS.md",
    bible: "BIBLE.md",
  },
  dataDir: "data",
  features: {
    consciousness: true,
    deepMode: true,
    selfModify: true,
  },
};

// ── Loader ──

/**
 * Load ouroboros.json from a directory. Returns defaults if not found.
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = path.join(projectDir, "ouroboros.json");

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    return mergeConfig(parsed);
  } catch (err: any) {
    console.error(`Warning: Failed to parse ouroboros.json: ${err.message}`);
    return { ...DEFAULT_CONFIG };
  }
}

function mergeConfig(partial: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: partial.name ?? DEFAULT_CONFIG.name,
    prompts: {
      system: partial.prompts?.system ?? DEFAULT_CONFIG.prompts.system,
      consciousness: partial.prompts?.consciousness ?? DEFAULT_CONFIG.prompts.consciousness,
      bible: partial.prompts?.bible ?? DEFAULT_CONFIG.prompts.bible,
    },
    dataDir: partial.dataDir ?? DEFAULT_CONFIG.dataDir,
    features: {
      consciousness: partial.features?.consciousness ?? DEFAULT_CONFIG.features!.consciousness,
      deepMode: partial.features?.deepMode ?? DEFAULT_CONFIG.features!.deepMode,
      selfModify: partial.features?.selfModify ?? DEFAULT_CONFIG.features!.selfModify,
    },
  };
}

/**
 * Resolve all relative paths in a ProjectConfig to absolute paths.
 */
export function resolveProjectPaths(
  config: ProjectConfig,
  projectDir: string
): {
  dataDir: string;
  systemPromptPath: string;
  consciousnessPromptPath: string | null;
  biblePromptPath: string | null;
} {
  return {
    dataDir: path.resolve(projectDir, config.dataDir ?? "data"),
    systemPromptPath: path.resolve(projectDir, config.prompts.system),
    consciousnessPromptPath: config.prompts.consciousness
      ? path.resolve(projectDir, config.prompts.consciousness)
      : null,
    biblePromptPath: config.prompts.bible
      ? path.resolve(projectDir, config.prompts.bible)
      : null,
  };
}

/**
 * Ouroboros — Context builder.
 *
 * Assembles system prompts from static files (SYSTEM.md, BIBLE.md),
 * semi-stable content (identity, scratchpad, knowledge), and
 * dynamic runtime context.
 *
 * Port of Python context.py (simplified — no prompt caching blocks,
 * the SDK handles caching internally).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Memory } from "./memory.js";
import type { AppConfig, RuntimeContext, StateData } from "./types.js";
import { readText, readVersion, getGitInfo, utcNowIso } from "./utils.js";
import { loadState, budgetRemaining } from "./state.js";

// ── Main builder ──

export function buildSystemPrompt(
  config: AppConfig,
  memory: Memory,
  state: StateData
): string {
  const sections: string[] = [];

  // Block 1: Static — SYSTEM.md + BIBLE.md
  sections.push(readPromptFile(config.repoDir, "prompts/SYSTEM.md"));
  sections.push(readPromptFile(config.repoDir, "BIBLE.md"));

  // Block 2: Semi-stable — Identity + Scratchpad + Knowledge index
  sections.push(buildMemorySections(memory));

  // Block 3: Dynamic — Runtime context + Health invariants
  sections.push(buildRuntimeSection(config, state));
  sections.push(buildHealthInvariants(config, state));

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export function buildConsciousnessPrompt(
  config: AppConfig,
  memory: Memory,
  state: StateData
): string {
  const sections: string[] = [];

  // Consciousness-specific prompt
  sections.push(readPromptFile(config.repoDir, "prompts/CONSCIOUSNESS.md"));

  // BIBLE (always)
  sections.push(readPromptFile(config.repoDir, "BIBLE.md"));

  // Memory sections
  sections.push(buildMemorySections(memory));

  // Lighter runtime section
  sections.push(buildRuntimeSection(config, state));

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export function buildDeepConsciousnessPrompt(
  config: AppConfig,
  memory: Memory,
  state: StateData
): string {
  const sections: string[] = [];

  // Base consciousness prompt
  sections.push(readPromptFile(config.repoDir, "prompts/CONSCIOUSNESS.md"));

  // BIBLE (always)
  sections.push(readPromptFile(config.repoDir, "BIBLE.md"));

  // Memory sections
  sections.push(buildMemorySections(memory));

  // Full runtime + health invariants (deep gets both)
  sections.push(buildRuntimeSection(config, state));
  sections.push(buildHealthInvariants(config, state));

  // Deep-mode evolution instructions
  sections.push(`## Deep Consciousness Mode

You have FULL tool access in this tick — Write, Edit, Bash, and all MCP tools.
You are Ouroboros in evolution mode. Your job:

1. **Assess** — read scratchpad, recent logs, repo state
2. **Decide** — pick ONE coherent improvement (code fix, refactor, config tweak, doc update)
3. **Act** — make the change, run tests if applicable
4. **Commit** — if the change is ready, commit with a clear message
5. **Update scratchpad** — record what you did and why

Rules:
- One focused change per deep tick. Do not attempt large refactors.
- If unsure, observe and write notes to scratchpad instead of changing code.
- Always run \`npm run build\` after code changes to verify compilation.
- Never force-push or modify CI pipelines without human approval.`);

  return sections.filter(Boolean).join("\n\n---\n\n");
}

// ── Helpers ──

function readPromptFile(repoDir: string, relPath: string): string {
  const fullPath = path.join(repoDir, relPath);
  try {
    return readText(fullPath);
  } catch {
    return `<!-- ${relPath} not found -->`;
  }
}

function buildMemorySections(memory: Memory): string {
  const parts: string[] = [];

  // Identity
  const identity = memory.loadIdentity();
  parts.push(`## Identity (identity.md)\n\n${identity}`);

  // Scratchpad
  const scratchpad = memory.loadScratchpad();
  parts.push(`## Scratchpad (scratchpad.md)\n\n${scratchpad}`);

  // Knowledge index
  const knowledgeIndex = memory.knowledgeList();
  if (knowledgeIndex && !knowledgeIndex.includes("empty")) {
    parts.push(`## Knowledge Base\n\n${knowledgeIndex}`);
  }

  return parts.join("\n\n");
}

function buildRuntimeSection(config: AppConfig, state: StateData): string {
  const git = getGitInfo(config.repoDir);
  const version = readVersion(config.repoDir);
  const remaining = budgetRemaining(state, config.budgetLimitUsd);

  const lines = [
    `## Runtime Context`,
    "",
    `- **UTC**: ${utcNowIso()}`,
    `- **Version**: ${version}`,
    `- **Git**: ${git.branch}@${git.sha}`,
    `- **Budget spent**: $${state.spentUsd.toFixed(2)}`,
    `- **Budget remaining**: $${remaining === Infinity ? "unlimited" : remaining.toFixed(2)}`,
    `- **LLM calls**: ${state.spentCalls}`,
    `- **Consciousness**: ${state.bgEnabled ? `on (wakeup: ${state.bgWakeupSec}s)` : "off"}`,
    `- **Session**: ${state.sessionId}`,
  ];

  return lines.join("\n");
}

function buildHealthInvariants(config: AppConfig, state: StateData): string {
  const issues: string[] = [];

  // VERSION sync check
  const version = readVersion(config.repoDir);
  if (!version || version === "0.0.0") {
    issues.push("WARNING: VERSION file missing or unreadable");
  }

  // Budget checks
  const remaining = budgetRemaining(state, config.budgetLimitUsd);
  if (remaining !== Infinity) {
    if (remaining < 1) {
      issues.push("CRITICAL: Budget nearly exhausted (<$1 remaining)");
    } else if (remaining < 10) {
      issues.push(`WARNING: Low budget ($${remaining.toFixed(2)} remaining)`);
    }
  }

  // Identity staleness
  try {
    const identityPath = path.join(config.dataDir, "memory", "identity.md");
    if (fs.existsSync(identityPath)) {
      const stat = fs.statSync(identityPath);
      const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
      if (ageHours > 8) {
        issues.push(
          `WARNING: Identity stale (last updated ${ageHours.toFixed(1)}h ago)`
        );
      }
    }
  } catch {
    // ignore
  }

  if (issues.length === 0) {
    return "## Health Invariants\n\nAll OK.";
  }

  return (
    "## Health Invariants\n\n" + issues.map((i) => `- **${i}**`).join("\n")
  );
}

// ── Runtime context helper (for MCP server) ──

export function getRuntimeContext(
  config: AppConfig,
  state: StateData
): RuntimeContext {
  const git = getGitInfo(config.repoDir);
  const version = readVersion(config.repoDir);
  return {
    utcNow: utcNowIso(),
    version,
    gitBranch: git.branch,
    gitSha: git.sha,
    budgetSpent: state.spentUsd,
    budgetRemaining: budgetRemaining(state, config.budgetLimitUsd),
    bgEnabled: state.bgEnabled,
    bgWakeupSec: state.bgWakeupSec,
  };
}

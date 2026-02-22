/**
 * Ouroboros — State management.
 *
 * Simple JSON read/write to data/state/state.json.
 * Atomic via write-to-temp-then-rename.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { StateData } from "./types.js";
import { utcNowIso, writeText } from "./utils.js";

function statePath(dataDir: string): string {
  return path.join(dataDir, "state", "state.json");
}

export function defaultState(): StateData {
  return {
    createdAt: utcNowIso(),
    sessionId: crypto.randomUUID(),
    spentUsd: 0,
    spentCalls: 0,
    spentTokensPrompt: 0,
    spentTokensCompletion: 0,
    currentBranch: null,
    currentSha: null,
    bgEnabled: false,
    bgWakeupSec: 300,
    lastInteractionAt: utcNowIso(),
  };
}

export function loadState(dataDir: string): StateData {
  const p = statePath(dataDir);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw) as Partial<StateData>;
    // Merge with defaults to ensure all fields exist
    return { ...defaultState(), ...obj };
  } catch {
    const st = defaultState();
    saveState(dataDir, st);
    return st;
  }
}

export function saveState(dataDir: string, state: StateData): void {
  const p = statePath(dataDir);
  writeText(p, JSON.stringify(state, null, 2));
}

export function updateBudget(
  dataDir: string,
  costUsd: number,
  turns: number,
  promptTokens: number,
  completionTokens: number
): StateData {
  const st = loadState(dataDir);
  st.spentUsd += costUsd;
  st.spentCalls += turns;
  st.spentTokensPrompt += promptTokens;
  st.spentTokensCompletion += completionTokens;
  saveState(dataDir, st);
  return st;
}

export function budgetRemaining(state: StateData, limitUsd: number): number {
  if (limitUsd <= 0) return Infinity;
  return Math.max(0, limitUsd - state.spentUsd);
}

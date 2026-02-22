/**
 * Ouroboros — Shared types.
 */

export interface AppConfig {
  /** Absolute path to this repository root. */
  repoDir: string;
  /** Absolute path to runtime data directory (./data). */
  dataDir: string;
  /** Total budget limit in USD (0 = unlimited). */
  budgetLimitUsd: number;
  /** Background consciousness budget as a percentage of total. */
  bgBudgetPct: number;
  /** Max agent turns per user message. */
  maxTurns: number;
  /** Default consciousness wakeup interval in seconds. */
  defaultWakeupSec: number;
}

export interface StateData {
  createdAt: string;
  sessionId: string;
  spentUsd: number;
  spentCalls: number;
  spentTokensPrompt: number;
  spentTokensCompletion: number;
  currentBranch: string | null;
  currentSha: string | null;
  bgEnabled: boolean;
  bgWakeupSec: number;
  lastInteractionAt: string;
}

export interface RuntimeContext {
  utcNow: string;
  version: string;
  gitBranch: string;
  gitSha: string;
  budgetSpent: number;
  budgetRemaining: number;
  bgEnabled: boolean;
  bgWakeupSec: number;
}

export interface LogEntry {
  ts: string;
  type: string;
  [key: string]: unknown;
}

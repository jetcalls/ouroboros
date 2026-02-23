/**
 * Ouroboros — Shared types.
 */

export interface AppConfig {
  /** Absolute path to the project root. */
  repoDir: string;
  /** Absolute path to runtime data directory. */
  dataDir: string;
  /** Total budget limit in USD (0 = unlimited). */
  budgetLimitUsd: number;
  /** Background consciousness budget as a percentage of total. */
  bgBudgetPct: number;
  /** Max agent turns per user message. */
  maxTurns: number;
  /** Default consciousness wakeup interval in seconds. */
  defaultWakeupSec: number;

  // ── Project config (from ouroboros.json) ──

  /** Display name of the agent (e.g. "Ouroboros", "HugoBot"). */
  agentName: string;
  /** Absolute path to the system prompt file. */
  systemPromptPath: string;
  /** Absolute path to the consciousness prompt file (null = disabled). */
  consciousnessPromptPath: string | null;
  /** Absolute path to the bible/constitution file (null = none). */
  biblePromptPath: string | null;
  /** Feature toggles. */
  features: {
    consciousness: boolean;
    deepMode: boolean;
    selfModify: boolean;
  };
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

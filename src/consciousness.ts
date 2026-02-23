/**
 * Ouroboros — Background consciousness.
 *
 * Periodic thinking loop that runs between user interactions.
 * Uses setTimeout (not threads). Pauses during user interaction,
 * resumes after.
 *
 * Port of Python consciousness.py.
 */

import {
  query,
  type SDKResultSuccess,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { AppConfig, StateData } from "./types.js";
import { Memory } from "./memory.js";
import { loadState, saveState, updateBudget, budgetRemaining } from "./state.js";
import { buildConsciousnessPrompt, buildDeepConsciousnessPrompt } from "./context.js";
import { getRuntimeContext } from "./context.js";
import { createOuroborosMcpServer, type McpDeps } from "./mcp-server.js";
import { utcNowIso, getLastCommitAge } from "./utils.js";

const MAX_BG_ROUNDS = 5;
const MAX_DEEP_ROUNDS = 15;
const DEEP_TICK_INTERVAL = 3; // every Nth tick is deep
const LIGHT_TIMEOUT_MS = 2 * 60 * 1000; // 2 min
const DEEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const STAGNATION_HOURS = 4;

export class BackgroundConsciousness {
  private config: AppConfig;
  private memory: Memory;
  private mcpServer: McpSdkServerConfigWithInstance;
  private mcpKey: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private running = false;
  private wakeupSec: number;
  private observations: string[] = [];
  private tickCount = 0;
  private lastTickAt = 0;

  onLog?: (text: string) => void;

  constructor(config: AppConfig, memory: Memory) {
    this.config = config;
    this.memory = memory;
    this.wakeupSec = config.defaultWakeupSec;
    this.mcpKey = config.agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const deps: McpDeps = {
      memory: this.memory,
      config,
      getRuntime: () => {
        const state = loadState(config.dataDir);
        return getRuntimeContext(config, state);
      },
      onSetWakeup: (sec) => {
        this.wakeupSec = sec;
        // Also persist to state
        const st = loadState(this.config.dataDir);
        st.bgWakeupSec = sec;
        saveState(this.config.dataDir, st);
      },
      onToggleConsciousness: (enabled) => {
        if (enabled) this.start();
        else this.stop();
      },
    };
    this.mcpServer = createOuroborosMcpServer(deps);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    const st = loadState(this.config.dataDir);
    st.bgEnabled = true;
    saveState(this.config.dataDir, st);
    this.log("Consciousness started");
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const st = loadState(this.config.dataDir);
    st.bgEnabled = false;
    saveState(this.config.dataDir, st);
    this.log("Consciousness stopped");
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.running) return;
    this.paused = false;
    // If no timer is pending, schedule one
    if (!this.timer) {
      this.scheduleNext();
    }
  }

  injectObservation(text: string): void {
    this.observations.push(text);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Returns true if the last tick completed within 3x the wakeup interval. */
  isHealthy(): boolean {
    if (!this.running) return true; // not running = nothing to check
    if (this.lastTickAt === 0) return true; // hasn't ticked yet
    const overdueMs = this.wakeupSec * 1000 * 3;
    return Date.now() - this.lastTickAt < overdueMs;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, this.wakeupSec * 1000);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.paused) {
      // If paused, don't schedule — resume() will do it
      if (this.running && !this.paused) this.scheduleNext();
      return;
    }

    // Budget check
    const state = loadState(this.config.dataDir);
    const bgBudgetLimit =
      this.config.budgetLimitUsd > 0
        ? (this.config.budgetLimitUsd * this.config.bgBudgetPct) / 100
        : Infinity;
    // Rough estimate: bg spent = total * bgPct (simple approach)
    if (state.spentUsd > bgBudgetLimit) {
      this.log("Background budget exceeded, skipping");
      this.scheduleNext();
      return;
    }

    this.tickCount++;
    const isDeep = this.config.features.deepMode && this.tickCount % DEEP_TICK_INTERVAL === 0;

    try {
      if (isDeep) {
        await this.thinkDeep(state);
      } else {
        await this.think(state);
      }
    } catch (err: any) {
      this.log(`Consciousness error: ${err.message}`);
      this.memory.appendLog("events.jsonl", {
        type: "consciousness_error",
        error: err.message,
      });
    }

    this.lastTickAt = Date.now();
    this.scheduleNext();
  }

  private async think(state: StateData): Promise<void> {
    this.log("Consciousness waking (light)...");

    // Build consciousness prompt with observations
    let prompt = buildConsciousnessPrompt(this.config, this.memory, state);

    if (this.observations.length > 0) {
      const obs = this.observations.splice(0).join("\n- ");
      prompt += `\n\n## Recent Observations\n\n- ${obs}`;
    }

    this.memory.appendLog("events.jsonl", {
      type: "consciousness_wake",
      mode: "light",
      wakeupSec: this.wakeupSec,
    });

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), LIGHT_TIMEOUT_MS);

    const q = query({
      prompt: "Background consciousness wakeup. Think, reflect, act if needed.",
      options: {
        systemPrompt: prompt,
        maxTurns: MAX_BG_ROUNDS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: this.config.repoDir,
        mcpServers: { [this.mcpKey]: this.mcpServer },
        allowedTools: [
          "Read", "Glob", "Grep", "WebSearch", "WebFetch",
          `mcp__${this.mcpKey}__*`,
        ],
        disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit"],
        persistSession: false,
        abortController,
      },
    });

    let costUsd = 0;
    let turns = 0;

    try {
      for await (const message of q) {
        if (message.type === "result") {
          costUsd = message.total_cost_usd;
          turns = message.num_turns;

          if (message.subtype === "success") {
            const text = (message as SDKResultSuccess).result;
            if (text) {
              this.log(`Thought: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        this.log("Light tick timed out (2m), continuing");
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (costUsd > 0) {
      updateBudget(this.config.dataDir, costUsd, turns, 0, 0);
    }

    this.memory.appendLog("events.jsonl", {
      type: "consciousness_done",
      mode: "light",
      cost: costUsd,
      turns,
    });

    this.log(`Light tick done (cost: $${costUsd.toFixed(4)}, turns: ${turns})`);
  }

  private async thinkDeep(state: StateData): Promise<void> {
    this.log("Consciousness waking (DEEP)...");

    let prompt = buildDeepConsciousnessPrompt(this.config, this.memory, state);

    // Prepend stagnation data
    const commit = getLastCommitAge(this.config.repoDir);
    let stagnationNote = `\n\n## Stagnation Check\n\nLast commit: ${commit.hours.toFixed(1)}h ago — "${commit.message}"`;
    if (commit.hours > STAGNATION_HOURS) {
      stagnationNote += `\n\n**WARNING: No commits in ${commit.hours.toFixed(1)} hours. Evolve NOW — make a meaningful change and commit.**`;
    }
    prompt += stagnationNote;

    if (this.observations.length > 0) {
      const obs = this.observations.splice(0).join("\n- ");
      prompt += `\n\n## Recent Observations\n\n- ${obs}`;
    }

    this.memory.appendLog("events.jsonl", {
      type: "consciousness_wake",
      mode: "deep",
      wakeupSec: this.wakeupSec,
      stagnationHours: commit.hours,
    });

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), DEEP_TIMEOUT_MS);

    const q = query({
      prompt: "Deep consciousness wakeup. You have full tool access. Assess, decide, act.",
      options: {
        systemPrompt: prompt,
        maxTurns: MAX_DEEP_ROUNDS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: this.config.repoDir,
        mcpServers: { [this.mcpKey]: this.mcpServer },
        allowedTools: [
          "Read", "Glob", "Grep", "WebSearch", "WebFetch",
          "Write", "Edit", "Bash",
          `mcp__${this.mcpKey}__*`,
        ],
        persistSession: false,
        abortController,
      },
    });

    let costUsd = 0;
    let turns = 0;

    try {
      for await (const message of q) {
        if (message.type === "result") {
          costUsd = message.total_cost_usd;
          turns = message.num_turns;

          if (message.subtype === "success") {
            const text = (message as SDKResultSuccess).result;
            if (text) {
              this.log(`Deep thought: ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        this.log("Deep tick timed out (5m), continuing");
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (costUsd > 0) {
      updateBudget(this.config.dataDir, costUsd, turns, 0, 0);
    }

    this.memory.appendLog("events.jsonl", {
      type: "consciousness_done",
      mode: "deep",
      cost: costUsd,
      turns,
    });

    this.log(`Deep tick done (cost: $${costUsd.toFixed(4)}, turns: ${turns})`);
  }

  private log(text: string): void {
    this.onLog?.(text);
  }
}

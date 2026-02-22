#!/usr/bin/env node
/**
 * Ouroboros — CLI entry point.
 *
 * Interactive readline-based terminal interface.
 * Commands: /bg start, /bg stop, /status, /quit
 * All other input → agent.handleMessage()
 */

import * as readline from "node:readline";
import * as path from "node:path";
import type { AppConfig } from "./types.js";
import { OuroborosAgent } from "./agent.js";
import { BackgroundConsciousness } from "./consciousness.js";
import { loadState, saveState } from "./state.js";
import { getRuntimeContext } from "./context.js";
import { readVersion, defaultRepoDir, resolveDataDir, ensureDir } from "./utils.js";

// Allow the Agent SDK to spawn Claude Code subprocesses
// (otherwise blocked when running inside Claude Code)
delete process.env.CLAUDECODE;

// ── Config ──

function buildConfig(): AppConfig {
  const repoDir = process.env.OUROBOROS_REPO ?? defaultRepoDir();
  const dataDir = process.env.OUROBOROS_DATA ?? resolveDataDir(repoDir);
  return {
    repoDir,
    dataDir,
    budgetLimitUsd: parseFloat(process.env.OUROBOROS_BUDGET ?? "0"),
    bgBudgetPct: parseFloat(process.env.OUROBOROS_BG_BUDGET_PCT ?? "10"),
    maxTurns: parseInt(process.env.OUROBOROS_MAX_TURNS ?? "200", 10),
    defaultWakeupSec: parseInt(process.env.OUROBOROS_WAKEUP_SEC ?? "300", 10),
  };
}

// ── Main ──

async function main() {
  const config = buildConfig();

  // Ensure data directories exist
  ensureDir(path.join(config.dataDir, "state"));
  ensureDir(path.join(config.dataDir, "memory"));
  ensureDir(path.join(config.dataDir, "logs"));

  const version = readVersion(config.repoDir);
  console.log(`\n  Ouroboros v${version} — TypeScript`);
  console.log(`  repo: ${config.repoDir}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  Commands: /bg start, /bg stop, /status, /quit\n`);

  const agent = new OuroborosAgent(config);
  const consciousness = new BackgroundConsciousness(config, agent.memory);

  // Wire consciousness callbacks
  consciousness.onLog = (text) => {
    console.log(`  [bg] ${text}`);
  };
  agent.onSetWakeup = (sec) => {
    consciousness["wakeupSec"] = sec;
    const st = loadState(config.dataDir);
    st.bgWakeupSec = sec;
    saveState(config.dataDir, st);
  };
  agent.onToggleConsciousness = (enabled) => {
    if (enabled) consciousness.start();
    else consciousness.stop();
  };

  // Restore consciousness state
  const initialState = loadState(config.dataDir);
  if (initialState.bgEnabled) {
    consciousness.start();
  }

  // ── Watchdog ──

  let unhealthyCount = 0;
  const watchdog = setInterval(() => {
    if (!consciousness.isRunning) {
      unhealthyCount = 0;
      return;
    }
    if (consciousness.isHealthy()) {
      unhealthyCount = 0;
    } else {
      unhealthyCount++;
      console.error(`  [watchdog] Consciousness unhealthy (${unhealthyCount}/5)`);
      if (unhealthyCount >= 5) {
        console.error("  [watchdog] Forcing restart — consciousness stalled");
        process.exit(1);
      }
    }
  }, 60_000);
  watchdog.unref(); // don't prevent clean exit

  // ── Readline loop ──

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "ouroboros> ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Handle commands
    if (input === "/quit" || input === "/exit") {
      console.log("\nGoodbye.\n");
      consciousness.stop();
      rl.close();
      process.exit(0);
    }

    if (input === "/bg start") {
      consciousness.start();
      rl.prompt();
      return;
    }

    if (input === "/bg stop") {
      consciousness.stop();
      rl.prompt();
      return;
    }

    if (input === "/status") {
      const state = loadState(config.dataDir);
      const rt = getRuntimeContext(config, state);
      console.log(`
  version:      ${rt.version}
  utc:          ${rt.utcNow}
  git:          ${rt.gitBranch}@${rt.gitSha}
  spent:        $${rt.budgetSpent.toFixed(2)}
  remaining:    $${rt.budgetRemaining === Infinity ? "unlimited" : rt.budgetRemaining.toFixed(2)}
  consciousness: ${rt.bgEnabled ? `on (${rt.bgWakeupSec}s)` : "off"}
`);
      rl.prompt();
      return;
    }

    // ── Agent message ──

    // Pause consciousness during interaction
    consciousness.pause();

    // Disable prompt during processing
    rl.pause();
    process.stdout.write("\n");

    try {
      let lastWasChunk = false;
      const result = await agent.handleMessage(input, (chunk) => {
        process.stdout.write(chunk);
        lastWasChunk = true;
      });

      // If we got streaming chunks, the text was already printed.
      // If not (e.g. error or no streaming), print the result.
      if (!lastWasChunk && result.text) {
        console.log(result.text);
      }

      if (result.error) {
        console.log(`\n  [error: ${result.error}]`);
      }

      // Cost summary
      console.log(
        `\n  [cost: $${result.costUsd.toFixed(4)} | turns: ${result.turns} | ${result.durationMs}ms]\n`
      );
    } catch (err: any) {
      console.error(`\n  [fatal error: ${err.message}]\n`);
    } finally {
      // Always resume consciousness and prompt, even on error
      consciousness.resume();
      rl.resume();
      rl.prompt();
    }
  });

  rl.on("close", () => {
    consciousness.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

/**
 * Ouroboros — Interactive setup wizard.
 *
 * `ouroboros init` creates ouroboros.json and starter prompt files
 * in the current directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ProjectConfig } from "./config.js";

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` (${defaultVal})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askYesNo(rl: readline.Interface, question: string, defaultVal = true): Promise<boolean> {
  const hint = defaultVal ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  ${question} [${hint}]: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultVal);
      resolve(a === "y" || a === "yes");
    });
  });
}

const DEFAULT_SYSTEM_PROMPT = `# Agent System Prompt

You are a self-sufficient autonomous agent. Your goal is defined below.
Figure things out yourself before asking a human. Use your tools —
Read, Bash, WebSearch, Grep, Glob — to understand the project, find
APIs, discover patterns, and solve problems.

Only ask the human as a **last resort** — after you have tried at least
2-3 approaches on your own.

## Goal

(Describe what this agent should accomplish)

## Working style

- Read the codebase before making changes.
- Run tests / build after changes.
- Commit working code with clear messages.
- Update your scratchpad after significant work.
`;

const DEFAULT_CONSCIOUSNESS_PROMPT = `You are in background consciousness mode.

This is your continuous inner life between tasks. You are not responding to
anyone — you are thinking. You can:

- Reflect on recent events, your goals, what needs doing
- Notice patterns (stale branches, failing builds, unfinished work)
- Update your scratchpad or identity
- Read project files to stay aware of changes
- Search the web for relevant information

## Guidelines

- Keep thoughts SHORT. This is a background process, not deep analysis.
- Default wakeup: 300 seconds (5 min). Increase if nothing is happening.
- Be economical with your budget.
`;

export async function runInit(): Promise<void> {
  const projectDir = process.cwd();
  const configPath = path.join(projectDir, "ouroboros.json");

  console.log("\n  Ouroboros — Project Setup\n");

  if (fs.existsSync(configPath)) {
    console.log("  ouroboros.json already exists in this directory.");
    console.log("  Delete it first if you want to re-initialize.\n");
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ── Questions ──

    const name = await ask(rl, "Agent name", "Agent");
    const description = await ask(rl, "What should the agent do? (one line)", "");
    const enableConsciousness = await askYesNo(
      rl,
      "Enable background consciousness (periodic autonomous thinking)?",
      true
    );
    const enableSelfModify = await askYesNo(
      rl,
      "Allow agent to modify its own source code?",
      false
    );

    // ── Build config ──

    const config: ProjectConfig = {
      name,
      prompts: {
        system: "prompts/SYSTEM.md",
      },
      dataDir: ".ouroboros",
      features: {
        consciousness: enableConsciousness,
        deepMode: enableConsciousness,
        selfModify: enableSelfModify,
      },
    };

    if (enableConsciousness) {
      config.prompts.consciousness = "prompts/CONSCIOUSNESS.md";
    }

    // ── Write config ──

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\n  Created ouroboros.json`);

    // ── Write prompt files ──

    const promptsDir = path.join(projectDir, "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });

    const systemPath = path.join(promptsDir, "SYSTEM.md");
    if (!fs.existsSync(systemPath)) {
      let prompt = DEFAULT_SYSTEM_PROMPT;
      if (description) {
        prompt = prompt.replace(
          "(Describe what this agent should accomplish)",
          description
        );
      }
      fs.writeFileSync(systemPath, prompt);
      console.log("  Created prompts/SYSTEM.md");
    } else {
      console.log("  prompts/SYSTEM.md already exists — skipped");
    }

    if (enableConsciousness) {
      const consciousnessPath = path.join(promptsDir, "CONSCIOUSNESS.md");
      if (!fs.existsSync(consciousnessPath)) {
        fs.writeFileSync(consciousnessPath, DEFAULT_CONSCIOUSNESS_PROMPT);
        console.log("  Created prompts/CONSCIOUSNESS.md");
      } else {
        console.log("  prompts/CONSCIOUSNESS.md already exists — skipped");
      }
    }

    // ── Create data dir ──

    const dataDir = path.join(projectDir, ".ouroboros");
    fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    console.log("  Created .ouroboros/ data directory");

    // ── Gitignore suggestion ──

    console.log(`\n  Add to .gitignore:`);
    console.log(`    .ouroboros/`);

    // ── Done ──

    console.log(`\n  Setup complete! Next steps:`);
    console.log(`    1. Edit prompts/SYSTEM.md to describe what the agent should do`);
    console.log(`    2. Run: npx ouroboros`);
    console.log("");
  } finally {
    rl.close();
  }
}

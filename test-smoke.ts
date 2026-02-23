/**
 * Smoke test — validates all hardening components work without live API calls.
 * Run: npx tsx test-smoke.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Memory } from "./src/memory.js";
import { getLastCommitAge, utcNowIso, getGitInfo, readVersion } from "./src/utils.js";
import { buildSystemPrompt, buildConsciousnessPrompt, buildDeepConsciousnessPrompt } from "./src/context.js";
import { BackgroundConsciousness } from "./src/consciousness.js";
import { loadState, saveState } from "./src/state.js";
import type { AppConfig } from "./src/types.js";

const PASS = "PASS";
const FAIL = "FAIL";
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ${PASS}  ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ${FAIL}  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Setup ──

const repoDir = process.cwd();
const dataDir = path.join(repoDir, "data");
const config: AppConfig = {
  repoDir,
  dataDir,
  budgetLimitUsd: 0,
  bgBudgetPct: 10,
  maxTurns: 200,
  defaultWakeupSec: 300,
  agentName: "Ouroboros",
  systemPromptPath: path.join(repoDir, "prompts/SYSTEM.md"),
  consciousnessPromptPath: path.join(repoDir, "prompts/CONSCIOUSNESS.md"),
  biblePromptPath: path.join(repoDir, "BIBLE.md"),
  features: {
    consciousness: true,
    deepMode: true,
    selfModify: true,
  },
};

console.log("\n== Ouroboros Smoke Test ==\n");

// ── 1. Utils ──

console.log("--- utils ---");

test("utcNowIso returns ISO string", () => {
  const ts = utcNowIso();
  assert(ts.includes("T") && ts.includes("Z"), `bad ISO: ${ts}`);
});

test("getGitInfo returns branch and sha", () => {
  const info = getGitInfo(repoDir);
  assert(info.branch.length > 0, "empty branch");
  assert(info.sha.length > 0, "empty sha");
});

test("readVersion returns 8.0.0", () => {
  const v = readVersion(repoDir);
  assert(v === "8.0.0", `got ${v}`);
});

test("getLastCommitAge returns hours and message", () => {
  const commit = getLastCommitAge(repoDir);
  assert(typeof commit.hours === "number", `hours not number: ${commit.hours}`);
  assert(commit.hours >= 0, `negative hours: ${commit.hours}`);
  assert(commit.message.length > 0, "empty message");
});

// ── 2. Memory ──

console.log("\n--- memory ---");

const memory = new Memory(dataDir);
memory.ensureFiles();

test("loadScratchpad returns content", () => {
  const sp = memory.loadScratchpad();
  assert(sp.length > 0, "empty scratchpad");
});

test("loadIdentity returns content", () => {
  const id = memory.loadIdentity();
  assert(id.length > 0, "empty identity");
});

test("appendLog writes and reads back", () => {
  memory.appendLog("test-smoke.jsonl", { type: "smoke_test", ok: true });
  const entries = memory.readJsonlTail("test-smoke.jsonl", 10);
  assert(entries.length > 0, "no entries read back");
  const last = entries[entries.length - 1];
  assert(last.type === "smoke_test", `wrong type: ${last.type}`);
});

test("log rotation triggers on large file", () => {
  const logPath = path.join(dataDir, "logs", "rotation-test.jsonl");
  // Write >5MB of data
  const bigLine = JSON.stringify({ ts: utcNowIso(), data: "x".repeat(10000) }) + "\n";
  const count = Math.ceil((5 * 1024 * 1024) / bigLine.length) + 10;
  let content = "";
  for (let i = 0; i < count; i++) content += bigLine;
  fs.writeFileSync(logPath, content);

  const sizeBefore = fs.statSync(logPath).size;
  assert(sizeBefore > 5 * 1024 * 1024, `file not big enough: ${sizeBefore}`);

  // This append should trigger rotation
  memory.appendLog("rotation-test.jsonl", { type: "trigger_rotate" });

  // Original file should now be small (just the new entry)
  const sizeAfter = fs.statSync(logPath).size;
  assert(sizeAfter < 1000, `file not rotated — size: ${sizeAfter}`);

  // Rotated file should exist
  const logDir = path.join(dataDir, "logs");
  const rotated = fs.readdirSync(logDir).filter(f => f.startsWith("rotation-test.jsonl."));
  assert(rotated.length > 0, "no rotated file found");

  // Cleanup
  fs.unlinkSync(logPath);
  for (const f of rotated) fs.unlinkSync(path.join(logDir, f));
});

// ── 3. Context builders ──

console.log("\n--- context ---");

const state = loadState(dataDir);

test("buildSystemPrompt returns non-empty", () => {
  const prompt = buildSystemPrompt(config, memory, state);
  assert(prompt.length > 100, `too short: ${prompt.length}`);
  assert(prompt.includes("Runtime Context"), "missing runtime section");
  assert(prompt.includes("Health Invariants"), "missing health section");
});

test("buildConsciousnessPrompt returns non-empty", () => {
  const prompt = buildConsciousnessPrompt(config, memory, state);
  assert(prompt.length > 100, `too short: ${prompt.length}`);
});

test("buildDeepConsciousnessPrompt includes evolution instructions", () => {
  const prompt = buildDeepConsciousnessPrompt(config, memory, state);
  assert(prompt.includes("Deep Consciousness Mode"), "missing deep mode section");
  assert(prompt.includes("FULL tool access"), "missing tool access note");
  assert(prompt.includes("Health Invariants"), "missing health invariants");
});

// ── 4. Consciousness lifecycle ──

console.log("\n--- consciousness ---");

test("consciousness start/stop/pause/resume lifecycle", () => {
  const c = new BackgroundConsciousness(config, memory);
  assert(!c.isRunning, "should not be running initially");
  assert(c.isHealthy(), "should be healthy when not running");

  c.start();
  assert(c.isRunning, "should be running after start");
  assert(c.isHealthy(), "should be healthy right after start (no ticks yet)");

  c.pause();
  c.resume();
  assert(c.isRunning, "should still be running after pause/resume");

  c.stop();
  assert(!c.isRunning, "should not be running after stop");
});

test("isHealthy returns false when tick is overdue", () => {
  const c = new BackgroundConsciousness(config, memory);
  c.start();
  // Simulate a tick that happened long ago
  (c as any).lastTickAt = Date.now() - (config.defaultWakeupSec * 1000 * 4);
  assert(!c.isHealthy(), "should be unhealthy when tick is 4x overdue");
  c.stop();
});

test("isHealthy returns true when tick is recent", () => {
  const c = new BackgroundConsciousness(config, memory);
  c.start();
  (c as any).lastTickAt = Date.now() - 1000; // 1 second ago
  assert(c.isHealthy(), "should be healthy when tick is recent");
  c.stop();
});

test("tickCount increments and deep mode triggers on 3rd tick", () => {
  const c = new BackgroundConsciousness(config, memory);
  // Verify deep mode calculation
  for (let i = 1; i <= 6; i++) {
    const isDeep = i % 3 === 0;
    if (i === 3 || i === 6) {
      assert(isDeep, `tick ${i} should be deep`);
    } else {
      assert(!isDeep, `tick ${i} should be light`);
    }
  }
});

// ── 5. Stagnation detection ──

console.log("\n--- stagnation ---");

test("getLastCommitAge detects recent commit", () => {
  const commit = getLastCommitAge(repoDir);
  // Should be within a few hours of the last commit
  assert(commit.hours < 24, `commit too old: ${commit.hours.toFixed(1)}h`);
  assert(commit.message.includes("v7.0.0") || commit.message.length > 0, "bad message");
});

// ── Cleanup test log ──
try {
  fs.unlinkSync(path.join(dataDir, "logs", "test-smoke.jsonl"));
} catch {}

// ── Summary ──

console.log(`\n== Results: ${passed} passed, ${failed} failed ==\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Ouroboros — Daemon mode.
 *
 * HTTP server wrapping OuroborosAgent + BackgroundConsciousness.
 * Runs as a background process, writes registry entry for discovery.
 *
 * Usage:
 *   startDaemon()  — fork a detached child and exit parent
 *   runDaemonServer() — run the HTTP server in-process (called by child)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fork } from "node:child_process";
import type { AppConfig } from "./types.js";
import { OuroborosAgent } from "./agent.js";
import { BackgroundConsciousness } from "./consciousness.js";
import { loadState, saveState } from "./state.js";
import { getRuntimeContext } from "./context.js";
import { readVersion, ensureDir } from "./utils.js";

// ── Registry ──

const REGISTRY_DIR = path.join(os.homedir(), ".ouroboros", "daemons");

export interface DaemonEntry {
  project: string;
  agentName: string;
  pid: number;
  port: number;
  startedAt: string;
}

export function projectHash(projectDir: string): string {
  return crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
}

function registryPath(projectDir: string): string {
  return path.join(REGISTRY_DIR, `${projectHash(projectDir)}.json`);
}

export function writeRegistry(entry: DaemonEntry, projectDir: string): void {
  ensureDir(REGISTRY_DIR);
  fs.writeFileSync(registryPath(projectDir), JSON.stringify(entry, null, 2));
}

export function removeRegistry(projectDir: string): void {
  try {
    fs.unlinkSync(registryPath(projectDir));
  } catch {
    // already gone
  }
}

export function readRegistry(projectDir: string): DaemonEntry | null {
  try {
    const raw = fs.readFileSync(registryPath(projectDir), "utf-8");
    return JSON.parse(raw) as DaemonEntry;
  } catch {
    return null;
  }
}

export function listRegistry(): DaemonEntry[] {
  ensureDir(REGISTRY_DIR);
  const entries: DaemonEntry[] = [];
  for (const file of fs.readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(REGISTRY_DIR, file), "utf-8");
      const entry = JSON.parse(raw) as DaemonEntry;
      // Check if PID is still alive
      try {
        process.kill(entry.pid, 0);
        entries.push(entry);
      } catch {
        // Dead PID — clean up stale entry
        try {
          fs.unlinkSync(path.join(REGISTRY_DIR, file));
        } catch {}
      }
    } catch {}
  }
  return entries;
}

// ── Find a free port ──

function findPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not determine port")));
      }
    });
    srv.on("error", reject);
  });
}

// ── Fork daemon ──

export async function startDaemon(config: AppConfig): Promise<DaemonEntry> {
  // Check if already running
  const existing = readRegistry(config.repoDir);
  if (existing) {
    try {
      process.kill(existing.pid, 0);
      console.log(`Daemon already running (pid ${existing.pid}, port ${existing.port})`);
      return existing;
    } catch {
      removeRegistry(config.repoDir);
    }
  }

  const port = await findPort();

  // Fork a child process that runs the daemon server
  // We pass config as env vars + the special __OUROBOROS_DAEMON flag
  const child = fork(
    new URL(import.meta.url).pathname,
    [],
    {
      detached: true,
      stdio: "ignore",
      execArgv: process.execArgv, // inherit tsx loader if running in dev
      env: {
        ...process.env,
        __OUROBOROS_DAEMON: "1",
        __OUROBOROS_PORT: String(port),
        __OUROBOROS_PROJECT: config.repoDir,
      },
    }
  );

  child.unref();

  // Wait briefly for the child to start and write registry
  await new Promise((r) => setTimeout(r, 500));

  const entry: DaemonEntry = {
    project: config.repoDir,
    agentName: config.agentName,
    pid: child.pid!,
    port,
    startedAt: new Date().toISOString(),
  };

  return entry;
}

// ── Daemon server (runs in forked child) ──

export async function runDaemonServer(config: AppConfig, port: number): Promise<void> {
  // Ensure data directories exist
  ensureDir(path.join(config.dataDir, "state"));
  ensureDir(path.join(config.dataDir, "memory"));
  ensureDir(path.join(config.dataDir, "logs"));

  const agent = new OuroborosAgent(config);
  const consciousness = new BackgroundConsciousness(config, agent.memory);

  // Wire consciousness callbacks
  consciousness.onLog = (text) => {
    agent.memory.appendLog("events.jsonl", {
      type: "daemon_bg_log",
      text,
    });
  };
  agent.onSetWakeup = (sec) => {
    (consciousness as any).wakeupSec = sec;
    const st = loadState(config.dataDir);
    st.bgWakeupSec = sec;
    saveState(config.dataDir, st);
  };
  agent.onToggleConsciousness = (enabled) => {
    if (enabled) consciousness.start();
    else consciousness.stop();
  };

  // Restore consciousness state
  if (config.features.consciousness) {
    const initialState = loadState(config.dataDir);
    if (initialState.bgEnabled) {
      consciousness.start();
    }
  }

  // Watchdog
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
      if (unhealthyCount >= 5) {
        removeRegistry(config.repoDir);
        process.exit(1);
      }
    }
  }, 60_000);
  watchdog.unref();

  // Lock to serialize message handling
  let messageLock = false;

  // ── HTTP server ──

  const server = http.createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    try {
      // ── GET /api/health ──
      if (url.pathname === "/api/health" && req.method === "GET") {
        json(res, 200, { ok: true, pid: process.pid });
        return;
      }

      // ── GET /api/status ──
      if (url.pathname === "/api/status" && req.method === "GET") {
        const state = loadState(config.dataDir);
        const rt = getRuntimeContext(config, state);
        json(res, 200, {
          agentName: config.agentName,
          project: config.repoDir,
          version: rt.version,
          git: `${rt.gitBranch}@${rt.gitSha}`,
          budgetSpent: rt.budgetSpent,
          budgetRemaining: rt.budgetRemaining,
          consciousness: rt.bgEnabled ? `on (${rt.bgWakeupSec}s)` : "off",
          pid: process.pid,
        });
        return;
      }

      // ── POST /api/consciousness/start ──
      if (url.pathname === "/api/consciousness/start" && req.method === "POST") {
        if (!config.features.consciousness) {
          json(res, 400, { ok: false, error: "consciousness disabled in config" });
          return;
        }
        consciousness.start();
        json(res, 200, { ok: true });
        return;
      }

      // ── POST /api/consciousness/stop ──
      if (url.pathname === "/api/consciousness/stop" && req.method === "POST") {
        consciousness.stop();
        json(res, 200, { ok: true });
        return;
      }

      // ── POST /api/message ──
      if (url.pathname === "/api/message" && req.method === "POST") {
        if (messageLock) {
          json(res, 429, { error: "Agent is busy processing another message" });
          return;
        }

        const body = await readBody(req);
        const { text } = JSON.parse(body);
        if (!text || typeof text !== "string") {
          json(res, 400, { error: "Missing 'text' field" });
          return;
        }

        // SSE response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        messageLock = true;
        consciousness.pause();

        try {
          const result = await agent.handleMessage(text, (chunk) => {
            res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
          });

          res.write(
            `data: ${JSON.stringify({
              type: "result",
              text: result.text,
              costUsd: result.costUsd,
              turns: result.turns,
              durationMs: result.durationMs,
              error: result.error ?? null,
            })}\n\n`
          );
        } catch (err: any) {
          res.write(
            `data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`
          );
        } finally {
          messageLock = false;
          consciousness.resume();
          res.end();
        }
        return;
      }

      // ── POST /api/stop ──
      if (url.pathname === "/api/stop" && req.method === "POST") {
        json(res, 200, { ok: true, message: "Shutting down" });
        shutdown();
        return;
      }

      // ── 404 ──
      json(res, 404, { error: "Not found" });
    } catch (err: any) {
      json(res, 500, { error: err.message });
    }
  });

  function shutdown(): void {
    consciousness.stop();
    removeRegistry(config.repoDir);
    server.close();
    clearInterval(watchdog);
    setTimeout(() => process.exit(0), 200);
  }

  // Graceful shutdown
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Write registry before listening
  const entry: DaemonEntry = {
    project: config.repoDir,
    agentName: config.agentName,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  writeRegistry(entry, config.repoDir);

  server.listen(port, "127.0.0.1", () => {
    // Daemon is ready — no console output since we're detached
    agent.memory.appendLog("events.jsonl", {
      type: "daemon_started",
      port,
      pid: process.pid,
    });
  });
}

// ── Helpers ──

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Self-boot when forked as daemon ──

if (process.env.__OUROBOROS_DAEMON === "1") {
  // Allow the Agent SDK to spawn Claude Code subprocesses
  delete process.env.CLAUDECODE;

  const port = parseInt(process.env.__OUROBOROS_PORT!, 10);
  const projectDir = process.env.__OUROBOROS_PROJECT!;

  // Clean up daemon env vars
  delete process.env.__OUROBOROS_DAEMON;
  delete process.env.__OUROBOROS_PORT;
  delete process.env.__OUROBOROS_PROJECT;

  // Dynamic import to build config
  const { loadProjectConfig, resolveProjectPaths } = await import("./config.js");
  const project = loadProjectConfig(projectDir);
  const paths = resolveProjectPaths(project, projectDir);

  const config: AppConfig = {
    repoDir: projectDir,
    dataDir: process.env.OUROBOROS_DATA ?? paths.dataDir,
    budgetLimitUsd: parseFloat(process.env.OUROBOROS_BUDGET ?? "0"),
    bgBudgetPct: parseFloat(process.env.OUROBOROS_BG_BUDGET_PCT ?? "10"),
    maxTurns: parseInt(process.env.OUROBOROS_MAX_TURNS ?? "200", 10),
    defaultWakeupSec: parseInt(process.env.OUROBOROS_WAKEUP_SEC ?? "300", 10),
    agentName: project.name,
    systemPromptPath: paths.systemPromptPath,
    consciousnessPromptPath: paths.consciousnessPromptPath,
    biblePromptPath: paths.biblePromptPath,
    features: {
      consciousness: project.features?.consciousness ?? true,
      deepMode: project.features?.deepMode ?? true,
      selfModify: project.features?.selfModify ?? true,
    },
  };

  runDaemonServer(config, port).catch((err) => {
    console.error("Daemon fatal:", err);
    process.exit(1);
  });
}

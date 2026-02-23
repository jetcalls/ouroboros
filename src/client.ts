/**
 * Ouroboros — Client for daemon interaction.
 *
 * CLI commands: send, status, stop.
 * Discovers daemons via ~/.ouroboros/daemons/ registry.
 */

import * as http from "node:http";
import { listRegistry, readRegistry, type DaemonEntry } from "./daemon.js";

// ── HTTP helpers ──

function request(
  port: number,
  method: string,
  path: string,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function streamRequest(
  port: number,
  path: string,
  body: string,
  onChunk: (data: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          // Parse SSE lines
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              onChunk(line.slice(6));
            }
          }
        });
        res.on("end", () => {
          // Flush remaining
          if (buf.startsWith("data: ")) {
            onChunk(buf.slice(6));
          }
          resolve();
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Daemon discovery ──

function findDaemon(projectDir: string): DaemonEntry | null {
  // First try exact match
  const entry = readRegistry(projectDir);
  if (entry) {
    try {
      process.kill(entry.pid, 0);
      return entry;
    } catch {
      return null;
    }
  }
  return null;
}

function requireDaemon(projectDir: string): DaemonEntry {
  const entry = findDaemon(projectDir);
  if (!entry) {
    console.error("No daemon running for this project.");
    console.error("Start one with: ouroboros start");
    process.exit(1);
  }
  return entry;
}

// ── CLI commands ──

export async function cmdStatus(): Promise<void> {
  const entries = listRegistry();
  if (entries.length === 0) {
    console.log("No daemons running.");
    return;
  }

  console.log(`\n  Running daemons:\n`);
  for (const entry of entries) {
    // Try to get live status
    try {
      const resp = await request(entry.port, "GET", "/api/status");
      const data = JSON.parse(resp.body);
      console.log(`  ${data.agentName}`);
      console.log(`    project: ${data.project}`);
      console.log(`    port:    ${entry.port} (pid ${entry.pid})`);
      console.log(`    git:     ${data.git}`);
      console.log(`    spent:   $${data.budgetSpent?.toFixed(2) ?? "?"}`);
      console.log(`    bg:      ${data.consciousness}`);
      console.log();
    } catch {
      console.log(`  ${entry.agentName}`);
      console.log(`    project: ${entry.project}`);
      console.log(`    port:    ${entry.port} (pid ${entry.pid})`);
      console.log(`    status:  unreachable`);
      console.log();
    }
  }
}

export async function cmdStop(projectDir: string): Promise<void> {
  const entry = requireDaemon(projectDir);

  try {
    await request(entry.port, "POST", "/api/stop");
    console.log(`Daemon stopped (pid ${entry.pid}).`);
  } catch {
    // If HTTP fails, kill the process directly
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(`Daemon killed (pid ${entry.pid}).`);
    } catch {
      console.log("Daemon already stopped.");
    }
  }
}

export async function cmdSend(projectDir: string, text: string): Promise<void> {
  const entry = requireDaemon(projectDir);

  console.log(`Sending to ${entry.agentName} (port ${entry.port})...\n`);

  try {
    let resultText = "";
    await streamRequest(
      entry.port,
      "/api/message",
      JSON.stringify({ text }),
      (data) => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "chunk") {
            process.stdout.write(parsed.text);
          } else if (parsed.type === "result") {
            resultText = parsed.text;
            if (parsed.error) {
              console.log(`\n  [error: ${parsed.error}]`);
            }
            console.log(
              `\n  [cost: $${parsed.costUsd?.toFixed(4) ?? "?"} | turns: ${parsed.turns ?? "?"} | ${parsed.durationMs ?? "?"}ms]`
            );
          } else if (parsed.type === "error") {
            console.error(`\n  [error: ${parsed.error}]`);
          }
        } catch {}
      }
    );
    console.log();
  } catch (err: any) {
    if (err.code === "ECONNREFUSED") {
      console.error("Daemon is not responding. It may have crashed.");
      console.error("Try: ouroboros start");
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

export async function cmdHealth(projectDir: string): Promise<void> {
  const entry = requireDaemon(projectDir);
  try {
    const resp = await request(entry.port, "GET", "/api/health");
    const data = JSON.parse(resp.body);
    console.log(`Daemon healthy (pid ${data.pid}, port ${entry.port}).`);
  } catch {
    console.error("Daemon unreachable.");
    process.exit(1);
  }
}

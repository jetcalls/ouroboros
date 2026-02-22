/**
 * Ouroboros — Utilities.
 *
 * File I/O, git helpers, common functions.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Time ──

export function utcNowIso(): string {
  return new Date().toISOString();
}

// ── File I/O ──

export function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

export function appendJsonl(filePath: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ── Text ──

export function clipText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

// ── Git ──

export interface GitInfo {
  branch: string;
  sha: string;
}

export function getGitInfo(repoDir: string): GitInfo {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    const sha = execSync("git rev-parse --short HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    return { branch, sha };
  } catch {
    return { branch: "unknown", sha: "unknown" };
  }
}

// ── Stagnation detection ──

export interface CommitAge {
  hours: number;
  message: string;
}

export function getLastCommitAge(repoDir: string): CommitAge {
  try {
    const raw = execSync("git log -1 --format=%ct/%s", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    const slashIdx = raw.indexOf("/");
    const epoch = parseInt(raw.slice(0, slashIdx), 10);
    const message = raw.slice(slashIdx + 1);
    const hours = (Date.now() / 1000 - epoch) / 3600;
    return { hours, message };
  } catch {
    return { hours: 0, message: "unknown" };
  }
}

// ── Version ──

export function readVersion(repoDir: string): string {
  try {
    return readText(path.join(repoDir, "VERSION")).trim();
  } catch {
    return "0.0.0";
  }
}

// ── Config defaults ──

export function resolveDataDir(repoDir: string): string {
  return path.join(repoDir, "data");
}

export function defaultRepoDir(): string {
  // Walk up from this file to find the repo root (where package.json lives)
  let dir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

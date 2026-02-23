/**
 * Ouroboros — Memory.
 *
 * Scratchpad, identity, knowledge base, event logs.
 * Port of Python memory.py + tools/knowledge.py.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { utcNowIso, readText, writeText, ensureDir, clipText, appendJsonl } from "./utils.js";
import type { LogEntry } from "./types.js";

// ── Constants ──

const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const LOG_KEEP_ROTATED = 2;
const KNOWLEDGE_DIR = "memory/knowledge";
const INDEX_FILE = "_index.md";
const VALID_TOPIC = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,98}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
const RESERVED_TOPICS = new Set(["_index", "con", "prn", "aux", "nul"]);

// ── Topic validation ──

function sanitizeTopic(topic: string): string {
  topic = topic.trim();
  if (!topic) throw new Error("Topic must be a non-empty string");
  if (topic.includes("/") || topic.includes("\\") || topic.includes("..")) {
    throw new Error(`Invalid characters in topic: ${topic}`);
  }
  if (!VALID_TOPIC.test(topic)) {
    throw new Error(
      `Invalid topic name: ${topic}. Use alphanumeric, underscore, hyphen, dot.`
    );
  }
  if (RESERVED_TOPICS.has(topic.toLowerCase())) {
    throw new Error(`Reserved topic name: ${topic}`);
  }
  return topic;
}

function extractSummary(text: string, maxChars = 150): string {
  const lines = text.trim().split("\n");
  const snippets: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const clean = stripped.replace(/^[-*]\s*/, "").replace(/^#+\s*/, "").trim();
    if (clean) snippets.push(clean);
    if (snippets.length >= 3) break;
  }
  let summary = snippets.join(" | ");
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars - 1) + "\u2026";
  }
  return summary;
}

// ── Memory class ──

export class Memory {
  private dataDir: string;
  private agentName: string;

  constructor(dataDir: string, agentName = "Ouroboros") {
    this.dataDir = dataDir;
    this.agentName = agentName;
  }

  // ── Paths ──

  private memoryPath(rel: string): string {
    return path.join(this.dataDir, "memory", rel);
  }

  private knowledgeDir(): string {
    return path.join(this.dataDir, KNOWLEDGE_DIR);
  }

  private logsPath(name: string): string {
    return path.join(this.dataDir, "logs", name);
  }

  // ── Scratchpad ──

  loadScratchpad(): string {
    const p = this.memoryPath("scratchpad.md");
    if (fs.existsSync(p)) return readText(p);
    const def = this.defaultScratchpad();
    writeText(p, def);
    return def;
  }

  saveScratchpad(content: string): void {
    writeText(this.memoryPath("scratchpad.md"), content);
  }

  // ── Identity ──

  loadIdentity(): string {
    const p = this.memoryPath("identity.md");
    if (fs.existsSync(p)) return readText(p);
    const def = this.defaultIdentity();
    writeText(p, def);
    return def;
  }

  saveIdentity(content: string): void {
    writeText(this.memoryPath("identity.md"), content);
  }

  // ── Knowledge base ──

  knowledgeRead(topic: string): string {
    let sanitized: string;
    try {
      sanitized = sanitizeTopic(topic);
    } catch (e: any) {
      return `Warning: Invalid topic: ${e.message}`;
    }
    const filePath = path.join(this.knowledgeDir(), `${sanitized}.md`);
    if (!fs.existsSync(filePath)) {
      return `Topic '${sanitized}' not found. Use knowledge_list to see available topics.`;
    }
    return readText(filePath);
  }

  knowledgeWrite(
    topic: string,
    content: string,
    mode: "overwrite" | "append" = "overwrite"
  ): string {
    let sanitized: string;
    try {
      sanitized = sanitizeTopic(topic);
    } catch (e: any) {
      return `Warning: Invalid topic: ${e.message}`;
    }
    ensureDir(this.knowledgeDir());
    const filePath = path.join(this.knowledgeDir(), `${sanitized}.md`);

    if (mode === "append") {
      let existing = "";
      if (fs.existsSync(filePath)) {
        existing = readText(filePath);
        if (existing.length > 0 && !existing.endsWith("\n")) {
          existing += "\n";
        }
      }
      writeText(filePath, existing + content);
    } else {
      writeText(filePath, content);
    }

    this.updateIndexEntry(sanitized);
    return `Knowledge '${sanitized}' saved (${mode}).`;
  }

  knowledgeList(): string {
    const kdir = this.knowledgeDir();
    const indexPath = path.join(kdir, INDEX_FILE);

    if (fs.existsSync(indexPath)) {
      return readText(indexPath);
    }

    if (fs.existsSync(kdir)) {
      this.rebuildIndex();
      if (fs.existsSync(indexPath)) {
        return readText(indexPath);
      }
    }

    return "Knowledge base is empty. Use knowledge_write to add topics.";
  }

  private rebuildIndex(): void {
    const kdir = this.knowledgeDir();
    if (!fs.existsSync(kdir)) return;

    const entries: string[] = [];
    const files = fs.readdirSync(kdir).filter(f => f.endsWith(".md") && f !== INDEX_FILE).sort();
    for (const f of files) {
      const stem = f.replace(/\.md$/, "");
      let sanitized: string;
      try {
        sanitized = sanitizeTopic(stem);
      } catch {
        continue;
      }
      try {
        const text = readText(path.join(kdir, f)).trim();
        const summary = extractSummary(text);
        entries.push(`- **${sanitized}**: ${summary}`);
      } catch {
        entries.push(`- **${sanitized}**: (unreadable)`);
      }
    }

    let indexContent = "# Knowledge Base Index\n\n";
    indexContent += entries.length > 0 ? entries.join("\n") + "\n" : "(empty)\n";
    writeText(path.join(kdir, INDEX_FILE), indexContent);
  }

  private updateIndexEntry(topic: string): void {
    const kdir = this.knowledgeDir();
    const indexPath = path.join(kdir, INDEX_FILE);
    const topicPath = path.join(kdir, `${topic}.md`);

    ensureDir(kdir);

    let indexContent: string;
    if (fs.existsSync(indexPath)) {
      indexContent = readText(indexPath);
    } else {
      indexContent = "# Knowledge Base Index\n\n";
    }

    const lines = indexContent.split("\n");
    // Find header end
    let headerEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        headerEnd = i + 1;
        if (i + 1 < lines.length && lines[i + 1].trim() === "") {
          headerEnd = i + 2;
        }
        break;
      }
    }

    const header = lines.slice(0, headerEnd).join("\n");
    const pattern = `- **${topic}**:`;
    let entries = lines
      .slice(headerEnd)
      .filter(l => l.trim() && l.trim() !== "(empty)" && !l.trim().startsWith(pattern));

    if (fs.existsSync(topicPath)) {
      try {
        const text = readText(topicPath).trim();
        const summary = extractSummary(text);
        entries.push(`- **${topic}**: ${summary}`);
      } catch {
        entries.push(`- **${topic}**: (unreadable)`);
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }

    const newIndex = entries.length > 0
      ? header.trimEnd() + "\n\n" + entries.join("\n") + "\n"
      : header.trimEnd() + "\n\n(empty)\n";

    writeText(indexPath, newIndex);
  }

  // ── JSONL log reading ──

  readJsonlTail(logName: string, maxEntries = 100): LogEntry[] {
    const p = this.logsPath(logName);
    if (!fs.existsSync(p)) return [];
    try {
      const lines = readText(p).trim().split("\n");
      const tail = lines.slice(-maxEntries);
      const entries: LogEntry[] = [];
      for (const line of tail) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  appendLog(logName: string, entry: Record<string, unknown>): void {
    const logPath = this.logsPath(logName);
    this.rotateIfNeeded(logPath);
    appendJsonl(logPath, { ts: utcNowIso(), ...entry });
  }

  private rotateIfNeeded(logPath: string): void {
    try {
      if (!fs.existsSync(logPath)) return;
      const stat = fs.statSync(logPath);
      if (stat.size < LOG_MAX_BYTES) return;

      // Rotate: rename current to timestamped backup
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rotated = `${logPath}.${ts}`;
      fs.renameSync(logPath, rotated);

      // Prune old rotated files, keep only LOG_KEEP_ROTATED
      const dir = path.dirname(logPath);
      const base = path.basename(logPath);
      const rotatedFiles = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base + ".") && f !== base)
        .sort()
        .reverse();

      for (const old of rotatedFiles.slice(LOG_KEEP_ROTATED)) {
        fs.unlinkSync(path.join(dir, old));
      }
    } catch {
      // Best-effort rotation — don't block logging
    }
  }

  // ── Ensure files on first run ──

  ensureFiles(): void {
    this.loadScratchpad();
    this.loadIdentity();
    ensureDir(path.join(this.dataDir, "logs"));
    ensureDir(path.join(this.dataDir, "state"));
    ensureDir(this.knowledgeDir());
  }

  // ── Defaults ──

  private defaultScratchpad(): string {
    return `# Scratchpad\n\nUpdatedAt: ${utcNowIso()}\n\n(empty — write anything here)\n`;
  }

  private defaultIdentity(): string {
    return [
      "# Who I Am\n",
      `I am ${this.agentName}. This file is my persistent self-identification.`,
      "I can write anything here: how I see myself, how I want to communicate,",
      "what matters to me, what I have understood about myself.\n",
      "This file is read at every dialogue and influences my responses.",
      "I update it when I feel the need.\n",
    ].join("\n");
  }
}

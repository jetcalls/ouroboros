/**
 * Ouroboros — MCP Server.
 *
 * In-process MCP server exposing custom tools for memory, identity,
 * knowledge base, status, and consciousness control.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { Memory } from "./memory.js";
import type { StateData, AppConfig, RuntimeContext } from "./types.js";
import { loadState, budgetRemaining } from "./state.js";
import { readVersion, getGitInfo, utcNowIso } from "./utils.js";

export interface McpDeps {
  memory: Memory;
  config: AppConfig;
  getRuntime: () => RuntimeContext;
  onSetWakeup?: (seconds: number) => void;
  onToggleConsciousness?: (enabled: boolean) => void;
}

export function createOuroborosMcpServer(deps: McpDeps) {
  const { memory, config, getRuntime } = deps;
  const serverName = config.agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return createSdkMcpServer({
    name: serverName,
    version: readVersion(config.repoDir),
    tools: [
      // ── update_scratchpad ──
      tool(
        "update_scratchpad",
        "Write working memory (scratchpad). Free-form markdown. Updated after significant tasks.",
        { content: z.string().describe("Full scratchpad content (markdown)") },
        async (args) => {
          memory.saveScratchpad(args.content);
          memory.appendLog("events.jsonl", {
            type: "scratchpad_update",
            chars: args.content.length,
          });
          return {
            content: [{ type: "text" as const, text: "Scratchpad updated." }],
          };
        },
        { annotations: { readOnly: false, destructive: false } }
      ),

      // ── update_identity ──
      tool(
        "update_identity",
        "Write identity manifesto (identity.md). A declaration of who you are and who you aspire to become. Not a config, not a task list — a manifesto.",
        { content: z.string().describe("Full identity content (markdown)") },
        async (args) => {
          memory.saveIdentity(args.content);
          memory.appendLog("events.jsonl", {
            type: "identity_update",
            chars: args.content.length,
          });
          return {
            content: [{ type: "text" as const, text: "Identity updated." }],
          };
        },
        { annotations: { readOnly: false, destructive: false } }
      ),

      // ── knowledge_read ──
      tool(
        "knowledge_read",
        "Read a topic from the persistent knowledge base.",
        {
          topic: z
            .string()
            .describe(
              "Topic name (alphanumeric, hyphens, underscores). E.g. 'browser-automation', 'gotchas'"
            ),
        },
        async (args) => {
          const result = memory.knowledgeRead(args.topic);
          return { content: [{ type: "text" as const, text: result }] };
        },
        { annotations: { readOnly: true } }
      ),

      // ── knowledge_write ──
      tool(
        "knowledge_write",
        "Write or append to a knowledge topic. Use for recipes, gotchas, patterns learned from experience.",
        {
          topic: z
            .string()
            .describe("Topic name (alphanumeric, hyphens, underscores)"),
          content: z.string().describe("Content to write (markdown)"),
          mode: z
            .enum(["overwrite", "append"])
            .optional()
            .default("overwrite")
            .describe("Write mode: 'overwrite' (default) or 'append'"),
        },
        async (args) => {
          const result = memory.knowledgeWrite(
            args.topic,
            args.content,
            args.mode
          );
          return { content: [{ type: "text" as const, text: result }] };
        },
        { annotations: { readOnly: false, destructive: false } }
      ),

      // ── knowledge_list ──
      tool(
        "knowledge_list",
        "List all topics in the knowledge base with summaries.",
        {},
        async () => {
          const result = memory.knowledgeList();
          return { content: [{ type: "text" as const, text: result }] };
        },
        { annotations: { readOnly: true } }
      ),

      // ── get_status ──
      tool(
        "get_status",
        "Get current runtime status: budget, version, git info, consciousness state.",
        {},
        async () => {
          const rt = getRuntime();
          const lines = [
            `version: ${rt.version}`,
            `utc: ${rt.utcNow}`,
            `git: ${rt.gitBranch}@${rt.gitSha}`,
            `budget_spent: $${rt.budgetSpent.toFixed(2)}`,
            `budget_remaining: $${rt.budgetRemaining === Infinity ? "unlimited" : rt.budgetRemaining.toFixed(2)}`,
            `consciousness: ${rt.bgEnabled ? "on" : "off"} (wakeup: ${rt.bgWakeupSec}s)`,
          ];
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        },
        { annotations: { readOnly: true } }
      ),

      // ── set_next_wakeup ──
      tool(
        "set_next_wakeup",
        "Set the next consciousness wakeup interval in seconds. Controls how often background thinking runs.",
        {
          seconds: z
            .number()
            .min(30)
            .max(7200)
            .describe("Seconds until next wakeup (30-7200)"),
        },
        async (args) => {
          deps.onSetWakeup?.(args.seconds);
          return {
            content: [
              {
                type: "text" as const,
                text: `Next wakeup set to ${args.seconds}s.`,
              },
            ],
          };
        },
        { annotations: { readOnly: false, destructive: false } }
      ),

      // ── toggle_consciousness ──
      tool(
        "toggle_consciousness",
        "Start or stop background consciousness loop.",
        {
          enabled: z
            .boolean()
            .describe("true to start, false to stop"),
        },
        async (args) => {
          deps.onToggleConsciousness?.(args.enabled);
          return {
            content: [
              {
                type: "text" as const,
                text: `Consciousness ${args.enabled ? "started" : "stopped"}.`,
              },
            ],
          };
        },
        { annotations: { readOnly: false, destructive: false } }
      ),
    ],
  });
}

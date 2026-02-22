/**
 * Ouroboros — Agent orchestrator.
 *
 * Wraps the Claude Agent SDK query() to run the Ouroboros agent.
 * Handles system prompt assembly, MCP tool registration, streaming
 * output, and budget tracking.
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultSuccess,
  type SDKResultError,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { AppConfig, StateData } from "./types.js";
import { Memory } from "./memory.js";
import { loadState, saveState, updateBudget } from "./state.js";
import { buildSystemPrompt } from "./context.js";
import { getRuntimeContext } from "./context.js";
import { createOuroborosMcpServer, type McpDeps } from "./mcp-server.js";
import { utcNowIso } from "./utils.js";

export interface AgentResult {
  text: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  error?: string;
}

export class OuroborosAgent {
  readonly config: AppConfig;
  readonly memory: Memory;
  private mcpServer: McpSdkServerConfigWithInstance;
  onSetWakeup?: (seconds: number) => void;
  onToggleConsciousness?: (enabled: boolean) => void;

  constructor(config: AppConfig) {
    this.config = config;
    this.memory = new Memory(config.dataDir);
    this.memory.ensureFiles();

    // Create MCP server with callbacks wired up
    const deps: McpDeps = {
      memory: this.memory,
      config,
      getRuntime: () => {
        const state = loadState(config.dataDir);
        return getRuntimeContext(config, state);
      },
      onSetWakeup: (sec) => this.onSetWakeup?.(sec),
      onToggleConsciousness: (en) => this.onToggleConsciousness?.(en),
    };
    this.mcpServer = createOuroborosMcpServer(deps);
  }

  /**
   * Handle a user message: build context, call SDK query(), stream output.
   * Returns after the agent finishes.
   */
  async handleMessage(
    userText: string,
    onChunk?: (text: string) => void
  ): Promise<AgentResult> {
    const state = loadState(this.config.dataDir);
    state.lastInteractionAt = utcNowIso();
    saveState(this.config.dataDir, state);

    const systemPrompt = buildSystemPrompt(this.config, this.memory, state);

    // Log the interaction
    this.memory.appendLog("events.jsonl", {
      type: "user_message",
      chars: userText.length,
    });

    // 10-minute timeout for user queries
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10 * 60 * 1000);

    const q: Query = query({
      prompt: userText,
      options: {
        systemPrompt,
        maxTurns: this.config.maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: this.config.repoDir,
        mcpServers: { ouroboros: this.mcpServer },
        allowedTools: ["mcp__ouroboros__*"],
        includePartialMessages: true,
        persistSession: false,
        abortController,
      },
    });

    let resultText = "";
    let costUsd = 0;
    let turns = 0;
    let durationMs = 0;
    let error: string | undefined;

    try {
      for await (const message of q) {
        this.handleStreamMessage(message, onChunk);

        if (message.type === "result") {
          durationMs = message.duration_ms;
          turns = message.num_turns;
          costUsd = message.total_cost_usd;

          if (message.subtype === "success") {
            resultText = (message as SDKResultSuccess).result;
          } else {
            error = (message as SDKResultError).subtype;
            const errors = (message as SDKResultError).errors;
            if (errors?.length) {
              error += ": " + errors.join("; ");
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        error = "query timed out (10m)";
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Update budget tracking
    if (costUsd > 0 || turns > 0) {
      const usage = q as any;
      updateBudget(this.config.dataDir, costUsd, turns, 0, 0);
    }

    // Log completion
    this.memory.appendLog("events.jsonl", {
      type: "agent_response",
      cost: costUsd,
      turns,
      durationMs,
      error: error ?? null,
    });

    return { text: resultText, costUsd, turns, durationMs, error };
  }

  /**
   * Handle a single stream message — extract text for real-time display.
   */
  private handleStreamMessage(
    message: SDKMessage,
    onChunk?: (text: string) => void
  ): void {
    if (!onChunk) return;

    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block && typeof block.text === "string") {
          onChunk(block.text);
        }
      }
    }
  }
}

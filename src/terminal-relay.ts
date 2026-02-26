/**
 * Terminal Relay — Interactive REPL for your AI agent
 *
 * Same brain, same data pipeline, same memory as the Telegram relay.
 * Run: bun run terminal
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import {
  HOME, CLAWDIA_DIR, RELAY_DIR, HANDOFF_FILE, PROJECT_ROOT,
  todayStr, timeStr, charsToTokens, sanitizeExternal, isSensitivePath,
  appendSessionLog, appendDailyNote,
  createSupabaseClient, saveMessage,
  createMemoryMcpServer,
  ContextTracker, TOOL_OVERHEAD_PER_TURN,
  DANGEROUS_PATTERNS, isDangerousCommand,
  loadSession, saveSession, clearSession,
  acquireLock, releaseLock, setupLockCleanup,
  readHandoff,
  SLASH_COMMANDS,
  buildQueryOptions,
  processMemoryIntents,
  detectSignals, recordSignals,
  actionApprovedSignal, actionRejectedSignal,
  validateSecurityPrerequisites,
  type ContextSnapshot,
} from "./relay-core.ts";

// ============================================================
// ANSI COLORS
// ============================================================

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// ============================================================
// STATE
// ============================================================

let sessionId: string | null = null;
let currentModel = "claude-opus-4-6";
let abortController: AbortController | null = null;
let activeQuery = false;
const startTime = Date.now();

const supabase = createSupabaseClient();
const tracker = new ContextTracker();

// ============================================================
// READLINE SETUP
// ============================================================

function makePrompt(): string {
  const pct = tracker.usedPct();
  const bar = tracker.progressBar(pct);
  if (pct > 20) {
    return `${c.dim(`${bar} ${pct}%`)} ${c.cyan("you>")} `;
  }
  return `${c.cyan("you>")} `;
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

function prompt(): void {
  rl.setPrompt(makePrompt());
  rl.prompt();
}

// ============================================================
// DANGEROUS COMMAND APPROVAL (terminal Y/n)
// ============================================================

function requestTerminalApproval(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`\n${c.yellow("Dangerous command:")}\n  ${c.dim("$")} ${command}\n`);
    rl.question(`${c.yellow("Approve?")} [y/N] `, (answer) => {
      const approved = answer.toLowerCase().startsWith("y");
      if (approved) {
        process.stdout.write(`${c.green("Approved")}\n`);
      } else {
        process.stdout.write(`${c.red("Rejected")}\n`);
      }
      resolve(approved);
    });
  });
}

// ============================================================
// TOOL USE RENDERING
// ============================================================

const TOOL_ICONS: Record<string, string> = {
  Read: "📄",
  Bash: "💻",
  Edit: "✏️",
  Write: "📝",
  Glob: "🔍",
  Grep: "🔎",
  Task: "🔀",
};

function formatToolUse(toolName: string, input: any): string | null {
  const icon = TOOL_ICONS[toolName] || "🔧";
  switch (toolName) {
    case "Read":
      return `  ${icon} Read ${input?.file_path || ""}`;
    case "Bash": {
      const cmd = input?.command || "";
      const short = cmd.length > 80 ? cmd.substring(0, 77) + "..." : cmd;
      return `  ${icon} Bash $ ${short}`;
    }
    case "Edit": {
      const fp = input?.file_path || "";
      const lines = (input?.new_string || "").split("\n").length;
      return `  ${icon} Edit ${fp} (${lines} line${lines !== 1 ? "s" : ""} changed)`;
    }
    case "Write":
      return `  ${icon} Write ${input?.file_path || ""}`;
    case "Glob": {
      const pattern = input?.pattern || "";
      return `  ${icon} Glob ${pattern}`;
    }
    case "Grep": {
      const pat = input?.pattern || "";
      return `  ${icon} Grep ${pat}`;
    }
    case "Task":
      return `  ${icon} Task ${input?.description || ""}`;
    default:
      return `  ${icon} ${toolName}`;
  }
}

// ============================================================
// CORE: SDK QUERY
// ============================================================

async function callAgent(userMessage: string): Promise<void> {
  activeQuery = true;
  abortController = new AbortController();

  // Save user message
  await saveMessage(supabase, "user", userMessage, "terminal");
  await appendSessionLog("terminal", "user", userMessage);

  // Feedback signals
  const signals = detectSignals(userMessage);
  if (signals.length > 0) {
    const snapshot: ContextSnapshot = {
      sessionId: sessionId || undefined,
      model: currentModel,
    };
    recordSignals(supabase, signals, snapshot).catch(() => {});
  }

  // Track user tokens
  tracker.addTokens(charsToTokens(userMessage.length));

  try {
    const memoryServer = createMemoryMcpServer(supabase);
    const options = buildQueryOptions({
      sessionId,
      model: currentModel,
      memoryServer,
      canUseTool: async (toolName, input) => {
        const inp = input as any;

        // All Bash commands — dangerous approval, curl timeouts, default timeout
        if (toolName === "Bash") {
          let patchedCmd: string = inp.command || "";

          // Dangerous command approval
          if (isDangerousCommand(patchedCmd)) {
            const approved = await requestTerminalApproval(patchedCmd);
            const signal = approved ? actionApprovedSignal() : actionRejectedSignal();
            const snapshot: ContextSnapshot = { sessionId: sessionId || undefined, model: currentModel };
            recordSignals(supabase, [signal], snapshot).catch(() => {});
            if (!approved) {
              return { behavior: "deny" as const, message: "User rejected this command." };
            }
          }

          // Auto-inject curl timeouts to prevent indefinite hangs
          if (patchedCmd.includes("curl") && !/--max-time|--connect-timeout|-m /.test(patchedCmd)) {
            patchedCmd = patchedCmd.replace(/curl/, "curl --max-time 30 --connect-timeout 10");
          }

          // Default 2-minute Bash timeout
          const timeout = inp.timeout || 120_000;

          return { behavior: "allow" as const, updatedInput: { ...inp, command: patchedCmd, timeout } };
        }

        // Sensitive path protection for Write/Edit
        if ((toolName === "Write" || toolName === "Edit") && isSensitivePath(inp.file_path || "")) {
          const approved = await requestTerminalApproval(`${toolName} → ${inp.file_path}`);
          const signal = approved ? actionApprovedSignal() : actionRejectedSignal();
          const snapshot: ContextSnapshot = { sessionId: sessionId || undefined, model: currentModel };
          recordSignals(supabase, [signal], snapshot).catch(() => {});
          if (!approved) {
            return { behavior: "deny" as const, message: "User rejected this file operation." };
          }
          return { behavior: "allow" as const, updatedInput: input };
        }
        return { behavior: "allow" as const, updatedInput: input };
      },
      abortController,
    });

    const q = query({ prompt: `[Terminal] ${userMessage}`, options });

    let allResponses: string[] = [];
    let currentTurnText = "";
    let currentTurnPrinted = 0;
    let currentMsgUuid = "";

    // Start streaming indicator
    process.stdout.write(`\n${c.dim("Agent: ")}`);

    for await (const msg of q) {
      // Capture session ID
      if (msg.type === "system" && (msg as any).subtype === "init") {
        const initMsg = msg as any;
        if (initMsg.session_id) {
          sessionId = initMsg.session_id;
          await saveSession(initMsg.session_id);
        }
      }

      // Detect compaction
      if (msg.type === "system") {
        const sysMsg = msg as any;
        const subtype = sysMsg.subtype || "";
        if (subtype === "compaction" || subtype === "compact" ||
            (sysMsg.message && /compact/i.test(String(sysMsg.message)))) {
          const prevUsed = tracker.usedPct();
          tracker.reset();
          process.stdout.write(`\n${c.yellow(`Context was compacted (was ~${prevUsed}% full). Summary generated.`)}\n`);
          process.stdout.write(`${c.dim("Session files preserved — reading back last exchanges.")}\n`);
          await appendSessionLog("terminal", "assistant", `[CONTEXT COMPACTED at ~${prevUsed}% — auto-recovering from session file]`);
        }
      }

      // Render tool_use blocks from assistant messages
      if (msg.type === "assistant" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        for (const block of content) {
          if (block.type === "tool_use") {
            const line = formatToolUse(block.name, block.input);
            if (line) process.stdout.write(`${c.dim(line)}\n`);
          }
        }
      }

      // Stream assistant text
      if (msg.type === "assistant" && (msg as any).message?.content) {
        const text = (msg as any).message.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");

        const usage = (msg as any).message?.usage;
        if (usage?.input_tokens) {
          tracker.setTokens(usage.input_tokens);
        }

        if (text) {
          // Detect new turn via UUID or fallback to length heuristic
          const msgUuid = (msg as any).uuid || "";
          const isNewTurn = (msgUuid && currentMsgUuid && msgUuid !== currentMsgUuid) ||
            (!msgUuid && text.length < currentTurnText.length && currentTurnText);
          if (msgUuid) currentMsgUuid = msgUuid;

          if (isNewTurn) {
            if (currentTurnText) allResponses.push(currentTurnText);
            // Print separator for new turn
            process.stdout.write(`\n${c.dim("---")}\n`);
            currentTurnText = text;
            currentTurnPrinted = 0;
          } else {
            currentTurnText = text;
          }

          // Stream new characters to stdout
          const newContent = currentTurnText.slice(currentTurnPrinted);
          if (newContent) {
            process.stdout.write(newContent);
            currentTurnPrinted = currentTurnText.length;
          }
        }
      }

      // Track tool overhead
      if (msg.type === "tool_use") {
        tracker.addTokens(TOOL_OVERHEAD_PER_TURN);
      }

      // Final result
      if (msg.type === "result") {
        const resultMsg = msg as any;

        if (currentTurnText) allResponses.push(currentTurnText);
        let fullResponse = allResponses.join("\n\n");

        // If nothing was streamed but there's a result string
        if (!fullResponse && resultMsg.result) {
          process.stdout.write(resultMsg.result);
          fullResponse = resultMsg.result;
        }

        process.stdout.write("\n");

        // Process memory intents + save
        if (fullResponse) {
          const cleaned = await processMemoryIntents(supabase, fullResponse);
          await saveMessage(supabase, "assistant", cleaned, "terminal");
          await appendSessionLog("terminal", "assistant", cleaned);
        }

        // Update last-activity
        await writeFile(join(RELAY_DIR, "last-activity"), Date.now().toString()).catch(() => {});

        tracker.addTokens(charsToTokens(fullResponse.length));

        // Context warnings
        const warning = tracker.checkWarnings();
        if (warning) {
          process.stdout.write(`\n${c.yellow(warning)}\n`);
        }

        // Log cost
        const used = tracker.usedPct();
        const usage = resultMsg.modelUsage || resultMsg.usage || {};
        const cacheRead = usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0;
        const cacheCreate = usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || 0;
        const inputTokens = usage.inputTokens || usage.input_tokens || 0;
        const outputTokens = usage.outputTokens || usage.output_tokens || 0;
        const costStr = resultMsg.total_cost_usd ? `$${resultMsg.total_cost_usd.toFixed(4)}` : "n/a";
        const turnsStr = resultMsg.num_turns || "?";
        const cacheStr = cacheRead > 0 ? `Cache: ${cacheRead}r/${cacheCreate}c` : "";
        const tokenStr = inputTokens ? `${inputTokens}in/${outputTokens}out` : "";
        const parts = [`${costStr}`, `${turnsStr}t`, `~${used}%ctx`];
        if (cacheStr) parts.push(cacheStr);
        if (tokenStr) parts.push(tokenStr);
        process.stdout.write(`${c.dim(parts.join(" | "))}\n`);
      }
    }
  } catch (error: any) {
    if (error.name === "AbortError" || abortController?.signal.aborted) {
      process.stdout.write(`\n${c.yellow("Stopped.")}\n`);
    } else {
      process.stdout.write(`\n${c.red(`Error: ${error.message}`)}\n`);
      console.error("SDK query error:", error.message);
    }
  } finally {
    activeQuery = false;
    abortController = null;
  }
}

// ============================================================
// SLASH COMMAND HANDLING
// ============================================================

async function handleSlashCommand(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^\//, "");
  const arg = parts.slice(1).join(" ").trim() || undefined;

  // System commands
  switch (cmd) {
    case "stop": {
      if (abortController) {
        abortController.abort();
        abortController = null;
        activeQuery = false;
        process.stdout.write(`${c.yellow("Stopped. What's next?")}\n`);
      } else {
        process.stdout.write("Nothing running right now.\n");
      }
      return true;
    }
    case "new": {
      await appendDailyNote("terminal", "New session started via /new command");
      sessionId = null;
      tracker.reset();
      await clearSession();
      process.stdout.write(`${c.green("Fresh session started.")} Context reset to 0%. Supabase memory still intact.\n`);
      return true;
    }
    case "status": {
      const uptimeSec = (Date.now() - startTime) / 1000;
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const mem = process.memoryUsage();
      const mbUsed = Math.round(mem.rss / 1024 / 1024);
      const ctxUsed = tracker.usedPct();
      const ctxBar = tracker.progressBar(ctxUsed);
      process.stdout.write(
        `\n${c.bold("Relay Status")}\n` +
        `  Model:   ${currentModel}\n` +
        `  Session: ${sessionId ? sessionId.substring(0, 8) + "..." : "none"}\n` +
        `  Context: ${ctxBar} ${ctxUsed}%\n` +
        `  Uptime:  ${hours}h ${mins}m\n` +
        `  Memory:  ${mbUsed}MB\n` +
        `  Channel: terminal\n\n`
      );
      return true;
    }
    case "sync": {
      process.stdout.write(`${c.dim("Syncing Claude sessions...")}\n`);
      try {
        const proc = Bun.spawn(["bun", "run", "src/sync-claude-sessions.ts"], {
          cwd: PROJECT_ROOT,
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        });
        const out = await new Response(proc.stdout).text();
        const code = await proc.exited;
        if (code === 0) {
          const msg = out.trim() || "Nothing new to sync.";
          process.stdout.write(`${c.green(msg)}\n`);
        } else {
          const err = await new Response(proc.stderr).text();
          process.stdout.write(`${c.red("Sync failed:")} ${err.trim()}\n`);
        }
      } catch (e: any) {
        process.stdout.write(`${c.red(`Sync error: ${e.message}`)}\n`);
      }
      return true;
    }
    case "model": {
      if (arg === "opus") {
        currentModel = "claude-opus-4-6";
        process.stdout.write(`${c.magenta("Switched to Opus 4.6 — deep work mode")}\n`);
      } else if (arg === "sonnet") {
        currentModel = "claude-sonnet-4-6";
        process.stdout.write(`${c.cyan("Switched to Sonnet 4.6 — fast mode")}\n`);
      } else if (arg === "haiku") {
        currentModel = "claude-haiku-4-5-20251001";
        process.stdout.write(`${c.green("Switched to Haiku 4.5 — quick replies")}\n`);
      } else {
        process.stdout.write(`Current model: ${currentModel}\n\nSwitch: /model opus | sonnet | haiku\n`);
      }
      return true;
    }
    case "help": {
      process.stdout.write(`\n${c.bold("Commands")}\n\n`);
      process.stdout.write(`${c.bold("Brain")}\n`);
      for (const sc of SLASH_COMMANDS) {
        const argHint = sc.takesArg ? ` [${sc.argLabel}]` : "";
        process.stdout.write(`  /${sc.name}${argHint} — ${sc.description}\n`);
      }
      process.stdout.write(`  /telegram — handoff & switch to Telegram\n\n`);
      process.stdout.write(`${c.bold("System")}\n`);
      process.stdout.write(`  /model opus|sonnet|haiku — switch model\n`);
      process.stdout.write(`  /new — fresh session\n`);
      process.stdout.write(`  /sync — sync raw claude sessions now\n`);
      process.stdout.write(`  /stop — abort current task\n`);
      process.stdout.write(`  /status — system info\n`);
      process.stdout.write(`  /help — this list\n\n`);
      process.stdout.write(`${c.dim("Ctrl+C aborts active query, Ctrl+D exits with handoff")}\n\n`);
      return true;
    }
    case "telegram": {
      await appendDailyNote("terminal", "Switching from terminal to Telegram via /telegram");
      await callAgent(
        `The user is switching to Telegram now. Write a handoff summary to ${CLAWDIA_DIR}/memory/HANDOFF.md — what we discussed, what's open, what needs follow-up. Keep it brief. Append, don't overwrite. End with a short goodbye.`
      );
      await appendSessionLog("terminal", "assistant", "[CHANNEL SWITCH — Terminal → Telegram]");
      process.stdout.write(`\n${c.dim("Handoff written. Switching to Telegram.")}\n`);
      await cleanup();
      process.exit(0);
      return true;
    }
  }

  // Brain commands from SLASH_COMMANDS
  const slashCmd = SLASH_COMMANDS.find(sc => sc.name === cmd);
  if (slashCmd) {
    // Commands that require an arg
    if (cmd === "remember" && !arg) {
      process.stdout.write("Usage: /remember [thing to remember]\n");
      return true;
    }
    if (cmd === "search" && !arg) {
      process.stdout.write("Usage: /search [query]\n");
      return true;
    }

    const p = slashCmd.buildPrompt(arg);
    if (p) {
      await callAgent(p);
    }
    return true;
  }

  return false;
}

// ============================================================
// CLEANUP
// ============================================================

async function cleanup(): Promise<void> {
  await releaseLock("terminal");
  if (sessionId) {
    await saveSession(sessionId);
  }
  await appendDailyNote("terminal", "Terminal session ended");
}

// ============================================================
// STARTUP
// ============================================================

async function start(): Promise<void> {
  // Validate security prerequisites
  await validateSecurityPrerequisites("terminal");

  // Acquire lock
  if (!(await acquireLock("terminal"))) {
    process.stderr.write(`${c.red("Could not acquire lock. Another terminal instance may be running.")}\n`);
    process.exit(1);
  }
  setupLockCleanup("terminal");

  // Load session
  sessionId = await loadSession();

  // Banner
  process.stdout.write(`\n${c.bold(c.cyan("Terminal Relay"))}\n`);
  process.stdout.write(`${c.dim("Same brain, same memory, same pipeline as Telegram.")}\n\n`);
  process.stdout.write(`  Model:   ${currentModel}\n`);
  process.stdout.write(`  Session: ${sessionId ? sessionId.substring(0, 8) + "..." : "new"}\n`);
  process.stdout.write(`  Context: ${tracker.progressBar()} ${tracker.usedPct()}%\n`);
  process.stdout.write(`  Supabase: ${supabase ? c.green("connected") : c.yellow("not configured")}\n`);
  process.stdout.write(`\n${c.dim("Type /help for commands. Ctrl+C to stop, Ctrl+D to exit.")}\n\n`);

  // Check for handoff
  const handoff = await readHandoff();
  if (handoff) {
    process.stdout.write(`${c.yellow("Handoff from last session:")}\n`);
    process.stdout.write(`${c.dim(handoff.substring(0, 500))}\n\n`);
  }

  await appendDailyNote("terminal", "Terminal session started");

  // SIGINT handler — first press aborts query, second exits
  let sigintCount = 0;
  process.on("SIGINT", async () => {
    if (activeQuery && abortController) {
      abortController.abort();
      abortController = null;
      activeQuery = false;
      sigintCount = 0;
      process.stdout.write(`\n${c.yellow("Stopped.")}\n`);
      prompt();
      return;
    }
    sigintCount++;
    if (sigintCount >= 2) {
      process.stdout.write(`\n${c.dim("Exiting...")}\n`);
      await cleanup();
      process.exit(0);
    }
    process.stdout.write(`\n${c.dim("Press Ctrl+C again to exit, or keep chatting.")}\n`);
    prompt();
  });

  // Main input loop
  rl.on("line", async (line) => {
    sigintCount = 0;
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }

    // Slash commands
    if (input.startsWith("/")) {
      const handled = await handleSlashCommand(input);
      if (handled) {
        prompt();
        return;
      }
      // If not a known slash command, pass through as a message
    }

    // Regular message — full pipeline
    await callAgent(input);
    prompt();
  });

  // Ctrl+D — clean exit
  rl.on("close", async () => {
    process.stdout.write(`\n${c.dim("Goodbye.")}\n`);
    await cleanup();
    process.exit(0);
  });

  // If there's a handoff, include it in context for the first prompt
  if (handoff) {
    // Don't auto-query, just let the user know it's loaded
    process.stdout.write(`${c.dim("Handoff context will be included in your first message.")}\n\n`);
  }

  prompt();
}

// ============================================================
// RUN
// ============================================================

start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

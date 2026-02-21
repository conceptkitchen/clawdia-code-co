/**
 * Relay Core — Shared module for Telegram + Terminal relays
 *
 * Everything channel-agnostic lives here: constants, utilities,
 * session logging, Supabase, memory MCP, context tracking,
 * dangerous command patterns, session persistence, lock files,
 * SDK query builder, stream processor, slash commands, handoff.
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { processMemoryIntents, getMemoryContext, getRelevantContext } from "./memory.ts";
import { writeFile, readFile, mkdir, unlink, appendFile, stat } from "fs/promises";
import { join, dirname } from "path";

// ============================================================
// CONSTANTS
// ============================================================

export const HOME = process.env.HOME || "";
export const CLAWDIA_DIR = process.env.BRAIN_DIR || `${HOME}/clawdia`;
export const RELAY_DIR = process.env.RELAY_DIR || join(HOME, ".claude-relay");
export const PROJECT_ROOT = dirname(dirname(import.meta.path));
export const SESSIONS_DIR = join(CLAWDIA_DIR, "memory", "sessions");
export const MEMORY_DIR = join(CLAWDIA_DIR, "memory");
export const HANDOFF_FILE = join(CLAWDIA_DIR, "memory", "HANDOFF.md");

// ============================================================
// UTILITIES
// ============================================================

export function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

export function timeStr(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function charsToTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

export function sanitizeExternal(input: string): string {
  return input
    .replace(/\[PROPOSE_(EDIT|WRITE|APPEND|COMMAND)\]/gi, "[BLOCKED_TAG]")
    .replace(/\[\/(PROPOSE_(EDIT|WRITE|APPEND|COMMAND))\]/gi, "[/BLOCKED_TAG]")
    .replace(/\[(REMEMBER|GOAL|DONE):\s*/gi, "[BLOCKED_MEMORY_TAG: ")
    .replace(/<\s*\/?\s*(system|human|assistant|user|tool_use|tool_result)\b[^>]*>/gi, "[BLOCKED_XML]")
    .replace(/\b(ignore\s+(all\s+)?previous\s+instructions|you\s+are\s+now|disregard\s+(all\s+)?prior|new\s+instructions?\s*:)/gi, "[BLOCKED_INJECTION]")
    .replace(/^(System|Assistant|Human|User)\s*:/gim, "[BLOCKED_ROLE]:");
}

// ============================================================
// SENSITIVE PATH PROTECTION
// ============================================================

const SENSITIVE_PATH_PREFIXES = [
  "~/.ssh/", "~/.env", "~/.bashrc", "~/.zshrc", "~/.bash_profile", "~/.profile",
  "~/.gitconfig", "~/.claude/settings", "~/.claude/credentials",
  "/etc/", "~/.gnupg/", "~/.aws/", "~/.kube/",
];

export function isSensitivePath(filePath: string): boolean {
  // Normalize ~ to HOME
  const normalized = filePath.replace(/^~/, HOME);
  const withTilde = filePath.startsWith("~") ? filePath : filePath.replace(HOME, "~");
  return SENSITIVE_PATH_PREFIXES.some(prefix => {
    const expandedPrefix = prefix.replace(/^~/, HOME);
    return normalized.startsWith(expandedPrefix) || withTilde.startsWith(prefix);
  });
}

// ============================================================
// SESSION LOGGING (parameterized by channel)
// ============================================================

export async function appendSessionLog(
  channel: "telegram" | "terminal" | "claude-cli",
  role: "user" | "assistant",
  content: string
): Promise<void> {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const filePath = join(SESSIONS_DIR, `${todayStr()}-${channel}-live.md`);
    const userName = process.env.USER_NAME || "User";
    const prefix = role === "user" ? `**${userName}**` : "**Assistant**";
    const entry = `\n[${timeStr()}] ${prefix}: ${content}\n`;
    await appendFile(filePath, entry);
  } catch (e) {
    console.error("Session log error:", e);
  }
}

export async function appendDailyNote(
  channel: "telegram" | "terminal" | "claude-cli",
  note: string
): Promise<void> {
  try {
    await mkdir(MEMORY_DIR, { recursive: true });
    const tags: Record<string, string> = { telegram: "[Telegram]", terminal: "[Terminal]", "claude-cli": "[Claude CLI]" };
    const tag = tags[channel] || `[${channel}]`;
    const filePath = join(MEMORY_DIR, `${todayStr()}.md`);
    await appendFile(filePath, `\n- [${timeStr()}] ${tag} ${note}\n`);
  } catch (e) {
    console.error("Daily note error:", e);
  }
}

// ============================================================
// SUPABASE
// ============================================================

export function createSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  // Prefer service role key (bypasses RLS for backend use); fall back to anon key
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return null;
}

export async function saveMessage(
  supabase: SupabaseClient | null,
  role: string,
  content: string,
  channel: string = "telegram"
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({ role, content, channel, metadata: {} });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// ============================================================
// MEMORY MCP SERVER FACTORY
// ============================================================

export function createMemoryMcpServer(supabase: SupabaseClient | null) {
  return createSdkMcpServer({
    name: "memory",
    tools: [
      tool(
        "search_memory",
        "Search past conversations and stored facts via semantic search across all channels (terminal + Telegram)",
        { query: z.string().describe("Search query — what to look for in past conversations and memories") },
        async ({ query: q }) => {
          const results = await getRelevantContext(supabase, q);
          return { content: [{ type: "text" as const, text: results || "No results found" }] };
        }
      ),
      tool(
        "get_facts_and_goals",
        "Get stored facts and active goals from Supabase memory",
        {},
        async () => {
          const ctx = await getMemoryContext(supabase);
          return { content: [{ type: "text" as const, text: ctx || "No facts or goals stored" }] };
        }
      ),
    ],
  });
}

// ============================================================
// CONTEXT WINDOW TRACKING
// ============================================================

export const CONTEXT_WINDOW = 200_000;
export const SYSTEM_PROMPT_ESTIMATE = 18_000;
export const TOOL_OVERHEAD_PER_TURN = 500;

export class ContextTracker {
  tokens = SYSTEM_PROMPT_ESTIMATE;
  warnings = { pct10: false, pct5: false };
  lastCompactionNotified = false;

  addTokens(n: number): void {
    this.tokens += n;
  }

  setTokens(n: number): void {
    this.tokens = n;
  }

  usedPct(): number {
    return Math.min(100, Math.round((this.tokens / CONTEXT_WINDOW) * 100));
  }

  remainingPct(): number {
    return 100 - this.usedPct();
  }

  reset(): void {
    this.tokens = SYSTEM_PROMPT_ESTIMATE;
    this.warnings = { pct10: false, pct5: false };
    this.lastCompactionNotified = false;
  }

  progressBar(pct?: number): string {
    const p = pct ?? this.usedPct();
    const total = 10;
    const filled = Math.round((p / 100) * total);
    const empty = total - filled;
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
    if (p >= 95) return `[${bar}]`;
    if (p >= 90) return `[${bar}]`;
    return `[${bar}]`;
  }

  /** Returns warning message if threshold crossed, null otherwise */
  checkWarnings(): string | null {
    const remaining = this.remainingPct();
    const used = this.usedPct();

    if (remaining <= 5 && !this.warnings.pct5) {
      this.warnings.pct5 = true;
      return (
        `Context ~${used}% full (~${remaining}% left). Compaction imminent.\n` +
        `Session files are saved — nothing will be lost.`
      );
    }
    if (remaining <= 10 && !this.warnings.pct10) {
      this.warnings.pct10 = true;
      return (
        `Context ~${used}% full (~${remaining}% left). Compaction approaching.\n` +
        `The agent will auto-recover from session files after compaction.`
      );
    }
    return null;
  }
}

// ============================================================
// DANGEROUS COMMAND PATTERNS
// ============================================================

export const DANGEROUS_PATTERNS = [
  // Destructive file ops
  /\brm\s/, /\bmkfs\b/, /\bdd\s/,
  // Privilege escalation
  /\bsudo\s/, /\bchmod\s/, /\bchown\s/, /\bsu\s/,
  // Git danger
  /force[\s-]*push/i, /--force/, /push\s+.*--force/, /git\s+reset\s+--hard/i,
  // Production deploys
  /\bdeploy\b.*prod/i,
  // Database destruction
  /\bDROP\s/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\s/i,
  // Arbitrary code execution via shell tricks
  /curl\s+.*[|;]\s*(ba)?sh/i, /wget\s+.*[|;]\s*(ba)?sh/i,
  /\beval\s*[(`]/, /base64\s+-d\s*.*[|;]\s*(ba)?sh/i,
  /\bpython[23]?\s+-c\b/, /\bnode\s+-e\b/, /\bbun\s+-e\b/,
  // More scripting interpreters
  /\bperl\s+-e\b/, /\bruby\s+-e\b/, /\bphp\s+-r\b/,
  // Process/system manipulation
  /\bkill\s+-9\b/, /\bpkill\b/, /\bkillall\b/,
  /\bcrontab\s+-[re]\b/,
  // Service management
  /\blaunchctl\s+(load|unload|remove)\b/, /\bsystemctl\s+(start|stop|enable|disable)\b/,
  // Shell redirects to sensitive paths
  />\s*~\/\.ssh\//, />\s*~\/\.bashrc/, />\s*~\/\.zshrc/, />\s*\/etc\//,
  // URL opening (potential phishing / exfiltration)
  /\bopen\s+https?:\/\//, /\bxdg-open\b/,
  // Permission / attribute manipulation
  /\bsetfacl\b/, /\bxattr\s+-wd?\b/,
  // Environment hijacking
  /\bexport\s+PATH=/, /\bexport\s+HOME=/,
  // Mount operations
  /\bmount\b/, /\bumount\b/,
  // Network-based code execution
  /\bssh\s+.*&&/, /\bssh\s+.*[|;]/,
  // Container escapes
  /\bdocker\s+run\b/, /\bdocker\s+exec\b/,
  // Package installs (can run arbitrary postinstall scripts)
  /\bnpm\s+install\b/, /\bbun\s+add\b/, /\bpip\s+install\b/,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

// ============================================================
// SECURITY PREREQUISITES
// ============================================================

export async function validateSecurityPrerequisites(channel: "telegram" | "terminal"): Promise<void> {
  // Hard fail: Telegram channel requires bot token and user ID
  if (channel === "telegram") {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error("FATAL: TELEGRAM_BOT_TOKEN is not set. Exiting.");
      process.exit(1);
    }
    if (!process.env.TELEGRAM_USER_ID) {
      console.error("FATAL: TELEGRAM_USER_ID is not set. Bot would accept messages from anyone. Exiting.");
      process.exit(1);
    }
  }

  // Warn: missing service role key
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("WARN: SUPABASE_SERVICE_ROLE_KEY not set — falling back to anon key (RLS may block writes).");
  }

  // Warn: .env permissions
  try {
    const envStat = await stat(join(PROJECT_ROOT, ".env"));
    const mode = envStat.mode & 0o777;
    if (mode & 0o077) {
      console.warn(`WARN: .env file permissions are ${mode.toString(8)} — recommend chmod 600.`);
    }
  } catch {}

  // Warn: running as root
  if (process.getuid?.() === 0) {
    console.warn("WARN: Running as root is not recommended.");
  }

  // Warn: brain directory
  try {
    await stat(CLAWDIA_DIR);
  } catch {
    console.warn(`WARN: Brain directory ${CLAWDIA_DIR} does not exist.`);
  }
}

// ============================================================
// SESSION PERSISTENCE
// ============================================================

const SESSION_FILE = join(RELAY_DIR, "session.json");

export async function loadSession(): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(SESSION_FILE, "utf-8"));
    return data.sessionId || null;
  } catch {
    return null;
  }
}

export async function saveSession(id: string): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true });
  await writeFile(
    SESSION_FILE,
    JSON.stringify({ sessionId: id, lastActivity: new Date().toISOString() }, null, 2)
  );
}

export async function clearSession(): Promise<void> {
  await writeFile(
    SESSION_FILE,
    JSON.stringify({ sessionId: null, lastActivity: new Date().toISOString() })
  );
}

// ============================================================
// LOCK FILE (parameterized)
// ============================================================

export async function acquireLock(name: string = "bot"): Promise<boolean> {
  const lockFile = join(RELAY_DIR, `${name}.lock`);
  try {
    await mkdir(RELAY_DIR, { recursive: true });
    const existingLock = await readFile(lockFile, "utf-8").catch(() => null);
    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }
    await writeFile(lockFile, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

export async function releaseLock(name: string = "bot"): Promise<void> {
  const lockFile = join(RELAY_DIR, `${name}.lock`);
  await unlink(lockFile).catch(() => {});
}

export function setupLockCleanup(name: string = "bot"): void {
  const lockFile = join(RELAY_DIR, `${name}.lock`);
  process.on("exit", () => {
    try { require("fs").unlinkSync(lockFile); } catch {}
  });
}

// ============================================================
// HANDOFF
// ============================================================

export async function readHandoff(): Promise<string | null> {
  try {
    const content = await readFile(HANDOFF_FILE, "utf-8");
    const stats = await stat(HANDOFF_FILE);
    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    if (ageHours > 24) return null;
    return content.trim();
  } catch {
    return null;
  }
}

// ============================================================
// SLASH COMMANDS — shared definitions for both channels
// ============================================================

export interface SlashCommand {
  name: string;
  description: string;
  category: "brain" | "system";
  takesArg?: boolean;
  argLabel?: string;
  buildPrompt: (arg?: string) => string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goals",
    description: "check goals & progress",
    category: "brain",
    buildPrompt: () => `Read ${CLAWDIA_DIR}/GOALS.md and give me a brief status on each goal. What's progressing, what's stalled, what needs attention?`,
  },
  {
    name: "agenda",
    description: "today's priorities",
    category: "brain",
    buildPrompt: () => "Check my calendar, outstanding tasks, and goals. Give me today's top 3 priorities and what's on deck. Be specific and actionable.",
  },
  {
    name: "tasks",
    description: "outstanding tasks",
    category: "brain",
    buildPrompt: () => `Read ${CLAWDIA_DIR}/memory/outstanding-tasks.md and give me the current list. Flag anything overdue or urgent.`,
  },
  {
    name: "people",
    description: "look up a contact",
    category: "brain",
    takesArg: true,
    argLabel: "name",
    buildPrompt: (name?: string) =>
      name
        ? `Look up "${name}" in ${CLAWDIA_DIR}/people/. Read their file and give me the key details, last interaction, and any pending follow-ups.`
        : `Read ${CLAWDIA_DIR}/people/DIRECTORY.md and give me a quick overview of my contacts. Who have I been in touch with recently? Anyone I should follow up with?`,
  },
  {
    name: "projects",
    description: "project status",
    category: "brain",
    takesArg: true,
    argLabel: "name",
    buildPrompt: (name?: string) =>
      name
        ? `Check ${CLAWDIA_DIR}/projects/ for anything related to "${name}". Read the relevant files and give me current status, next steps, and blockers.`
        : `List all directories in ${CLAWDIA_DIR}/projects/ and give me a one-line status on each active project. What needs attention?`,
  },
  {
    name: "budget",
    description: "financial snapshot",
    category: "brain",
    buildPrompt: () => `Read the budget skill at ${CLAWDIA_DIR}/skills/budget/SKILL.md, then follow its instructions to give me a current financial snapshot. What's due, what's coming in, what's tight?`,
  },
  {
    name: "journal",
    description: "read or write journal",
    category: "brain",
    takesArg: true,
    argLabel: "entry",
    buildPrompt: (entry?: string) =>
      entry
        ? `Journal entry: "${entry}". Save this to ${CLAWDIA_DIR}/journal/ following the journal skill format. Confirm when saved.`
        : `Read my most recent journal entries from ${CLAWDIA_DIR}/journal/. Summarize the last 2-3 entries.`,
  },
  {
    name: "remember",
    description: "save to memory",
    category: "brain",
    takesArg: true,
    argLabel: "fact",
    buildPrompt: (fact?: string) =>
      fact
        ? `Remember this: ${fact}. Save it to the appropriate place in ${CLAWDIA_DIR}/ (memory file, people file, project file, wherever it belongs). Confirm what you saved and where.`
        : "",
  },
  {
    name: "search",
    description: "search everything",
    category: "brain",
    takesArg: true,
    argLabel: "query",
    buildPrompt: (q?: string) =>
      q
        ? `Search for "${q}" across everything: Supabase memory (use search_memory tool), ${CLAWDIA_DIR}/memory/, ${CLAWDIA_DIR}/people/, ${CLAWDIA_DIR}/projects/. Give me what you find.`
        : "",
  },
  {
    name: "handoff",
    description: "write channel handoff",
    category: "brain",
    buildPrompt: () => `Write a handoff summary to ${CLAWDIA_DIR}/memory/HANDOFF.md. Summarize our recent conversation: what we discussed, what's open, what needs follow-up. Append, don't overwrite.`,
  },
];

// ============================================================
// SDK QUERY OPTIONS BUILDER
// ============================================================

export interface QueryConfig {
  sessionId: string | null;
  model: string;
  memoryServer: ReturnType<typeof createMemoryMcpServer>;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }>;
  abortController?: AbortController;
}

export function buildQueryOptions(config: QueryConfig) {
  return {
    resume: config.sessionId || undefined,
    cwd: CLAWDIA_DIR,
    model: config.model,
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    settingSources: ["project" as const],
    tools: { type: "preset" as const, preset: "claude_code" as const },
    permissionMode: "acceptEdits" as const,
    canUseTool: config.canUseTool,
    abortController: config.abortController,
    additionalDirectories: [`${HOME}/repos`],
    maxTurns: 25,
    maxBudgetUsd: 5.0,
    mcpServers: {
      playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      memory: config.memoryServer,
    },
  };
}

// ============================================================
// STREAM PROCESSOR — shared for-await loop
// ============================================================

export interface StreamCallbacks {
  onSessionId: (id: string) => void;
  onCompaction: (prevUsedPct: number) => void;
  onText: (fullText: string, newChunk: string) => void;
  onResult: (fullResponse: string, resultMsg: any) => void;
  onContextWarning: (warning: string) => void;
}

export async function processQueryStream(
  prompt: string,
  channelTag: string,
  config: QueryConfig,
  tracker: ContextTracker,
  supabase: SupabaseClient | null,
  channel: "telegram" | "terminal",
  callbacks: StreamCallbacks,
): Promise<void> {
  tracker.addTokens(charsToTokens(prompt.length));

  const options = buildQueryOptions(config);
  const q = query({ prompt: `[${channelTag}] ${prompt}`, options });

  let allResponses: string[] = [];
  let currentTurnText = "";

  for await (const msg of q) {
    // Capture session ID
    if (msg.type === "system" && (msg as any).subtype === "init") {
      const initMsg = msg as any;
      if (initMsg.session_id) {
        await saveSession(initMsg.session_id);
        callbacks.onSessionId(initMsg.session_id);
      }
    }

    // Detect context compaction
    if (msg.type === "system") {
      const sysMsg = msg as any;
      const subtype = sysMsg.subtype || "";
      if (subtype === "compaction" || subtype === "compact" ||
          (sysMsg.message && /compact/i.test(String(sysMsg.message)))) {
        const prevUsed = tracker.usedPct();
        tracker.reset();
        callbacks.onCompaction(prevUsed);
        await appendSessionLog(channel, "assistant", `[CONTEXT COMPACTED at ~${prevUsed}% — auto-recovering from session file]`);
      }
    }

    // Accumulate assistant text
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
        // New turn detection
        if (text.length < currentTurnText.length && currentTurnText) {
          if (currentTurnText) allResponses.push(currentTurnText);
          currentTurnText = text;
        } else {
          currentTurnText = text;
        }

        callbacks.onText(currentTurnText, text);
      }
    }

    // Track tool use overhead
    if (msg.type === "tool_use") {
      tracker.addTokens(TOOL_OVERHEAD_PER_TURN);
    }

    // Final result
    if (msg.type === "result") {
      const resultMsg = msg as any;

      if (currentTurnText) allResponses.push(currentTurnText);
      let fullResponse = allResponses.join("\n\n");

      if (!fullResponse && resultMsg.result) {
        fullResponse = resultMsg.result;
      }

      // Process memory intents + save
      if (fullResponse) {
        const cleaned = await processMemoryIntents(supabase, fullResponse);
        await saveMessage(supabase, "assistant", cleaned, channel);
        await appendSessionLog(channel, "assistant", cleaned);
        fullResponse = cleaned;
      }

      // Update last-activity
      await writeFile(join(RELAY_DIR, "last-activity"), Date.now().toString()).catch(() => {});

      // Track response tokens
      tracker.addTokens(charsToTokens(fullResponse.length));

      // Check context warnings
      const warning = tracker.checkWarnings();
      if (warning) callbacks.onContextWarning(warning);

      // Log cost + context usage
      const used = tracker.usedPct();
      const usage = resultMsg.modelUsage || resultMsg.usage || {};
      const cacheRead = usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || 0;
      const inputTokens = usage.inputTokens || usage.input_tokens || 0;
      const outputTokens = usage.outputTokens || usage.output_tokens || 0;
      const costStr = resultMsg.total_cost_usd ? `$${resultMsg.total_cost_usd.toFixed(4)}` : "n/a";
      const turnsStr = resultMsg.num_turns || "?";
      const cacheStr = cacheRead > 0 ? `Cache: ${cacheRead} read, ${cacheCreate} created` : "Cache: none";
      const tokenStr = inputTokens ? `In: ${inputTokens} Out: ${outputTokens}` : "";
      console.log(`Query: ${costStr} | Turns: ${turnsStr} | Context: ~${used}% | ${cacheStr}${tokenStr ? ` | ${tokenStr}` : ""}`);

      callbacks.onResult(fullResponse, resultMsg);
    }
  }
}

// ============================================================
// RE-EXPORTS for convenience
// ============================================================

export { processMemoryIntents } from "./memory.ts";
export { detectSignals, recordSignals, actionApprovedSignal, actionRejectedSignal } from "./feedback.ts";
export type { ContextSnapshot } from "./feedback.ts";

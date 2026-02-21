/**
 * Claude Code Telegram Relay — SDK Edition
 *
 * Thin bridge between Telegram and Claude Code via the Agent SDK.
 * One persistent session, real tools, real memory, full context.
 * The agent's brain lives at BRAIN_DIR — the SDK loads CLAUDE.md from there.
 *
 * Run: bun run src/relay.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { transcribe } from "./transcribe.ts";
import { writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";

// Shared core
import {
  HOME, CLAWDIA_DIR, RELAY_DIR, PROJECT_ROOT,
  charsToTokens, sanitizeExternal, isSensitivePath,
  appendSessionLog, appendDailyNote,
  createSupabaseClient, saveMessage,
  createMemoryMcpServer,
  ContextTracker, TOOL_OVERHEAD_PER_TURN,
  DANGEROUS_PATTERNS,
  loadSession, saveSession, clearSession,
  acquireLock, releaseLock, setupLockCleanup,
  buildQueryOptions,
  SLASH_COMMANDS,
  processMemoryIntents,
  detectSignals, recordSignals,
  actionApprovedSignal, actionRejectedSignal,
  validateSecurityPrerequisites,
  type ContextSnapshot,
} from "./relay-core.ts";

// ============================================================
// CONFIGURATION — Telegram-specific
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID!;

// ElevenLabs TTS for driving mode
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const KNOWLEDGE_DIR = join(RELAY_DIR, "knowledge");

// ============================================================
// STATE
// ============================================================

let sessionId: string | null = null;
let activeQuery: AsyncGenerator<SDKMessage> | null = null;
let abortController: AbortController | null = null;
let currentModel = "claude-opus-4-6";
let drivingMode = false;
let toolStream = true;
let currentCtx: Context | null = null;

// Message queue — hold incoming while a query is active
const messageQueue: Array<{ ctx: Context; handler: () => Promise<void> }> = [];
let processing = false;

// Context tracking via shared class
const tracker = new ContextTracker();

// Rate limiter — max 10 messages per 60 seconds
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  // Prune old entries
  while (rateLimitTimestamps.length > 0 && rateLimitTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    rateLimitTimestamps.shift();
  }
  if (rateLimitTimestamps.length >= RATE_LIMIT_MAX) return true;
  rateLimitTimestamps.push(now);
  return false;
}

// ============================================================
// SETUP
// ============================================================

// Validate security prerequisites before anything else
await validateSecurityPrerequisites("telegram");

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(KNOWLEDGE_DIR, { recursive: true });
sessionId = await loadSession();

// ============================================================
// SUPABASE + MEMORY MCP
// ============================================================

const supabase = createSupabaseClient();

// ============================================================
// APPROVAL SYSTEM — dangerous commands need Telegram button tap
// ============================================================

const pendingApprovals = new Map<string, { resolve: (ok: boolean) => void; timer: Timer }>();

async function requestTelegramApproval(command: string): Promise<boolean> {
  if (!currentCtx) return false;
  const id = Math.random().toString(36).substring(2, 8);
  const keyboard = new InlineKeyboard()
    .text("Approve", `approve_${id}`)
    .text("Reject", `reject_${id}`);

  const displayCmd = command.length > 500 ? command.substring(0, 500) + "..." : command;
  await currentCtx.reply(`⚡ Dangerous command:\n\`$ ${displayCmd}\``, { reply_markup: keyboard });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      resolve(false);
    }, 10 * 60 * 1000);
    pendingApprovals.set(id, { resolve, timer });
  });
}

// ============================================================
// CORE: SDK QUERY
// ============================================================

async function callAgent(ctx: Context, userMessage: string): Promise<void> {
  currentCtx = ctx;
  abortController = new AbortController();

  // Save user message to Supabase + local file
  await saveMessage(supabase, "user", userMessage, "telegram");
  await appendSessionLog("telegram", "user", userMessage);

  // Track user message tokens
  tracker.addTokens(charsToTokens(userMessage.length));

  // Typing indicator
  await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});

  // Typing keepalive
  const typingInterval = setInterval(async () => {
    try { await ctx.api.sendChatAction(ctx.chat!.id, "typing"); } catch {}
  }, 4000);

  try {
    const memoryServer = createMemoryMcpServer(supabase);
    const options = buildQueryOptions({
      sessionId,
      model: currentModel,
      memoryServer,
      canUseTool: async (toolName, input) => {
        // Dangerous Bash commands
        if (toolName === "Bash" && DANGEROUS_PATTERNS.some(p => p.test((input as any).command || ""))) {
          const approved = await requestTelegramApproval((input as any).command);
          return approved
            ? { behavior: "allow" as const, updatedInput: input }
            : { behavior: "deny" as const, message: "User rejected this command." };
        }
        // Sensitive path protection for Write/Edit
        if ((toolName === "Write" || toolName === "Edit") && isSensitivePath((input as any).file_path || "")) {
          const approved = await requestTelegramApproval(`${toolName} → ${(input as any).file_path}`);
          return approved
            ? { behavior: "allow" as const, updatedInput: input }
            : { behavior: "deny" as const, message: "User rejected this file operation." };
        }
        return { behavior: "allow" as const, updatedInput: input };
      },
      abortController,
    });

    const q = query({ prompt: `[Telegram] ${userMessage}`, options });
    activeQuery = q;

    // Stream and buffer text for Telegram delivery
    let allResponses: string[] = [];
    let currentTurnText = "";
    let currentTurnSent = 0;
    let lastFlush = Date.now();

    for await (const msg of q) {
      // Capture session ID
      if (msg.type === "system" && (msg as any).subtype === "init") {
        const initMsg = msg as any;
        if (initMsg.session_id) {
          sessionId = initMsg.session_id;
          await saveSession(initMsg.session_id);
        }
      }

      // Detect context compaction from SDK system messages
      if (msg.type === "system") {
        const sysMsg = msg as any;
        const subtype = sysMsg.subtype || "";
        if (subtype === "compaction" || subtype === "compact" ||
            (sysMsg.message && /compact/i.test(String(sysMsg.message)))) {
          const prevUsed = tracker.usedPct();
          tracker.reset();
          await ctx.reply(
            `🔄 Context was compacted (was ~${prevUsed}% full). Summary generated.\n` +
            `Session files preserved — reading back last exchanges.`
          ).catch(() => {});
          await appendSessionLog("telegram", "assistant", `[CONTEXT COMPACTED at ~${prevUsed}% — auto-recovering from session file]`);
        }
      }

      // Accumulate assistant text — handles multi-turn responses (tool calls create new turns)
      if (msg.type === "assistant" && (msg as any).message?.content) {
        const text = (msg as any).message.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");

        // Use real usage data if SDK provides it
        const usage = (msg as any).message?.usage;
        if (usage?.input_tokens) {
          tracker.setTokens(usage.input_tokens);
        }

        if (text) {
          // Detect new turn (text shorter than what we had = new assistant message after tool call)
          if (text.length < currentTurnText.length && currentTurnText) {
            // Save previous turn, start new one
            if (currentTurnText) allResponses.push(currentTurnText);
            currentTurnText = text;
            currentTurnSent = 0;
          } else {
            currentTurnText = text;
          }

          // Flush at paragraph breaks or size thresholds — always at word boundaries
          const unsent = currentTurnText.slice(currentTurnSent);
          const now = Date.now();
          const hasParagraphBreak = unsent.includes("\n\n") && unsent.length > 80;
          const isLarge = unsent.length > 400;
          const isStale = now - lastFlush > 3000 && unsent.length > 40;

          if (hasParagraphBreak || isLarge || isStale) {
            // Find a safe split point — never cut mid-word
            let flushEnd = unsent.length;

            if (hasParagraphBreak) {
              const paraIdx = unsent.lastIndexOf("\n\n");
              if (paraIdx > 0) flushEnd = paraIdx;
            } else {
              const sentenceEnd = Math.max(
                unsent.lastIndexOf(". "),
                unsent.lastIndexOf(".\n"),
                unsent.lastIndexOf("? "),
                unsent.lastIndexOf("! "),
              );
              if (sentenceEnd > unsent.length * 0.3) {
                flushEnd = sentenceEnd + 1;
              } else {
                const lastSpace = unsent.lastIndexOf(" ");
                if (lastSpace > unsent.length * 0.3) {
                  flushEnd = lastSpace;
                }
              }
            }

            const chunk = unsent.slice(0, flushEnd).trim();
            if (chunk) {
              await sendResponse(ctx, chunk);
              currentTurnSent += flushEnd;
              lastFlush = now;
            }
          }
        }
      }

      // Track tool use overhead
      if (msg.type === "tool_use") {
        tracker.addTokens(TOOL_OVERHEAD_PER_TURN);
      }

      // Final result
      if (msg.type === "result") {
        const resultMsg = msg as any;

        // Collect final turn
        if (currentTurnText) allResponses.push(currentTurnText);
        const fullResponse = allResponses.join("\n\n");

        // Flush any remaining unsent text from the last turn
        const remaining = currentTurnText.slice(currentTurnSent).trim();
        if (remaining) {
          await sendResponse(ctx, remaining);
        }

        // If no text was accumulated but there's a result string, send that
        if (!fullResponse && resultMsg.result) {
          await sendResponse(ctx, resultMsg.result);
          allResponses.push(resultMsg.result);
        }

        // Save assistant response to Supabase + local file
        const finalResponse = allResponses.join("\n\n");
        if (finalResponse) {
          const cleaned = await processMemoryIntents(supabase, finalResponse);
          await saveMessage(supabase, "assistant", cleaned, "telegram");
          await appendSessionLog("telegram", "assistant", cleaned);
        }

        // Update last-activity for smart-checkin suppression
        await writeFile(join(RELAY_DIR, "last-activity"), Date.now().toString()).catch(() => {});

        // Track assistant response tokens
        tracker.addTokens(charsToTokens(finalResponse.length));

        // Check for context warnings and send to Telegram
        const warning = tracker.checkWarnings();
        if (warning) {
          await ctx.reply(warning).catch(() => {});
        }

        // Log cost + context usage + cache stats
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
      }
    }
  } catch (error: any) {
    if (error.name === "AbortError" || abortController?.signal.aborted) {
      console.log("Query aborted by user");
    } else {
      console.error("SDK query error:", error.message);
      await ctx.reply("Something went wrong. Try again or send /new to start fresh.").catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    activeQuery = null;
    abortController = null;
  }
}

// ============================================================
// MESSAGE QUEUE — prevent concurrent queries
// ============================================================

async function enqueue(ctx: Context, handler: () => Promise<void>): Promise<void> {
  if (processing) {
    messageQueue.push({ ctx, handler });
    await ctx.reply("Working on something right now. I'll get to this next.").catch(() => {});
    return;
  }
  processing = true;
  try {
    await handler();
  } finally {
    processing = false;
    const next = messageQueue.shift();
    if (next) {
      enqueue(next.ctx, next.handler);
    }
  }
}

// ============================================================
// TEXT-TO-SPEECH — ElevenLabs for driving mode
// ============================================================

async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;
  try {
    const cleanText = text
      .replace(/💙\s*/g, "")
      .replace(/[*_~`#]/g, "")
      .replace(/\[.*?\]\(.*?\)/g, "")
      .replace(/\n{2,}/g, ". ")
      .trim();
    if (!cleanText) return null;

    const speechText = cleanText.substring(0, 4500);
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: speechText,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!response.ok) {
      console.error(`ElevenLabs error: ${response.status}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error: any) {
    console.error("TTS error:", error.message);
    return null;
  }
}

// ============================================================
// SEND RESPONSE — handles Telegram 4096 char limit + driving mode
// ============================================================

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
  } else {
    let remaining = response;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        await ctx.reply(remaining);
        break;
      }
      let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = MAX_LENGTH;

      await ctx.reply(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }
  }

  // Driving mode: also send as voice note
  if (drivingMode && ELEVENLABS_API_KEY) {
    const audio = await textToSpeech(response);
    if (audio) {
      const voicePath = join(TEMP_DIR, `voice_${Date.now()}.mp3`);
      await writeFile(voicePath, audio);
      await ctx.replyWithVoice(new InputFile(voicePath));
      await unlink(voicePath).catch(() => {});
    }
  }
}

// ============================================================
// BOT SETUP
// ============================================================

if (!(await acquireLock("bot"))) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}
setupLockCleanup("bot");

process.on("SIGINT", async () => { await releaseLock("bot"); process.exit(0); });
process.on("SIGTERM", async () => { await releaseLock("bot"); process.exit(0); });

const bot = new Bot(BOT_TOKEN);

// Security: only respond to authorized user + rate limiting
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }
  if (isRateLimited()) {
    console.warn(`Rate limited: ${RATE_LIMIT_MAX} messages in ${RATE_LIMIT_WINDOW / 1000}s`);
    await ctx.reply("Slow down — too many messages. Try again in a minute.");
    return;
  }
  await next();
});

// ============================================================
// COMMAND HANDLERS
// ============================================================

// Stop — abort active query
bot.command("stop", async (ctx) => {
  if (abortController) {
    abortController.abort();
    abortController = null;
    activeQuery = null;
    processing = false;
    await ctx.reply("🛑 Stopped. What's next?");
  } else {
    await ctx.reply("Nothing running right now.");
  }
});

// New session — clear SDK session (Supabase memory persists)
bot.command("new", async (ctx) => {
  await appendDailyNote("telegram", "New session started via /new command");
  sessionId = null;
  tracker.reset();
  await clearSession();
  await ctx.reply("Fresh session started. Context reset to 0%. Supabase memory still intact.");
});

// Restart — spawn a new instance then exit
bot.command("restart", async (ctx) => {
  await appendSessionLog("telegram", "assistant", "[RELAY RESTART — session file preserved, agent will read back on startup]");
  await appendDailyNote("telegram", "Relay restarted via /restart command");
  await ctx.reply("Restarting... back in a few seconds.");
  // Stop polling BEFORE spawning the new instance to avoid 409 conflict
  await bot.stop();
  await releaseLock("bot");
  const child = Bun.spawn(["bun", "run", "src/relay.ts"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
});

// ============================================================
// BRAIN COMMANDS — use shared definitions from relay-core
// ============================================================

for (const cmd of SLASH_COMMANDS) {
  bot.command(cmd.name, async (ctx) => {
    const arg = ctx.match?.trim() || undefined;

    // Commands that require an arg
    if (cmd.name === "remember" && !arg) {
      await ctx.reply("Usage: /remember [thing to remember]");
      return;
    }
    if (cmd.name === "search" && !arg) {
      await ctx.reply("Usage: /search [query]");
      return;
    }

    const prompt = cmd.buildPrompt(arg);
    if (prompt) {
      await enqueue(ctx, () => callAgent(ctx, prompt));
    }
  });
}

// Terminal — handoff + clean sign-off for switching to terminal
bot.command("terminal", async (ctx) => {
  await appendDailyNote("telegram", "Switching from Telegram to terminal via /terminal");
  await enqueue(ctx, async () => {
    await callAgent(ctx, `The user is switching to terminal now. Write a handoff summary to ${CLAWDIA_DIR}/memory/HANDOFF.md — what we discussed, what's open, what needs follow-up. Keep it brief. Append, don't overwrite. End with a short goodbye.`);
    await appendSessionLog("telegram", "assistant", "[CHANNEL SWITCH — Telegram → Terminal]");
  });
});

// Status — system status
bot.command("status", async (ctx) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const mem = process.memoryUsage();
  const mbUsed = Math.round(mem.rss / 1024 / 1024);
  const ctxUsed = tracker.usedPct();
  const ctxBar = tracker.progressBar(ctxUsed);
  await ctx.reply(
    `📊 Relay Status\n` +
    `Model: ${currentModel}\n` +
    `Session: ${sessionId ? sessionId.substring(0, 8) + "..." : "none"}\n` +
    `Context: ${ctxBar} ${ctxUsed}%\n` +
    `Uptime: ${hours}h ${mins}m\n` +
    `Memory: ${mbUsed}MB\n` +
    `Queue: ${messageQueue.length} pending\n` +
    `Driving mode: ${drivingMode ? "ON" : "OFF"}`
  );
});

// Help — list all commands
bot.command("help", async (ctx) => {
  await ctx.reply(
    `Commands\n\n` +
    `🧠 Brain\n` +
    `/goals — check goals & progress\n` +
    `/agenda — today's priorities\n` +
    `/tasks — outstanding tasks\n` +
    `/projects [name] — project status\n` +
    `/people [name] — look up a contact\n` +
    `/budget — financial snapshot\n` +
    `/journal [entry] — read or write journal\n` +
    `/search [query] — search everything\n` +
    `/remember [fact] — save to memory\n` +
    `/handoff — write channel handoff\n` +
    `/terminal — handoff & switch to terminal\n\n` +
    `⚙️ System\n` +
    `/model opus|sonnet|haiku — switch model\n` +
    `/drive — toggle voice replies\n` +
    `/stream — toggle tool use streaming\n` +
    `/new — fresh session\n` +
    `/stop — abort current task\n` +
    `/restart — restart relay\n` +
    `/status — system info`
  );
});

// Driving mode toggle
bot.command("drive", async (ctx) => {
  drivingMode = !drivingMode;
  if (drivingMode && !ELEVENLABS_API_KEY) {
    drivingMode = false;
    await ctx.reply("Driving mode needs ELEVENLABS_API_KEY in .env");
    return;
  }
  await ctx.reply(drivingMode ? "🚗 Driving mode ON — I'll voice note you" : "🚗 Driving mode OFF — back to text");
});

// Model switching
bot.command("model", async (ctx) => {
  const arg = ctx.match?.trim().toLowerCase();
  if (arg === "opus") {
    currentModel = "claude-opus-4-6";
    await ctx.reply("🧠 Switched to Opus 4.6 — deep work mode");
  } else if (arg === "sonnet") {
    currentModel = "claude-sonnet-4-6";
    await ctx.reply("⚡ Switched to Sonnet 4.6 — fast mode");
  } else if (arg === "haiku") {
    currentModel = "claude-haiku-4-5-20251001";
    await ctx.reply("🌸 Switched to Haiku 4.5 — quick replies");
  } else {
    await ctx.reply(`Current model: ${currentModel}\n\nSwitch: /model opus | sonnet | haiku`);
  }
});

// Tool stream toggle
bot.command("stream", async (ctx) => {
  toolStream = !toolStream;
  await ctx.reply(toolStream ? "🔧 Tool streaming ON" : "🔇 Tool streaming OFF");
});

// ============================================================
// TEXT MESSAGES
// ============================================================

bot.on("message:text", async (ctx) => {
  let text = ctx.message.text;
  const lower = text.toLowerCase().trim();

  // Quick commands that don't need the SDK
  if (lower === "stop" || lower === "cancel" || lower === "nevermind" || lower === "nvm" || lower === "abort" || lower === "kill it") {
    if (abortController) {
      abortController.abort();
      abortController = null;
      activeQuery = null;
      processing = false;
      await ctx.reply("🛑 Stopped. What's next?");
    } else {
      await ctx.reply("Nothing running right now.");
    }
    return;
  }

  if (/\b(driv(e|ing)\s*mode\s*on|voice\s*mode\s*on|start\s*driv(e|ing))\b/.test(lower)) {
    if (!ELEVENLABS_API_KEY) { await ctx.reply("Driving mode needs ELEVENLABS_API_KEY in .env"); return; }
    drivingMode = true;
    await ctx.reply("🚗 Driving mode ON — I'll voice note you");
    return;
  }
  if (/\b(driv(e|ing)\s*mode\s*off|voice\s*mode\s*off|stop\s*driv(e|ing))\b/.test(lower)) {
    drivingMode = false;
    await ctx.reply("🚗 Driving mode OFF — back to text");
    return;
  }

  // Model switching — flexible natural language detection
  if (/\b(switch\s+to\s+|use\s+|go\s+)?opus\b/i.test(lower) || /\bdeep\s*mode\s*(on)?\b/.test(lower)) {
    currentModel = "claude-opus-4-6";
    await ctx.reply("🧠 Switched to Opus 4.6 — deep work mode");
    return;
  }
  if (/\b(switch\s+to\s+|use\s+|go\s+)?sonnet\b/i.test(lower) || /\bfast\s*mode\s*(on)?\b/.test(lower) || lower === "deep mode off") {
    currentModel = "claude-sonnet-4-6";
    await ctx.reply("⚡ Switched to Sonnet 4.6 — fast mode");
    return;
  }
  if (/\b(switch\s+to\s+|use\s+|go\s+)?haiku\b/i.test(lower)) {
    currentModel = "claude-haiku-4-5-20251001";
    await ctx.reply("🌸 Switched to Haiku 4.5 — quick replies");
    return;
  }
  if (/\b(what|which|current)\s*model\b/.test(lower)) {
    await ctx.reply(`Currently using: ${currentModel}`);
    return;
  }

  console.log(`Message: ${text.substring(0, 80)}...`);
  await writeFile(join(RELAY_DIR, "last-activity"), Date.now().toString()).catch(() => {});

  // Forwarded message context
  const fwd = ctx.message.forward_origin;
  if (fwd) {
    let from = "someone";
    if (fwd.type === "user" && fwd.sender_user) {
      from = fwd.sender_user.first_name + (fwd.sender_user.last_name ? ` ${fwd.sender_user.last_name}` : "");
    } else if (fwd.type === "hidden_user" && fwd.sender_user_name) {
      from = fwd.sender_user_name;
    } else if (fwd.type === "channel" && fwd.chat) {
      from = fwd.chat.title || "a channel";
    } else if (fwd.type === "chat" && fwd.sender_chat) {
      from = fwd.sender_chat.title || "a chat";
    }
    from = sanitizeExternal(from).substring(0, 100);
    const fwdDate = fwd.date ? new Date(fwd.date * 1000).toLocaleString() : "";
    text = `[Forwarded message from ${from}${fwdDate ? ` on ${fwdDate}` : ""}]:\n${sanitizeExternal(text)}`;
  }

  // Reply context — extract quoted message so the agent can reference it
  const reply = ctx.message.reply_to_message;
  if (reply) {
    const replyText = (reply as any).text || (reply as any).caption || "";
    if (replyText) {
      const quoted = sanitizeExternal(replyText.substring(0, 1000));
      text = `[The user is replying to this specific message you sent: "${quoted}"]\n\nTheir reply: ${text}`;
      console.log(`Reply context detected: "${quoted.substring(0, 60)}..."`);
    } else {
      console.log("Reply detected but no text/caption in quoted message");
    }
  }

  // Feedback signal detection
  const signals = detectSignals(text);
  if (signals.length > 0) {
    const snapshot: ContextSnapshot = {
      sessionId: sessionId || undefined,
      model: currentModel,
    };
    recordSignals(supabase, signals, snapshot).catch(() => {});
  }

  await enqueue(ctx, () => callAgent(ctx, text));
});

// ============================================================
// VOICE MESSAGES
// ============================================================

bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await writeFile(join(RELAY_DIR, "last-activity"), Date.now().toString()).catch(() => {});

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply("Voice transcription is not set up yet. Run setup and choose a voice provider.");
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await ctx.reply(`🎙️ "${transcription}"`);

    let voiceText = `[Voice note from user, ${voice.duration}s — transcription]: "${transcription}"`;

    // Reply context on voice
    const voiceReply = ctx.message.reply_to_message;
    if (voiceReply) {
      const voiceReplyText = (voiceReply as any).text || (voiceReply as any).caption || "";
      if (voiceReplyText) {
        const quoted = sanitizeExternal(voiceReplyText.substring(0, 1000));
        voiceText = `[The user is replying to this specific message you sent: "${quoted}"]\n\n${voiceText}`;
      }
    }

    voiceText += `\n\nIMPORTANT: Start your response by quoting the FULL transcription back in quotes so the user can verify you heard them correctly. Then respond.`;

    await enqueue(ctx, () => callAgent(ctx, voiceText));
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  }
});

// ============================================================
// PHOTOS
// ============================================================

bot.on("message:photo", async (ctx) => {
  console.log("Image received");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);
    const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    let caption = ctx.message.caption || "Analyze this image.";

    // Forwarded image context
    const imgFwd = ctx.message.forward_origin;
    if (imgFwd) {
      let imgFrom = "someone";
      if (imgFwd.type === "user" && imgFwd.sender_user) imgFrom = imgFwd.sender_user.first_name;
      else if (imgFwd.type === "channel" && imgFwd.chat) imgFrom = imgFwd.chat.title || "a channel";
      imgFrom = sanitizeExternal(imgFrom).substring(0, 100);
      caption = `[Forwarded image from ${imgFrom}] ${caption}`;
    }

    // Reply context on images
    const imgReply = ctx.message.reply_to_message;
    if (imgReply) {
      const imgReplyText = (imgReply as any).text || (imgReply as any).caption || "";
      if (imgReplyText) {
        caption = `[The user is replying to this specific message you sent: "${sanitizeExternal(imgReplyText.substring(0, 500))}"]\n\n${caption}`;
      }
    }

    const prompt = `[Image saved at: ${filePath}]\n\n${caption}`;

    await enqueue(ctx, async () => {
      await callAgent(ctx, prompt);
      await unlink(filePath).catch(() => {});
    });
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// ============================================================
// DOCUMENTS
// ============================================================

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);

  try {
    const file = await ctx.getFile();
    // Sanitize filename: strip path separators to prevent traversal
    const rawName = doc.file_name || `file_${Date.now()}`;
    const fileName = rawName.replace(/[/\\]/g, "_").replace(/^\.+/, "_");
    const filePath = join(KNOWLEDGE_DIR, fileName);

    const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    let caption = ctx.message.caption || `Read and remember this file: ${doc.file_name}`;

    const docFwd = ctx.message.forward_origin;
    if (docFwd) {
      let docFrom = "someone";
      if (docFwd.type === "user" && docFwd.sender_user) docFrom = docFwd.sender_user.first_name;
      else if (docFwd.type === "channel" && docFwd.chat) docFrom = docFwd.chat.title || "a channel";
      docFrom = sanitizeExternal(docFrom).substring(0, 100);
      caption = `[Forwarded from ${docFrom}] ${caption}`;
    }

    const docReply = ctx.message.reply_to_message;
    if (docReply) {
      const docReplyText = (docReply as any).text || (docReply as any).caption || "";
      if (docReplyText) {
        caption = `[The user is replying to this specific message you sent: "${sanitizeExternal(docReplyText.substring(0, 500))}"]\n\n${caption}`;
      }
    }

    const prompt =
      `[File saved to knowledge base: ${filePath}]\n\n${caption}\n\n` +
      `Instructions: Read the file, extract key information, and save a summary to memory. ` +
      `The original file is kept permanently at ${filePath}.`;

    await enqueue(ctx, () => callAgent(ctx, prompt));
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// CALLBACK QUERIES — approval buttons
// ============================================================

bot.on("callback_query:data", async (ctx) => {
  // Only the authorized user can press approval buttons
  const presserId = ctx.callbackQuery.from?.id?.toString();
  if (ALLOWED_USER_ID && presserId !== ALLOWED_USER_ID) {
    await ctx.answerCallbackQuery({ text: "Not authorized" });
    return;
  }

  const data = ctx.callbackQuery.data;
  const match = data.match(/^(approve|reject)_(.+)$/);
  if (!match) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  const [, action, id] = match;
  const pending = pendingApprovals.get(id);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Expired" });
    return;
  }

  clearTimeout(pending.timer);
  pendingApprovals.delete(id);
  pending.resolve(action === "approve");

  const emoji = action === "approve" ? "✅" : "❌";
  await ctx.answerCallbackQuery({ text: `${emoji} ${action === "approve" ? "Approved" : "Rejected"}` });
  await ctx.editMessageText(`${emoji} ${action === "approve" ? "Approved" : "Rejected"}`).catch(() => {});

  // Record feedback signal
  const snapshot: ContextSnapshot = { sessionId: sessionId || undefined, model: currentModel };
  const signal = action === "approve" ? actionApprovedSignal() : actionRejectedSignal();
  recordSignals(supabase, [signal], snapshot).catch(() => {});
});

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay (SDK Edition)...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Brain directory: ${CLAWDIA_DIR}`);
console.log(`Default model: ${currentModel}`);
if (sessionId) console.log(`Resuming session: ${sessionId}`);

bot.start({
  drop_pending_updates: true,
  onStart: () => {
    console.log("Bot is running! (old queued messages dropped)");
  },
});

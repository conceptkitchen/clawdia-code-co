/**
 * Claude Transcript Sync — Reads raw `claude` CLI session JSONL
 * from ~/.claude/projects/ and syncs to Supabase + local files.
 *
 * This catches conversations from running `claude` directly in
 * project folders (~/my-agent, ~/repos/my-project, etc.)
 * that would otherwise never reach the feedback pipeline.
 *
 * Run manually: bun run sync
 * Auto: launchd runs every 5 minutes
 */

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import {
  HOME, RELAY_DIR,
  appendSessionLog,
  createSupabaseClient, saveMessage,
  processMemoryIntents,
  detectSignals, recordSignals,
  type ContextSnapshot,
} from "./relay-core.ts";

// ============================================================
// PATHS
// ============================================================

const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");
const SYNC_STATE_FILE = join(RELAY_DIR, "sync-state.json");

// ============================================================
// SYNC STATE — track last-synced position per file
// ============================================================

interface SyncState {
  [filePath: string]: {
    lastLine: number;
    lastTimestamp: string;
  };
}

async function loadSyncState(): Promise<SyncState> {
  try {
    return JSON.parse(await readFile(SYNC_STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveSyncState(state: SyncState): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true });
  await writeFile(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// PROJECT NAME DETECTION
// ============================================================

function projectFromDirName(dirName: string): string {
  // "-Users-username-my-agent-relay" → "my-agent-relay"
  // "-Users-username-my-agent" → "my-agent"
  // "-Users-username" → "home"
  const parts = dirName.split("-");
  // Find the user segment pattern: "-Users-{username}-..."
  // Skip leading empty string and "Users", "username" segments
  const userIdx = parts.indexOf("Users");
  if (userIdx >= 0 && userIdx + 2 < parts.length) {
    const projectParts = parts.slice(userIdx + 2);
    return projectParts.join("-") || "home";
  }
  return dirName || "unknown";
}

// ============================================================
// SECRET REDACTION
// ============================================================

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,                    // OpenAI / Anthropic keys
  /\bghp_[a-zA-Z0-9]{36,}\b/g,                      // GitHub personal access tokens
  /\bgho_[a-zA-Z0-9]{36,}\b/g,                      // GitHub OAuth tokens
  /\bghs_[a-zA-Z0-9]{36,}\b/g,                      // GitHub App tokens
  /\bxoxb-[a-zA-Z0-9-]+\b/g,                        // Slack bot tokens
  /\bxoxp-[a-zA-Z0-9-]+\b/g,                        // Slack user tokens
  /\bAKIA[A-Z0-9]{16}\b/g,                           // AWS access key IDs
  /\beyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/g, // JWTs
  /\bsbp_[a-zA-Z0-9]{20,}\b/g,                      // Supabase tokens
  /\bglpat-[a-zA-Z0-9_-]{20,}\b/g,                  // GitLab PATs
  /\bnpm_[a-zA-Z0-9]{36,}\b/g,                       // npm tokens
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ============================================================
// JSONL LINE PARSING
// ============================================================

interface ParsedMessage {
  type: "user_text" | "assistant_text";
  text: string;
  timestamp: string;
  sessionId: string;
}

function parseLine(line: string): ParsedMessage | null {
  try {
    const d = JSON.parse(line);

    // Skip non-message types
    const skipTypes = new Set([
      "file-history-snapshot", "progress", "queue-operation", "system",
    ]);
    if (skipTypes.has(d.type)) return null;

    const msg = d.message;
    if (!msg) return null;
    const timestamp = d.timestamp || new Date().toISOString();
    const sessionId = d.sessionId || "";

    // User message with string content (the actual typed message)
    if (d.type === "user" && msg.role === "user" && typeof msg.content === "string") {
      return { type: "user_text", text: msg.content, timestamp, sessionId };
    }

    // Assistant message with text blocks
    if (d.type === "assistant" && msg.role === "assistant" && Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text);
      if (textParts.length > 0) {
        return { type: "assistant_text", text: textParts.join(""), timestamp, sessionId };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// SYNC ONE FILE
// ============================================================

async function syncFile(
  filePath: string,
  project: string,
  state: SyncState,
  supabase: ReturnType<typeof createSupabaseClient>,
): Promise<number> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  const fileKey = filePath;
  const lastLine = state[fileKey]?.lastLine || 0;

  if (lastLine >= lines.length) return 0;

  let synced = 0;
  // Buffer assistant texts to deduplicate streaming updates
  // The JSONL contains multiple assistant lines per turn as the response builds up.
  // We only want the longest (final) text per session turn.
  let lastAssistantText = "";
  let lastAssistantTimestamp = "";
  let lastAssistantSessionId = "";

  const flushAssistant = async () => {
    if (!lastAssistantText) return;
    // Redact secrets + process memory intents
    const redacted = redactSecrets(lastAssistantText);
    const cleaned = await processMemoryIntents(supabase, redacted);
    await saveMessage(supabase, "assistant", cleaned, "claude-cli");
    await appendSessionLog("claude-cli", "assistant", cleaned);
    lastAssistantText = "";
    synced++;
  };

  for (let i = lastLine; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (!parsed) continue;

    if (parsed.type === "user_text") {
      // Flush any pending assistant message first
      await flushAssistant();

      const redactedUserText = redactSecrets(parsed.text);
      await saveMessage(supabase, "user", redactedUserText, "claude-cli");
      await appendSessionLog("claude-cli", "user", redactedUserText);

      // Feedback signals
      const signals = detectSignals(parsed.text);
      if (signals.length > 0) {
        const snapshot: ContextSnapshot = {
          sessionId: parsed.sessionId || undefined,
          model: "claude-opus-4-6", // CLI default
        };
        await recordSignals(supabase, signals, snapshot);
      }
      synced++;
    } else if (parsed.type === "assistant_text") {
      // Track the longest assistant text for this turn
      // JSONL streams multiple assistant lines — later ones are longer (appended to)
      if (parsed.text.length >= lastAssistantText.length) {
        lastAssistantText = parsed.text;
        lastAssistantTimestamp = parsed.timestamp;
        lastAssistantSessionId = parsed.sessionId;
      } else {
        // Text got shorter → new turn. Flush the old one.
        await flushAssistant();
        lastAssistantText = parsed.text;
        lastAssistantTimestamp = parsed.timestamp;
        lastAssistantSessionId = parsed.sessionId;
      }
    }
  }

  // Flush final assistant message
  await flushAssistant();

  // Update state
  state[fileKey] = {
    lastLine: lines.length,
    lastTimestamp: new Date().toISOString(),
  };

  return synced;
}

// ============================================================
// MAIN SYNC
// ============================================================

async function main() {
  const supabase = createSupabaseClient();
  const state = await loadSyncState();

  let totalSynced = 0;
  let filesProcessed = 0;

  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);

    for (const dir of projectDirs) {
      // Skip subagent dirs
      if (dir === "subagents") continue;

      const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
      const dirStat = await stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const project = projectFromDirName(dir);
      const files = await readdir(dirPath);

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const filePath = join(dirPath, file);

        // Skip if file hasn't changed since last sync
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        const fileKey = filePath;
        const lastSync = state[fileKey]?.lastTimestamp;
        if (lastSync) {
          const lastSyncTime = new Date(lastSync).getTime();
          // If file was modified before our last sync, skip
          if (fileStat.mtimeMs < lastSyncTime) continue;
        }

        try {
          const synced = await syncFile(filePath, project, state, supabase);
          if (synced > 0) {
            console.log(`Synced ${synced} messages from ${project}/${file}`);
            totalSynced += synced;
          }
          filesProcessed++;
        } catch (err: any) {
          console.error(`Error syncing ${filePath}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log("No Claude projects directory found — nothing to sync.");
      return;
    }
    throw err;
  }

  await saveSyncState(state);

  if (totalSynced > 0) {
    console.log(`Done — synced ${totalSynced} messages from ${filesProcessed} files.`);
  }
}

main().catch((err) => {
  console.error("Sync error:", err.message);
  process.exit(1);
});

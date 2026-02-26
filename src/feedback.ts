/**
 * Feedback Loop — Context Engineering Signal Detection
 *
 * Detects interaction quality signals from user messages and action outcomes.
 * Stores them in Supabase for weekly reflection and prompt tuning.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

// ============================================================
// SIGNAL DETECTION HEURISTICS
// ============================================================

interface Signal {
  type: string;
  source: string;
  value: number;
  notes: string;
}

// Positive signals — user is happy, engaged, or following up
const POSITIVE_PATTERNS: [RegExp, string][] = [
  [/\b(thanks|thank you|thx|ty|appreciate|great job|perfect|love it|nice|awesome|exactly)\b/i, "gratitude/praise"],
  [/\b(yes|yeah|yep|correct|right|that's it|bingo|spot on)\b/i, "confirmation"],
  [/\b(let's do|go ahead|sounds good|do it|ship it|approved|let's go)\b/i, "approval/momentum"],
  [/\b(this is (great|perfect|exactly|helpful))\b/i, "explicit praise"],
];

// Negative signals — user is frustrated, correcting, or repeating
const NEGATIVE_PATTERNS: [RegExp, string][] = [
  [/\b(no|nope|wrong|that's not|incorrect|not what i|you got it wrong)\b/i, "correction/rejection"],
  [/\b(i (already|just) (said|told|asked|mentioned))\b/i, "repetition frustration"],
  [/\b(stop|don't|quit|enough|never mind|forget it|nvm)\b/i, "frustration/abort"],
  [/\b(is this true|are you sure|that doesn't sound right|i thought)\b/i, "doubt/verification"],
];

// Context miss signals — the agent should have known this
const CONTEXT_MISS_PATTERNS: [RegExp, string][] = [
  [/\b(i told you|we discussed|remember when|you should know|i already)\b/i, "memory gap"],
  [/\b(check (my|the) (files?|notes?|memory|goals?))\b/i, "explicit context request"],
  [/\b(you forgot|did you forget|don't you remember)\b/i, "forgotten context"],
];

export function detectSignals(userMessage: string): Signal[] {
  const signals: Signal[] = [];
  const msg = userMessage.trim();

  // Skip very short messages (commands, toggles)
  if (msg.length < 5) return signals;

  for (const [pattern, note] of POSITIVE_PATTERNS) {
    if (pattern.test(msg)) {
      signals.push({ type: "positive", source: "text_heuristic", value: 0.5, notes: note });
      break; // One positive signal per message
    }
  }

  for (const [pattern, note] of NEGATIVE_PATTERNS) {
    if (pattern.test(msg)) {
      signals.push({ type: "negative", source: "text_heuristic", value: -0.5, notes: note });
      break;
    }
  }

  for (const [pattern, note] of CONTEXT_MISS_PATTERNS) {
    if (pattern.test(msg)) {
      signals.push({ type: "context_miss", source: "text_heuristic", value: -0.7, notes: note });
      break;
    }
  }

  // Engagement signal — long, detailed messages suggest the user is invested
  if (msg.length > 200) {
    signals.push({ type: "engagement", source: "text_heuristic", value: 0.3, notes: `long message (${msg.length} chars)` });
  }

  // Correction signal — message starts with "no" or "actually"
  if (/^(no[,.]?\s|actually[,.]?\s|wait[,.]?\s)/i.test(msg)) {
    signals.push({ type: "correction", source: "text_heuristic", value: -0.6, notes: "correction opener" });
  }

  return signals;
}

// ============================================================
// ACTION OUTCOME SIGNALS
// ============================================================

export function actionApprovedSignal(): Signal {
  return { type: "action_approved", source: "action_button", value: 0.8, notes: "user approved proposed action" };
}

export function actionRejectedSignal(): Signal {
  return { type: "action_rejected", source: "action_button", value: -0.8, notes: "user rejected proposed action" };
}

// ============================================================
// SAVE TO SUPABASE
// ============================================================

export interface ContextSnapshot {
  sessionId?: string;
  model: string;
  numTurns?: number;
  costUsd?: number;
}

// Local feedback log — backup so nothing is lost if Supabase is down
// {BRAIN_DIR}/feedback/signals/{date}.jsonl
import { CLAWDIA_DIR } from "./relay-core.ts";
const FEEDBACK_DIR = join(CLAWDIA_DIR, "feedback", "signals");

async function appendFeedbackLog(signals: Signal[], contextSnapshot: ContextSnapshot): Promise<void> {
  try {
    await mkdir(FEEDBACK_DIR, { recursive: true });
    const date = new Date().toLocaleDateString("en-CA", { timeZone: process.env.USER_TIMEZONE || "UTC" });
    const filePath = join(FEEDBACK_DIR, `${date}.jsonl`);
    const timestamp = new Date().toISOString();
    for (const s of signals) {
      const line = JSON.stringify({ timestamp, ...s, context: contextSnapshot });
      await appendFile(filePath, line + "\n");
    }
  } catch {
    // Best-effort — don't let local logging break anything
  }
}

export async function recordSignals(
  supabase: SupabaseClient | null,
  signals: Signal[],
  contextSnapshot: ContextSnapshot,
  messageId?: string
): Promise<void> {
  if (signals.length === 0) return;

  // Always save locally first — this is the backup
  await appendFeedbackLog(signals, contextSnapshot);

  if (!supabase) return;

  try {
    const rows = signals.map((s) => ({
      message_id: messageId || null,
      signal_type: s.type,
      signal_source: s.source,
      signal_value: s.value,
      context_loaded: contextSnapshot,
      notes: s.notes,
    }));

    const { error } = await supabase.from("feedback").insert(rows);
    if (error) console.error("Feedback insert error:", error.message);
    else console.log(`Recorded ${signals.length} feedback signal(s): ${signals.map(s => s.type).join(", ")}`);
  } catch (err: any) {
    console.error("Feedback recording error:", err.message);
  }
}

// ============================================================
// WEEKLY METRICS QUERY — used by reflection job
// ============================================================

export async function getWeeklyMetrics(supabase: SupabaseClient): Promise<{
  total: number;
  positive: number;
  negative: number;
  corrections: number;
  contextMisses: number;
  approvals: number;
  rejections: number;
  topNotes: string[];
} | null> {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("feedback")
      .select("signal_type, signal_value, notes")
      .gte("created_at", weekAgo);

    if (error || !data) return null;

    const metrics = {
      total: data.length,
      positive: data.filter((r) => r.signal_type === "positive" || r.signal_type === "engagement").length,
      negative: data.filter((r) => r.signal_type === "negative").length,
      corrections: data.filter((r) => r.signal_type === "correction").length,
      contextMisses: data.filter((r) => r.signal_type === "context_miss").length,
      approvals: data.filter((r) => r.signal_type === "action_approved").length,
      rejections: data.filter((r) => r.signal_type === "action_rejected").length,
      topNotes: [] as string[],
    };

    // Most frequent negative notes (what keeps going wrong)
    const negNotes = data
      .filter((r) => r.signal_value < 0)
      .map((r) => r.notes)
      .filter(Boolean);
    const noteCounts = new Map<string, number>();
    for (const note of negNotes) {
      noteCounts.set(note, (noteCounts.get(note) || 0) + 1);
    }
    metrics.topNotes = [...noteCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([note, count]) => `${note} (${count}x)`);

    return metrics;
  } catch {
    return null;
  }
}

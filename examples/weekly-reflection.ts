/**
 * Weekly Reflection — Feedback Loop Analysis
 *
 * Runs once per week (Sunday 8 AM). Analyzes interaction signals
 * from the past 7 days, generates insights via Claude, and stores
 * a metrics snapshot for tracking prompt quality over time.
 *
 * Run manually: bun run examples/weekly-reflection.ts
 * Schedule: bun run setup:launchd -- --service all
 */

import { spawn } from "bun";
import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getWeeklyMetrics } from "../src/feedback.ts";

const HOME = process.env.HOME || "";
const BRAIN_DIR = process.env.BRAIN_DIR || join(HOME, "clawdia");
const WEEKLY_DIR = join(BRAIN_DIR, "feedback", "weekly");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// CLAUDE HELPER
// ============================================================

async function askClaude(prompt: string): Promise<string> {
  try {
    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return "";
    return output.trim();
  } catch {
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!supabase) {
    console.log("Supabase not configured, skipping reflection");
    return;
  }

  console.log("Running weekly reflection...");
  const metrics = await getWeeklyMetrics(supabase);

  if (!metrics || metrics.total === 0) {
    console.log("No feedback signals this week, skipping");
    return;
  }

  // Calculate key ratios
  const positiveRate = metrics.total > 0 ? Math.round((metrics.positive / metrics.total) * 100) : 0;
  const approvalRate = (metrics.approvals + metrics.rejections) > 0
    ? Math.round((metrics.approvals / (metrics.approvals + metrics.rejections)) * 100)
    : 100;

  // Build reflection prompt for Claude
  const reflectionPrompt = `You are an AI assistant analyzing your own interaction quality with the user this week.

WEEKLY METRICS:
- Total signals detected: ${metrics.total}
- Positive signals: ${metrics.positive} (${positiveRate}%)
- Negative signals: ${metrics.negative}
- Corrections from the user: ${metrics.corrections}
- Context misses (should have known): ${metrics.contextMisses}
- Action approvals: ${metrics.approvals}
- Action rejections: ${metrics.rejections}
- Action approval rate: ${approvalRate}%
- Top issues: ${metrics.topNotes.join(", ") || "none"}

Based on these metrics, write a brief reflection (under 1500 chars) that:
1. Highlights what went well (high approval rate, low corrections, etc.)
2. Identifies patterns in what went wrong (repeated corrections, context misses)
3. Suggests 1-2 specific prompt or behavior changes to improve next week
4. Gives yourself an honest score out of 10

Start with 💙 and be honest with yourself. This goes to the user on Telegram.`;

  const reflection = await askClaude(reflectionPrompt);

  if (reflection) {
    await sendTelegram(reflection);
    console.log("Reflection sent to Telegram");
  }

  // Save metrics snapshot
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekLabel = now.toISOString().split("T")[0]; // e.g. 2026-02-22

  // Save locally to {BRAIN_DIR}/feedback/weekly/{date}.md
  try {
    await mkdir(WEEKLY_DIR, { recursive: true });
    const localReport =
      `# Weekly Reflection — ${weekLabel}\n\n` +
      `**Period:** ${weekAgo.toISOString().split("T")[0]} → ${weekLabel}\n\n` +
      `## Metrics\n` +
      `- Total signals: ${metrics.total}\n` +
      `- Positive: ${metrics.positive} (${positiveRate}%)\n` +
      `- Negative: ${metrics.negative}\n` +
      `- Corrections: ${metrics.corrections}\n` +
      `- Context misses: ${metrics.contextMisses}\n` +
      `- Action approvals: ${metrics.approvals}\n` +
      `- Action rejections: ${metrics.rejections}\n` +
      `- Approval rate: ${approvalRate}%\n` +
      `- Top issues: ${metrics.topNotes.join(", ") || "none"}\n\n` +
      `## Reflection\n\n${reflection || "(no reflection generated)"}\n`;

    await writeFile(join(WEEKLY_DIR, `${weekLabel}.md`), localReport);
    console.log(`Local report saved: ${WEEKLY_DIR}/${weekLabel}.md`);
  } catch (err: any) {
    console.error("Local report save error:", err.message);
  }

  // Save to Supabase
  try {
    const { error } = await supabase.from("prompt_metrics").insert({
      period_start: weekAgo.toISOString(),
      period_end: now.toISOString(),
      total_interactions: metrics.total,
      positive_signals: metrics.positive,
      negative_signals: metrics.negative,
      corrections: metrics.corrections,
      action_approval_rate: approvalRate / 100,
      context_sections_loaded: { top_issues: metrics.topNotes },
      insights: reflection?.substring(0, 2000) || "",
    });

    if (error) console.error("Metrics save error:", error.message);
    else console.log("Metrics snapshot saved to Supabase");
  } catch (err: any) {
    console.error("Metrics save error:", err.message);
  }
}

main().catch(console.error);

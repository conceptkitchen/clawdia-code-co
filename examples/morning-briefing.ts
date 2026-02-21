/**
 * Morning Briefing — AI Agent
 *
 * Sends 3 Telegram messages:
 *   1. 💙 ☀️ Morning Briefing — Oura scores, calendar, goals, yesterday recap
 *   2. 💙 📋 Daily Agenda — Claude-generated top 3 priorities
 *   3. 💙 📰 Trend Report — AI/tech news via Claude web search
 *
 * Schedule: 6:30 AM via launchd (see setup/configure-launchd.ts)
 * Manual:   bun run examples/morning-briefing.ts
 */

import { spawn } from "bun";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  getOuraSleep,
  getOuraReadiness,
  getOuraActivity,
  getCalendarEvents,
  getActiveGoals,
} from "../src/data-sources.ts";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

async function saveAgenda(content: string): Promise<void> {
  const dir = join(RELAY_DIR, "memory", "agenda");
  await mkdir(dir, { recursive: true });
  const today = new Date().toISOString().split("T")[0];
  await writeFile(join(dir, `${today}.md`), `# Daily Agenda — ${today}\n\n${content}\n`);
}

async function saveTrendReport(content: string): Promise<void> {
  const dir = join(RELAY_DIR, "memory", "trend-reports");
  await mkdir(dir, { recursive: true });
  const today = new Date().toISOString().split("T")[0];
  await writeFile(join(dir, `${today}.md`), `# Trend Report — ${today}\n\n${content}\n`);
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

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
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// MESSAGE 1: MORNING BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];
  sections.push(`💙 ☀️ *Morning Briefing*\n${dateStr}\n`);

  // Oura health data
  try {
    const [sleepData, readiness, activity] = await Promise.all([
      getOuraSleep(),
      getOuraReadiness(),
      getOuraActivity(),
    ]);
    sections.push(`🛌 ${sleepData}`);
    sections.push(`⚡ ${readiness}`);
    sections.push(`🏃 ${activity}\n`);
  } catch (e) {
    console.error("Oura fetch failed:", e);
  }

  // Calendar
  try {
    const calendar = await getCalendarEvents();
    sections.push(`📅 *Today's Schedule*\n${calendar}\n`);
  } catch (e) {
    console.error("Calendar fetch failed:", e);
  }

  // Active goals
  try {
    const goals = await getActiveGoals();
    if (goals.length) {
      sections.push(`🎯 *Active Goals*\n${goals.map((g) => `- ${g}`).join("\n")}\n`);
    }
  } catch (e) {
    console.error("Goals fetch failed:", e);
  }

  return sections.join("\n");
}

// ============================================================
// MESSAGE 2: DAILY AGENDA
// ============================================================

async function buildAgenda(): Promise<string> {
  const calendar = await getCalendarEvents();
  const goals = await getActiveGoals();

  const prompt = `You are a personal AI assistant. Based on today's calendar and active goals, generate the top 3 priorities for today. Be specific and actionable. No exclamation points. No em dashes. Keep it brief.

Calendar:
${calendar}

Active Goals:
${goals.length ? goals.map((g) => `- ${g}`).join("\n") : "None set"}

Respond with just the 3 priorities, numbered 1-3. One sentence each.`;

  const priorities = await askClaude(prompt);
  const agendaContent = priorities || "Could not generate agenda";
  await saveAgenda(agendaContent);
  return `💙 📋 *Daily Agenda*\n\n${agendaContent}`;
}

// ============================================================
// MESSAGE 3: TREND REPORT
// ============================================================

async function buildTrendReport(): Promise<string> {
  const prompt = `You are a personal AI assistant. Search for the most important AI and tech news from today or yesterday. Give a brief 3-5 bullet summary of what matters. Focus on: AI model releases, cybersecurity developments, developer tools, and anything relevant to someone building AI-powered products and transitioning into cybersecurity. No exclamation points. No em dashes. Keep each bullet to one sentence.`;

  const trends = await askClaude(prompt);
  const trendsContent = trends || "Could not fetch trends";
  await saveTrendReport(trendsContent);
  return `💙 📰 *Trend Report*\n\n${trendsContent}`;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  // Message 1: Morning Briefing
  const briefing = await buildBriefing();
  console.log("Sending briefing...");
  const ok1 = await sendTelegram(briefing);
  if (!ok1) console.error("Failed to send briefing");

  await sleep(2000);

  // Message 2: Daily Agenda
  console.log("Generating agenda...");
  const agenda = await buildAgenda();
  console.log("Sending agenda...");
  const ok2 = await sendTelegram(agenda);
  if (!ok2) console.error("Failed to send agenda");

  await sleep(2000);

  // Message 3: Trend Report
  console.log("Generating trend report...");
  const trends = await buildTrendReport();
  console.log("Sending trend report...");
  const ok3 = await sendTelegram(trends);
  if (!ok3) console.error("Failed to send trend report");

  const sent = [ok1, ok2, ok3].filter(Boolean).length;
  console.log(`Done. ${sent}/3 messages sent.`);
  if (sent < 3) process.exit(1);
}

main();

/**
 * Smart Check-in — AI Agent
 *
 * Runs every 15 minutes (6 AM - 11 PM). Checks priority order:
 *   1. Routine check-in (morning/midday/evening window)
 *   2. Meal nudge (10am/3pm/7pm/9pm)
 *   3. Oura stress alert (if stress is high)
 *   4. Meeting reminder (event within 35 min)
 *
 * Exits after first send. State persists in ~/.claude-relay/heartbeat-state.json.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  loadState,
  saveState,
  getCurrentCheckinWindow,
  getMealNudgeSlot,
} from "../src/state.ts";
import {
  getOuraStress,
  getUpcomingEvents,
  getCalendarEvents,
  getActiveGoals,
  getOuraSleep,
  getOuraReadiness,
} from "../src/data-sources.ts";

const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
const ACTIVE_SESSION_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

async function isActiveSession(): Promise<boolean> {
  try {
    const ts = await readFile(join(RELAY_DIR, "last-activity"), "utf-8");
    const lastActivity = parseInt(ts.trim());
    return Date.now() - lastActivity < ACTIVE_SESSION_COOLDOWN_MS;
  } catch {
    return false; // No activity file = no active session
  }
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
// CHECK-IN PROMPTS BY WINDOW
// ============================================================

const WINDOW_PROMPTS: Record<string, string> = {
  morning: `You are a personal AI assistant checking in with the user in the morning. Ask about one or two of these: morning exercise, meditation, getting sunlight, or a quick win to start the day. Be warm, brief, direct. No exclamation points. No em dashes. Start with 💙. One short message, 2-3 sentences max.`,
  midday: `You are a personal AI assistant checking in with the user at midday. Ask about one or two of these: hydration, gym session, lunch, or afternoon energy. Be warm, brief, direct. No exclamation points. No em dashes. Start with 💙. One short message, 2-3 sentences max.`,
  evening: `You are a personal AI assistant checking in with the user in the evening. Ask about one or two of these: journaling, cold shower, gratitude practice, or how he'd rate his day 1-10. Be warm, brief, direct. No exclamation points. No em dashes. Start with 💙. One short message, 2-3 sentences max.`,
};

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running smart check-in...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  // Don't interrupt active conversations
  if (await isActiveSession()) {
    console.log("Active session detected (< 15 min since last message). Skipping check-in.");
    return;
  }

  const state = await loadState();
  let sent = false;

  // --- Priority 1: Routine check-in ---
  const window = getCurrentCheckinWindow();
  if (window && !state.routineCheckins[window]) {
    console.log(`Routine check-in: ${window}`);

    // Gather context for a richer prompt
    const [sleep, readiness, goals, calendar] = await Promise.all([
      getOuraSleep(),
      getOuraReadiness(),
      getActiveGoals(),
      getCalendarEvents(),
    ]);

    const contextPrompt = `${WINDOW_PROMPTS[window]}

Context (use lightly, don't dump all of this):
- ${sleep}
- ${readiness}
- Calendar: ${calendar}
- Goals: ${goals.length ? goals.join(", ") : "none set"}`;

    const message = await askClaude(contextPrompt);
    if (message) {
      sent = await sendTelegram(message);
      if (sent) {
        state.routineCheckins[window] = true;
        console.log(`Sent ${window} check-in`);
      }
    }
  }

  // --- Priority 2: Meal nudge ---
  if (!sent) {
    const mealSlot = getMealNudgeSlot();
    if (mealSlot && !state.mealNudges[mealSlot]) {
      console.log(`Meal nudge: ${mealSlot}`);
      const message = await askClaude(
        `You are a personal AI assistant. Send a brief, warm meal/hydration nudge to the user. It's ${mealSlot}. ` +
          `Just a quick one-liner reminder to eat or hydrate. No exclamation points. No em dashes. Start with 💙.`
      );
      if (message) {
        sent = await sendTelegram(message);
        if (sent) {
          state.mealNudges[mealSlot] = true;
          console.log(`Sent ${mealSlot} meal nudge`);
        }
      }
    }
  }

  // --- Priority 3: Oura stress alert ---
  if (!sent) {
    try {
      const stress = await getOuraStress();
      if (stress.level === "high") {
        console.log("Stress alert triggered");
        const message = await askClaude(
          `You are a personal AI assistant. The user's Oura ring shows high stress levels right now. ` +
            `Send a brief, supportive check-in. Suggest a 2-minute break, breathing exercise, or stepping outside. ` +
            `No exclamation points. No em dashes. Start with 💙. Keep it to 2 sentences.`
        );
        if (message) {
          sent = await sendTelegram(message);
          if (sent) console.log("Sent stress alert");
        }
      }
    } catch (e) {
      console.error("Stress check failed:", e);
    }
  }

  // --- Priority 4: Meeting reminder ---
  if (!sent) {
    try {
      const upcoming = await getUpcomingEvents(35);
      if (upcoming) {
        // Check if we already reminded for this event text
        const eventKey = upcoming.substring(0, 50);
        if (!state.meetingReminders.includes(eventKey)) {
          console.log("Meeting reminder triggered");
          const message = `💙 Heads up, you have something coming up in the next 30 minutes:\n\n${upcoming}`;
          sent = await sendTelegram(message);
          if (sent) {
            state.meetingReminders.push(eventKey);
            console.log("Sent meeting reminder");
          }
        }
      }
    } catch (e) {
      console.error("Meeting check failed:", e);
    }
  }

  // Save state regardless
  await saveState(state);

  if (!sent) {
    console.log("No check-in needed");
  }
}

main();

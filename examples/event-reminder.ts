/**
 * Event Reminder — AI Agent
 *
 * Runs every 5 minutes via launchd. Checks the calendar and sends
 * Telegram reminders at two windows: ~30 min and ~10 min before each event.
 *
 * Independent of smart-checkin — meeting reminders always fire,
 * never suppressed by active sessions or other notifications.
 *
 * State persists in ~/.claude-relay/heartbeat-state.json (eventReminders).
 *
 * Run: bun run examples/event-reminder.ts
 */

import { loadState, saveState } from "../src/state.ts";
import { getUpcomingEventsStructured } from "../src/data-sources.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

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
// REMINDER WINDOWS
// ============================================================

const REMINDER_WINDOWS = [
  { label: "30min", threshold: 30, tolerance: 5 },
  { label: "10min", threshold: 10, tolerance: 5 },
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running event reminder check...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const state = await loadState();

  // Ensure eventReminders exists (backward compat with old state files)
  if (!state.eventReminders) {
    state.eventReminders = [];
  }

  // Fetch events starting within the next 35 minutes
  const events = await getUpcomingEventsStructured(35);

  if (events.length === 0) {
    console.log("No upcoming events in the next 35 minutes");
    await saveState(state);
    return;
  }

  const now = new Date();
  let sentCount = 0;

  for (const event of events) {
    const minutesUntil = (event.startTime.getTime() - now.getTime()) / (60 * 1000);

    for (const window of REMINDER_WINDOWS) {
      // Check if we're within this reminder window (threshold +/- tolerance)
      const lowerBound = window.threshold - window.tolerance;
      const upperBound = window.threshold + window.tolerance;

      if (minutesUntil >= lowerBound && minutesUntil <= upperBound) {
        const timeKey = formatTime(event.startTime);
        const stateKey = `${event.title}|${timeKey}|${window.label}`;

        if (state.eventReminders.includes(stateKey)) {
          console.log(`Already reminded: ${stateKey}`);
          continue;
        }

        const approxMinutes = Math.round(minutesUntil);
        const message = `\u{1F499} \u{1F4C5} ${event.title} starts in ~${approxMinutes} minutes`;

        const sent = await sendTelegram(message);
        if (sent) {
          state.eventReminders.push(stateKey);
          sentCount++;
          console.log(`Sent reminder: ${stateKey}`);
        }
      }
    }
  }

  await saveState(state);

  if (sentCount === 0) {
    console.log("No reminders needed right now");
  } else {
    console.log(`Sent ${sentCount} reminder(s)`);
  }
}

main();

/**
 * Heartbeat State Management
 *
 * Tracks daily check-in windows, meal nudges, meeting reminders,
 * and briefing status. Persists to ~/.claude-relay/heartbeat-state.json.
 * Auto-resets daily fields when the date changes.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = process.env.STATE_DIR || join(homedir(), ".claude-relay");
const STATE_FILE = join(STATE_DIR, "heartbeat-state.json");

// ============================================================
// TYPES
// ============================================================

interface RoutineCheckins {
  morning: boolean;   // 8-10 AM
  midday: boolean;    // 1-3 PM
  evening: boolean;   // 8-9 PM
}

interface MealNudges {
  "10am": boolean;
  "3pm": boolean;
  "7pm": boolean;
  "9pm": boolean;
}

export interface HeartbeatState {
  routineCheckins: RoutineCheckins;
  mealNudges: MealNudges;
  meetingReminders: string[];  // event IDs already reminded
  eventReminders: string[];    // keys like "Team Standup|09:30|30min"
  lastBriefing: string;        // ISO date of last briefing
  lastOuraUpdate: string;      // ISO timestamp
  lastAlive: string;           // ISO timestamp
  todayDate: string;           // YYYY-MM-DD, triggers daily reset
}

function freshState(): HeartbeatState {
  return {
    routineCheckins: { morning: false, midday: false, evening: false },
    mealNudges: { "10am": false, "3pm": false, "7pm": false, "9pm": false },
    meetingReminders: [],
    eventReminders: [],
    lastBriefing: "",
    lastOuraUpdate: "",
    lastAlive: new Date().toISOString(),
    todayDate: todayStr(),
  };
}

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: process.env.USER_TIMEZONE || "UTC" });
}

// ============================================================
// LOAD / SAVE
// ============================================================

export async function loadState(): Promise<HeartbeatState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    const state: HeartbeatState = JSON.parse(content);

    // Auto-reset daily fields when date changes
    if (state.todayDate !== todayStr()) {
      state.routineCheckins = { morning: false, midday: false, evening: false };
      state.mealNudges = { "10am": false, "3pm": false, "7pm": false, "9pm": false };
      state.meetingReminders = [];
      state.eventReminders = [];
      state.todayDate = todayStr();
    }

    return state;
  } catch {
    return freshState();
  }
}

export async function saveState(state: HeartbeatState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  state.lastAlive = new Date().toISOString();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CHECK-IN WINDOWS
// ============================================================

export type CheckinWindow = "morning" | "midday" | "evening";

export function getCurrentCheckinWindow(): CheckinWindow | null {
  const hour = new Date().getHours();

  if (hour >= 8 && hour < 10) return "morning";
  if (hour >= 13 && hour < 15) return "midday";
  if (hour >= 20 && hour < 21) return "evening";

  return null;
}

// ============================================================
// MEAL NUDGE SLOTS
// ============================================================

export type MealSlot = "10am" | "3pm" | "7pm" | "9pm";

export function getMealNudgeSlot(): MealSlot | null {
  const now = new Date();
  const hour = now.getHours();
  const min = now.getMinutes();
  const totalMin = hour * 60 + min;

  // Each slot has a 30-minute window
  if (totalMin >= 600 && totalMin < 630) return "10am";   // 10:00-10:30
  if (totalMin >= 900 && totalMin < 930) return "3pm";     // 15:00-15:30
  if (totalMin >= 1140 && totalMin < 1170) return "7pm";   // 19:00-19:30
  if (totalMin >= 1260 && totalMin < 1290) return "9pm";   // 21:00-21:30

  return null;
}

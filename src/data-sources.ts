/**
 * Data Sources Module
 *
 * Real data fetchers for Oura health metrics, calendar events,
 * and Supabase-stored goals/facts. Used by morning briefing,
 * smart check-ins, and the main relay.
 */

import { spawn } from "bun";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const OURA_API_TOKEN = process.env.OURA_API_TOKEN || "";
const OURA_BASE = "https://api.ouraring.com/v2/usercollection";

// ============================================================
// OURA RING (V2 API)
// ============================================================

async function ouraFetch(endpoint: string, params?: Record<string, string>): Promise<any> {
  if (!OURA_API_TOKEN) return null;

  const url = new URL(`${OURA_BASE}/${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${OURA_API_TOKEN}` },
  });

  if (!res.ok) {
    console.error(`Oura API error (${endpoint}): ${res.status}`);
    return null;
  }

  return res.json();
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

export async function getOuraSleep(): Promise<string> {
  const data = await ouraFetch("daily_sleep", {
    start_date: yesterdayStr(),
    end_date: todayStr(),
  });
  if (!data?.data?.length) return "Sleep: no data";

  const latest = data.data[data.data.length - 1];
  const score = latest.score ?? "N/A";
  const c = latest.contributors || {};

  const details: string[] = [];
  if (c.deep_sleep != null) details.push(`Deep: ${c.deep_sleep}`);
  if (c.efficiency != null) details.push(`Efficiency: ${c.efficiency}`);
  if (c.restfulness != null) details.push(`Restfulness: ${c.restfulness}`);

  return `Sleep Score: ${score}/100` +
    (details.length ? ` (${details.join(", ")})` : "");
}

export async function getOuraReadiness(): Promise<string> {
  const data = await ouraFetch("daily_readiness", {
    start_date: yesterdayStr(),
    end_date: todayStr(),
  });
  if (!data?.data?.length) return "Readiness: no data";

  const latest = data.data[data.data.length - 1];
  return `Readiness Score: ${latest.score ?? "N/A"}/100`;
}

export async function getOuraStress(): Promise<{ level: string; summary: string }> {
  const data = await ouraFetch("daily_stress", {
    start_date: todayStr(),
    end_date: todayStr(),
  });
  if (!data?.data?.length) return { level: "unknown", summary: "Stress: no data" };

  const latest = data.data[data.data.length - 1];
  const stressHigh = latest.stress_high ?? 0;
  const recoveryHigh = latest.recovery_high ?? 0;

  let level = "normal";
  if (stressHigh > recoveryHigh * 2) level = "high";
  else if (recoveryHigh > stressHigh * 2) level = "low";

  return {
    level,
    summary: `Stress: ${level} (stress periods: ${stressHigh}, recovery: ${recoveryHigh})`,
  };
}

export async function getOuraActivity(): Promise<string> {
  const data = await ouraFetch("daily_activity", {
    start_date: yesterdayStr(),
    end_date: todayStr(),
  });
  if (!data?.data?.length) return "Activity: no data";

  const latest = data.data[data.data.length - 1];
  const score = latest.score ?? "N/A";
  const steps = latest.steps ?? 0;
  const cal = latest.active_calories ?? 0;

  return `Activity Score: ${score}/100 | Steps: ${steps.toLocaleString()} | Active Cal: ${cal}`;
}

// ============================================================
// CALENDAR (icalBuddy)
// ============================================================

async function runIcalBuddy(args: string[]): Promise<string> {
  const icalBuddyPath = "/opt/homebrew/bin/icalBuddy";
  try {
    const proc = spawn([icalBuddyPath, ...args], {
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

export async function getCalendarEvents(): Promise<string> {
  const output = await runIcalBuddy([
    "-f",
    "-ea",
    "-nc",
    "-b", "- ",
    "-ps", "| | ",
    "-po", "title,datetime",
    "eventsToday",
  ]);
  return output || "No events today";
}

// Strip ANSI color codes from icalBuddy output
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function getUpcomingEvents(minutes: number = 35): Promise<string> {
  // Get today's events from now on, then filter to only those STARTING within N minutes
  // icalBuddy's -n flag shows currently-ongoing events too, so we parse start times
  const rawOutput = await runIcalBuddy([
    "-n",
    "-f",
    "-ea",
    "-nc",
    "-b", "- ",
    "-ps", "| | ",
    "-po", "title,datetime,location,notes,attendees",
    "eventsToday",
  ]);
  if (!rawOutput) return "";

  const output = stripAnsi(rawOutput);
  const now = new Date();
  const cutoff = new Date(now.getTime() + minutes * 60 * 1000);

  // Split by top-level bullet "- " at start of line
  const events = output.split(/^- /m).filter(Boolean);
  const upcoming: string[] = [];

  for (const event of events) {
    // Extract start time — formats like "9:00 AM - 8:00 PM" or "today at 6:00 PM - 9:00 PM"
    const timeMatch = event.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-/i);
    if (!timeMatch) continue;

    const startTimeStr = timeMatch[1].trim();
    const parts = startTimeStr.split(/\s+/);
    const ampm = parts[parts.length - 1];
    const timePart = parts[0];
    const [h, m] = timePart.split(":").map(Number);
    let hours = h;
    if (ampm.toUpperCase() === "PM" && h !== 12) hours += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) hours = 0;

    const eventStart = new Date(now);
    eventStart.setHours(hours, m, 0, 0);

    // Only include if event STARTS between now and cutoff (not already-started)
    if (eventStart > now && eventStart <= cutoff) {
      upcoming.push(`- ${event.trim()}`);
    }
  }

  return upcoming.join("\n\n");
}

// ============================================================
// CALENDAR (structured)
// ============================================================

export interface CalendarEvent {
  title: string;
  startTime: Date;
  location: string;
}

export async function getUpcomingEventsStructured(minutes: number = 35): Promise<CalendarEvent[]> {
  const rawOutput = await runIcalBuddy([
    "-n",
    "-f",
    "-ea",
    "-nc",
    "-b", "- ",
    "-ps", "| | ",
    "-po", "title,datetime,location",
    "eventsToday",
  ]);
  if (!rawOutput) return [];

  const output = stripAnsi(rawOutput);
  const now = new Date();
  const cutoff = new Date(now.getTime() + minutes * 60 * 1000);

  const events = output.split(/^- /m).filter(Boolean);
  const results: CalendarEvent[] = [];

  for (const event of events) {
    const lines = event.trim().split("\n");
    const title = lines[0]?.trim() || "";

    // Extract start time
    const timeMatch = event.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-/i);
    if (!timeMatch) continue;

    const startTimeStr = timeMatch[1].trim();
    const parts = startTimeStr.split(/\s+/);
    const ampm = parts[parts.length - 1];
    const timePart = parts[0];
    const [h, m] = timePart.split(":").map(Number);
    let hours = h;
    if (ampm.toUpperCase() === "PM" && h !== 12) hours += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) hours = 0;

    const startTime = new Date(now);
    startTime.setHours(hours, m, 0, 0);

    if (startTime > now && startTime <= cutoff) {
      // Extract location if present (line starting with "location:")
      const locMatch = event.match(/location:\s*(.+)/i);
      const location = locMatch ? locMatch[1].trim() : "";

      results.push({ title, startTime, location });
    }
  }

  return results;
}

// ============================================================
// SUPABASE (goals & facts)
// ============================================================

function getSupabase(): SupabaseClient | null {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

export async function getActiveGoals(): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  try {
    const { data } = await supabase.rpc("get_active_goals");
    if (!data?.length) return [];
    return data.map((g: any) => {
      const deadline = g.deadline
        ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${g.content}${deadline}`;
    });
  } catch {
    return [];
  }
}

export async function getRecentFacts(): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  try {
    const { data } = await supabase.rpc("get_facts");
    if (!data?.length) return [];
    return data.map((f: any) => f.content);
  } catch {
    return [];
  }
}

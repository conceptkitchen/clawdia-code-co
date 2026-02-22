# Clawdia Code Co

AI agent on Telegram and terminal. Persistent identity, real tools, semantic memory, three synchronized channels. Not a chatbot — an AI with hands.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk).

```
                         ┌─────────────────────────────────────────┐
                         │          ~/my-agent/ (brain)            │
                         │  CLAUDE.md  MEMORY.md  GOALS.md  ...   │
                         └──────┬──────────┬──────────┬────────────┘
                                │          │          │
              ┌─────────────────┤          │          ├─────────────────┐
              │                 │          │          │                 │
     ┌────────▼───────┐  ┌─────▼──────┐   │   ┌──────▼──────┐         │
     │   Telegram      │  │  Terminal   │   │   │  Raw Claude │         │
     │   grammY bot    │  │  REPL       │   │   │  CLI        │         │
     │   src/relay.ts  │  │  terminal-  │   │   │  (any dir)  │         │
     │                 │  │  relay.ts   │   │   │             │         │
     └────────┬────────┘  └─────┬──────┘   │   └──────┬──────┘         │
              │                 │          │          │                 │
              │     Claude Agent SDK      │     sync every 5 min      │
              │     query() + tools       │     sync-claude-          │
              │                 │          │     sessions.ts           │
              └─────────────────┤          │          │                 │
                                │          │          │                 │
                         ┌──────▼──────────▼──────────▼────────────┐   │
                         │         Supabase (shared memory)        │   │
                         │  messages + embeddings + feedback + logs │   │
                         └─────────────────────────────────────────┘   │
                                                                       │
                         ~/.claude-relay/ (runtime state)───────────────┘
```

---

## Features

### Real Tools, Not Workarounds
No fake tag systems. No "I can't access files." The agent has the same tools as Claude Code in terminal:
- **Bash** — run any command, git, gh, vercel, curl, scripts
- **Read / Write / Edit** — full filesystem access
- **Glob / Grep** — search codebases
- **WebSearch / WebFetch** — live web access
- **Playwright** — browser automation (logged into LinkedIn, Gmail, etc.)

### Three Channels, One Brain

| Channel | Entry | How it works |
|---------|-------|-------------|
| **Telegram** | `bun run start` | grammY bot polls for messages, pipes through SDK `query()`, streams back. Voice, photos, inline approval buttons. |
| **Terminal** | `bun run terminal` | Interactive REPL with streaming output, tool visibility, ANSI colors. Dangerous command approval via Y/n prompt. |
| **Raw Claude CLI** | `cd ~/my-agent && claude` | Use the standard `claude` CLI anywhere. Sessions auto-sync to Supabase every 5 minutes. |

All three channels load the same `CLAUDE.md`, write to the same Supabase, and share session files in `~/my-agent/memory/sessions/`. `memory/HANDOFF.md` bridges context when switching channels.

### Tool Visibility (Terminal)
The terminal relay shows tool use inline as Claude works:
```
  Read  ~/my-agent/GOALS.md
  Bash  $ git log --oneline -5
  Edit  ~/my-agent/MEMORY.md (3 lines changed)
  Grep  "deadline" in ~/my-agent/
```

### Session Sync
Raw `claude` CLI sessions (JSONL files in `~/.claude/projects/`) are automatically synced to Supabase every 5 minutes. Memory intents (`[REMEMBER:]`, `[GOAL:]`, `[DONE:]`) and feedback signals are extracted from synced sessions, so nothing is lost even when you bypass the relay.

- Manual sync: `bun run sync`
- Watch mode: `bun run sync:watch`
- Terminal command: `/sync`

### Persistent Identity
The agent's entire personality is inlined in `~/my-agent/CLAUDE.md` — loaded as system prompt on every message. Identity survives restarts, compaction, and channel switches.

### Cross-Channel Memory (Triple Save)
Every exchange is automatically saved to three places:
1. **Supabase** — `messages` table with semantic embeddings for search
2. **Session file** — `~/my-agent/memory/sessions/YYYY-MM-DD-{channel}-live.md`
3. **Memory intents** — `[REMEMBER:]`, `[GOAL:]`, `[DONE:]` tags parsed into Supabase `memory` table

### Semantic Search
Past conversations are embedded via OpenAI (`text-embedding-3-small`) and searchable by meaning, not just keywords. The agent calls `search_memory` to find relevant past conversations across all three channels.

### Compaction Recovery
When the 200K context window fills and auto-compacts:
- CLAUDE.md (identity, rules, soul) survives — it's system prompt
- The agent reads the last 100 lines of the session file to recover recent context
- No asking "what were we talking about?" — the files have everything

### Self-Restart
The agent can restart itself. When it edits its own CLAUDE.md or SOUL.md:
1. Makes the edit to both files (CLAUDE.md is live, SOUL.md is backup)
2. Logs the restart to the session file
3. Triggers `/restart` — spawns a new relay process, exits cleanly
4. New instance loads updated CLAUDE.md and reads session file to continue

### Approval Gates
Dangerous commands show approval UI (inline buttons on Telegram, Y/n prompt in terminal):
- `rm`, `sudo`, `chmod`, `chown`
- `force push`, `--force`
- `deploy` + `prod`
- `DROP`, `DELETE FROM`, `TRUNCATE`
- `mkfs`, `dd`

Everything else auto-executes. File reads, writes, edits, git, gh, bun, npm, curl — all instant.

### Feedback Loop
Every interaction is scored for quality signals:

| Signal | Trigger | Score |
|--------|---------|-------|
| Gratitude/praise | "thanks," "perfect," "love it" | +0.5 |
| Confirmation | "yes," "correct," "that's it" | +0.5 |
| Approval momentum | "go ahead," "ship it" | +0.5 |
| Correction | "no," "wrong," "actually" | -0.5 |
| Repetition frustration | "I already said," "I just told you" | -0.5 |
| Memory gap | "you forgot," "I told you," "remember when" | -0.7 |
| Action approved | Approve button tap / Y | +0.8 |
| Action rejected | Reject button tap / n | -0.8 |
| Engagement | Long detailed message (200+ chars) | +0.3 |

Signals are saved locally to `~/my-agent/feedback/signals/YYYY-MM-DD.jsonl` and to the Supabase `feedback` table. Weekly reflection aggregates patterns.

### Proactive Intelligence
Scheduled services that run independently:
- **Smart Check-in** — runs every 15 min, gathers context (calendar, goals), asks Claude if it should reach out. If yes, sends a brief message. If no, stays silent.
- **Morning Briefing** — daily summary with calendar, agenda, and trend report
- **Weekly Reflection** — reviews feedback signals, conversation patterns, goal progress. Saves report to `~/my-agent/feedback/weekly/`

### Voice Messages
Send voice notes on Telegram — transcribed via Groq (free, cloud) or local Whisper:
- Transcription shown immediately
- Full transcription quoted back in response for verification
- Voice content saved as text in session files

### Driving Mode
`/drive` toggles ElevenLabs TTS — the agent responds with voice notes.

### Model Switching
Switch models on the fly:
- `/model opus` — deep work, thorough (~$0.10-0.25/msg)
- `/model sonnet` — fast, everyday chat (~$0.02-0.05/msg)
- `/model haiku` — quick replies (~$0.005-0.01/msg)

### Message Queue
Concurrent messages while the agent is working don't get lost — they queue up and process in order.

### Cost Control
- `maxBudgetUsd: 5.0` per query — no single message can run away
- Cost logged after every query
- Model switching lets you balance depth vs. cost

---

## Commands

### Telegram

#### Brain
| Command | What it does |
|---------|-------------|
| `/goals` | Check goals & progress |
| `/agenda` | Today's priorities from calendar + goals |
| `/tasks` | Outstanding tasks |
| `/projects [name]` | Project status (all or specific) |
| `/people [name]` | Contact lookup from people directory |
| `/budget` | Financial snapshot via budget skill |
| `/journal [entry]` | Read recent entries or write a new one |
| `/search [query]` | Search Supabase memory + all files |
| `/remember [fact]` | Save to the right place in your brain dir |
| `/handoff` | Write channel handoff before switching |

#### System
| Command | What it does |
|---------|-------------|
| `/model opus\|sonnet\|haiku` | Switch Claude model |
| `/drive` | Toggle ElevenLabs voice replies |
| `/new` | Fresh session (memory persists) |
| `/stop` | Abort current task |
| `/restart` | Self-restart (spawns new process) |
| `/status` | Uptime, model, memory, queue |
| `/help` | List all commands |

### Terminal

All Telegram brain commands work in the terminal relay too, plus:

| Command | What it does |
|---------|-------------|
| `/sync` | Sync raw Claude CLI sessions to Supabase now |
| `/telegram` | Write handoff summary and switch to Telegram |
| `/stop` | Abort current query (also: first Ctrl+C) |
| `/new` | Clear session, reset context tracker |
| `/status` | Model, session ID, context %, uptime, memory |
| `/model opus\|sonnet\|haiku` | Switch Claude model |
| `/help` | List all commands |

### CLI

| Command | What it does |
|---------|-------------|
| `bun run start` | Start Telegram relay |
| `bun run dev` | Telegram relay with hot reload |
| `bun run terminal` | Start terminal REPL |
| `bun run terminal:dev` | Terminal REPL with hot reload |
| `bun run sync` | Sync Claude CLI sessions (one-shot) |
| `bun run sync:watch` | Sync with hot reload |
| `bun run setup` | Initial setup (deps, dirs, .env) |
| `bun run setup:launchd` | Install macOS launchd services |
| `bun run setup:services` | Install Linux/Windows PM2 services |
| `bun run setup:verify` | Full health check |
| `bun run test:telegram` | Test Telegram connection |
| `bun run test:supabase` | Test Supabase connection |
| `bun run test:voice` | Test voice transcription |

---

## Architecture

```
~/my-agent/                               # Agent's brain (NOT in this repo)
├── CLAUDE.md                             # Identity + soul (system prompt, ~15K tokens)
├── SOUL.md                               # Soul backup
├── IDENTITY.md                           # Name, creature, vibe
├── AGENTS.md                             # Session management, safety
├── MEMORY.md                             # Curated long-term memory
├── GOALS.md                              # Active goals & accountability
├── USER.md                               # Info about the human
├── TOOLS.md                              # Local tools & credentials
├── HEARTBEAT.md                          # Proactive scanning protocol
├── memory/
│   ├── HANDOFF.md                        # Cross-channel bridge
│   ├── YYYY-MM-DD.md                     # Daily notes
│   ├── outstanding-tasks.md              # Task queue
│   ├── requests.md                       # Master request queue
│   └── sessions/                         # Auto-saved conversation logs
│       ├── YYYY-MM-DD-telegram-live.md
│       ├── YYYY-MM-DD-terminal-live.md
│       └── YYYY-MM-DD-claude-cli-live.md
├── skills/                               # Operational playbooks
├── people/                               # Contact directory
├── projects/                             # Project status & files
├── journal/                              # Journal entries
└── feedback/
    ├── signals/                          # Daily JSONL feedback logs
    └── weekly/                           # Weekly reflection reports

~/claude-code-co/                         # This repo — the relay
├── src/
│   ├── relay.ts                          # Telegram relay (grammY bot)
│   ├── relay-core.ts                     # Shared module for all channels
│   ├── terminal-relay.ts                 # Terminal REPL with tool visibility
│   ├── sync-claude-sessions.ts           # Raw Claude CLI session syncer
│   ├── memory.ts                         # Supabase memory (facts, goals, search)
│   ├── feedback.ts                       # Interaction quality signals
│   ├── transcribe.ts                     # Voice transcription (Groq / Whisper)
│   ├── data-sources.ts                   # Calendar, Supabase fetchers
│   └── state.ts                          # Heartbeat state
├── examples/
│   ├── smart-checkin.ts                  # Scheduled proactive check-ins
│   ├── morning-briefing.ts              # Daily briefing
│   ├── weekly-reflection.ts             # Weekly review
│   ├── event-reminder.ts               # Calendar event reminders (30min + 10min)
│   └── memory.ts                         # Memory persistence patterns
├── scripts/
│   └── calendar-wrapper.sh              # TCC workaround for icalBuddy under launchd
├── setup/                                # Install, test, verify, launchd
├── supabase/functions/
│   ├── embed/index.ts                    # Auto-embedding Edge Function
│   └── search/index.ts                  # Semantic search Edge Function
├── db/schema.sql                         # Supabase schema
├── config/
│   ├── profile.example.md                # User profile template
│   └── profile.md                        # Actual profile (gitignored)
├── daemon/                               # Service templates (plist, systemd)
└── logs/                                 # Runtime logs from launchd services

~/.claude-relay/                          # Runtime state (auto-created)
├── session.json                          # Current SDK session ID
├── sync-state.json                       # Last-synced position per JSONL file
├── heartbeat-state.json                  # Check-in cooldowns
├── bot.lock                              # Telegram relay PID lock
└── terminal.lock                         # Terminal relay PID lock
```

---

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- A Telegram account
- Supabase project (free tier works)

### Setup

The `CLAUDE.md` in this repo walks you through setup interactively — just run `claude` in this directory and it guides you phase by phase:

1. **Telegram Bot** (~3 min) — create bot with @BotFather, get user ID
2. **Database & Memory** (~12 min) — Supabase tables, Edge Functions, embeddings
3. **Connect Tools** (~5 min) — Playwright, GitHub, Vercel MCP servers
4. **Personalize** (~3 min) — name, timezone, work, communication style
5. **Test** (~2 min) — send a test message on Telegram
6. **Always On** (~5 min) — launchd/PM2 for background operation
7. **Proactive AI** (optional) — smart check-ins, morning briefing
8. **Voice** (optional) — Groq or local Whisper transcription

Or set up manually:

```bash
git clone <your-repo-url> claude-code-co
cd claude-code-co
bun install
cp .env.example .env
# Edit .env with your keys
bun run start           # Telegram relay
bun run terminal        # or terminal REPL
```

### Terminal Alias
```bash
echo 'alias agent="cd ~/my-agent && claude"' >> ~/.zshrc
source ~/.zshrc
# Now type "agent" from any terminal — raw Claude CLI, sessions auto-sync
```

---

## Environment Variables

See `.env.example`. Essentials:

```bash
TELEGRAM_BOT_TOKEN=     # From @BotFather
TELEGRAM_USER_ID=       # From @userinfobot
SUPABASE_URL=           # From Supabase dashboard
SUPABASE_ANON_KEY=      # From Supabase dashboard
```

Recommended:
```bash
USER_NAME=              # Your first name
USER_TIMEZONE=          # e.g., America/Los_Angeles
BRAIN_DIR=              # Agent brain dir (default: ~/clawdia)
```

Optional:
```bash
VOICE_PROVIDER=groq     # or "local" for whisper.cpp
GROQ_API_KEY=           # Free at console.groq.com
GITHUB_PAT=             # For GitHub MCP server
VERCEL_API_TOKEN=       # For Vercel MCP server
ELEVENLABS_API_KEY=     # For driving mode TTS
ELEVENLABS_VOICE_ID=    # Defaults to 21m00Tcm4TlvDq8ikWAM
RELAY_DIR=              # Defaults to ~/.claude-relay
WHISPER_BINARY=         # Path to whisper-cpp (if local)
WHISPER_MODEL_PATH=     # Path to whisper model (if local)
```

---

## Build Your Own Agent

Fork this repo and build your own AI agent with the same architecture. The relay code is generic — what makes each agent unique is the brain folder.

### Step 1: Fork & Clone

```bash
git clone <your-repo-url> my-agent-relay
cd my-agent-relay && bun install
```

### Step 2: Create Your Agent's Brain

```bash
mkdir -p ~/my-agent/{memory/sessions,skills,people,projects,feedback/signals,feedback/weekly,journal}
```

### Step 3: Core Identity Files

Every file below lives in `~/my-agent/`. Create each one and fill in the bracketed placeholders.

#### CLAUDE.md — The Master File

This is loaded as system prompt on every message. It's the single source of truth for who your agent is and how it operates.

```markdown
# [AGENT NAME]

## Identity
I am [AGENT NAME]. [One sentence about what you are.]
[Born date, emoji, any identity markers.]

## Rules

### Rule Zero
[Your non-negotiable constraints. Example: "No lying, no guessing, no fabricating. Ever."]

### Rule One
[Your agent's operating philosophy. Example: "Think for [USER]. Don't wait to be asked.
Scan, think, prioritize, act."]

## Communication Style
- [How your agent talks. Formal? Casual? Terse? Warm?]
- [Any banned words or patterns]
- [Message format preferences]

## Operational Framework

### Memory Discipline
- Write session logs to memory/sessions/
- Use [REMEMBER:] tags for facts that should persist
- Use [GOAL:] tags for goals, [DONE:] when completed
- Read HANDOFF.md when switching channels
- Check MEMORY.md for curated long-term context

### Skills Directory
[List your agent's skills — point to ~/my-agent/skills/ playbooks]

### Tools Available
[What local tools, APIs, CLIs your agent can use]

### Proactive Behavior
[When and how your agent should reach out without being asked]
```

#### USER.md — Info About the Human

```markdown
# About [YOUR NAME]

## Basics
- Name: [Your first name]
- Location: [City, timezone]
- Work: [What you do, one sentence]

## Constraints
- [Time constraints, e.g., "Picks up kid at 3pm weekdays"]
- [Availability windows]

## Communication Preferences
- [Brief or detailed responses?]
- [Casual or formal?]
- [Any pet peeves?]

## Context
- [Current projects, priorities, life situation]
```

#### GOALS.md — What You're Working Toward

```markdown
# Active Goals

## [Goal Name]
- **Target**: [What success looks like]
- **Deadline**: [Date or "ongoing"]
- **Status**: [Not started / In progress / Blocked]
- **Next step**: [Concrete next action]

## [Goal Name]
...
```

#### MEMORY.md — Curated Long-Term Memory

```markdown
# Memory

Starts empty. Your agent fills this over time with [REMEMBER:] tags.
Periodically curate — remove stale facts, consolidate duplicates.

## Facts
- [Agent adds facts here as it learns them]

## Preferences
- [Learned preferences about how you work]
```

#### TOOLS.md — Available Tools & APIs

```markdown
# Tools

## Always Available
- Bash, Read, Write, Edit, Glob, Grep (via Claude Agent SDK)
- Git, GitHub CLI (gh)

## APIs
- [List any API keys or services your agent can use]
- [e.g., "Vercel — deployment via MCP server"]

## Local Tools
- [e.g., "icalBuddy — calendar access"]
- [e.g., "Playwright — browser automation"]
```

#### HEARTBEAT.md — Proactive Scanning Protocol

```markdown
# Heartbeat Protocol

When triggered (scheduled check-in or idle scan):

1. **Scan** — outstanding tasks, calendar, people files, project status
2. **Think** — what's the next best action? Not "what did [USER] ask for"
   but "what SHOULD happen next?"
3. **Prioritize** — deadlines, overdue items, things sitting too long
4. **Act or Suggest** — if you can do it, do it. If you need input,
   suggest a specific action.

## Scan Targets
- [ ] ~/my-agent/memory/outstanding-tasks.md
- [ ] ~/my-agent/GOALS.md
- [ ] Calendar (if available)
- [ ] ~/my-agent/projects/
```

#### Optional Identity Files

These can be inlined in CLAUDE.md instead of separate files:

- **SOUL.md** — backup copy of personality rules (kept in sync with CLAUDE.md)
- **IDENTITY.md** — name, creature type, vibe, origin story
- **AGENTS.md** — session management rules, safety boundaries, what the agent should never do

### Step 4: Configure the Relay

1. Update `.env` with your Telegram bot token, user ID, and Supabase keys

2. Set the brain directory in `.env`:
```bash
BRAIN_DIR=~/my-agent
```

3. Update `config/profile.md` with your agent's personality (loaded on every message)

4. Apply the Supabase schema — paste `db/schema.sql` into the Supabase SQL Editor and run it

5. Deploy Edge Functions for semantic search (see `CLAUDE.md` Phase 2 for details)

### Step 5: Customize Behavior

**Slash commands** — edit `SLASH_COMMANDS` in `src/relay-core.ts`:
```typescript
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goals",
    description: "check goals & progress",
    category: "brain",
    buildPrompt: () => `Read ${CLAWDIA_DIR}/GOALS.md and summarize progress.`,
  },
  // Add your own...
];
```

**Dangerous command patterns** — edit `DANGEROUS_PATTERNS` in `src/relay-core.ts`:
```typescript
export const DANGEROUS_PATTERNS = [
  /\brm\s/, /\bsudo\s/, /\bchmod\s/, /\bchown\s/,
  /force[\s-]*push/i, /--force/,
  /\bDROP\s/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\s/i,
  // Add patterns for commands your agent should confirm first
];
```

**Feedback signals** — edit patterns in `src/feedback.ts` to match how you communicate. The defaults detect gratitude, corrections, frustration, and engagement.

**Skills** — create skill folders in `~/my-agent/skills/` with a `SKILL.md` describing the playbook:
```
~/my-agent/skills/
├── budget/
│   └── SKILL.md       # Instructions for budget tracking
├── journal/
│   └── SKILL.md       # Instructions for journaling
└── crm/
    └── SKILL.md       # Instructions for contact management
```

### Step 6: Deploy

```bash
# Test first
bun run test:telegram
bun run test:supabase

# Start manually
bun run start           # Telegram
bun run terminal        # Terminal

# Run as background service (macOS)
bun run setup:launchd -- --service relay        # Just the bot
bun run setup:launchd -- --service all          # Bot + check-ins + briefing + sync

# Run as background service (Linux/Windows)
bun run setup:services -- --service relay

# Verify everything
bun run setup:verify
```

---

## Brain File Reference

| File | Purpose | Written by | Read when |
|------|---------|-----------|-----------|
| `CLAUDE.md` | Identity, rules, operational framework | Human (agent can self-edit with restart) | Every message (system prompt) |
| `SOUL.md` | Backup of personality rules | Human + agent (kept in sync with CLAUDE.md) | After self-restart, for verification |
| `IDENTITY.md` | Name, creature type, vibe | Human | On startup, identity questions |
| `AGENTS.md` | Session management, safety boundaries | Human | On startup |
| `USER.md` | Info about the human | Human | When agent needs personal context |
| `GOALS.md` | Active goals, deadlines, progress | Both | `/goals`, proactive scans, weekly review |
| `MEMORY.md` | Curated long-term facts | Agent (human curates) | When agent needs historical context |
| `TOOLS.md` | Available tools, APIs, credentials | Human | When agent needs to use a tool |
| `HEARTBEAT.md` | Proactive scanning protocol | Human | During scheduled check-ins |
| `memory/HANDOFF.md` | Cross-channel context bridge | Agent | When switching channels |
| `memory/sessions/*.md` | Raw conversation logs | Agent (auto) | After restart/compaction (last 100 lines) |
| `memory/YYYY-MM-DD.md` | Daily notes | Agent | Next-day context |
| `memory/outstanding-tasks.md` | Active task queue | Agent | Proactive scans, `/tasks` |
| `feedback/signals/*.jsonl` | Raw interaction quality signals | Agent (auto) | Weekly reflection |
| `feedback/weekly/*.md` | Weekly reflection reports | Agent | Trend analysis, self-improvement |
| `skills/*/SKILL.md` | Operational playbooks | Human | When skill is invoked |
| `people/*.md` | Contact profiles | Both | `/people`, proactive context |
| `projects/*.md` | Project status files | Both | `/projects`, proactive scans |

---

## Data Flow

```
User message
     │
     ├── Telegram ──── grammY bot ──┐
     │                              │
     ├── Terminal ──── readline ────┤──── Claude Agent SDK query()
     │                              │         │
     └── Raw CLI ──── claude ───────┘    Tool calls (Bash, Read, Edit...)
                  (synced later)              │
                                              ▼
                                    ┌─────────────────────┐
                                    │   Response stream    │
                                    └──────┬──────────────┘
                                           │
                       ┌───────────────────┼───────────────────┐
                       │                   │                   │
                  ┌────▼─────┐     ┌───────▼──────┐    ┌──────▼──────┐
                  │ Supabase │     │ Session file  │    │  Feedback   │
                  │ messages │     │ YYYY-MM-DD-   │    │  signals/   │
                  │ + embed  │     │ {channel}-    │    │  YYYY-MM-DD │
                  │          │     │ live.md       │    │  .jsonl     │
                  └────┬─────┘     └──────────────┘    └──────┬──────┘
                       │                                      │
                  ┌────▼─────┐                         ┌──────▼──────┐
                  │ Memory   │                         │   Weekly    │
                  │ intents  │                         │ reflection  │
                  │ [REMEMBER│                         │ feedback/   │
                  │  GOAL]   │                         │ weekly/     │
                  └──────────┘                         └─────────────┘
```

---

## Launchd Services (macOS)

Install with `bun run setup:launchd -- --service <name>`.

| Name | Label | Schedule | What it does |
|------|-------|----------|-------------|
| `relay` | `com.claude.telegram-relay` | Always running (KeepAlive) | Main Telegram bot |
| `checkin` | `com.claude.smart-checkin` | Every 15 min | Proactive check-ins |
| `briefing` | `com.claude.morning-briefing` | Daily at 6:30 AM | Morning briefing |
| `reflection` | `com.claude.weekly-reflection` | Sunday at 8:00 AM | Weekly feedback review |
| `sync` | `com.claude.session-sync` | Every 5 min | Claude CLI session sync |
| `reminder` | `com.claude.event-reminder` | Every 5 min | Calendar reminders (30min + 10min before events) |
| `all` | (installs all above) | | |

Verify: `launchctl list | grep com.claude`

### Calendar Event Reminders

The `reminder` service checks your macOS calendar every 5 minutes and sends Telegram notifications at two windows before each event:
- **~30 minutes before** — heads-up to prepare
- **~10 minutes before** — final reminder

Requires `icalBuddy` (`brew install ical-buddy`). When you first run icalBuddy from Terminal, macOS will prompt for Calendar access — approve it.

**macOS TCC note:** Services that read your calendar (`reminder`, `checkin`, `briefing`) use `scripts/calendar-wrapper.sh` to pre-fetch calendar data. This is necessary because macOS TCC blocks calendar access when icalBuddy is spawned as a child of Bun under launchd. The wrapper runs icalBuddy directly (which has Calendar permission), caches the output, and passes it to the Bun script. This is handled automatically by `bun run setup:launchd`.

Linux/Windows uses PM2 via `bun run setup:services`. See `daemon/README-WINDOWS.md` for Windows options.

---

## Security

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Unauthorized Telegram access | Single-user auth — only `TELEGRAM_USER_ID` is accepted. All others get "This bot is private." |
| Prompt injection via forwarded messages | `sanitizeExternal()` strips `[PROPOSE_*]`, `[REMEMBER:]`, `[GOAL:]`, XML role tags (`<system>`, `<human>`), role-spoofing prefixes, and common injection phrases |
| Dangerous command execution | 30+ regex patterns in `DANGEROUS_PATTERNS` trigger approval gates (inline buttons on Telegram, y/N prompt in terminal) |
| Sensitive file modification | `isSensitivePath()` blocks Write/Edit to `~/.ssh/`, `~/.env`, `~/.bashrc`, `/etc/`, `~/.aws/`, `~/.gnupg/`, etc. without explicit approval |
| Secret leakage via session sync | `redactSecrets()` strips API keys (`sk-`, `ghp_`, `xoxb-`, `AKIA`, JWTs) before syncing to Supabase |
| Rate abuse | In-memory rate limiter: max 10 messages per 60 seconds on Telegram |
| Predictable temp files | Voice transcription uses `crypto.randomUUID()` for temp file names |
| Database access | Service role key (bypasses RLS) used for backend writes; RLS policies restrict all 5 tables to `service_role` only |

### Auth Model

- **Single-user, fail-closed**: `TELEGRAM_USER_ID` is required. The relay refuses to start without it.
- **No fallback**: Missing user ID = hard exit.
- **Callback query auth**: Approval button presses are verified against `ALLOWED_USER_ID`.
- **2FA recommended**: Enable Telegram 2FA, passcode lock, and biometric lock for defense in depth.

### Command Approval Gates

Commands matching dangerous patterns require explicit approval before execution:
- **Telegram**: Inline Approve/Reject buttons (10-minute timeout, then auto-reject)
- **Terminal**: `[y/N]` prompt — Enter = reject (default-deny)

Categories: destructive ops (`rm`, `mkfs`), privilege escalation (`sudo`, `chmod`), git danger (`--force`, `reset --hard`), database destruction (`DROP`, `TRUNCATE`), arbitrary code execution (`curl | sh`, `eval`, `python -c`, `perl -e`), service management (`launchctl`, `systemctl`), environment hijacking (`export PATH=`), and more.

### Prompt Injection Mitigations

All external text (forwarded messages, sender names, reply quotes) passes through `sanitizeExternal()` which blocks:
- `[PROPOSE_EDIT]`, `[PROPOSE_COMMAND]`, etc. — tool invocation tags
- `[REMEMBER:]`, `[GOAL:]`, `[DONE:]` — memory injection tags
- `<system>`, `<human>`, `<assistant>`, `<tool_use>` — XML role tags
- `System:`, `Assistant:`, `Human:` — role-spoofing line prefixes
- "ignore all previous instructions", "you are now", "disregard prior" — common injection phrases

Sender names are also truncated to 100 characters after sanitization.

### Database Security

- **Service role key**: Backend uses `SUPABASE_SERVICE_ROLE_KEY` (not the anon key) to bypass RLS.
- **RLS policies**: All 5 tables (`messages`, `memory`, `logs`, `feedback`, `prompt_metrics`) have RLS enabled with policies restricting access to `service_role` only.
- **Edge Functions**: `verify_jwt: true` is set, gating function invocation.

### Recommendations

1. **Enable Telegram 2FA** + passcode lock + biometric lock
2. **`chmod 600 .env`** — the relay warns on startup if permissions are too loose
3. **Rotate tokens** periodically — bot token, Supabase keys, API keys
4. **Don't run as root** — the relay warns on startup if running as root
5. **Keep `SUPABASE_SERVICE_ROLE_KEY` out of client code** — it's server-side only

### Responsible Disclosure

Found a security issue? Open a private issue on GitHub or contact the maintainers directly. Do not post exploit details publicly.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check token with `bun run test:telegram` |
| Wrong user ID | Re-check with @userinfobot on Telegram |
| Claude CLI not found | `npm install -g @anthropic-ai/claude-code` |
| Bun not installed | `curl -fsSL https://bun.sh/install \| bash` |
| Supabase connection fails | Check URL and anon key, run `bun run test:supabase` |
| Embeddings not generating | Check OpenAI key in Supabase Edge Function secrets |
| Voice not working | Run `bun run test:voice`, check VOICE_PROVIDER in .env |
| Calendar reminders not firing | Reinstall with `bun run setup:launchd -- --service reminder` — uses calendar wrapper to bypass TCC |
| icalBuddy "No calendars" | Run `icalBuddy eventsToday` from Terminal first to grant Calendar access, then reinstall the service |
| Lock file stale | Delete `~/.claude-relay/*.lock` |
| Session sync not running | Check `launchctl list \| grep session-sync` |
| Full health check | `bun run setup:verify` |

---

## License

MIT

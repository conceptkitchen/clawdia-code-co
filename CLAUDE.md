# Clawdia Code Co — Setup Playbook

> This file is read by Claude Code on startup. It contains step-by-step instructions
> for getting a new user's agent up and running. Guide them through it conversationally —
> one section at a time, confirming each piece works before continuing.

## Overview

Clawdia Code Co is a three-channel AI agent relay: Telegram, Terminal, and raw Claude CLI sessions.
All three channels share persistent memory via Supabase and a local brain directory.

Your role: walk the user through configuration interactively. Collect credentials, write config files,
run tests, troubleshoot. Never present the whole guide at once — take it section by section.

Before anything else, check if dependencies are installed. If not: `bun run setup`.

---

## 1. Telegram Credentials

The Telegram channel needs two values: a bot token and the user's numeric chat ID.

**Collect from the user:**
- Bot token — they create one by talking to `@BotFather` on Telegram (send `/newbot`, follow prompts, copy the token)
- Their numeric user ID — they can get it by messaging `@userinfobot` on Telegram

**Configure:**
1. If `.env` doesn't exist yet, run `bun run setup`
2. Write both values to `.env`: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID`
3. Verify with `bun run test:telegram` — this fires a test message to their chat

Move on once the test message lands in their Telegram.

---

## 2. Supabase (Persistent Memory)

The agent stores conversations, learned facts, goals, and embeddings in Supabase.
This gives it memory that survives restarts and works across all three channels.

### 2a. Project & Keys

**Collect from the user:**
- Their Supabase project URL (found under Project Settings > API)
- The `anon` public key from the same page

If they don't have a Supabase account yet, point them to supabase.com to create one and spin up a project.

**Configure:**
Write `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`.

### 2b. Supabase MCP Server

Adding Supabase as an MCP server lets you manage the database directly from Claude Code.

**Collect:** A Supabase access token (from supabase.com/dashboard/account/tokens)

**Configure:**
```
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest --access-token ACCESS_TOKEN
```

### 2c. Database Schema

Apply the schema to their project:
1. Open `db/schema.sql` and run it via the Supabase MCP's `execute_sql` tool
2. If MCP isn't cooperating, have them paste the SQL into the Supabase SQL Editor manually
3. Confirm with `bun run test:supabase`

### 2d. Embeddings & Semantic Search

Embeddings let the agent recall relevant past conversations automatically.

**Collect:** An OpenAI API key (from platform.openai.com > API keys)

**Configure:**
1. Deploy both edge functions through the Supabase MCP:
   - `supabase/functions/embed/index.ts` (generates embeddings)
   - `supabase/functions/search/index.ts` (queries them)
2. The OpenAI key lives in Supabase, not locally. Tell the user to add it:
   - Dashboard > Project Settings > Edge Functions > Secrets > add `OPENAI_API_KEY`
3. Wire up automatic embedding via database webhooks:
   - Dashboard > Database > Webhooks > Create:
     - `embed_messages` — table: `messages`, event: INSERT, function: `embed`
     - `embed_memory` — table: `memory`, event: INSERT, function: `embed`

### 2e. Confirm

Run `bun run test:supabase`. All three tables should exist (messages, memory, logs),
edge functions should respond, and a test insert should generate an embedding vector.

---

## 3. Tool Integrations (MCP Servers)

MCP servers extend what the agent can do — browse the web, manage GitHub repos, deploy to Vercel.

### Playwright (Browser)

Pre-configured in the relay code. No setup needed. The agent spawns a Playwright browser
automatically when processing queries. Users can log into any site in that browser
and the agent will have access to those sessions.

### GitHub (Optional)

Gives the agent access to repos, PRs, issues, and CI.

**Collect:** A personal access token with `repo` scope (from github.com/settings/tokens)

**Configure:**
1. Add `GITHUB_PAT` to `.env`
2. Register the MCP server:
   ```
   claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=THEIR_TOKEN -- npx -y @modelcontextprotocol/server-github
   ```

### Vercel (Optional)

Gives the agent access to deployments, env vars, and logs.

**Collect:** An API token (from vercel.com/account/tokens)

**Configure:**
1. Add `VERCEL_API_TOKEN` to `.env`
2. Register the MCP server:
   ```
   claude mcp add vercel -e VERCEL_API_TOKEN=THEIR_TOKEN -- npx -y vercel-mcp-server
   ```

Verify registered servers with `claude mcp list`.

---

## 4. Identity & Profile

The agent adapts its tone and context based on a profile file loaded with every message.

**Ask the user:**
- First name
- Timezone (e.g. `America/New_York`, `Europe/Berlin`)
- What they do (one sentence)
- Schedule constraints they want the agent to know about
- Communication preference: terse vs. detailed, casual vs. formal

**Configure:**
1. Set `USER_NAME` and `USER_TIMEZONE` in `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in their answers — the relay loads this file on every incoming message

---

## 5. Smoke Test

Time to see it work end-to-end.

1. Start the relay: `bun run start`
2. Have the user send any message to their bot on Telegram
3. Confirm it responds with context-aware output
4. Ctrl+C to stop

**If something breaks:**
- Bot doesn't respond → double-check the token and user ID in `.env`
- `claude` command not found → they need Claude Code installed: `npm install -g @anthropic-ai/claude-code`
- `bun` not found → install it: `curl -fsSL https://bun.sh/install | bash`

---

## 6. Background Service

The relay should run persistently — surviving terminal closes and rebooting with the machine.

**macOS (launchd):**
```
bun run setup:launchd -- --service relay
```
Generates a plist, loads it into launchd. Verify: `launchctl list | grep com.claude`

**Linux (PM2):**
```
bun run setup:services -- --service relay
```
Verify: `npx pm2 status`

---

## 7. Scheduled Agents (Optional)

These turn the bot from reactive to proactive — it reaches out on its own when appropriate.

### Smart Check-ins

`examples/smart-checkin.ts` runs every 15 minutes during waking hours. It checks context
(health data, calendar, time of day) and decides whether to send a brief message.
If there's nothing worth saying, it stays quiet. If the user is in an active conversation,
it backs off automatically.

### Morning Briefing

`examples/morning-briefing.ts` sends three messages each morning: a health + calendar summary,
AI-generated daily priorities, and a trend report on AI/tech news.

**Schedule both:**
```
bun run setup:launchd -- --service all    # macOS
bun run setup:services -- --service all   # Linux
```

Skip this section if the user doesn't want proactive messages.

---

## 8. Voice Messages (Optional)

Adds speech-to-text so the agent can process Telegram voice notes.

**Two options — ask the user which they prefer:**

### Groq (cloud, recommended)
Fast cloud transcription using Whisper. Free tier handles 2,000 requests/day.

- User creates an account at console.groq.com, generates an API key
- Set `VOICE_PROVIDER=groq` and `GROQ_API_KEY` in `.env`
- Test: `bun run test:voice`

### Local Whisper (offline)
Runs entirely on their machine. No account needed but requires ffmpeg and whisper-cpp.

- Install deps: `brew install ffmpeg whisper-cpp` (macOS) or build from source
- Download model: `curl -L -o ~/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
- Set `VOICE_PROVIDER=local`, `WHISPER_BINARY`, and `WHISPER_MODEL_PATH` in `.env`
- Test: `bun run test:voice`

---

## Wrap-Up

Run the full health check to see everything at a glance:

```
bun run setup:verify
```

Give the user a summary of what's configured and running. Remind them:
- Send a Telegram message to test the bot live
- If Phase 6 is done, the relay is running in the background already
- They can return to this directory and run `claude` to modify anything

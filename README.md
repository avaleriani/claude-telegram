# claude-telegram

Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone. One file, no frameworks.

Wanted to use Claude Code on the go — check on long tasks, fire off quick prompts from the couch, send a screenshot of a bug. This is a single Node.js file that bridges Telegram to the Claude CLI running on your machine. No frameworks, no `npm install`, no build step.

```
Your phone (Telegram) --> claude-server.js --> Claude CLI --> your codebase
                          ~1,500 lines
                          no npm dependencies
                          just Node.js built-ins
```

## Quick start

You need **Node.js 18+** and **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and logged in.

### Option 1: npx (fastest)

```bash
npx claude-telegram --setup
```

### Option 2: clone

```bash
git clone https://github.com/avaleriani/claude-telegram.git
cd claude-telegram
npm run go
```

The setup wizard walks you through everything:
1. Checks that Claude Code is installed
2. Asks for your Telegram bot token (get one from [@BotFather](https://t.me/BotFather) in 30 seconds)
3. Lets you pick a permission mode (how much access Claude gets)
4. Waits for you to send a message so it can grab your chat ID
5. Writes `.env` and starts the bot in the background

That's it. Send a message to your bot and Claude responds.

## What you get

**Full codebase access from Telegram.** Same as Claude Code in the terminal — reads, edits, creates files. Conversations persist across messages, `/new` starts fresh.

**Live streaming.** Responses stream into a single message that updates as Claude types. While Claude is thinking or using tools, you see a live progress indicator with elapsed time so you know it's not stuck.

**Files and voice.** Drop a photo, PDF, or any document — it saves to your project directory. Add a caption like "fix the bug in this screenshot" and Claude processes it. Voice messages work too.

**Git from your phone.**

| Command | |
|---|---|
| `/commit` | Stage all + commit |
| `/cm fix the navbar` | Commit with message |
| `/shipit` | Commit + push in one go |
| `/push` `/pull` | Push / pull |
| `/diff` `/log` | Changes / last 15 commits |
| `/branch` | Switch branch (picker) |
| `/stash` `/stashpop` | Stash and pop |

**Switch projects on the fly.** `/switch` opens a folder picker. `/switch /path/to/dir` sets it directly.

**All commands:**

| Command | |
|---|---|
| `/new` | New conversation |
| `/retry` | Re-send last prompt |
| `/stop` | Stop Claude + clear queue |
| `/latest` | Show latest Claude output while running |
| `/q message` | Queue a message for after current task |
| `/switch` | Switch project (picker or path) |
| `/branch` | Switch branch (picker) |
| `/model` | Switch model (Opus / Sonnet / Haiku) |
| `/system prompt` | Set a system prompt |
| `/system clear` | Clear system prompt |
| `/verbosity` | Tool call visibility (all / condensed / quiet) |
| `/usage` | Token usage and cost (`/usage reset` to clear) |
| `/commit` | Quick commit |
| `/cm message` | Commit with message |
| `/shipit` | Commit & push |
| `/push` `/pull` | Push / pull |
| `/diff` `/log` | Changes / last 15 commits |
| `/stash` `/stashpop` | Stash and pop |
| `/info` | Current settings at a glance |
| `/permissions` | Change permission mode |
| `/status` | Claude API status |
| `/menu` | Quick-access button menu |
| `/allowed id1,id2` | Whitelist chat IDs |
| `/ping` | Check if the bot is alive |

## Running

```bash
claude-telegram --setup     # Setup wizard (token, permissions, chat ID) + start
claude-telegram --start     # Start in background
claude-telegram --stop      # Stop
claude-telegram --logs      # Tail logs
claude-telegram --dev       # Dev mode (watch for changes, auto-restart)
```

Or with npm scripts:

```bash
npm run go        # First-time setup + start
npm start         # Start in background
npm run dev       # Dev mode
npm run stop      # Stop
npm run logs      # Tail logs
npm run restart   # Stop + start
```

The bot runs in the background and auto-restarts on crashes. No process manager needed.

## Config

All config lives in `~/.claude-telegram/.env` (auto-generated on first run). See [`.env.example`](.env.example) for all options.

```env
TELEGRAM_BOT_TOKEN=your-token
PROJECT_DIR=/path/to/default/project
PROJECTS_DIR=/path/to/parent/folder
ALLOWED_CHATS=123456789
VERBOSITY=condensed
PERMISSION_MODE=bypassPermissions
```

### Permission modes

Pick during setup, change anytime with `/permissions` or in `.env`:

| Mode | Value | What Claude can do |
|---|---|---|
| **Trust all** | `bypassPermissions` | Read, write, run any command. Best for personal projects. |
| **Accept edits** | `acceptEdits` | Read + edit files, approved commands only. No arbitrary shell. |
| **Plan mode** | `plan` | Read only. Claude suggests but can't modify anything. |

## How it works

```
claude-server.js
├── Long-polls Telegram's Bot API (Node's built-in https)
├── Spawns `claude` CLI as a child process per conversation
├── Parses stream-json output and edits a Telegram message in real-time
├── Shows live progress indicator with elapsed time and tool count
├── Handles file downloads, voice messages, git commands
├── Runs in the background with auto-restart (no process manager needed)
├── Backs off automatically when hitting Telegram's rate limits
└── Persists state to state.json, config to .env
```

No Express. No Telegraf. No node_modules. One file using Node.js built-ins: `https`, `child_process`, `fs`, `path`, `readline`.

## Security

- **Runs on your machine.** No server, no cloud, no middleman. Talks directly to Telegram's Bot API.
- **Chat ID whitelist.** Only IDs in `ALLOWED_CHATS` can interact with the bot. Setup captures yours automatically.
- **No secrets in code.** Tokens live in `.env`, which is gitignored.
- **No data collection.** No analytics, no telemetry, no phoning home.
- **Permission modes.** You choose how much access Claude gets — from full access to read-only.

> **Note:** Bot messages pass through Telegram's servers (not end-to-end encrypted). The Claude CLI sends prompts and file contents to Anthropic's API. This is the same as using Claude Code normally — Telegram is just the transport layer.

## Disclaimer

Independent open-source project. **Not** affiliated with Anthropic or Telegram.

**This bot can execute code and commands on your machine.** Depending on the permission mode, Claude may read, write, delete files and run shell commands. Use `plan` mode if you want read-only. You are responsible for reviewing what Claude does.

Provided "as is", without warranty. You are responsible for:
- Securing your bot token
- Managing Anthropic API costs
- Reviewing code changes
- Compliance with [Anthropic's](https://www.anthropic.com/policies/terms) and [Telegram's](https://telegram.org/tos) terms of service

## License

MIT

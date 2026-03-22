# claude-telegram

Control [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone. One file, no npm dependencies.

<!-- ADD IMAGE: screen recording or screenshot of a real conversation in Telegram showing streaming response -->

I wanted to use Claude Code from my phone — check on long tasks, fire off quick prompts from the couch, send a screenshot of a bug. So I built this: a single Node.js file that bridges Telegram to the Claude CLI. No frameworks, no `npm install`, no build step.

```
Your phone (Telegram) --> claude-server.js --> Claude CLI --> your codebase
                          ~1,500 lines
                          no npm dependencies
                          just Node.js built-ins
```

## Prerequisites

Before you start, make sure you have these installed and working:

1. **Node.js 18+** — [Download here](https://nodejs.org/). Check with `node -v`
2. **Claude Code (CLI)** — This project is a remote interface for Claude Code, so you need it installed and logged in **on the same machine** where the bot will run:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude  # this opens the browser auth flow — complete it
   ```
   After auth, run `claude -p "hello"` to confirm it works. If that prints a response, you're good. [Full docs here](https://docs.anthropic.com/en/docs/claude-code).
3. **pm2** — Process manager to keep the bot running in the background:
   ```bash
   npm install -g pm2
   ```
4. **A Telegram bot token** — Free, takes 30 seconds:
   - Open Telegram, search for [@BotFather](https://t.me/BotFather)
   - Send `/newbot`, pick a name, copy the token it gives you

That's everything. No API keys to configure, no cloud accounts, no Docker.

> The setup wizard checks for `claude` and `pm2` automatically and will tell you what's missing before going further.

## Quick start

```bash
git clone https://github.com/avaleriani/claude-telegram.git
cd claude-telegram
npm run go    # or: pnpm run go
```

The setup wizard will:
1. Check that `claude` and `pm2` are installed
2. Ask you to choose a permission mode (how much access Claude gets)
3. Ask for your bot token (the one from BotFather)
4. Wait for you to send any message in Telegram so it can grab your chat ID
5. Write `.env` and start the bot with pm2

After that, just send a message to your bot and Claude will respond.

## What it does

### Chat with your full codebase
Send any text and Claude responds with full access to your project files. It can read, edit, create files — same as Claude Code in the terminal. Conversations persist across messages, use `/new` to start fresh.

### Streaming
Responses stream into a single Telegram message that updates as Claude types. No message spam — one message, keeps updating until done. If Claude is working on something silently (running tools), you'll see a "working..." indicator so you know it's not stuck.

<!-- ADD IMAGE: screenshot showing a streaming response mid-update -->

### Files and voice
Drop a photo, PDF, or any document — it gets saved to your project directory. Add a caption like "fix the bug in this screenshot" and Claude processes it.

You can also send voice messages — the audio gets saved to your project and Claude is told you sent a voice note.

### Git from your phone

| Command | |
|---|---|
| `/commit` | Stage all + commit (message: "update") |
| `/cm fix the navbar` | Commit with a custom message |
| `/push` | Push current branch |
| `/pull` | Pull from remote |
| `/diff` | Show uncommitted changes |
| `/log` | Last 15 commits |
| `/branch` | Switch branch (shows a picker) |
| `/stash` / `/stashpop` | Stash and pop |

### Switch projects

| Command | |
|---|---|
| `/project` | Pick from projects in your folder |
| `/project /path/to/dir` | Set project directory directly |
| `/projectsdir /path` | Change the parent folder to scan |

### All commands

| Command | |
|---|---|
| `/new` | New conversation |
| `/retry` | Re-send last prompt |
| `/cancel` | Stop Claude mid-response |
| `/model` | Switch model (Opus / Sonnet / Haiku) |
| `/system prompt` | Set a system prompt |
| `/system clear` | Clear system prompt |
| `/verbosity` | Toggle tool call visibility (all / condensed / quiet) |
| `/usage` | Token usage and cost (`/usage reset` to clear) |
| `/info` | Current project, model, and all settings at a glance |
| `/permissions` | View/change permission mode (trust / edits / plan) |
| `/status` | Check Claude API status (hits status.anthropic.com) |
| `/menu` | Quick-access button menu |
| `/allowed id1,id2` | Whitelist additional chat IDs |
| `/ping` | Check if the bot is alive |
| `/help` | Show all commands |

## Running

```bash
npm run go        # First-time setup + start with pm2
npm start         # Start with pm2
npm run dev       # Dev mode (auto-restart on changes, logs in terminal)
npm stop          # Stop
npm restart       # Restart
npm run logs      # Tail logs
npm run status    # Check if running
```

The bot runs in the background via pm2 and auto-restarts on crashes.

## Config

All config lives in `.env` (auto-generated on first run). See [`.env.example`](.env.example) for all options with descriptions.

```env
TELEGRAM_BOT_TOKEN=your-token
PROJECT_DIR=/path/to/default/project
PROJECTS_DIR=/path/to/parent/folder
ALLOWED_CHATS=123456789
VERBOSITY=condensed              # all | condensed | quiet
PERMISSION_MODE=bypassPermissions # see below
```

### Permission modes

During setup you pick how much freedom Claude gets. You can change it anytime with `/permissions` or by editing `.env`:

| Mode | `PERMISSION_MODE` value | What Claude can do |
|---|---|---|
| **Trust all** | `bypassPermissions` | Read, write, run any command. Best for personal projects on your own machine. |
| **Accept edits** | `acceptEdits` | Read and edit files, but only approved commands. No arbitrary shell. |
| **Plan mode** | `plan` | Read only. Claude suggests changes but can't modify anything. |

See [`.env.example`](.env.example) for additional modes (`default`, `auto`, `dontAsk`).

## How it works

```
claude-server.js
├── Long-polls Telegram's Bot API (Node's built-in https)
├── Spawns `claude` CLI as a child process per conversation
├── Parses stream-json output and edits a Telegram message in real-time
├── Handles file downloads, voice messages, git commands
├── Backs off automatically when hitting Telegram's rate limits
└── Persists state to state.json, config to .env
```

No Express. No Telegraf. No node_modules. One file using only Node.js built-ins: `https`, `child_process`, `fs`, `path`, `readline`.

## Security & Privacy

This was built with privacy in mind. Some things worth knowing:

- **Everything runs on your machine.** There is no server, no cloud, no middleman. The bot process runs locally and talks directly to Telegram's Bot API.
- **Chat ID whitelist.** Only chat IDs listed in `ALLOWED_CHATS` can interact with the bot. Everyone else gets rejected. The setup wizard captures your ID automatically.
- **No secrets in code.** Tokens and config live in `.env`, which is gitignored.
- **No data collection.** This project doesn't phone home, doesn't have analytics, doesn't log anything except to your local console.
- **Permission modes.** You choose how much access Claude gets during setup — from full access down to read-only plan mode. Change anytime with `/permissions`.
- **Your code stays local.** Files are read and written by the Claude CLI on your machine. The only data that leaves your machine is whatever goes through the Telegram Bot API (your messages and Claude's responses) and Anthropic's API (via the Claude CLI).

> **Note:** Messages sent through Telegram pass through Telegram's servers. If your work is sensitive, be aware that Telegram can technically see the content of bot messages (bot chats are not end-to-end encrypted). The Claude CLI also sends your prompts and file contents to Anthropic's API. This is the same as using Claude Code normally — the Telegram bot just adds Telegram as a transport layer.

## Disclaimer

This is an independent open-source project. It is **not** affiliated with, endorsed by, or officially connected to Anthropic or Telegram in any way.

**This bot can execute code and commands on your machine.** Depending on the permission mode you choose, Claude may read, write, and delete files, run shell commands, and modify your codebase. Use the `plan` permission mode if you want to restrict Claude to read-only access. You are responsible for reviewing what Claude does — especially in `bypassPermissions` mode.

This software is provided "as is", without warranty of any kind. Use it at your own risk. The authors are not responsible for any damage, data loss, unintended code changes, costs incurred (including Anthropic API usage costs), or other issues arising from the use of this software.

You are responsible for:
- Securing your Telegram bot token (anyone with the token can control the bot)
- Managing your Anthropic API usage and associated costs
- Reviewing changes Claude makes to your code
- Ensuring compliance with [Anthropic's terms of service](https://www.anthropic.com/policies/terms) and [Telegram's terms of service](https://telegram.org/tos)

By using this bot, you acknowledge that your messages are transmitted through Telegram's servers and that prompts and file contents are sent to Anthropic's API for processing, subject to their respective privacy policies.

## License

MIT

#!/usr/bin/env node
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Config ---

const STATE_FILE = path.join(__dirname, 'state.json');
const ENV_FILE = path.join(__dirname, '.env');
const PID_FILE = path.join(__dirname, '.bot.pid');
const LOG_FILE = path.join(__dirname, 'bot.log');
const PERM_LABELS = { bypassPermissions: 'Trust all', acceptEdits: 'Accept edits only', plan: 'Plan mode' };
const STREAM_EDIT_THROTTLE = 1500;

function loadEnv() {
    if (!fs.existsSync(ENV_FILE)) return;
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
    }
}

function setEnv(key, value) {
    process.env[key] = value;
    let lines = [];
    if (fs.existsSync(ENV_FILE)) {
        lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    }
    let found = false;
    lines = lines.map(line => {
        if (line.match(new RegExp(`^\\s*${key}\\s*=`))) {
            found = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!found) lines.push(`${key}=${value}`);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
}

const readline = require('readline');

function askInput(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

loadEnv();

let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function ensureToken() {
    if (BOT_TOKEN) return;
    console.log('No bot token found.\n');
    console.log('1. Open Telegram and talk to @BotFather');
    console.log('2. Send /newbot and follow the steps');
    console.log('3. Copy the token and paste it below\n');
    BOT_TOKEN = await askInput('Bot token: ');
    if (!BOT_TOKEN) { console.error('No token provided.'); process.exit(1); }
    setEnv('TELEGRAM_BOT_TOKEN', BOT_TOKEN);
    console.log('Token saved to .env\n');
}

// --- Telegram helpers ---

let streamEditThrottle = STREAM_EDIT_THROTTLE;

function telegramRequest(method, body, _retries = 0) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, res => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(buf);
                    if (parsed?.error_code === 429 && _retries < 3) {
                        const wait = (parsed.parameters?.retry_after || 1) * 1000;
                        // Back off streaming edits when rate limited
                        streamEditThrottle = Math.min(streamEditThrottle + 500, 5000);
                        console.log(`[Telegram] Rate limited, waiting ${wait}ms (throttle now ${streamEditThrottle}ms)`);
                        setTimeout(() => telegramRequest(method, body, _retries + 1).then(resolve, reject), wait);
                    } else {
                        // Gradually recover throttle back to default
                        if (streamEditThrottle > STREAM_EDIT_THROTTLE) {
                            streamEditThrottle = Math.max(streamEditThrottle - 100, STREAM_EDIT_THROTTLE);
                        }
                        resolve(parsed);
                    }
                } catch { resolve(null); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function telegramDownload(filePath) {
    return new Promise((resolve, reject) => {
        https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
    });
}

function telegramSendFile(chatId, localPath, { method = 'sendDocument', fieldName = 'document', contentType = 'application/octet-stream', caption } = {}) {
    return new Promise((resolve, reject) => {
        const fileName = path.basename(localPath);
        const fileData = fs.readFileSync(localPath);
        const boundary = '----FormBoundary' + Date.now().toString(36);

        let body = '';
        body += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
        if (caption) body += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`;
        const tail = `\r\n--${boundary}--\r\n`;

        const bodyBuf = Buffer.concat([Buffer.from(body), fileData, Buffer.from(tail)]);

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length }
        }, res => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
        });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });
}

function telegramSendDocument(chatId, localPath, caption) {
    return telegramSendFile(chatId, localPath, { caption });
}

function telegramSendVoice(chatId, localPath) {
    return telegramSendFile(chatId, localPath, { method: 'sendVoice', fieldName: 'voice', contentType: 'audio/ogg' });
}

// --- First-run setup ---

function checkDependency(cmd, name, installHint) {
    try {
        require('child_process').execSync(`which ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch {
        console.error(`\u274C ${name} not found. Install it first:\n   ${installHint}\n`);
        return false;
    }
}

async function setup() {
    console.log('\n=== FIRST-RUN SETUP ===\n');

    // Check dependencies
    let ok = true;
    if (!checkDependency('claude', 'Claude CLI', 'npm install -g @anthropic-ai/claude-code')) ok = false;
    if (!ok) {
        console.log('Install the missing dependencies above and run again.');
        process.exit(1);
    }
    console.log('\u2705 Dependencies OK\n');

    // Permission mode selection
    console.log('How should Claude handle permissions?\n');
    console.log('  1. Trust all (default)');
    console.log('     Claude can read, write, and run commands freely.');
    console.log('     Best for personal projects on your own machine.\n');
    console.log('  2. Accept edits only');
    console.log('     Claude can read and edit files, but must use approved');
    console.log('     commands only. Blocks arbitrary shell commands.\n');
    console.log('  3. Plan mode');
    console.log('     Claude can only read files and suggest changes.');
    console.log('     Nothing gets modified without you doing it yourself.\n');

    const modeChoice = await askInput('Choose (1/2/3, default 1): ');
    const modeMap = { '1': 'bypassPermissions', '2': 'acceptEdits', '3': 'plan' };
    const permissionMode = modeMap[modeChoice] || 'bypassPermissions';

    console.log(`\nPermission mode: ${PERM_LABELS[permissionMode]}`);
    console.log('You can change this later in .env (PERMISSION_MODE)\n');

    console.log('Almost done! Open your bot on Telegram and send any message.');
    console.log('This lets the bot detect your chat ID.\n');
    console.log('Waiting for your message...\n');

    let setupOffset = 0;
    while (true) {
        try {
            const res = await telegramRequest('getUpdates', {
                offset: setupOffset, timeout: 30, allowed_updates: ['message']
            });
            if (!res || !res.ok || !res.result) continue;

            for (const update of res.result) {
                setupOffset = update.update_id + 1;
                const msg = update.message;
                if (!msg) continue;

                const chatId = msg.chat.id;
                const name = msg.from.first_name || 'there';
                const projectsDir = path.dirname(process.cwd());

                await telegramRequest('sendMessage', {
                    chat_id: chatId,
                    text: `Hey ${name}! Setting up your Claude bot.\n\nChat ID: ${chatId}\nProject: ${process.cwd()}\nProjects folder: ${projectsDir}\nPermissions: ${PERM_LABELS[permissionMode]}\n\nWriting .env...`
                });

                fs.writeFileSync(ENV_FILE, [
                    `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`,
                    `PROJECT_DIR=${process.cwd()}`,
                    `PROJECTS_DIR=${projectsDir}`,
                    `ALLOWED_CHATS=${chatId}`,
                    `VERBOSITY=condensed`,
                    `PERMISSION_MODE=${permissionMode}`,
                ].join('\n') + '\n');

                await telegramRequest('sendMessage', {
                    chat_id: chatId, text: '\u2705 Done! Bot is starting.'
                });

                console.log(`.env written. Chat ID: ${chatId}\nPermission mode: ${permissionMode}\nStarting bot...\n`);
                return;
            }
        } catch (err) {
            console.error('Setup error:', err.message);
        }
    }
}

// --- Main bot ---

async function startBot() {

loadEnv();

const DEFAULT_PROJECT = process.env.PROJECT_DIR || process.cwd();
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.dirname(DEFAULT_PROJECT);
let ALLOWED_CHATS = process.env.ALLOWED_CHATS
    ? process.env.ALLOWED_CHATS.split(',').map(Number)
    : [];

// --- State ---

const DEFAULT_STATE = { sessions: {}, projects: {}, systemPrompts: {}, models: {}, verbosity: {}, lastPrompts: {} };
let state = { ...DEFAULT_STATE };

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
        }
    } catch {}
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

loadState();

const busy = {};
const procs = {};
const queues = {}; // per-chat message queue
const liveText = {}; // per-chat latest streamed text from Claude

function enqueue(chatId, prompt, fileContext) {
    if (!queues[chatId]) queues[chatId] = [];
    queues[chatId].push({ prompt, fileContext });
    const total = queues[chatId].length;
    send(chatId, `📋 _Queued (${total} pending):_ ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
}

function processQueue(chatId) {
    if (!queues[chatId] || queues[chatId].length === 0) return;
    if (busy[chatId]) return;
    const next = queues[chatId].shift();
    send(chatId, `📋 _Running queued message (${queues[chatId].length} remaining)_`);
    runClaude(chatId, next.prompt, next.fileContext);
}

let cbIdCounter = 0;
const cbRegistry = {};
function registerCallback(prefix, value) {
    const key = `${prefix}:${cbIdCounter++}`;
    cbRegistry[key] = value;
    return key;
}
function resolveCallback(key) { return cbRegistry[key]; }

function getProject(chatId) {
    return state.projects[chatId] || DEFAULT_PROJECT;
}

function isAllowed(chatId) {
    return ALLOWED_CHATS.length === 0 || ALLOWED_CHATS.includes(chatId);
}

function getVerbosity(chatId) {
    return state.verbosity[chatId] || process.env.VERBOSITY || 'condensed';
}

// --- Markdown sanitization ---

function sanitizeMarkdown(text) {
    let result = text;

    // Fix unclosed code blocks
    const codeBlocks = result.match(/```/g) || [];
    if (codeBlocks.length % 2 !== 0) result += '\n```';

    // Fix unclosed inline code (outside code blocks)
    let outside = result.replace(/```[\s\S]*?```/g, '');
    const inlineTicks = (outside.match(/`/g) || []).length;
    if (inlineTicks % 2 !== 0) result += '`';

    return result;
}

// --- Send helpers ---

function sendChunked(chatId, text, extra = {}) {
    const str = String(text);
    if (!str) return telegramRequest('sendMessage', { chat_id: chatId, text: '(empty)', ...extra });

    const chunks = [];
    let remaining = str;
    while (remaining.length > 0) {
        if (remaining.length <= 4096) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', 4096);
        if (splitAt < 2048) splitAt = 4096;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }

    let chain = Promise.resolve();
    const results = [];
    for (const chunk of chunks) {
        chain = chain.then(() =>
            telegramRequest('sendMessage', { chat_id: chatId, text: chunk, ...extra })
                .then(r => { results.push(r); return r; })
        );
    }
    return chain.then(() => results);
}

function send(chatId, text, extra = {}) {
    const sanitized = sanitizeMarkdown(String(text));
    return sendChunked(chatId, sanitized, { parse_mode: 'Markdown', ...extra }).catch(() =>
        sendChunked(chatId, String(text), extra)
    );
}

function editMsg(chatId, messageId, text, extra = {}) {
    const sanitized = sanitizeMarkdown(String(text));
    const parseMode = extra.parse_mode !== undefined ? extra.parse_mode : 'Markdown';
    const baseOpts = {
        chat_id: chatId,
        message_id: messageId,
        ...extra
    };
    delete baseOpts.parse_mode;

    if (!parseMode) {
        // Plain text edit — no markdown parsing, won't fail on partial markdown
        return telegramRequest('editMessageText', {
            ...baseOpts,
            text: String(text).slice(0, 4096),
        }).catch(() => {});
    }

    return telegramRequest('editMessageText', {
        ...baseOpts,
        text: sanitized.slice(0, 4096),
        parse_mode: parseMode,
    }).catch(() =>
        telegramRequest('editMessageText', {
            ...baseOpts,
            text: String(text).slice(0, 4096),
        }).catch(() => {})
    );
}

// --- File handling ---

async function downloadTelegramFile(fileId, destDir) {
    const fileInfo = await telegramRequest('getFile', { file_id: fileId });
    if (!fileInfo?.ok) return null;
    const tgPath = fileInfo.result.file_path;
    const ext = path.extname(tgPath) || '.bin';
    const fileName = `telegram_${Date.now()}${ext}`;
    const destPath = path.join(destDir, fileName);
    const data = await telegramDownload(tgPath);
    fs.writeFileSync(destPath, data);
    return { fileName, destPath, size: data.length };
}

async function handleVoiceMessage(chatId, fileId) {
    const projectDir = getProject(chatId);
    const file = await downloadTelegramFile(fileId, projectDir);
    if (!file) { send(chatId, 'Failed to download voice message'); return; }

    const sizeKb = Math.round(file.size / 1024);
    send(chatId, `\uD83C\uDFA4 Voice saved: \`${file.fileName}\` (${sizeKb}KB)`);
    return `[Voice message saved as ${file.fileName} in project directory (${sizeKb}KB). The user sent an audio/voice message.]`;
}

// Track files modified by Claude to offer sending them back
function getModifiedFiles(projectDir, since) {
    try {
        const proc = spawn('find', [projectDir, '-maxdepth', '3', '-type', 'f', '-newer', since, '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*'], { timeout: 10000 });
        return new Promise(resolve => {
            let out = '';
            proc.stdout.on('data', d => out += d.toString());
            proc.on('close', () => {
                const files = out.trim().split('\n').filter(f => f);
                resolve(files);
            });
        });
    } catch { return Promise.resolve([]); }
}

// --- Pickers ---

function listDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
            .map(d => ({ name: d.name, path: path.join(dir, d.name) }));
    } catch { return []; }
}

function sendProjectPicker(chatId, browseDir) {
    const dir = browseDir || PROJECTS_DIR;
    const dirs = listDirs(dir);
    const current = getProject(chatId);
    const buttons = [];

    // "Select this folder" button if we're browsing into a subfolder
    if (dir !== PROJECTS_DIR) {
        const isCurrent = dir === current;
        buttons.push([{ text: isCurrent ? '> SELECT THIS FOLDER' : 'SELECT THIS FOLDER', callback_data: registerCallback('project', dir) }]);
    }

    // Parent directory button
    const parent = path.dirname(dir);
    if (parent !== dir) {
        buttons.push([{ text: '.. (up)', callback_data: registerCallback('browse', parent) }]);
    }

    // Subdirectories (limit to 20 to avoid Telegram button limits)
    for (const d of dirs.slice(0, 20)) {
        const hasChildren = listDirs(d.path).length > 0;
        const isCurrent = d.path === current;
        const label = (isCurrent ? '> ' : '') + d.name + (hasChildren ? ' /' : '');
        // If it has children, browse into it. Otherwise select it directly.
        if (hasChildren) {
            buttons.push([
                { text: label, callback_data: registerCallback('browse', d.path) },
                { text: 'Select', callback_data: registerCallback('project', d.path) }
            ]);
        } else {
            buttons.push([{ text: label, callback_data: registerCallback('project', d.path) }]);
        }
    }

    if (buttons.length === 0) return send(chatId, `No folders in \`${dir}\``);

    const relPath = path.relative(PROJECTS_DIR, dir) || '.';
    send(chatId, `Current: *${path.basename(current)}*\nBrowsing: \`${relPath}\``, {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
    });
}

const MODELS = [
    { name: 'Opus 4', id: 'claude-opus-4-0-20250514' },
    { name: 'Sonnet 4', id: 'claude-sonnet-4-20250514' },
    { name: 'Haiku 3.5', id: 'claude-haiku-4-5-20251001' },
];

function sendModelPicker(chatId) {
    const current = state.models[chatId] || 'default';
    const buttons = MODELS.map(m => {
        const label = m.id === current ? `> ${m.name}` : m.name;
        return [{ text: label, callback_data: registerCallback('model', m.id) }];
    });
    buttons.push([{ text: current !== 'default' ? 'Default' : '> Default', callback_data: registerCallback('model', 'default') }]);
    send(chatId, `Current model: *${current}*\nSelect:`, {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
    });
}

const VERBOSITY_MODES = [
    { name: 'All', id: 'all', desc: 'Every tool call shown' },
    { name: 'Condensed', id: 'condensed', desc: 'Clean, no tool spam' },
    { name: 'Quiet', id: 'quiet', desc: 'Only start & finish' },
];

function sendVerbosityPicker(chatId) {
    const current = getVerbosity(chatId);
    const buttons = VERBOSITY_MODES.map(m => {
        const label = m.id === current ? `> ${m.name} - ${m.desc}` : `${m.name} - ${m.desc}`;
        return [{ text: label, callback_data: registerCallback('verbosity', m.id) }];
    });
    send(chatId, `Tool messages: *${current}*\nSelect verbosity:`, {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
    });
}

function sendBranchPicker(chatId) {
    const cwd = getProject(chatId);
    const proc = spawn('git', ['branch', '-a'], { cwd, timeout: 15000 });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', () => {
        const branches = out.trim().split('\n')
            .map(b => b.trim().replace(/^\* /, ''))
            .filter(b => b && !b.includes('->') && !b.startsWith('remotes/'));
        if (branches.length === 0) return send(chatId, 'No branches found');
        const current = out.trim().split('\n').find(b => b.trim().startsWith('* '))?.trim().slice(2) || '';
        const buttons = branches.slice(0, 20).map(b => {
            const label = b === current ? `> ${b}` : b;
            return [{ text: label, callback_data: registerCallback('branch', b) }];
        });
        send(chatId, `Current: *${current}*\nSelect branch:`, {
            reply_markup: JSON.stringify({ inline_keyboard: buttons })
        });
    });
}

// --- Git helpers ---

function runGit(chatId, args, label) {
    const cwd = getProject(chatId);
    const proc = spawn('git', args, { cwd, timeout: 30000 });
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', () => {
        send(chatId, `*${label}*\n\`\`\`\n${output.trim() || '(empty)'}\n\`\`\``);
    });
}

function runShellGit(chatId, script, done) {
    if (busy[chatId]) return send(chatId, 'A task is already running, please wait...');
    busy[chatId] = true;
    const cwd = getProject(chatId);
    const proc = spawn('bash', ['-c', script], { cwd, timeout: 60000 });
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', (code) => { busy[chatId] = false; done(code, output.trim()); });
}

function runCommit(chatId, msg) {
    send(chatId, '\uD83D\uDCBE Committing...');
    const commitMsg = msg || 'update';
    const script = `
        git add -A &&
        STAT=$(git diff --cached --stat | tail -1) &&
        if [ -z "$STAT" ]; then echo "NO_CHANGES"
        else git commit -m "${commitMsg.replace(/"/g, '\\"')}" && echo "COMMITTED"
        fi
    `;
    runShellGit(chatId, script, (code, out) => {
        if (out.includes('NO_CHANGES')) send(chatId, '_Nothing to commit._');
        else if (out.includes('COMMITTED')) send(chatId, `\u2705 Committed: *${commitMsg}*`);
        else send(chatId, `\u274C Commit failed:\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    });
}

function runPush(chatId) {
    send(chatId, '\u2B06\uFE0F Pushing...');
    const script = `BRANCH=$(git rev-parse --abbrev-ref HEAD) && git push origin "$BRANCH" && echo "PUSHED:$BRANCH"`;
    runShellGit(chatId, script, (code, out) => {
        if (out.includes('PUSHED:')) {
            const branch = out.match(/PUSHED:(.+)/)?.[1]?.trim();
            send(chatId, `\u2705 Pushed to *${branch}*`);
        } else send(chatId, `\u274C Push failed:\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    });
}

function runCommitAndPush(chatId, msg) {
    send(chatId, '\uD83D\uDE80 Committing & pushing...');
    const commitMsg = msg || 'update';
    const script = `
        git add -A &&
        STAT=$(git diff --cached --stat | tail -1) &&
        if [ -z "$STAT" ]; then echo "NO_CHANGES"
        else
            git commit -m "${commitMsg.replace(/"/g, '\\"')}" &&
            BRANCH=$(git rev-parse --abbrev-ref HEAD) &&
            git push origin "$BRANCH" &&
            echo "DONE:$BRANCH"
        fi
    `;
    runShellGit(chatId, script, (code, out) => {
        if (out.includes('NO_CHANGES')) send(chatId, '_Nothing to commit._');
        else if (out.includes('DONE:')) {
            const branch = out.match(/DONE:(.+)/)?.[1]?.trim();
            send(chatId, `\u2705 Committed & pushed to *${branch}*`);
        } else send(chatId, `\u274C Failed:\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    });
}

function runPull(chatId) {
    send(chatId, '\u2B07\uFE0F Pulling...');
    runShellGit(chatId, 'git pull && echo "PULLED"', (code, out) => {
        if (out.includes('PULLED')) send(chatId, `\u2705 Pulled:\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
        else send(chatId, `\u274C Pull failed:\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    });
}

// --- Claude CLI ---

function runClaude(chatId, prompt, fileContext) {
    if (busy[chatId]) {
        enqueue(chatId, prompt, fileContext);
        return;
    }
    busy[chatId] = true;

    // Save last prompt for /retry
    state.lastPrompts[chatId] = prompt;
    saveState();

    // Session indicator
    const projectName = path.basename(getProject(chatId));
    const resuming = !!state.sessions[chatId];
    const verbosity = getVerbosity(chatId);
    console.log(`[Claude] chat=${chatId} verbosity=${verbosity} resuming=${resuming} project=${projectName}`);

    const permMode = process.env.PERMISSION_MODE || 'bypassPermissions';
    const args = ['--permission-mode', permMode, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (state.models[chatId]) args.push('--model', state.models[chatId]);

    if (state.systemPrompts[chatId] && !resuming) args.push('--system-prompt', state.systemPrompts[chatId]);
    if (resuming) args.push('--resume', state.sessions[chatId]);

    const fullPrompt = fileContext ? `${fileContext}\n\n${prompt}` : prompt;
    args.push('-p', fullPrompt);

    const cwd = getProject(chatId);

    // Create a timestamp file to track modified files
    const tsFile = path.join(cwd, `.claude_ts_${Date.now()}`);
    try { fs.writeFileSync(tsFile, ''); } catch {}

    const proc = spawn('claude', args, { cwd, timeout: 600000 });
    procs[chatId] = proc;

    proc.on('error', err => {
        clearInterval(streamTimer);
        clearInterval(thinkTimer);
        if (err.code === 'ENOENT') {
            send(chatId, '\u274C *Claude CLI not found.*\n\nMake sure it\'s installed and in your PATH:\n```\nnpm install -g @anthropic-ai/claude-code\nclaude --version\n```');
        } else {
            send(chatId, `\u274C Failed to start Claude: ${err.message}`);
        }
        delete procs[chatId];
        delete liveText[chatId];
        busy[chatId] = false;
        processQueue(chatId);
    });

    let buffer = '';
    let gotResponse = false;
    let toolCount = 0;
    let stderrBuf = '';

    // Live message — shows progress, then streaming text, then collapses to summary
    let liveMsgId = null;
    let liveMsgReady = false;
    const startTime = Date.now();

    // Accumulated response text (full, for sending as final message)
    let fullText = '';
    liveText[chatId] = '';
    // Visible portion for the live message (tail end, fits in 4096)
    let streamDirty = false;
    let lastEdit = 0;
    let streamTimer = null;

    // Send initial live message
    const statusPromise = telegramRequest('sendMessage', {
        chat_id: chatId, text: '⏳ _thinking._', parse_mode: 'Markdown'
    }).then(res => {
        if (res?.ok) {
            liveMsgId = res.result.message_id;
            liveMsgReady = true;
        }
    });

    // Animated progress indicator — updates the live message
    let dotCount = 1;
    const thinkTimer = setInterval(() => {
        if (!busy[chatId] || !liveMsgReady) return;
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const extra = toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? 's' : ''}` : '';

        if (fullText) {
            // Already streaming text — show it with a progress footer
            const footer = `\n\n_⏳ ${elapsed}s${extra}_`;
            const available = 4096 - footer.length;
            const visible = fullText.length > available ? '...' + fullText.slice(-(available - 3)) : fullText;
            editMsg(chatId, liveMsgId, visible + footer, { parse_mode: null });
        } else {
            // No text yet — just show thinking indicator
            editMsg(chatId, liveMsgId, `⏳ _thinking${dots}_ ${elapsed}s${extra}`, { parse_mode: 'Markdown' });
        }
    }, 2000);

    function flushStream() {
        if (!streamDirty || !liveMsgReady || !fullText) return;
        const now = Date.now();
        if (now - lastEdit < streamEditThrottle) return;

        streamDirty = false;
        lastEdit = now;

        const elapsed = Math.round((now - startTime) / 1000);
        const extra = toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? 's' : ''}` : '';
        const footer = `\n\n_⏳ ${elapsed}s${extra}_`;
        const available = 4096 - footer.length;
        const visible = fullText.length > available ? '...' + fullText.slice(-(available - 3)) : fullText;
        editMsg(chatId, liveMsgId, visible + footer, { parse_mode: null });
    }

    streamTimer = setInterval(flushStream, STREAM_EDIT_THROTTLE);


    proc.stdout.on('data', data => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line);

                if (event.type === 'result') {
                    if (event.session_id) {
                        state.sessions[chatId] = event.session_id;
                        saveState();
                    }
                    if (event.usage) {
                        if (!state.usage) state.usage = {};
                        const prev = state.usage[chatId] || { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost: 0 };
                        const u = event.usage;
                        state.usage[chatId] = {
                            input: prev.input + (u.input_tokens || 0),
                            output: prev.output + (u.output_tokens || 0),
                            cache_read: prev.cache_read + (u.cache_read_input_tokens || 0),
                            cache_creation: prev.cache_creation + (u.cache_creation_input_tokens || 0),
                            cost: +(prev.cost + (u.cost_usd || 0)).toFixed(4),
                        };
                        saveState();
                    }
                }

                // Incremental streaming via stream_event
                if (event.type === 'stream_event' && event.event) {
                    const se = event.event;
                    if (se.type === 'content_block_delta' && se.delta) {
                        if (se.delta.type === 'text_delta' && se.delta.text) {
                            gotResponse = true;
                            fullText += se.delta.text;
                            liveText[chatId] = fullText;
                            streamDirty = true;
                        }
                    }
                }

                // Full assistant message (emitted at end of turn)
                if (event.type === 'assistant' && event.message && event.message.content) {
                    for (const block of event.message.content) {
                        if (block.type === 'text' && block.text) {
                            gotResponse = true;
                            fullText = block.text;
                            liveText[chatId] = fullText;
                            streamDirty = true;
                        }
                        if (block.type === 'tool_use') {
                            toolCount++;
                            if (verbosity === 'all') {
                                send(chatId, `\`[tool]\` ${block.name}...`);
                            }
                        }
                    }
                }
            } catch {}
        }
    });

    proc.stderr.on('data', data => {
        stderrBuf += data.toString();
    });

    proc.on('close', async () => {
        clearInterval(streamTimer);
        clearInterval(thinkTimer);

        // Wait for the live message to be ready if it hasn't resolved yet
        await statusPromise;

        // Finalize live message — keep the text, just remove the progress footer
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        const toolStr = toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? 's' : ''}` : '';

        if (fullText && liveMsgId) {
            // Edit live message to show clean final text (no progress footer)
            editMsg(chatId, liveMsgId, fullText);
        } else if (!gotResponse) {
            const errMsg = stderrBuf.trim();
            const failText = errMsg
                ? `Claude failed:\n\`\`\`\n${errMsg.slice(0, 2000)}\n\`\`\``
                : 'Claude finished without a response';
            if (liveMsgId) {
                editMsg(chatId, liveMsgId, failText);
            } else {
                send(chatId, failText);
            }
        }

        // Send summary as a small follow-up
        const summary = gotResponse
            ? `✅ _done in ${timeStr}${toolStr}_`
            : `❌ _failed after ${timeStr}_`;
        send(chatId, summary);

        // Send back files that were created/modified during the session
        const showFiles = (process.env.SHOW_MODIFIED_FILES || 'false').toLowerCase() === 'true';
        try {
            if (!showFiles) throw 'skip';
            const modified = await getModifiedFiles(cwd, tsFile);
            // Filter out hidden/temp files
            const interesting = modified.filter(f =>
                !path.basename(f).startsWith('.claude_ts_') &&
                !path.basename(f).startsWith('.') &&
                !f.includes('node_modules') &&
                fs.statSync(f).size < 10 * 1024 * 1024 // < 10MB
            );
            if (interesting.length > 0 && interesting.length <= 10) {
                const buttons = interesting.map(f => {
                    const rel = path.relative(cwd, f);
                    return [{ text: rel, callback_data: registerCallback('sendfile', f) }];
                });
                // Add commit & push button
                buttons.push([{ text: '\uD83D\uDE80 Commit & Push', callback_data: registerCallback('commitpush', 'update') }]);
                send(chatId, `\uD83D\uDCCE _${interesting.length} file(s) modified:_`, {
                    reply_markup: JSON.stringify({ inline_keyboard: buttons })
                });
            }
        } catch {}

        // Clean up timestamp file
        try { fs.unlinkSync(tsFile); } catch {}

        delete procs[chatId];
        delete liveText[chatId];
        busy[chatId] = false;

        // Process next queued message
        processQueue(chatId);
    });
}

// --- Claude Status ---

function checkClaudeStatus(chatId) {
    send(chatId, '\uD83D\uDD0D Checking Claude status...');

    function fetchStatus(hostname, redirects = 0) {
        if (redirects > 3) { send(chatId, '\u274C Too many redirects'); return; }
        const req = https.request({
            hostname,
            path: '/api/v2/summary.json',
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                try {
                    const url = new URL(res.headers.location);
                    fetchStatus(url.hostname, redirects + 1);
                } catch { send(chatId, '\u274C Bad redirect URL'); }
                return;
            }
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => {
                try {
                    const data = JSON.parse(buf);
                    const status = data.status?.description || 'Unknown';
                    const indicator = data.status?.indicator || 'none';
                    const icons = { none: '\u2705', minor: '\u26A0\uFE0F', major: '\u274C', critical: '\uD83D\uDD34' };
                    const icon = icons[indicator] || '';

                    let text = `${icon} *${status}*\n`;

                    if (data.components?.length) {
                        const relevant = data.components.filter(c => !c.group_id);
                        for (const c of relevant) {
                            const cIcon = c.status === 'operational' ? '\u2705' : '\u26A0\uFE0F';
                            text += `${cIcon} ${c.name}: _${c.status.replace(/_/g, ' ')}_\n`;
                        }
                    }

                    if (data.incidents?.length) {
                        text += '\n*Active Incidents:*\n';
                        for (const inc of data.incidents.slice(0, 3)) {
                            const latest = inc.incident_updates?.[0];
                            text += `\u26A0\uFE0F *${inc.name}*\n`;
                            if (latest) text += `  _${latest.body.slice(0, 200)}_\n`;
                        }
                    }

                    send(chatId, text);
                } catch {
                    send(chatId, '\u274C Failed to parse status response');
                }
            });
        });
        req.on('error', err => send(chatId, `\u274C Status check failed: ${err.message}`));
        req.end();
    }

    fetchStatus('status.anthropic.com');
}

// --- Menu ---

const MENU_ITEMS = [
    { text: '\uD83E\uDD16 Model', data: 'menu_model' },
    { text: '\uD83D\uDCDD System Prompt', data: 'menu_system' },
    { text: '\uD83D\uDD08 Verbosity', data: 'menu_verbosity' },
    { text: '\uD83D\uDCE6 Stash', data: 'menu_stash' },
    { text: '\uD83D\uDCE4 Stash Pop', data: 'menu_stashpop' },
];

function sendMenu(chatId) {
    const buttons = MENU_ITEMS.map(item => [{ text: item.text, callback_data: registerCallback('menu', item.data) }]);
    send(chatId, '\u2699\uFE0F *Quick menu*', {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
    });
}

// --- Command handler ---

function handleCommand(chatId, cmd, args) {
    switch (cmd) {
        case 'new':
            delete state.sessions[chatId];
            saveState();
            send(chatId, '\u2728 New conversation started.');
            break;

        case 'list': {
            const keys = Object.keys(state.sessions);
            if (keys.length === 0) send(chatId, 'No active sessions');
            else {
                const lines = keys.map(id => `- Chat \`${id}\`: \`${state.sessions[id]}\``);
                send(chatId, `Active sessions:\n${lines.join('\n')}`);
            }
            break;
        }

        case 'retry': {
            const lastPrompt = state.lastPrompts[chatId];
            if (!lastPrompt) {
                send(chatId, 'Nothing to retry');
            } else {
                send(chatId, `Retrying: _${lastPrompt.slice(0, 100)}${lastPrompt.length > 100 ? '...' : ''}_`);
                runClaude(chatId, lastPrompt);
            }
            break;
        }

        case 'commit':
            runCommit(chatId, args || null);
            break;

        case 'cm':
            // Commit with custom message (required)
            if (!args) {
                send(chatId, 'Usage: `/cm your commit message here`');
            } else {
                runCommit(chatId, args);
            }
            break;

        case 'push':
            runPush(chatId);
            break;

        case 'shipit':
            runCommitAndPush(chatId, args || 'update');
            break;

        case 'pull':
            runPull(chatId);
            break;

        case 'status':
            checkClaudeStatus(chatId);
            break;

        case 'log':
            runGit(chatId, ['log', '--oneline', '-15'], 'Recent commits');
            break;

        case 'diff':
            runGit(chatId, ['diff', '--stat'], 'Uncommitted changes');
            break;

        case 'branch':
            if (args) {
                const cwd = getProject(chatId);
                const proc = spawn('git', ['checkout', args], { cwd, timeout: 15000 });
                let out = '';
                proc.stdout.on('data', d => out += d.toString());
                proc.stderr.on('data', d => out += d.toString());
                proc.on('close', () => send(chatId, `\`\`\`\n${out.trim()}\n\`\`\``));
            } else {
                sendBranchPicker(chatId);
            }
            break;

        case 'stop':
        case 'cancel':
            if (procs[chatId]) {
                procs[chatId].kill('SIGTERM');
                const cleared = queues[chatId]?.length || 0;
                if (cleared) queues[chatId] = [];
                send(chatId, `\u23F9 Stopped.${cleared ? ` ${cleared} queued message(s) cleared.` : ''}`);
            }
            else send(chatId, '_Nothing running._');
            break;

        case 'latest':
            if (!busy[chatId]) {
                send(chatId, '_Claude is not running._');
            } else if (!liveText[chatId]) {
                send(chatId, '_No output yet — still thinking..._');
            } else {
                const text = liveText[chatId];
                const truncated = text.length > 4000 ? '...' + text.slice(-3997) : text;
                send(chatId, truncated);
            }
            break;

        case 'q':
            if (!args) {
                const qLen = queues[chatId]?.length || 0;
                send(chatId, qLen ? `📋 _${qLen} message(s) in queue_` : '_Queue is empty._');
            } else {
                enqueue(chatId, args);
            }
            break;

        case 'switch':
        case 'project':
            if (!args) {
                sendProjectPicker(chatId);
            } else {
                const resolved = path.resolve(args);
                if (!fs.existsSync(resolved)) send(chatId, `Not found: \`${resolved}\``);
                else if (!fs.statSync(resolved).isDirectory()) send(chatId, `Not a directory: \`${resolved}\``);
                else {
                    state.projects[chatId] = resolved;
                    delete state.sessions[chatId];
                    saveState();
                    setEnv('PROJECT_DIR', resolved);
                    send(chatId, `\uD83D\uDCC2 Project: *${path.basename(resolved)}*\n_Session reset. Saved to .env._`);
                }
            }
            break;

        case 'model':
            if (!args) {
                sendModelPicker(chatId);
            } else {
                state.models[chatId] = args;
                saveState();
                send(chatId, `\uD83E\uDD16 Model: *${args}*`);
            }
            break;

        case 'system':
            if (!args) {
                const cur = state.systemPrompts[chatId];
                send(chatId, cur ? `System prompt:\n\`\`\`\n${cur}\n\`\`\`` : 'No system prompt set. Use `/system your prompt here`');
            } else if (args === 'clear') {
                delete state.systemPrompts[chatId];
                saveState();
                send(chatId, 'System prompt cleared');
            } else {
                state.systemPrompts[chatId] = args;
                saveState();
                send(chatId, `System prompt set:\n\`\`\`\n${args}\n\`\`\``);
            }
            break;

        case 'verbosity':
            if (!args) {
                sendVerbosityPicker(chatId);
            } else if (['all', 'condensed', 'quiet'].includes(args)) {
                state.verbosity[chatId] = args;
                saveState();
                send(chatId, `\uD83D\uDD08 Verbosity: *${args}*`);
            } else {
                send(chatId, 'Options: `all`, `condensed`, `quiet`');
            }
            break;

        case 'usage': {
            const u = state.usage?.[chatId];
            if (!u) {
                send(chatId, '_No usage tracked yet._');
            } else {
                const lines = [
                    `\uD83D\uDCCA *Usage*`,
                    ``,
                    `\u2022 Input: \`${u.input.toLocaleString()}\` tokens`,
                    `\u2022 Output: \`${u.output.toLocaleString()}\` tokens`,
                    `\u2022 Cache read: \`${u.cache_read.toLocaleString()}\` tokens`,
                    `\u2022 Cache creation: \`${u.cache_creation.toLocaleString()}\` tokens`,
                    `\u2022 Cost: *$${u.cost.toFixed(4)}*`,
                ];
                if (args === 'reset') {
                    delete state.usage[chatId];
                    saveState();
                    lines.push('', '_Usage reset._');
                }
                send(chatId, lines.join('\n'));
            }
            break;
        }

        case 'stash':
            runGit(chatId, ['stash'], 'git stash');
            break;

        case 'stashpop':
            runGit(chatId, ['stash', 'pop'], 'git stash pop');
            break;

        case 'menu':
            sendMenu(chatId);
            break;

        case 'allowed':
            if (args) {
                ALLOWED_CHATS = args.split(',').map(Number);
                setEnv('ALLOWED_CHATS', args);
                send(chatId, `Allowed chats updated: \`${args}\`\nSaved to .env.`);
            } else {
                send(chatId, `Allowed chats: \`${ALLOWED_CHATS.join(',')}\``);
            }
            break;

        case 'projectsdir':
            if (args) {
                const resolved = path.resolve(args);
                if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
                    send(chatId, `Not a directory: \`${resolved}\``);
                } else {
                    setEnv('PROJECTS_DIR', resolved);
                    send(chatId, `Projects dir set to: \`${resolved}\`\nRestart bot to apply.`);
                }
            } else {
                send(chatId, `Projects dir: \`${PROJECTS_DIR}\``);
            }
            break;

        case 'file':
            send(chatId, 'Send me a file (photo or document) and I\'ll save it to the project directory. Add a caption to tell Claude what to do with it.');
            break;

        case 'start':
            send(chatId, [
                '\u2728 *Claude Telegram*',
                'Type anything to talk to Claude.',
                '',
                '\uD83D\uDCAC *Chat*',
                '/new \u2014 New conversation',
                '/retry \u2014 Retry last prompt',
                '/stop \u2014 Stop Claude + clear queue',
                '/latest \u2014 Show latest Claude output',
                '/q message \u2014 Queue for after current task',
                '/model \u2014 Change model',
                '/system \u2014 Set system prompt',
                '/verbosity \u2014 Tool message style',
                '/usage \u2014 Token usage & cost',
                '',
                '\uD83D\uDCCE *Files*',
                'Send photo, doc, or voice message',
                '/file \u2014 File help',
                '',
                '\uD83D\uDD00 *Git*',
                '/diff \u2014 Show changes',
                '/log \u2014 Recent commits',
                '/branch \u2014 Switch branch',
                '/commit \u2014 Quick commit',
                '/cm message \u2014 Commit with message',
                '/push \u2014 Push to remote',
                '/shipit \u2014 Commit & push',
                '/pull \u2014 Pull from remote',
                '/stash \u2014 Stash changes',
                '/stashpop \u2014 Pop stash',
                '',
                '\u2699\uFE0F *Config*',
                '/switch \u2014 Switch project',
                '/info \u2014 Current settings',
                '/permissions \u2014 Permission mode',
                '/status \u2014 Claude API status',
                '/allowed id1,id2 \u2014 Whitelist chats',
                '/projectsdir /path \u2014 Projects folder',
                '/ping \u2014 Check if bot is alive',
            ].join('\n'));
            break;

        case 'info': {
            const permMode = process.env.PERMISSION_MODE || 'bypassPermissions';
            const session = state.sessions[chatId] ? 'Active' : 'None';
            send(chatId, [
                `\uD83D\uDCCB *Info*`,
                '',
                `\u2022 Project: \`${path.basename(getProject(chatId))}\``,
                `\u2022 Full path: \`${getProject(chatId)}\``,
                `\u2022 Model: _${state.models[chatId] || 'default'}_`,
                `\u2022 Verbosity: _${getVerbosity(chatId)}_`,
                `\u2022 Permissions: _${PERM_LABELS[permMode] || permMode}_`,
                `\u2022 Session: _${session}_`,
            ].join('\n'));
            break;
        }

        case 'help':
            handleCommand(chatId, 'start', '');
            break;

        case 'permissions': {
            const validModes = {
                'trust': 'bypassPermissions',
                'edits': 'acceptEdits',
                'plan': 'plan',
                'bypassPermissions': 'bypassPermissions',
                'acceptEdits': 'acceptEdits',
            };
            if (!args) {
                const current = process.env.PERMISSION_MODE || 'bypassPermissions';
                send(chatId, [
                    `\uD83D\uDD12 *Permission mode:* ${PERM_LABELS[current] || current}`,
                    '',
                    'Change with:',
                    '`/permissions trust` \u2014 full access',
                    '`/permissions edits` \u2014 read + edit only',
                    '`/permissions plan` \u2014 read only',
                ].join('\n'));
            } else if (validModes[args]) {
                const mode = validModes[args];
                setEnv('PERMISSION_MODE', mode);
                process.env.PERMISSION_MODE = mode;
                send(chatId, `\uD83D\uDD12 Permission mode: *${PERM_LABELS[mode]}*`);
            } else {
                send(chatId, 'Options: `trust`, `edits`, `plan`');
            }
            break;
        }

        case 'ping':
            send(chatId, `\uD83C\uDFD3 Pong! Bot is running.\n\`${path.basename(getProject(chatId))}\` \u2014 _${state.models[chatId] || 'default'}_`);
            break;

        default:
            send(chatId, `Unknown command: /${cmd}`);
            break;
    }
}

// --- Bot commands registration ---

const BOT_COMMANDS = [
    { command: 'new', description: 'New conversation' },
    { command: 'retry', description: 'Retry last prompt' },
    { command: 'stop', description: 'Stop Claude + clear queue' },
    { command: 'latest', description: 'Show latest Claude output' },
    { command: 'switch', description: 'Switch project' },
    { command: 'branch', description: 'Switch branch' },
    { command: 'commit', description: 'Quick commit' },
    { command: 'cm', description: 'Commit with message' },
    { command: 'shipit', description: 'Commit & push' },
    { command: 'push', description: 'Push' },
    { command: 'pull', description: 'Pull' },
    { command: 'help', description: 'Show all commands' },
    { command: 'ping', description: 'Check if bot is alive' },
];

await telegramRequest('setMyCommands', { commands: BOT_COMMANDS });
console.log('Bot commands registered');

// --- Polling ---

let offset = 0;

console.log(`Bot started | Project: ${DEFAULT_PROJECT}`);
console.log(`Projects dir: ${PROJECTS_DIR}`);
console.log(`Default verbosity: ${process.env.VERBOSITY || 'condensed'}`);
if (ALLOWED_CHATS.length) console.log(`Allowed chats: ${ALLOWED_CHATS.join(', ')}`);
else console.log('WARNING: No ALLOWED_CHATS set — bot is open to everyone');
console.log(`Permission mode: ${PERM_LABELS[process.env.PERMISSION_MODE] || process.env.PERMISSION_MODE || 'Trust all (default)'}`);

while (true) {
    try {
        const res = await telegramRequest('getUpdates', {
            offset, timeout: 30, allowed_updates: ['message', 'callback_query']
        });
        if (!res || !res.ok || !res.result) continue;

        for (const update of res.result) {
            offset = update.update_id + 1;

            // --- Callback queries ---
            if (update.callback_query) {
                const cb = update.callback_query;
                const chatId = cb.message.chat.id;
                if (!isAllowed(chatId)) continue;

                const value = resolveCallback(cb.data);
                if (!value) {
                    telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text: 'Button expired, try again' });
                    continue;
                }

                const [prefix] = cb.data.split(':');
                switch (prefix) {
                    case 'project':
                        state.projects[chatId] = value;
                        delete state.sessions[chatId];
                        saveState();
                        setEnv('PROJECT_DIR', value);
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        send(chatId, `\uD83D\uDCC2 Project: *${path.basename(value)}*\n_Session reset. Saved to .env._`);
                        break;

                    case 'browse':
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        sendProjectPicker(chatId, value);
                        break;

                    case 'model':
                        if (value === 'default') delete state.models[chatId];
                        else state.models[chatId] = value;
                        saveState();
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        send(chatId, `\uD83E\uDD16 Model: *${value}*`);
                        break;

                    case 'branch': {
                        const cwd = getProject(chatId);
                        const proc = spawn('git', ['checkout', value], { cwd, timeout: 15000 });
                        let out = '';
                        proc.stdout.on('data', d => out += d.toString());
                        proc.stderr.on('data', d => out += d.toString());
                        proc.on('close', () => {
                            telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                            send(chatId, `\uD83D\uDD00 Switched to *${value}*\n\`\`\`\n${out.trim()}\n\`\`\``);
                        });
                        break;
                    }

                    case 'menu':
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        if (value === 'menu_model') sendModelPicker(chatId);
                        else if (value === 'menu_system') handleCommand(chatId, 'system', '');
                        else if (value === 'menu_verbosity') sendVerbosityPicker(chatId);
                        else if (value === 'menu_stash') runGit(chatId, ['stash'], 'git stash');
                        else if (value === 'menu_stashpop') runGit(chatId, ['stash', 'pop'], 'git stash pop');
                        break;

                    case 'verbosity':
                        state.verbosity[chatId] = value;
                        saveState();
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        send(chatId, `\uD83D\uDD08 Verbosity: *${value}*`);
                        break;

                    case 'sendfile':
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        if (fs.existsSync(value)) {
                            telegramSendDocument(chatId, value, path.basename(value)).catch(err => {
                                send(chatId, `Failed to send file: ${err.message}`);
                            });
                        } else {
                            send(chatId, 'File no longer exists');
                        }
                        break;

                    case 'commitpush':
                        telegramRequest('answerCallbackQuery', { callback_query_id: cb.id });
                        runCommitAndPush(chatId, value);
                        break;
                }
                continue;
            }

            // --- Messages ---
            const msg = update.message;
            if (!msg) continue;

            const chatId = msg.chat.id;
            if (!isAllowed(chatId)) {
                send(chatId, `Unauthorized. Your chat ID: \`${chatId}\``);
                continue;
            }

            // --- Voice messages ---
            if (msg.voice || msg.audio) {
                const voiceFileId = msg.voice?.file_id || msg.audio?.file_id;
                try {
                    const fileContext = await handleVoiceMessage(chatId, voiceFileId);
                    if (fileContext) {
                        runClaude(chatId, 'The user sent a voice message. Please acknowledge it.', fileContext);
                    }
                } catch (err) {
                    send(chatId, `Voice error: ${err.message}`);
                }
                continue;
            }

            // --- File handling (photos & documents) ---
            const fileId = msg.photo?.at(-1)?.file_id || msg.document?.file_id;
            if (fileId) {
                const projectDir = getProject(chatId);
                try {
                    const file = await downloadTelegramFile(fileId, projectDir);
                    if (file) {
                        const caption = msg.caption || '';
                        const sizeKb = Math.round(file.size / 1024);
                        send(chatId, `File saved: \`${file.fileName}\` (${sizeKb}KB)`);

                        if (caption && !caption.startsWith('/')) {
                            const fileContext = `The user sent a file that has been saved to the project directory as "${file.fileName}" (${sizeKb}KB). The file is at: ${file.destPath}`;
                            runClaude(chatId, caption, fileContext);
                        }
                    } else {
                        send(chatId, 'Failed to download file');
                    }
                } catch (err) {
                    send(chatId, `File error: ${err.message}`);
                }
                continue;
            }

            // --- Text messages ---
            if (!msg.text) continue;

            const text = msg.text.trim();

            if (text.startsWith('/')) {
                const [rawCmd, ...argParts] = text.split(' ');
                const cmd = rawCmd.slice(1).split('@')[0];
                if (!cmd) { handleCommand(chatId, 'start', ''); continue; }
                handleCommand(chatId, cmd, argParts.join(' ').trim());
            } else {
                runClaude(chatId, text);
            }
        }
    } catch (err) {
        console.error('Poll error:', err.message);
    }
}

} // end startBot

// --- Process management ---

const MODE = process.argv[2]; // --setup, --start, --stop, --logs, --dev, or nothing

function isRunning() {
    try {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
        process.kill(pid, 0); // test if alive
        return pid;
    } catch { return false; }
}

function daemonize() {
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [__filename, '--daemon'], {
        cwd: __dirname,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    fs.writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    return child.pid;
}

function stopBot() {
    const pid = isRunning();
    if (!pid) {
        console.log('  Bot is not running.');
        return false;
    }
    process.kill(pid, 'SIGTERM');
    try { fs.unlinkSync(PID_FILE); } catch {}
    console.log(`  \x1b[32m✔\x1b[0m Bot stopped (pid ${pid})`);
    return true;
}

function tailLogs() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log('  No log file yet. Start the bot first.');
        process.exit(1);
    }
    const tail = spawn('tail', ['-f', '-n', '50', LOG_FILE], { stdio: 'inherit' });
    process.on('SIGINT', () => { tail.kill(); process.exit(0); });
}

function startDev() {
    console.log('\n  \x1b[36m◆\x1b[0m Dev mode — watching for changes\n');
    let child = null;
    let restarting = false;

    function start() {
        child = spawn(process.execPath, [__filename], {
            cwd: __dirname,
            stdio: 'inherit',
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        child.on('close', (code) => {
            if (!restarting) {
                console.log(`\n  Process exited (code ${code}), restarting in 1s...`);
                setTimeout(start, 1000);
            }
        });
    }

    start();

    // Watch for file changes
    let debounce = null;
    fs.watch(path.join(__dirname, 'claude-server.js'), () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
            console.log('\n  \x1b[33m↻\x1b[0m File changed, restarting...\n');
            restarting = true;
            if (child) child.kill('SIGTERM');
            setTimeout(() => {
                restarting = false;
                start();
            }, 500);
        }, 300);
    });

    process.on('SIGINT', () => {
        restarting = true;
        if (child) child.kill('SIGTERM');
        process.exit(0);
    });
}

// --- Daemon mode: auto-restart on crash ---

if (MODE === '--daemon') {
    (async function runWithRestart() {
        while (true) {
            try {
                await startBot();
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Bot crashed: ${err.message}`);
                console.error('Restarting in 3s...');
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    })();
} else if (MODE === '--stop') {
    stopBot();
    process.exit(0);
} else if (MODE === '--logs') {
    tailLogs();
} else if (MODE === '--dev') {
    startDev();
} else if (MODE === '--setup' || MODE === '--start') {
    (async () => {
        await ensureToken();
        if (MODE === '--setup' || !fs.existsSync(ENV_FILE) || !process.env.ALLOWED_CHATS) {
            await setup();
        }

        // Stop existing instance if running
        const existing = isRunning();
        if (existing) {
            process.kill(existing, 'SIGTERM');
            try { fs.unlinkSync(PID_FILE); } catch {}
            await new Promise(r => setTimeout(r, 500));
        }

        const pid = daemonize();
        console.log(`\n  \x1b[32m✔\x1b[0m Bot is running! (pid ${pid})\n`);
        console.log('  Commands:');
        console.log('    claude-telegram --logs     View logs');
        console.log('    claude-telegram --stop     Stop');
        console.log('    claude-telegram --start    Restart');
        console.log('    claude-telegram --dev      Dev mode (watch + auto-restart)\n');
        process.exit(0);
    })();
} else {
    // No flag: run in foreground (direct `node claude-server.js`)
    (async () => {
        loadEnv();
        await ensureToken();
        if (!fs.existsSync(ENV_FILE) || !process.env.ALLOWED_CHATS) {
            await setup();
        }
        await startBot();
    })();
}

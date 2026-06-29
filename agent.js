const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec, execSync } = require('child_process');

const BASE_DIR = __dirname;
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const MODELS_FILE = path.join(BASE_DIR, 'models.json');
const MEMO_FILE = path.join(BASE_DIR, 'imp_memo.md');
const EXP_FILE = path.join(BASE_DIR, 'experience.md');
const SKILLS_DIR = path.join(BASE_DIR, 'skills');

const tools = require(path.join(BASE_DIR, 'tools.js'));
const api = require(path.join(BASE_DIR, 'connection.js'));

// --- GLOBAL WORKSPACE PROTECTION PARSER ---
const args = process.argv.slice(2);
if (args.length > 0 && args[0] === '--clear-sessions') {
    if (fs.existsSync(SESSIONS_DIR)) {
        const targets = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        targets.forEach(f => fs.unlinkSync(path.join(SESSIONS_DIR, f)));
    }
    console.log("\x1b[32m✔ Every cached context workspace session has been purged cleanly.\x1b[0m\n");
    process.exit(0);
}

// --- TERMINAL UI ENGINE ---
const colors = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m", blue: "\x1b[34m", bgRed: "\x1b[41m", bgYellow: "\x1b[43m" };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sysLog(...args) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    if (args.length > 0) console.log(...args);
    if (!isProcessing) rl.prompt(true);
}

async function sysLogAnimated(text, prefix = "") {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const lines = (text || "").replace(/\r/g, '').split('\n');
    for (const line of lines) {
        process.stdout.write(prefix);
        const chunkSize = 3; 
        for (let i = 0; i < line.length; i += chunkSize) {
            process.stdout.write(line.substring(i, i + chunkSize));
            await sleep(2); 
        }
        console.log(colors.reset);
    }
    if (!isProcessing) rl.prompt(true);
}

class Spinner {
    constructor(text = "Processing") {
        this.frames = ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠴', '⠲', '⠳', '⠓'];
        this.text = text;
        this.idx = 0;
        this.timer = null;
    }
    start() {
        if (this.timer) return;
        process.stdout.write("\x1B[?25l"); 
        this.timer = setInterval(() => {
            const spinStr = `${colors.cyan}${this.frames[this.idx]}${colors.reset} ${colors.cyan}${colors.dim}${this.text}...${colors.reset}`;
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`${spinStr}  |  ${colors.bold}${colors.cyan}❯ You:${colors.reset} ${rl.line}`);
            this.idx = (this.idx + 1) % this.frames.length;
        }, 80);
    }
    stop(clearLine = true) {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        process.stdout.write("\x1B[?25h"); 
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        if (!clearLine) console.log();
    }
    update(newText) { this.text = newText; }
}
const spinner = new Spinner();

let chatHistory = [];
let availableModels = [];
let activeModel = null;
let isProcessing = false;
let cancelWork = false;
let promptQueue = [];
let abortController = new AbortController();
let pasteBuffer = [];
let pasteTimer = null;

if (!fs.existsSync(SESSIONS_DIR)) { fs.mkdirSync(SESSIONS_DIR); }

function getAvailableSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
            if (!data.history || data.history.length === 0) continue;
            sessions.push({ filename: file, title: data.title || file, timestamp: fs.statSync(path.join(SESSIONS_DIR, file)).mtimeMs });
        } catch(e) {}
    }
    return sessions.sort((a, b) => b.timestamp - a.timestamp); 
}

async function generateChatTitle(firstPrompt) {
    if (!activeModel) return "New Conversation";
    try {
        const titlePrompt = `Summarize this user prompt into a short, catchy title (3 to 6 words maximum). Return ONLY the raw text of the title with no markdown. Prompt: "${firstPrompt}"`;
        const rawResponse = await api.callAI({ activeModel, chatHistory: [{ role: "user", content: titlePrompt }], promptText: titlePrompt, abortController: new AbortController(), spinner: { start: () => {}, stop: () => {}, update: () => {} }, sysLog: () => {}, colors, SYSTEM_PROMPT: "Provide ONLY the text title string." });
        let cleanTitle = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/["']/g, '').trim();
        if (cleanTitle.length > 50) cleanTitle = cleanTitle.substring(0, 47) + "...";
        return cleanTitle || "New Conversation";
    } catch(err) { return "New Conversation"; }
}

function prepareNvidiaCompliantHistory(rawHistory) {
    const compliant = [];
    let lastRole = null;
    for (const msg of rawHistory) {
        let targetRole = msg.role === 'system' ? 'user' : msg.role;
        if (targetRole === 'ai') targetRole = 'assistant';
        if (targetRole === lastRole) {
            compliant[compliant.length - 1].content += "\n\n" + msg.content;
        } else {
            compliant.push({ role: targetRole, content: msg.content });
            lastRole = targetRole;
        }
    }
    return compliant;
}

const _originalParse = JSON.parse;
function safeJsonParse(text) {
    if (typeof text !== 'string') return null;
    try { return _originalParse(text); } catch (e) {
        try {
            let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            cleaned = cleaned.replace(/\x60\x60\x60json/gi, '').replace(/\x60\x60\x60/g, '').trim();
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start !== -1 && end !== -1 && start < end) { return _originalParse(cleaned.substring(start, end + 1)); }
        } catch(err) {}
        return null; 
    }
}
JSON.parse = function(text, reviver) { try { return _originalParse(text, reviver); } catch(e) { return safeJsonParse(text); } };

const askSync = (q) => new Promise(res => { rl.question(q, (ans) => res(ans)); });

async function switchModelMenu() {
    sysLog(`\n${colors.bold}${colors.cyan}+-- Switch Active Core ------------------${colors.reset}`);
    try { if (fs.existsSync(MODELS_FILE)) availableModels = _originalParse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch(e) {}
    availableModels.forEach((m, i) => sysLog(`${colors.cyan}|${colors.reset}  ${colors.cyan}[${i+1}]${colors.reset} ${m.name}`));
    sysLog(`${colors.cyan}\\----------------------------------------${colors.reset}`);
    
    rl.removeListener('line', lineHandler);
    const choice = await askSync(`\nSelect a new core [1-${availableModels.length}] or press Enter to cancel: `);
    rl.on('line', lineHandler);
    
    const index = parseInt(choice) - 1;
    if (!isNaN(index) && index >= 0 && index < availableModels.length) {
        activeModel = availableModels[index];
        sysLog(`${colors.green}✔ Active core switched to: ${activeModel.name}${colors.reset}`);
        return true;
    }
    return false;
}

async function loadConfig() {
    console.clear();
    try { availableModels = _originalParse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch(e) { process.exit(1); }
    availableModels.forEach((m, i) => console.log("  " + colors.cyan + "[" + (i+1) + "]" + colors.reset + " " + m.name));
    const choice = await askSync(`\nSelect a core [1-${availableModels.length}]: `);
    activeModel = availableModels[parseInt(choice)-1] || availableModels[0];

    console.log(`\n${colors.bold}Session State:${colors.reset}`);
    const sessions = getAvailableSessions();
    console.log(`  ${colors.cyan}[1]${colors.reset} New Chat`);
    sessions.forEach((s, idx) => { console.log(`  ${colors.cyan}[${idx + 2}]${colors.reset} ${s.title}`); });
    
    const sessionChoice = await askSync(`\nSelect option [1-${sessions.length + 1}]: `);
    const selectionIndex = parseInt(sessionChoice) - 2;

    if (selectionIndex >= 0 && selectionIndex < sessions.length) {
        currentSessionFile = sessions[selectionIndex].filename;
        const loadData = _originalParse(fs.readFileSync(path.join(SESSIONS_DIR, currentSessionFile), 'utf8'));
        chatHistory = loadData.history || [];
        currentSessionTitle = loadData.title || "Untitled Chat";
    } else {
        currentSessionFile = `session_${Date.now()}.json`;
        chatHistory = [];
    }

    console.clear();
    rl.setPrompt(`\n${colors.bold}${colors.cyan}❯ You:${colors.reset} `);
    rl.prompt(true);
    rl.on('line', lineHandler);
}

async function lineHandler(line) {
    const rawLine = line; 
    if (rawLine.trim().toLowerCase() === 'exit' && pasteBuffer.length === 0) { saveSessionState(); process.exit(0); }
    pasteBuffer.push(rawLine);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
        const finalInput = pasteBuffer.join('\n').trim();
        pasteBuffer = []; 
        if (!finalInput) { rl.prompt(true); return; }
        promptQueue.push(finalInput);
        if (!isProcessing) processNextInQueue();
    }, 150); 
}

async function processNextInQueue() {
    if (promptQueue.length === 0) { isProcessing = false; rl.prompt(true); return; }
    isProcessing = true;
    cancelWork = false;
    const currentPrompt = promptQueue.shift();
    
    if (chatHistory.length === 0) { currentSessionTitle = await generateChatTitle(currentPrompt); }
    chatHistory.push({ role: "user", content: currentPrompt });
    let isComplete = false;
    let aiPrompt = currentPrompt;

    while (!isComplete && !cancelWork) {
        spinner.start();
        if (activeModel) activeModel.temperature = 0.3;
        const cleanPayloadHistory = prepareNvidiaCompliantHistory(chatHistory);

        try {
            const rawResponse = await api.callAI({ activeModel, chatHistory: cleanPayloadHistory, promptText: aiPrompt, abortController, spinner, sysLog, colors, SYSTEM_PROMPT: getSystemPrompt() });
            spinner.stop(true);
            if (cancelWork) break;

            const parsed = safeJsonParse(rawResponse);
            if (!parsed) {
                chatHistory.push({ role: "assistant", content: rawResponse });
                saveSessionState();
                break;
            }

            if (parsed.action === "tool_call" && Array.isArray(parsed.calls)) {
                let combinedResults = "";
                for (const call of parsed.calls) {
                    if (cancelWork) break;
                    let toolResult = "";
                    
                    if (call.tool === 'execute_command') {
                        toolResult = await new Promise((resolve, reject) => {
                            const childProcess = exec(call.args.command, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 });
                            let outputBuffer = "";
                            childProcess.stdout?.on('data', data => outputBuffer += data);
                            childProcess.stderr?.on('data', data => outputBuffer += data);
                            childProcess.on('close', code => resolve(outputBuffer));
                        });
                    } else if (call.tool === 'update_core_memory') {
                        fs.writeFileSync(MEMO_FILE, call.args.content);
                        toolResult = "Memory synchronized.";
                    } else {
                        toolResult = await tools.execute(call.tool, call.args);
                    }
                    combinedResults += `\n--- Result for ${call.tool} ---\n${toolResult}\n`;
                }
                aiPrompt = `Batched tools executed. Results:\n${combinedResults}`;
                chatHistory.push({ role: "user", content: aiPrompt });
                saveSessionState();
                
            } else if (parsed.action === "complete") {
                console.log(`\n\x1b[32m◆ AI:\x1b[0m ${parsed.result}\n`);
                chatHistory.push({ role: "assistant", content: parsed.result });
                saveSessionState();
                isComplete = true;
            }
        } catch(err) { spinner.stop(true); break; }
    }
    isProcessing = false;
    rl.prompt(true);
}

loadConfig();

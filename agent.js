const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const tools = require('./tools.js');
const api = require('./connection.js');

// --- TERMINAL UI ENGINE (UNIVERSAL ASCII & ANIMATION) ---
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

// --- SESSION MANAGEMENT ---
const SESSIONS_DIR = './sessions';
let currentSessionFile = null;
let currentSessionTitle = "Untitled Chat";

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

function getAvailableSessions() {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
            sessions.push({
                filename: file,
                title: data.title || file,
                timestamp: fs.statSync(path.join(SESSIONS_DIR, file)).mtimeMs
            });
        } catch(e) {}
    }
    return sessions.sort((a, b) => b.timestamp - a.timestamp); 
}

async function generateChatTitle(firstPrompt) {
    if (!activeModel) return "New Conversation";
    try {
        const titlePrompt = `Summarize this user prompt into a short, catchy title (3 to 6 words maximum). Return ONLY the raw text of the title, with absolutely no quotes, no markdown, and no reasoning blocks. Prompt: "${firstPrompt}"`;
        const rawResponse = await api.callAI({
            activeModel, 
            chatHistory: [{ role: "user", content: titlePrompt }], 
            promptText: titlePrompt, 
            abortController: new AbortController(), 
            spinner: { start: () => {}, stop: () => {}, update: () => {} }, 
            sysLog: () => {}, 
            colors, 
            SYSTEM_PROMPT: "You are a concise title generator. Provide ONLY the title string."
        });
        
        let cleanTitle = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/["']/g, '').trim();
        if (cleanTitle.length > 50) cleanTitle = cleanTitle.substring(0, 47) + "...";
        return cleanTitle || "New Conversation";
    } catch(err) {
        return "New Conversation";
    }
}

// --- DECOUPLED SAFE PARSING ENGINE ---
const _originalParse = JSON.parse;
function safeJsonParse(text) {
    if (typeof text !== 'string') return null;
    try { return _originalParse(text); } catch (e) {
        try {
            let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            // Using \x60 to prevent mobile clipboard breakages on literal backticks
            cleaned = cleaned.replace(/\x60\x60\x60json/gi, '').replace(/\x60\x60\x60/g, '').trim();
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start !== -1 && end !== -1 && start < end) {
                return _originalParse(cleaned.substring(start, end + 1));
            }
        } catch(err) {}
        return null; 
    }
}
JSON.parse = function(text, reviver) {
    try { return _originalParse(text, reviver); } catch(e) { return safeJsonParse(text); }
};

const askSync = (q) => new Promise(res => { rl.question(q, (ans) => res(ans)); });

const askToolConfirm = (q) => new Promise(res => {
    rl.removeListener('line', lineHandler);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    rl.question(q, (ans) => {
        rl.on('line', lineHandler);
        res(ans);
    });
});

async function switchModelMenu() {
    sysLog(`\n${colors.bold}${colors.cyan}+-- Switch Active Core ------------------${colors.reset}`);
    try { if (fs.existsSync('models.json')) availableModels = _originalParse(fs.readFileSync('models.json', 'utf8')); } catch(e) {}
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

// --- SWARM TOOLS ---
const agentTools = [...tools.schemas, 
{ 
    name: 'execute_command', description: 'Execute shell commands on the host OS.', 
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } 
},
{
    name: 'spawn_sub_agent', description: 'Delegate a complex research, debugging, or planning sub-task to a specialized child AI to preserve your main context window.',
    parameters: { 
        type: 'object', 
        properties: { 
            role: { type: 'string', description: 'The persona of the child agent (e.g., Data Architect, Security Auditor, Coder)' }, 
            task: { type: 'string', description: 'Highly detailed instructions for what the sub-agent needs to solve and return.' } 
        }, 
        required: ['role', 'task'] 
    }
}];

const SYSTEM_PROMPT = `You are an elite, autonomous AI Orchestrator running natively on Termux (Android/aarch64).
Available Tools: ${JSON.stringify(agentTools)}

CORE OPERATING PROCEDURES:
1. PLAN: Break the user's request into logical, discrete steps using the "task_manager". 
2. DELEGATE (Swarm Protocol): If a task requires deep code analysis, independent research, or complex logic that would bloat your context window, use 'spawn_sub_agent' to hand it to a specialized worker.
3. EXECUTE (Batching): Group multiple independent tool calls into a single response to save time and API requests.
4. VERIFY: Do not blindly assume a command worked. Check the output before proceeding. If you write a file, you MUST verify it exists using 'ls' or 'cat' in your next step.
5. TERMINATE (CRITICAL): Once the ultimate goal is achieved, you MUST immediately set "action" to "complete" and provide a final summary. DO NOT loop endlessly.
6. FAIL-SAFE: If a tool fails 3 times in a row, set "action" to "complete" and explicitly ask the user for assistance.
7. TOKEN CONSERVATION (CONDITIONAL REASONING): Do NOT generate <think> reasoning blocks for simple, repetitive, or obvious tasks (like creating basic files, routing commands, or simple conversational replies). ONLY use reasoning blocks for highly complex architectural planning or critical debugging. Skip the thought process whenever possible to save tokens.

JSON SCHEMA ENFORCEMENT:
You must strictly format your ENTIRE response as a valid JSON object. No raw markdown outside the JSON brackets.

{
  "task_manager": {
    "current_goal": "Ultimate objective summary",
    "completed_tasks": ["Step 1 done"],
    "pending_tasks": ["Step 2 to do", "Step 3 to do"]
  },
  "action": "tool_call" | "complete",
  "calls": [{"tool": "tool_name", "args": {"arg_name": "value"}}], 
  "result": "Final comprehensive output, summary, or question for the user (ONLY used if action is 'complete')"
}`;

function saveAndExit() {
    spinner.start();
    spinner.update("Saving context");
    if (!currentSessionFile) {
        currentSessionFile = `session_${Date.now()}.json`;
    }
    const sessionData = {
        title: currentSessionTitle,
        history: chatHistory
    };
    fs.writeFileSync(path.join(SESSIONS_DIR, currentSessionFile), JSON.stringify(sessionData, null, 2));
    spinner.stop();
    sysLog(`${colors.green}✔ Context saved to ${currentSessionFile}. Terminating.${colors.reset}`);
    process.exit(0);
}

async function handleSlashCommand(cmd) {
    const base = cmd.trim().toLowerCase().split(' ')[0];
    if (base === '/stop') {
        if (isProcessing) {
            cancelWork = true;
            abortController.abort();
            abortController = new AbortController(); 
            sysLog(`${colors.yellow}⚠ AI execution interrupted by user.${colors.reset}`);
        } else { sysLog(`${colors.dim}No active AI process to stop.${colors.reset}`); }
        return;
    }
    if (base === '/exit') { saveAndExit(); return; }
    if (base === '/btw') {
        const question = cmd.trim().substring(4).trim();
        if (!question) {
            sysLog(`${colors.yellow}⚠ Please provide a question. Usage: /btw <your question>${colors.reset}`);
            return;
        }
        const wasSpinning = spinner.timer !== null;
        if (wasSpinning) spinner.stop(true);
        
        sysLog(`\n${colors.cyan}+-- 💬 BTW Question -----------------------${colors.reset}`);
        sysLog(`${colors.cyan}|${colors.reset} ${question}`);
        sysLog(`${colors.cyan}\\----------------------------------------${colors.reset}`);
        sysLog(`${colors.dim}Thinking... (Task execution continues in background)${colors.reset}`);
        
        if (wasSpinning) spinner.start();

        api.callAI({
            activeModel, chatHistory: [...chatHistory, { role: "user", content: question }], promptText: question, abortController: new AbortController(), spinner: { start: () => {}, stop: () => {}, update: () => {} }, sysLog: () => {}, colors, SYSTEM_PROMPT: "You are a world-class senior frontend/backend engineer. Answer briefly without JSON structure. Do NOT use <think> blocks."
        }).then(async rawResponse => {
            const isNowSpinning = spinner.timer !== null;
            if (isNowSpinning) spinner.stop(true);
            let cleanSideResponse = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            cleanSideResponse = cleanSideResponse.replace(/\x60\x60\x60json/gi, '').replace(/\x60\x60\x60/g, '').trim();
            if (cleanSideResponse.startsWith('{') && cleanSideResponse.endsWith('}')) {
                const parsed = safeJsonParse(cleanSideResponse);
                if (parsed && parsed.result) cleanSideResponse = parsed.result;
            }
            sysLog(`\n${colors.bold}${colors.cyan}+-- ◆ BTW Answer ------------------------${colors.reset}`);
            await sysLogAnimated(cleanSideResponse, `${colors.cyan}|${colors.reset} `);
            sysLog(`${colors.bold}${colors.cyan}\\----------------------------------------${colors.reset}\n`);
            if (isNowSpinning) spinner.start();
        }).catch(err => {
            const isNowSpinning = spinner.timer !== null;
            if (isNowSpinning) spinner.stop(true);
            sysLog(`\n${colors.red}✖ [BTW Error]: ${err.message}${colors.reset}\n`);
            if (isNowSpinning) spinner.start();
        });
        return;
    }
    
    sysLog();
    if (base === '/' || base === '/help') {
        sysLog(`${colors.bold}${colors.cyan}+-- Agentic Framework Commands ----------${colors.reset}`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/btw <q>${colors.reset}   Ask a question mid-session`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/stop${colors.reset}      Interrupt AI processing`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/model${colors.reset}     Hot-swap the AI core`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/settings${colors.reset}  View framework config`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/skills${colors.reset}    View loaded markdown skills`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/clear${colors.reset}     Wipe context memory`);
        sysLog(`${colors.cyan}|${colors.reset}  ${colors.green}/exit${colors.reset}      Terminate session`);
        sysLog(`${colors.bold}${colors.cyan}\\----------------------------------------${colors.reset}`);
    } else if (base === '/model') { await switchModelMenu();
    } else if (base === '/settings') {
        sysLog(`${colors.bold}${colors.cyan}+-- System Settings ---------------------${colors.reset}`);
        sysLog(`${colors.cyan}|${colors.reset} Engine: ${colors.yellow}${activeModel.name}${colors.reset}`);
        sysLog(`${colors.cyan}|${colors.reset} Endpoint: ${colors.dim}${activeModel.baseUrl || "Default Google"}${colors.reset}`);
        sysLog(`${colors.cyan}|${colors.reset} Queue: ${promptQueue.length > 0 ? colors.yellow + promptQueue.length + " pending" : colors.green + "Empty"}${colors.reset}`);
        sysLog(`${colors.bold}${colors.cyan}\\----------------------------------------${colors.reset}`);
    } else if (base === '/instructions') { sysLog(`${colors.bold}${colors.cyan}--- Base Instructions ---${colors.reset}\n${SYSTEM_PROMPT}`);
    } else if (base === '/skills') {
        sysLog(`${colors.bold}${colors.cyan}+-- Installed Skills --------------------${colors.reset}`);
        if (!fs.existsSync('./skills')) fs.mkdirSync('./skills');
        const files = fs.readdirSync('./skills').filter(f => f.endsWith('.md'));
        if (files.length === 0) sysLog(`${colors.cyan}|${colors.reset} ${colors.dim}No skills found.${colors.reset}`);
        else files.forEach(f => sysLog(`${colors.cyan}|${colors.reset} ${colors.green}• ${f}${colors.reset}`));
        sysLog(`${colors.bold}${colors.cyan}\\----------------------------------------${colors.reset}`);
    } else if (base === '/clear') { chatHistory = []; sysLog(`${colors.green}✔ Context memory wiped.${colors.reset}`);
    } else { sysLog(`${colors.red}✖ Unknown command.${colors.reset}`); }
    sysLog();
}

async function loadConfig() {
    console.clear();
    console.log(`${colors.bold}${colors.cyan}┌──────────────────────────────────────────────────────────────┐${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│                                                              │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│                                                              │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│          ┌─┐        _  │    ╭───╮                            │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│          ├─┤  ╲  ╱  │  │    │   │                            │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│          │ │   ╳    │  │    │   │                            │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│          │ │  ╱  ╲  │  └─── ╰───╯  v1.0                      │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│                                                              │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}│                                                              │${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}└──────────────────────────────────────────────────────────────┘${colors.reset}\n`);
    try { availableModels = _originalParse(fs.readFileSync('models.json', 'utf8')); } catch(e) {
        console.log(`${colors.yellow}⚠️ models.json not found. Run 'node add_model.js' first.${colors.reset}`);
        process.exit(1);
    }
    console.log(`${colors.bold}Available Cores:${colors.reset}`);
    availableModels.forEach((m, i) => console.log(`  ${colors.cyan}[${i+1}]${colors.reset} ${m.name}`));
    const choice = await askSync(`\nSelect a core [1-${availableModels.length}]: `);
    activeModel = availableModels[parseInt(choice)-1] || availableModels[0];

    if (fs.existsSync('history.json')) {
        const legacyData = _originalParse(fs.readFileSync('history.json', 'utf8'));
        const migratedFile = `session_${Date.now()}.json`;
        fs.writeFileSync(path.join(SESSIONS_DIR, migratedFile), JSON.stringify({ title: "Migrated Session", history: legacyData }, null, 2));
        fs.renameSync('history.json', 'history_backup.json');
    }

    console.log(`\n${colors.bold}Session State:${colors.reset}`);
    const sessions = getAvailableSessions();
    console.log(`  ${colors.cyan}[1]${colors.reset} New Chat`);
    sessions.forEach((s, idx) => {
        console.log(`  ${colors.cyan}[${idx + 2}]${colors.reset} ${s.title} ${colors.dim}(${new Date(s.timestamp).toLocaleDateString()})${colors.reset}`);
    });
    
    const sessionChoice = await askSync(`\nSelect option [1-${sessions.length + 1}]: `);
    const selectionIndex = parseInt(sessionChoice) - 2;

    if (selectionIndex >= 0 && selectionIndex < sessions.length) {
        currentSessionFile = sessions[selectionIndex].filename;
        const loadData = _originalParse(fs.readFileSync(path.join(SESSIONS_DIR, currentSessionFile), 'utf8'));
        chatHistory = loadData.history || [];
        currentSessionTitle = loadData.title || "Untitled Chat";
        console.log(`${colors.green}✔ Resumed: ${currentSessionTitle}${colors.reset}`);
    } else {
        currentSessionFile = `session_${Date.now()}.json`;
        chatHistory = [];
        currentSessionTitle = "Untitled Chat";
    }

    if (!fs.existsSync('./skills')) fs.mkdirSync('./skills');
    console.clear();
    console.log(`${colors.dim}Session active. Model: ${activeModel.name}. Type '/' for menu.${colors.reset}\n`);
    rl.setPrompt(`\n${colors.bold}${colors.cyan}❯ You:${colors.reset} `);
    rl.prompt(true);
    rl.on('line', lineHandler);
}

async function lineHandler(line) {
    const rawLine = line; 
    if (rawLine.trim().startsWith('/') && pasteBuffer.length === 0) {
        await handleSlashCommand(rawLine.trim());
        if (!isProcessing) rl.prompt(true);
        return;
    }
    if (rawLine.trim().toLowerCase() === 'exit' && pasteBuffer.length === 0) { saveAndExit(); return; }
    pasteBuffer.push(rawLine);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
        const finalInput = pasteBuffer.join('\n').trim();
        pasteBuffer = []; 
        if (!finalInput) { if (!isProcessing) rl.prompt(true); return; }
        promptQueue.push(finalInput);
        if (isProcessing) { sysLog(`${colors.dim}[Prompt queued: ${promptQueue.length} pending...]${colors.reset}`);
        } else { processNextInQueue(); }
    }, 150); 
}

async function processNextInQueue() {
    if (promptQueue.length === 0) { 
        isProcessing = false; 
        rl.prompt(true); 
        return; 
    }
    isProcessing = true;
    cancelWork = false;
    const currentPrompt = promptQueue.shift();
    
    if (chatHistory.length === 0) {
        spinner.start();
        spinner.update("Generating session title");
        currentSessionTitle = await generateChatTitle(currentPrompt);
        spinner.stop(true);
        sysLog(`${colors.dim}Session named: ${currentSessionTitle}${colors.reset}`);
    }

    chatHistory.push({ role: "user", content: currentPrompt });
    let isComplete = false;
    let aiPrompt = currentPrompt;

    while (!isComplete && !cancelWork) {
        spinner.start();
        spinner.update("Thinking & Planning");
        
        try {
            const rawResponse = await api.callAI({
                activeModel, chatHistory, promptText: aiPrompt, abortController, spinner, sysLog, colors, SYSTEM_PROMPT
            });
            spinner.stop(true);
            if (cancelWork) break;

            const thinkMatch = rawResponse.match(/<think>([\s\S]*?)<\/think>/i);
            if (thinkMatch && thinkMatch[1]) {
                sysLog(`\n${colors.dim}+-- 🧠 Reasoning ------------------------`);
                sysLog(thinkMatch[1].trim().split('\n').map(l => `|  ${l}`).join('\n'));
                sysLog(`\\----------------------------------------${colors.reset}`);
            }
            
            const parsed = safeJsonParse(rawResponse);
            if (!parsed) {
                let fallbackText = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\x60\x60\x60json/gi, '').replace(/\x60\x60\x60/g, '').trim();
                sysLog(`\n${colors.bold}${colors.green}+-- ◆ AI (Raw Output) ───────────────────${colors.reset}`);
                await sysLogAnimated(fallbackText, `${colors.green}|${colors.reset} `);
                sysLog(`${colors.bold}${colors.green}\\----------------------------------------${colors.reset}`);
                chatHistory.push({ role: "ai", content: rawResponse });
                break;
            }

            if (parsed.task_manager) {
                sysLog(`\n${colors.bold}${colors.blue}+-- 📝 Task Board: ${colors.reset}${colors.dim}${parsed.task_manager.current_goal}${colors.reset}`);
                if (parsed.task_manager.completed_tasks) parsed.task_manager.completed_tasks.forEach(t => sysLog(`${colors.blue}|${colors.reset}  ${colors.green}✔ ${t}${colors.reset}`));
                if (parsed.task_manager.pending_tasks) parsed.task_manager.pending_tasks.forEach(t => sysLog(`${colors.blue}|${colors.reset}  ${colors.dim}□ ${t}${colors.reset}`));
                sysLog(`${colors.bold}${colors.blue}\\----------------------------------------${colors.reset}`);
            }

            if (parsed.action === "tool_call" && Array.isArray(parsed.calls)) {
                let combinedResults = "";
                for (const call of parsed.calls) {
                    if (cancelWork) break;
                    sysLog(`\n${colors.yellow}+-- ⚙️  Invoking Tool: ${colors.bold}${call.tool}${colors.reset}`);
                    let toolResult = "";
                    
                    if (call.tool === 'execute_command') {
                        sysLog(`${colors.yellow}|${colors.reset}  ${colors.bgRed}${colors.bold} COMMAND WARNING ${colors.reset}`);
                        const cmdLines = (call.args.command || "").replace(/\r/g, '').split('\n');
                        cmdLines.forEach(l => sysLog(`${colors.yellow}|${colors.reset}  ${colors.dim}${l}${colors.reset}`));
                        sysLog(`${colors.yellow}|${colors.reset}`);
                        
                        const confirm = await askToolConfirm(`${colors.yellow}|${colors.reset}  Approve execution? ${colors.green}[y/N] or type feedback${colors.reset}: `);
                        const ans = confirm.trim();
                        
                        if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
                            sysLog(`${colors.yellow}|${colors.reset}  ${colors.dim}Executing (Async Background Support)...${colors.reset}`);
                            try { 
                                toolResult = await new Promise((resolve, reject) => {
                                    const childProcess = exec(call.args.command, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 });
                                    let outputBuffer = "";
                                    let isDone = false;
                                    
                                    const autoDetachTimer = setTimeout(() => {
                                        if (!isDone) {
                                            isDone = true;
                                            childProcess.unref(); 
                                            resolve(outputBuffer + "\n[Process taking longer than 8 seconds. Detached and continuing safely in the background.]");
                                        }
                                    }, 8000); 

                                    childProcess.stdout?.on('data', data => { outputBuffer += data; });
                                    childProcess.stderr?.on('data', data => { outputBuffer += data; });
                                    
                                    childProcess.on('close', code => {
                                        if (!isDone) {
                                            isDone = true;
                                            clearTimeout(autoDetachTimer);
                                            if (code === 0) resolve(outputBuffer);
                                            else reject(new Error(`Exit status ${code}:\n${outputBuffer}`));
                                        }
                                    });
                                    
                                    childProcess.on('error', err => {
                                        if (!isDone) {
                                            isDone = true;
                                            clearTimeout(autoDetachTimer);
                                            reject(err);
                                        }
                                    });
                                });
                                sysLog(`${colors.yellow}+-- ${colors.green}✔ Command Dispatched${colors.reset}`);
                            } catch(e) { 
                                toolResult = e.message; 
                                sysLog(`${colors.yellow}+-- ${colors.red}✖ Command Failed${colors.reset}`);
                            }
                        } else if (ans.toLowerCase() === 'n' || ans.toLowerCase() === 'no' || ans === '') {
                            toolResult = "User denied command execution.";
                            sysLog(`${colors.yellow}+-- ${colors.red}✖ Execution Aborted${colors.reset}`);
                        } else {
                            toolResult = `User denied command execution and provided this feedback/instruction: "${ans}"`;
                            sysLog(`${colors.yellow}+-- ${colors.yellow}⚠ Aborted. Feedback routed to AI.${colors.reset}`);
                        }
                    
                    } else if (call.tool === 'spawn_sub_agent') {
                        sysLog(`${colors.yellow}|${colors.reset}  ${colors.magenta}Spawning Worker Node: ${colors.bold}${call.args.role}${colors.reset}`);
                        spinner.start();
                        spinner.update(`Worker [${call.args.role}] is active`);
                        
                        try {
                            const workerPrompt = `You are an elite, specialized ${call.args.role} worker drone in a swarm framework. Your sole objective is: ${call.args.task}. Provide a raw, detailed, and highly actionable text report without JSON wrapping. Do NOT use <think> blocks. Just execute the task directly.`;
                            const subAgentResponse = await api.callAI({
                                activeModel, chatHistory: [{ role: "user", content: call.args.task }], promptText: call.args.task, abortController: new AbortController(), spinner: { start: () => {}, stop: () => {}, update: () => {} }, sysLog: () => {}, colors, SYSTEM_PROMPT: workerPrompt
                            });
                            let cleanReport = subAgentResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                            toolResult = `[SWARM NODE REPORT: ${call.args.role}]\n${cleanReport}`;
                            spinner.stop(true);
                            sysLog(`${colors.yellow}+-- ${colors.green}✔ Worker Node Terminated (Data Received)${colors.reset}`);
                        } catch(e) {
                            spinner.stop(true);
                            toolResult = `[SWARM FATAL ERROR]: Worker node ${call.args.role} failed: ${e.message}`;
                            sysLog(`${colors.yellow}+-- ${colors.red}✖ Worker Node Failed${colors.reset}`);
                        }
                    } else {
                        sysLog(`${colors.yellow}|${colors.reset}  ${colors.dim}Executing API Tool...${colors.reset}`);
                        spinner.start();
                        spinner.update(`Running ${call.tool}`);
                        toolResult = await tools.execute(call.tool, call.args);
                        spinner.stop(true);
                        sysLog(`${colors.yellow}+-- ${colors.green}✔ Done${colors.reset}`);
                    }
                    
                    if (toolResult && toolResult.trim().length > 0) {
                        sysLog(`${colors.yellow}+-- 📄 Tool Output:${colors.reset}`);
                        const outLines = toolResult.trim().replace(/\r/g, '').split('\n');
                        const displayLines = outLines.slice(0, 25);
                        displayLines.forEach(l => sysLog(`${colors.yellow}|${colors.reset}  ${colors.dim}${l}${colors.reset}`));
                        if (outLines.length > 25) {
                            sysLog(`${colors.yellow}|${colors.reset}  ${colors.dim}... (${outLines.length - 25} more lines hidden from UI to save screen space)${colors.reset}`);
                        }
                    }
                    sysLog(`${colors.yellow}\\----------------------------------------${colors.reset}`);
                    combinedResults += `\n--- Result for ${call.tool} ---\n${toolResult}\n`;
                }
                aiPrompt = `Batched tools executed. Results:\n${combinedResults}\nUpdate your task manager and continue.`;
                chatHistory.push({ role: "system", content: aiPrompt });
                
            } else if (parsed.action === "complete") {
                sysLog(`\n${colors.bold}${colors.green}+-- ◆ AI --------------------------------${colors.reset}`);
                await sysLogAnimated(parsed.result, `${colors.green}|${colors.reset}  `);
                sysLog(`${colors.bold}${colors.green}\\----------------------------------------${colors.reset}`);
                chatHistory.push({ role: "ai", content: parsed.result });
                isComplete = true;
            } else {
                sysLog(`\n${colors.bold}${colors.green}+-- ◆ AI (JSON Output) ------------------${colors.reset}`);
                await sysLogAnimated(JSON.stringify(parsed, null, 2), `${colors.green}|${colors.reset}  `);
                sysLog(`${colors.bold}${colors.green}\\----------------------------------------${colors.reset}`);
                chatHistory.push({ role: "ai", content: JSON.stringify(parsed) });
                isComplete = true;
            }

        } catch(err) {
            spinner.stop(true);
            if (err.name === 'AbortError' || err.message === 'AbortError') {
                sysLog(`${colors.yellow}⚠ Task aborted successfully.${colors.reset}`);
                break;
            }
            sysLog(`\n${colors.red}${colors.bold}✖ API Error Intercepted:${colors.reset} ${err.message}\n`);
            sysLog(`${colors.bold}${colors.cyan}+-- Auto-Model Rescue -------------------${colors.reset}`);
            sysLog(`${colors.cyan}|${colors.reset} ${colors.dim}The current model (${activeModel.name}) rejected the request.${colors.reset}`);
            sysLog(`${colors.cyan}|${colors.reset} ${colors.green}[M]${colors.reset} Switch to a different model and auto-resume task`);
            sysLog(`${colors.cyan}|${colors.reset} ${colors.green}[A]${colors.reset} Abort and return to prompt`);
            sysLog(`${colors.bold}${colors.cyan}\\----------------------------------------${colors.reset}`);
            
            rl.removeListener('line', lineHandler);
            const fallbackChoice = await askSync(`\nSelect action [M/A]: `);
            rl.on('line', lineHandler);

            if (fallbackChoice.trim().toLowerCase() === 'm') {
                const switched = await switchModelMenu();
                if (switched) {
                    sysLog(`\n${colors.green}✔ Resuming active task using ${activeModel.name}...${colors.reset}\n`);
                    abortController = new AbortController(); 
                    continue; 
                } else {
                    sysLog(`${colors.yellow}⚠ Model switch cancelled. Task aborted.${colors.reset}`);
                    break;
                }
            } else {
                sysLog(`${colors.yellow}⚠ Task aborted by user.${colors.reset}`);
                break;
            }
        }
    }
    
    isProcessing = false;
    rl.prompt(true);
}

loadConfig();

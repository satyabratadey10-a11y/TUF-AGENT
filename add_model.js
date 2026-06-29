const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MODELS_FILE = path.join(__dirname, 'models.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, ans => res(ans.trim())));

async function main() {
    console.log("\n\x1b[36m┌──────────────────────────────────────────┐");
    console.log("│         MODEL CONFIGURATION UTILITY      │");
    console.log("└──────────────────────────────────────────┘\x1b[0m\n");

    const name = await ask("Enter Model Name (e.g., OpenRouter Claude 3.5): ");
    if (!name) { console.log("\x1b[31m✖ Name cannot be empty.\x1b[0m\n"); process.exit(1); }

    const id = await ask("Enter Model ID (e.g., anthropic/claude-3.5-sonnet): ");
    const endpoint = await ask("Enter Endpoint URL (Press Enter for default NVIDIA NIM URL): ") || "https://integrate.api.nvidia.com/v1";
    const apiKey = await ask("Enter API Key (Mandatory): ");
    if (!apiKey) { console.log("\x1b[31m✖ API Key is required.\x1b[0m\n"); process.exit(1); }

    const tempInput = await ask("Enter Temperature [Press Enter for 0.3]: ");
    const temperature = tempInput !== "" ? parseFloat(tempInput) : 0.3;

    const tokenInput = await ask("Enter Max Tokens [Press Enter for 4096]: ");
    const maxTokens = tokenInput !== "" ? parseInt(tokenInput, 10) : 4096;

    const streamInput = await ask("Enable Stream? (true/false) [Press Enter for true]: ");
    const stream = streamInput === "false" ? false : true;

    let models = [];
    try { if (fs.existsSync(MODELS_FILE)) models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch(e) {}

    // Overwrite if exact ID match exists
    models = models.filter(m => m.id !== id);
    models.push({ name, id, endpoint, apiKey, temperature, maxTokens, stream });

    fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2));
    console.log(`\n\x1b[32m✔ Successfully configured [${name}]\x1b[0m\n`);
    process.exit(0);
}
main();

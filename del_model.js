const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MODELS_FILE = path.join(__dirname, 'models.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, ans => res(ans.trim())));

async function main() {
    console.log("\n\x1b[31m┌──────────────────────────────────────────┐");
    console.log("│           MODEL DELETION PANEL           │");
    console.log("└──────────────────────────────────────────┘\x1b[0m\n");

    let models = [];
    try { if (fs.existsSync(MODELS_FILE)) models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch(e) {}

    if (models.length === 0) {
        console.log("\x1b[33m⚠ No active cores found in models.json.\x1b[0m\n");
        process.exit(0);
    }

    console.log("Available Active Cores:");
    models.forEach((m, idx) => {
        console.log(`  \x1b[36m[${idx + 1}]\x1b[0m ${m.name} \x1b[2m(${m.id})\x1b[2m`);
    });

    const choice = await ask(`\nSelect a core to remove [1-${models.length}]: `);
    const index = parseInt(choice, 10) - 1;

    if (!isNaN(index) && index >= 0 && index < models.length) {
        const removed = models.splice(index, 1);
        fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2));
        console.log(`\x1b[31m✔ Successfully dropped core: ${removed[0].name}\x1b[0m\n`);
    } else {
        console.log("\x1b[33m⚠ Invalid selection. Operation aborted.\x1b[0m\n");
    }
    process.exit(0);
}
main();

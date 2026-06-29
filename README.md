# AxilO AGENT

AxilO AGENT is an elite, autonomous AI Orchestrator and runtime engineered for terminal-first workflows, swarm delegation, and native execution on Termux (Android/aarch64) and standard POSIX environments.

The architecture is hidden entirely within a global home directory configuration (`~/.axilo/`), enabling zero-trail execution from any current workspace path without duplicating files or breaking relative dependencies.

## Highlights

- **Hidden System Core:** Entire orchestration stack resides globally in `~/.axilo/` to keep your active workspace directories immaculate.

- **Global Flag Injection:** Single-command global `axilo` utility with native routing flags (`--add-model`, `--delete-model`, `--clear-sessions`).

- **Interactive Multi-Turn Engine:** Self-contained terminal layout featuring deterministic low-temperature processing (`0.3`), greeting bypass channels, and a fail-safe streaming validator for incoming chunk pipelines.

- **Swarm & Tool Delegation:** Pluggable schema-based tool execution layer featuring recursive background compilation monitoring, self-healing builds, child sub-agent spawning, and detached process lifecycle handling.

- **Universal Provider Compliance:** Built-in history payload restructuring to ensure strict alternating role arrays to satisfy strict remote gateway formatting requirements.

## Architecture & Project Layout

The framework hides its components within the root configuration layer to enable zero-leak execution:

| Global Path | Purpose |
|-------------|---------|
| `$PREFIX/bin/axilo` | Global binary shortcut script managing routing flags and running from current path |
| `~/.axilo/agent.js` | Main Orchestrator, terminal loop, and tool execution system |
| `~/.axilo/connection.js` | Universal API gateway layer with streaming choice hooks |
| `~/.axilo/add_model.js` | Interactive console wizard requesting full API credentials |
| `~/.axilo/del_model.js` | Interactive indexed listing selection panel for quick core drops |
| `~/.axilo/tools.js` | Modular tool schema execution registry |
| `~/.axilo/skills/` | Markdown archive tracking ingested design rules and platform guidelines |
| `~/.axilo/sessions/` | Workspace directory maintaining runtime multi-turn historical logs |
| `~/.axilo/imp_memo.md` | Persistent global memory injected directly into the system context |
| `~/.axilo/experience.md` | Self-improvement engine tracking automated lessons learned |

## Global Command Usage

The wrapper script tracks flag commands directly from your terminal cursor, independent of your active working directory.

### 1. Launch the Runtime Conductor

Boot up the interactive orchestrator loop directly from your current workspace:

```bash
axilo
```

2. Interactive Model Credential Addition

Launches the wizard to securely input Name, ID, custom Base Endpoint URL, API Keys, and token ceilings directly into the encrypted global scope:

```bash
axilo --add-model
```

3. Interactive Model Core Drop

Brings up a numerical selector from 1 to Max to safely drop specific configuration indices:

```bash
axilo --delete-model
```

4. Purge All Cached Contexts

Instantly cleans out the workspace trace files, wiping out old or uninitialized session tracking blocks:

```bash
axilo --clear-sessions
```

System Configurations & Fail-Safes

Stream Disconnection Shield

The streaming channel validates incoming text chunks securely inside connection.js:

```javascript
if (chunk && chunk.choices &&
    chunk.choices[0] && chunk.choices[0].delta) {
  const content = chunk.choices[0].delta.content || "";
  fulltext += content;
}
```

This blocks empty API frames from causing a system exception when remote streaming socket pipelines drop unexpectedly.

Role Alternation Array Flattening

To comply with strict multi-turn validation structures, historical message arrays are automatically parsed into alternating sequences:

```
[System Instruction] + [User Prompt] ⇢ [Assistant Output] + [User Prompt]
```

Any consecutive tracking indices of matching roles are cleanly combined to guarantee zero-fault query validation passes regardless of the backend endpoint provider.

Troubleshooting

· Module Not Found Errors: If the system complains about missing dependencies, execute npm install openai inside the ~/.axilo home layer.
· Empty File Generation Logs: Ensure your agent models are configured to run with structured JSON syntax payloads. If an endpoint drops the format, check the terminal trace boards to locate the target logs.
· Environment API Dropouts: If the server returns empty payloads or authorization failures, confirm that your target shell environment variables hold active authentication values for your chosen API provider.

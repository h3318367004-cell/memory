# Codex Memory Cloud

One memory system, one cloud data source.

```text
Codex local MCP -> Cloudflare Worker -> D1
ChatGPT / other AI URL -> Cloudflare Worker -> D1
```

The Worker owns the tools. The local MCP server is only a thin stdio bridge to the same URL that ChatGPT can call.

## Tools

- `wakeup`: grouped wakeup context: state, core, projects, feel, hot, recent, dream
- `search`: lexical + Zhipu vector ranking, with layer/kind/tag filters
- `remember`: save or upsert a memory atom
- `revise`: update a memory atom
- `pin`: boost a memory into wakeup
- `archive`: hide stale memory without deleting it
- `supersede`: mark one memory as replaced by another
- `link`: create typed memory relations
- `dream`: DeepSeek consolidation into durable dream summaries
- `state`: get/set/list wakeup state

## Memory Philosophy

Layers:

- `core`: durable preferences, boundaries, stable relationship facts
- `identity`: names and selfhood
- `relationship`: relationship-state memory
- `episode`: dated events
- `feel`: Codex's felt interpretation
- `project`: project state and open loops
- `dream`: consolidation summaries
- `working`: temporary working state
- `note`: uncategorized memory

Each memory has importance, confidence, sensitivity, tags, emotion score, pin/lock, archive/supersede state, recall heat, optional Zhipu embedding, and metadata.

## Cloudflare

```powershell
npm install
npm run db:migrate
wrangler secret put CODEX_MEMORY_TOKEN --config ./worker/wrangler.toml
wrangler secret put DEEPSEEK_API_KEY --config ./worker/wrangler.toml
wrangler secret put ZHIPU_API_KEY --config ./worker/wrangler.toml
npm run worker:deploy
```

Worker URL:

```text
https://codex-memory-cloud.h3318367004.workers.dev
```

OpenAPI for ChatGPT Actions:

```text
https://codex-memory-cloud.h3318367004.workers.dev/openapi.json
```

Auth uses:

```http
Authorization: Bearer <CODEX_MEMORY_TOKEN>
```

## Local Codex MCP

```toml
[mcp_servers.codex_private_memory]
args = ['C:\cyberboss-roundtable\codex-memory\src\mcp-server.js']
command = "node"
startup_timeout_sec = 30

[mcp_servers.codex_private_memory.env]
CODEX_MEMORY_WORKER_URL = 'https://codex-memory-cloud.h3318367004.workers.dev'
CODEX_MEMORY_TOKEN = 'same-token'
```

## Import Local Memory

Local source files are ignored by git:

- `relationship_memory.json`
- `feel.jsonl`
- `event_log.jsonl`

Import through the Worker:

```powershell
npm run import:local
```

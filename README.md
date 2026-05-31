# Codex Memory Cloud

Codex-only private memory kernel on Supabase Postgres and Cloudflare Workers.

This is not a chat cache. It is a cloud memory system with durable memory atoms, wakeup context, state, typed links, dream consolidation, archive/supersede semantics, a Cloudflare Worker gateway, and local MCP tools for Codex only.

## Architecture

- Cloud gateway: Cloudflare Worker
- Cloud database: Supabase Postgres
- Vector support: `pgvector` with optional `text-embedding-3-small`
- Default search: Postgres full text + importance + confidence + recency + heat + pinned/locked boosts
- Local entry: MCP stdio server calling the Worker when `CODEX_MEMORY_WORKER_URL` is configured
- Claude entry: none

## Memory Model

Main table: `public.codex_memories`

Layers:

- `core`: durable preferences, boundaries, long-lived relationship facts
- `identity`: names, selfhood, stable identity facts
- `relationship`: relationship-state memory
- `episode`: dated events
- `feel`: Codex's felt interpretation
- `project`: project state and open threads
- `dream`: generated consolidation summaries
- `working`: temporary working state
- `note`: uncategorized durable notes

Supporting tables:

- `public.codex_memory_links`: typed relations between memory atoms
- `public.codex_memory_state`: current state shown during wakeup
- `public.codex_memory_dreams`: consolidation runs and source memory ids

## Setup

```powershell
npm install
npm run db:migrate
```

For local fallback you can use:

```dotenv
CODEX_MEMORY_DATABASE_URL=postgresql://postgres:your-password@db.yapkbzfwtwzbzqufsgwr.supabase.co:5432/postgres
```

or:

```dotenv
CODEX_MEMORY_DB_PASSWORD_FILE=C:\path\to\postgres-password-or-url.txt
```

## Cloudflare Worker

The Worker is the preferred runtime path. It exposes authenticated HTTPS endpoints under `/tool/*` and talks to Supabase over HTTP.

```powershell
npm run worker:dry-run
wrangler login
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config ./worker/wrangler.toml
wrangler secret put CODEX_MEMORY_TOKEN --config ./worker/wrangler.toml
npm run worker:deploy
```

After deploy, configure local MCP with:

```dotenv
CODEX_MEMORY_WORKER_URL=https://codex-memory-cloud.your-subdomain.workers.dev
CODEX_MEMORY_TOKEN=the-same-token-you-put-in-worker
```

If those variables are absent, the MCP server falls back to direct Postgres access for local debugging.

## Import Local Memory

```powershell
npm run import:local
```

The importer reads local private source files, which are intentionally ignored by git:

- `relationship_memory.json`
- `feel.jsonl`
- `event_log.jsonl`

## Codex MCP Config

```toml
[mcp_servers.codex_private_memory]
args = ['C:\cyberboss-roundtable\codex-memory\src\mcp-server.js']
command = "node"
startup_timeout_sec = 30

[mcp_servers.codex_private_memory.env]
CODEX_MEMORY_WORKER_URL = 'https://codex-memory-cloud.your-subdomain.workers.dev'
CODEX_MEMORY_TOKEN = 'the-same-token-you-put-in-worker'
```

## Tools

- `wakeup`: returns grouped wakeup context: state, core, projects, feel, hot, recent, dream
- `search`: searches cloud memory with layer/kind/tag filters
- `remember`: saves or upserts a memory atom
- `revise`: updates an existing memory atom
- `pin`: pins or unpins a memory
- `archive`: archives stale memory without deleting it
- `supersede`: marks one memory as replaced by a newer one
- `link`: creates a typed relation between two memories
- `dream`: consolidates memories into a durable dream summary and links the sources
- `state`: gets, sets, or lists current wakeup state keys

The wakeup tool is named `wakeup`, not `wakeupCodex`.

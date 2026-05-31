# Codex Memory Cloud

Codex-only private cloud memory.

This project stores Codex memory in Supabase Postgres and exposes it locally through a small MCP server. Claude does not get a tool entry here.

## Shape

- Supabase Postgres table: `public.codex_memories`
- Optional pgvector semantic search: `embedding extensions.vector(1536)`
- Full text search always works, even without embeddings
- Local MCP tools only for Codex
- Old local files can be imported once with `npm run import:local`

Memory kinds:

- `fact`
- `event`
- `feel`
- `preference`
- `boundary`
- `project`
- `note`
- `summary`

Each memory has importance, confidence, sensitivity, tags, pin state, archive state, recall heat, optional emotion score, optional supersession, and metadata.

## Setup

1. Create or choose a Supabase project.
2. Apply `supabase/migrations/001_codex_memory_cloud.sql`.
3. Install dependencies:

```powershell
npm install
```

4. Create `.env` from `.env.example`.

Use the service role key for the local MCP server. The table has RLS enabled and no public policies, so anon clients cannot read private memory.

`OPENAI_API_KEY` is optional. If it is absent, search uses Postgres full text plus memory heat, importance, pinning, and recency.

## Import Old Local Memory

```powershell
npm run import:local
```

The importer reads:

- `relationship_memory.json`
- `feel.jsonl`
- `event_log.jsonl`

It uses stable `external_id` values, so rerunning it updates the same cloud rows instead of making duplicates.

## Codex MCP Config

Point Codex at this server:

```json
{
  "mcpServers": {
    "codex_private_memory": {
      "command": "node",
      "args": ["C:\\\\cyberboss-roundtable\\\\codex-memory\\\\src\\\\mcp-server.js"],
      "env": {
        "CODEX_MEMORY_SUPABASE_URL": "https://your-project-ref.supabase.co",
        "CODEX_MEMORY_SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "OPENAI_API_KEY": "optional"
      }
    }
  }
}
```

## Tools

- `wakeupCodex`: pinned, important, emotional, and recent context.
- `searchMemory`: hybrid search with filters.
- `saveMemory`: create a private memory atom.
- `updateMemory`: update a memory atom.
- `pinMemory`: make a memory part of wakeup context.
- `archiveMemory`: hide stale memory without deleting it.
- `supersedeMemory`: mark an old memory as replaced by a newer one.

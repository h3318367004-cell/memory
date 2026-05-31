const { Client } = require("pg");
const { buildConnectionString } = require("./db-url");
const { readConfig } = require("./config");
const { embedText, embeddingInput } = require("./embedding");
const { normalizeMemoryInput, normalizeMemoryPatch } = require("./memory-service");

const WRITE_COLUMNS = [
  "external_id",
  "canonical_key",
  "kind",
  "layer",
  "title",
  "text",
  "summary",
  "source",
  "tags",
  "importance",
  "confidence",
  "sensitivity",
  "emotion_score",
  "pinned",
  "locked",
  "status",
  "memory_date",
  "valid_from",
  "valid_to",
  "expires_at",
  "metadata",
  "embedding",
];

function createPostgresMemoryService(options = {}) {
  const config = options.config || readOptionalConfig();
  const connectionString = options.connectionString || buildConnectionString();

  async function withClient(fn) {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  return {
    async remember(input = {}) {
      const memory = normalizeMemoryInput(input);
      return withClient(async (client) => upsertMemory(client, memory, config));
    },

    async search(input = {}) {
      const query = normalizeString(input.query);
      const embedding = await maybeEmbed(query, config);
      return withClient(async (client) => {
        const rows = await searchRows(client, {
          query,
          embedding,
          limit: clampInteger(input.limit, 1, 50, 8),
          kinds: normalizeArray(input.kinds || input.kind),
          layers: normalizeArray(input.layers || input.layer),
          tags: normalizeArray(input.tags),
          includeArchived: Boolean(input.includeArchived),
        });
        await touchReturned(client, rows);
        return rows;
      });
    },

    async wakeup(input = {}) {
      return withClient(async (client) => {
        const limit = clampInteger(input.limit, 4, 80, 24);
        const state = await listState(client);
        const core = await selectMemories(client, {
          where: "status = 'active' and archived_at is null and layer in ('core', 'identity', 'relationship')",
          limit: Math.min(12, limit),
          order: "locked desc, pinned desc, importance desc, updated_at desc",
        });
        const projects = await selectMemories(client, {
          where: "status = 'active' and archived_at is null and layer = 'project'",
          limit: 8,
          order: "pinned desc, importance desc, updated_at desc",
        });
        const feel = await selectMemories(client, {
          where: "status = 'active' and archived_at is null and layer = 'feel'",
          limit: 6,
          order: "abs(coalesce(emotion_score, 0)) desc, importance desc, updated_at desc",
        });
        const hot = await selectMemories(client, {
          where: "status = 'active' and archived_at is null",
          limit: Math.min(10, limit),
          order: "pinned desc, ln(1 + recall_count) desc, importance desc, updated_at desc",
        });
        const recent = await selectMemories(client, {
          where: "status = 'active' and archived_at is null",
          limit: Math.min(10, limit),
          order: "coalesce(memory_date, created_at) desc, updated_at desc",
        });
        const dream = await selectMemories(client, {
          where: "status = 'active' and archived_at is null and layer = 'dream'",
          limit: 4,
          order: "created_at desc",
        });
        const rowsToTouch = [...core, ...projects, ...feel, ...hot, ...recent, ...dream];
        await touchReturned(client, rowsToTouch);
        return { state, core, projects, feel, hot, recent, dream };
      });
    },

    async revise(input = {}) {
      const id = requireString(input.id, "id");
      const patch = normalizeMemoryPatch(input);
      if (!Object.keys(patch).length) throw new Error("at least one update field is required");
      return withClient(async (client) => {
        if (patch.text || patch.summary || patch.tags || patch.kind || patch.layer || patch.title) {
          const existing = await getMemory(client, id);
          patch.embedding = await embedForMemory({ ...existing, ...patch }, config);
        }
        return updateMemory(client, id, patch);
      });
    },

    async pin(input = {}) {
      return this.revise({ id: input.id, pinned: input.pinned !== false });
    },

    async archive(input = {}) {
      const id = requireString(input.id, "id");
      const reason = normalizeString(input.reason);
      return withClient(async (client) => {
        const existing = await getMemory(client, id);
        return updateMemory(client, id, {
          archived_at: new Date().toISOString(),
          status: "archived",
          metadata: reason ? { ...(existing.metadata || {}), archiveReason: reason } : existing.metadata,
        });
      });
    },

    async supersede(input = {}) {
      const id = requireString(input.id, "id");
      const supersededBy = requireString(input.supersededBy || input.superseded_by, "supersededBy");
      const note = normalizeString(input.note);
      return withClient(async (client) => {
        const existing = await getMemory(client, id);
        const updated = await updateMemory(client, id, {
          superseded_by: supersededBy,
          status: "superseded",
          metadata: note ? { ...(existing.metadata || {}), supersedeNote: note } : existing.metadata,
        });
        await linkMemories(client, {
          fromMemoryId: id,
          toMemoryId: supersededBy,
          relation: "superseded_by",
          strength: 1,
          note,
        });
        return updated;
      });
    },

    async link(input = {}) {
      return withClient((client) => linkMemories(client, input));
    },

    async state(input = {}) {
      const action = normalizeString(input.action || "list").toLowerCase();
      return withClient(async (client) => {
        if (action === "set") {
          const key = requireString(input.key, "key");
          const value = input.value === undefined ? null : input.value;
          const note = normalizeString(input.note);
          const result = await client.query({
            text: `
              insert into public.codex_memory_state (key, value, note)
              values ($1, $2, $3)
              on conflict (key) do update set value = excluded.value, note = excluded.note
              returning *
            `,
            values: [key, value, note || null],
          });
          return result.rows[0];
        }
        if (action === "get") {
          const key = requireString(input.key, "key");
          const result = await client.query("select * from public.codex_memory_state where key = $1", [key]);
          return result.rows[0] || null;
        }
        return listState(client);
      });
    },

    async dream(input = {}) {
      const kind = normalizeString(input.kind) || "ad_hoc";
      const limit = clampInteger(input.limit, 3, 80, 24);
      return withClient(async (client) => {
        const sourceRows = await selectMemories(client, {
          where: "status = 'active' and archived_at is null and layer <> 'dream'",
          limit,
          order: "coalesce(last_dreamed_at, 'epoch'::timestamptz) asc, pinned desc, importance desc, updated_at desc",
        });
        if (!sourceRows.length) throw new Error("no source memories available for dream");
        const text = await buildDreamText(sourceRows, input, config);
        const summaryMemory = await insertMemory(client, {
          external_id: `dream:${new Date().toISOString()}`,
          canonical_key: null,
          kind: "summary",
          layer: "dream",
          title: dreamTitle(kind),
          text,
          summary: firstLine(text),
          source: "codex-memory dream",
          tags: ["dream", kind],
          importance: clampNumber(input.importance, 0, 1, 0.75),
          confidence: 0.75,
          sensitivity: "low",
          emotion_score: null,
          pinned: Boolean(input.pinned),
          locked: false,
          status: "active",
          memory_date: new Date().toISOString(),
          valid_from: null,
          valid_to: null,
          expires_at: null,
          metadata: { sourceCount: sourceRows.length },
        }, config);
        const sourceIds = sourceRows.map((row) => row.id);
        await client.query({
          text: `
            insert into public.codex_memory_dreams
              (kind, period_start, period_end, source_memory_ids, summary_memory_id, text)
            values ($1, $2, $3, $4, $5, $6)
            returning *
          `,
          values: [
            kind,
            minDate(sourceRows),
            maxDate(sourceRows),
            sourceIds,
            summaryMemory.id,
            text,
          ],
        });
        for (const sourceId of sourceIds) {
          await linkMemories(client, {
            fromMemoryId: summaryMemory.id,
            toMemoryId: sourceId,
            relation: "summarizes",
            strength: 0.8,
          });
        }
        await client.query(
          "update public.codex_memories set last_dreamed_at = now(), dream_count = dream_count + 1 where id = any($1::uuid[])",
          [sourceIds],
        );
        return { summaryMemory, sourceCount: sourceRows.length, sourceIds };
      });
    },
  };
}

async function searchRows(client, input) {
  const clauses = [];
  const values = [];
  const query = normalizeString(input.query);
  if (!input.includeArchived) {
    clauses.push("m.archived_at is null and m.status = 'active'");
  }
  if (input.kinds.length) {
    values.push(input.kinds);
    clauses.push(`m.kind = any($${values.length}::text[])`);
  }
  if (input.layers.length) {
    values.push(input.layers);
    clauses.push(`m.layer = any($${values.length}::text[])`);
  }
  if (input.tags.length) {
    values.push(input.tags);
    clauses.push(`m.tags && $${values.length}::text[]`);
  }
  values.push(query);
  const queryIndex = values.length;
  values.push(input.embedding ? JSON.stringify(input.embedding) : null);
  const embeddingIndex = values.length;
  values.push(input.limit);
  const limitIndex = values.length;
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const result = await client.query({
    text: `
      with ranked as (
        select
          m.*,
          case
            when nullif(trim($${queryIndex}), '') is null then 0
            else ts_rank_cd(m.search_vector, websearch_to_tsquery('simple', $${queryIndex}))
          end as lexical_score,
          case
            when $${embeddingIndex}::extensions.vector is null or m.embedding is null then 0
            else greatest(0, 1 - (m.embedding <=> $${embeddingIndex}::extensions.vector))
          end as semantic_score,
          (1 / (1 + greatest(0, extract(epoch from (now() - m.updated_at)) / 86400) / 30)) as recency_score,
          (ln(1 + m.recall_count) / 5) as heat_score
        from public.codex_memories m
        ${where}
      )
      select *,
        (
          lexical_score * 0.35 +
          semantic_score * 0.45 +
          importance * 0.25 +
          confidence * 0.10 +
          recency_score * 0.10 +
          heat_score * 0.15 +
          case when pinned then 0.50 else 0 end +
          case when locked then 0.35 else 0 end
        ) as score
      from ranked
      where
        nullif(trim($${queryIndex}), '') is null
        or search_vector @@ websearch_to_tsquery('simple', $${queryIndex})
        or ($${embeddingIndex}::extensions.vector is not null and embedding is not null)
      order by score desc, updated_at desc
      limit $${limitIndex}
    `,
    values,
  });
  return result.rows;
}

async function selectMemories(client, { where, order, limit }) {
  const result = await client.query(`
    select *
    from public.codex_memories
    where ${where}
    order by ${order}
    limit ${Math.max(1, Math.min(80, limit))}
  `);
  return result.rows;
}

async function insertMemory(client, memory, config) {
  const normalized = normalizeMemoryInput(memory);
  normalized.embedding = await embedForMemory(normalized, config);
  const columns = WRITE_COLUMNS.filter((column) => normalized[column] !== undefined);
  const values = columns.map((column) => normalized[column]);
  const placeholders = columns.map((column, index) => column === "embedding"
    ? `$${index + 1}::extensions.vector`
    : `$${index + 1}`);
  const result = await client.query({
    text: `
      insert into public.codex_memories (${columns.join(", ")})
      values (${placeholders.join(", ")})
      returning *
    `,
    values,
  });
  return result.rows[0];
}

async function upsertMemory(client, memory, config) {
  const normalized = normalizeMemoryInput(memory);
  normalized.embedding = await embedForMemory(normalized, config);
  const columns = WRITE_COLUMNS.filter((column) => normalized[column] !== undefined);
  const values = columns.map((column) => normalized[column]);
  const placeholders = columns.map((column, index) => column === "embedding"
    ? `$${index + 1}::extensions.vector`
    : `$${index + 1}`);
  const conflict = normalized.canonical_key ? "canonical_key" : "external_id";
  const updates = columns
    .filter((column) => column !== conflict)
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  const result = await client.query({
    text: `
      insert into public.codex_memories (${columns.join(", ")})
      values (${placeholders.join(", ")})
      on conflict (${conflict}) do update set ${updates}
      returning *
    `,
    values,
  });
  return result.rows[0];
}

async function getMemory(client, id) {
  const result = await client.query("select * from public.codex_memories where id = $1", [id]);
  if (!result.rows[0]) throw new Error(`memory not found: ${id}`);
  return result.rows[0];
}

async function updateMemory(client, id, patch) {
  const entries = Object.entries(patch)
    .filter(([key, value]) => WRITE_COLUMNS.includes(key) || ["archived_at", "superseded_by"].includes(key))
    .filter(([, value]) => value !== undefined);
  if (!entries.length) throw new Error("no valid update fields");
  const assignments = entries.map(([key], index) => key === "embedding"
    ? `${key} = $${index + 2}::extensions.vector`
    : `${key} = $${index + 2}`);
  const result = await client.query({
    text: `
      update public.codex_memories
      set ${assignments.join(", ")}
      where id = $1
      returning *
    `,
    values: [id, ...entries.map(([, value]) => value)],
  });
  if (!result.rows[0]) throw new Error(`memory not found: ${id}`);
  return result.rows[0];
}

async function linkMemories(client, input = {}) {
  const fromMemoryId = requireString(input.fromMemoryId || input.from_memory_id || input.from, "fromMemoryId");
  const toMemoryId = requireString(input.toMemoryId || input.to_memory_id || input.to, "toMemoryId");
  const relation = normalizeString(input.relation) || "related";
  const strength = clampNumber(input.strength, 0, 1, 0.5);
  const note = normalizeString(input.note) || null;
  const result = await client.query({
    text: `
      insert into public.codex_memory_links
        (from_memory_id, to_memory_id, relation, strength, note)
      values ($1, $2, $3, $4, $5)
      on conflict (from_memory_id, to_memory_id, relation) do update set
        strength = excluded.strength,
        note = excluded.note
      returning *
    `,
    values: [fromMemoryId, toMemoryId, relation, strength, note],
  });
  return result.rows[0];
}

async function listState(client) {
  const result = await client.query("select key, value, note, updated_at from public.codex_memory_state order by key");
  return result.rows;
}

async function touchReturned(client, rows) {
  for (const id of [...new Set((rows || []).map((row) => row.id).filter(Boolean))]) {
    await client.query("select public.codex_memory_touch($1)", [id]);
  }
}

async function buildDreamText(rows, input, config) {
  const instruction = normalizeString(input.instruction);
  if (config.openaiApiKey) {
    const body = [
      "Summarize these private memory records into one concise durable memory.",
      "Keep stable facts, relationship state, project state, decisions, and open threads.",
      "Mention contradictions or stale items if visible.",
      instruction ? `Extra instruction: ${instruction}` : "",
      "",
      ...rows.map((row, index) => `${index + 1}. [${row.layer}/${row.kind}] ${row.title || row.summary || row.external_id}\n${row.text}`),
    ].filter(Boolean).join("\n");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.CODEX_MEMORY_DREAM_MODEL || "gpt-4.1-mini",
        messages: [{ role: "user", content: body }],
        temperature: 0.2,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
  }
  const grouped = groupBy(rows, (row) => row.layer || "note");
  return Object.entries(grouped).map(([layer, items]) => {
    const lines = items.slice(0, 8).map((row) => `- ${row.title || row.summary || row.external_id}: ${row.summary || row.text}`);
    return `## ${layer}\n${lines.join("\n")}`;
  }).join("\n\n");
}

function groupBy(rows, fn) {
  return rows.reduce((acc, row) => {
    const key = fn(row);
    acc[key] = acc[key] || [];
    acc[key].push(row);
    return acc;
  }, {});
}

function dreamTitle(kind) {
  return `Dream ${kind} ${new Date().toISOString().slice(0, 10)}`;
}

function firstLine(text) {
  return normalizeString(text).split(/\r?\n/).find(Boolean)?.slice(0, 240) || "Dream summary";
}

function minDate(rows) {
  return rows.map((row) => row.memory_date || row.created_at).filter(Boolean).sort()[0] || null;
}

function maxDate(rows) {
  return rows.map((row) => row.memory_date || row.created_at).filter(Boolean).sort().at(-1) || null;
}

async function embedForMemory(memory, config) {
  const embedding = await maybeEmbed(embeddingInput(memory), config);
  return embedding ? JSON.stringify(embedding) : null;
}

async function maybeEmbed(text, config) {
  if (!config.openaiApiKey) return null;
  return embedText(text, config);
}

function readOptionalConfig() {
  try {
    return readConfig();
  } catch {
    return {
      openaiApiKey: normalizeString(process.env.OPENAI_API_KEY),
      embeddingModel: normalizeString(process.env.CODEX_MEMORY_EMBEDDING_MODEL) || "text-embedding-3-small",
    };
  }
}

function normalizeArray(value) {
  const array = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(array.map(normalizeString).filter(Boolean))];
}

function requireString(value, name) {
  const text = normalizeString(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampInteger(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  createPostgresMemoryService,
};

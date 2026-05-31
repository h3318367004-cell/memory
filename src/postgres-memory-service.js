const { Client } = require("pg");
const { buildConnectionString } = require("./db-url");
const { readConfig } = require("./config");
const { embedText, embeddingInput } = require("./embedding");
const { normalizeMemoryInput, normalizeMemoryPatch } = require("./memory-service");

function createPostgresMemoryService(options = {}) {
  const config = options.config || readOptionalConfig();
  const connectionString = options.connectionString || buildConnectionString();

  async function withClient(fn) {
    const client = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  return {
    async saveMemory(input = {}) {
      const memory = normalizeMemoryInput(input);
      return withClient(async (client) => insertMemory(client, memory, config));
    },

    async upsertMemory(input = {}) {
      const memory = normalizeMemoryInput(input);
      return withClient(async (client) => upsertMemory(client, memory, config));
    },

    async searchMemory(input = {}) {
      const query = normalizeString(input.query);
      const embedding = await maybeEmbed(query, config);
      return withClient(async (client) => {
        const result = await client.query({
          text: `
            select *
            from public.codex_memory_search($1, $2::extensions.vector, $3, $4::text[], $5::text[], $6)
          `,
          values: [
            query,
            embedding ? JSON.stringify(embedding) : null,
            clampInteger(input.limit, 1, 50, 8),
            normalizeArray(input.kinds),
            normalizeArray(input.tags),
            Boolean(input.includeArchived),
          ],
        });
        await touchReturned(client, result.rows);
        return result.rows;
      });
    },

    async wakeup(input = {}) {
      return withClient(async (client) => {
        const result = await client.query("select * from public.codex_memory_wakeup($1)", [
          clampInteger(input.limit, 1, 50, 12),
        ]);
        await touchReturned(client, result.rows);
        return result.rows;
      });
    },

    async getMemory(id) {
      const cleanId = requireString(id, "id");
      return withClient(async (client) => getMemory(client, cleanId));
    },

    async updateMemory(input = {}) {
      const id = requireString(input.id, "id");
      const patch = normalizeMemoryPatch(input);
      if (!Object.keys(patch).length) {
        throw new Error("at least one update field is required");
      }
      return withClient(async (client) => {
        if (patch.text || patch.summary || patch.tags || patch.kind) {
          const existing = await getMemory(client, id);
          const nextMemory = { ...existing, ...patch };
          const embedding = await maybeEmbed(embeddingInput(nextMemory), config);
          patch.embedding = embedding ? JSON.stringify(embedding) : null;
        }
        return updateMemory(client, id, patch);
      });
    },

    async pinMemory(input = {}) {
      return this.updateMemory({ id: input.id, pinned: input.pinned !== false });
    },

    async archiveMemory(input = {}) {
      const id = requireString(input.id, "id");
      const reason = normalizeString(input.reason);
      return withClient(async (client) => {
        const existing = await getMemory(client, id);
        return updateMemory(client, id, {
          archived_at: new Date().toISOString(),
          metadata: reason ? { ...(existing.metadata || {}), archiveReason: reason } : existing.metadata,
        });
      });
    },

    async supersedeMemory(input = {}) {
      const id = requireString(input.id, "id");
      const supersededBy = requireString(input.supersededBy, "supersededBy");
      const note = normalizeString(input.note);
      return withClient(async (client) => {
        const existing = await getMemory(client, id);
        return updateMemory(client, id, {
          superseded_by: supersededBy,
          metadata: note ? { ...(existing.metadata || {}), supersedeNote: note } : existing.metadata,
        });
      });
    },
  };
}

async function insertMemory(client, memory, config) {
  const embedding = await maybeEmbed(embeddingInput(memory), config);
  const result = await client.query({
    text: `
      insert into public.codex_memories (
        external_id, kind, text, summary, source, tags, importance, confidence,
        sensitivity, emotion_score, pinned, metadata, embedding
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::extensions.vector)
      returning *
    `,
    values: memoryValues(memory, embedding),
  });
  return result.rows[0];
}

async function upsertMemory(client, memory, config) {
  const embedding = await maybeEmbed(embeddingInput(memory), config);
  const result = await client.query({
    text: `
      insert into public.codex_memories (
        external_id, kind, text, summary, source, tags, importance, confidence,
        sensitivity, emotion_score, pinned, metadata, embedding
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::extensions.vector)
      on conflict (external_id) do update set
        kind = excluded.kind,
        text = excluded.text,
        summary = excluded.summary,
        source = excluded.source,
        tags = excluded.tags,
        importance = excluded.importance,
        confidence = excluded.confidence,
        sensitivity = excluded.sensitivity,
        emotion_score = excluded.emotion_score,
        pinned = excluded.pinned,
        metadata = excluded.metadata,
        embedding = excluded.embedding
      returning *
    `,
    values: memoryValues(memory, embedding),
  });
  return result.rows[0];
}

function memoryValues(memory, embedding) {
  return [
    memory.external_id,
    memory.kind,
    memory.text,
    memory.summary,
    memory.source,
    memory.tags,
    memory.importance,
    memory.confidence,
    memory.sensitivity,
    memory.emotion_score,
    memory.pinned,
    memory.metadata,
    embedding ? JSON.stringify(embedding) : null,
  ];
}

async function getMemory(client, id) {
  const result = await client.query("select * from public.codex_memories where id = $1", [id]);
  if (!result.rows[0]) throw new Error(`memory not found: ${id}`);
  return result.rows[0];
}

async function updateMemory(client, id, patch) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  const assignments = entries.map(([key], index) => {
    if (key === "embedding") return `${key} = $${index + 2}::extensions.vector`;
    return `${key} = $${index + 2}`;
  });
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

async function touchReturned(client, rows) {
  for (const id of [...new Set((rows || []).map((row) => row.id).filter(Boolean))]) {
    await client.query("select public.codex_memory_touch($1)", [id]);
  }
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

module.exports = {
  createPostgresMemoryService,
};

const { readConfig } = require("./config");
const { embedText, embeddingInput } = require("./embedding");
const { createSupabaseMemoryClient } = require("./supabase");

const KINDS = new Set(["fact", "event", "feel", "preference", "boundary", "project", "note", "summary"]);
const SENSITIVITY = new Set(["low", "medium", "high"]);

function createMemoryService(options = {}) {
  const config = options.config || readConfig();
  const supabase = options.supabase || createSupabaseMemoryClient(config);

  return {
    async saveMemory(input = {}) {
      const memory = normalizeMemoryInput(input);
      const embedding = await embedText(embeddingInput(memory), config);
      const payload = { ...memory };
      if (embedding) payload.embedding = embedding;
      const query = supabase.from("codex_memories").insert(payload).select("*").single();
      return unwrap(await query);
    },

    async upsertMemory(input = {}) {
      const memory = normalizeMemoryInput(input);
      if (!memory.external_id) {
        return this.saveMemory(memory);
      }
      const embedding = await embedText(embeddingInput(memory), config);
      const payload = { ...memory };
      if (embedding) payload.embedding = embedding;
      const query = supabase
        .from("codex_memories")
        .upsert(payload, { onConflict: "external_id" })
        .select("*")
        .single();
      return unwrap(await query);
    },

    async searchMemory(input = {}) {
      const query = normalizeString(input.query);
      const embedding = await embedText(query, config);
      const { data, error } = await supabase.rpc("codex_memory_search", {
        query_text: query,
        query_embedding: embedding,
        match_count: clampInteger(input.limit, 1, 50, 8),
        filter_kinds: normalizeArray(input.kinds),
        filter_tags: normalizeArray(input.tags),
        include_archived: Boolean(input.includeArchived),
      });
      const rows = unwrap({ data, error });
      await touchReturned(rows);
      return rows;
    },

    async wakeup(input = {}) {
      const { data, error } = await supabase.rpc("codex_memory_wakeup", {
        match_count: clampInteger(input.limit, 1, 50, 12),
      });
      const rows = unwrap({ data, error });
      await touchReturned(rows);
      return rows;
    },

    async updateMemory(input = {}) {
      const id = normalizeString(input.id);
      if (!id) throw new Error("id is required");
      const patch = normalizeMemoryPatch(input);
      if (!Object.keys(patch).length) {
        throw new Error("at least one update field is required");
      }
      if (patch.text || patch.summary || patch.tags || patch.kind) {
        const existing = await this.getMemory(id);
        const nextMemory = { ...existing, ...patch };
        const embedding = await embedText(embeddingInput(nextMemory), config);
        patch.embedding = embedding || null;
      }
      const { data, error } = await supabase
        .from("codex_memories")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();
      return unwrap({ data, error });
    },

    async getMemory(id) {
      const cleanId = normalizeString(id);
      if (!cleanId) throw new Error("id is required");
      const { data, error } = await supabase
        .from("codex_memories")
        .select("*")
        .eq("id", cleanId)
        .single();
      return unwrap({ data, error });
    },

    async pinMemory(input = {}) {
      return this.updateMemory({ id: input.id, pinned: input.pinned !== false });
    },

    async archiveMemory(input = {}) {
      const id = normalizeString(input.id);
      if (!id) throw new Error("id is required");
      const note = normalizeString(input.reason);
      const existing = await this.getMemory(id);
      const { data, error } = await supabase
        .from("codex_memories")
        .update({
          archived_at: new Date().toISOString(),
          metadata: note ? { ...(existing.metadata || {}), archiveReason: note } : existing.metadata,
        })
        .eq("id", id)
        .select("*")
        .single();
      return unwrap({ data, error });
    },

    async supersedeMemory(input = {}) {
      const id = normalizeString(input.id);
      const supersededBy = normalizeString(input.supersededBy);
      if (!id) throw new Error("id is required");
      if (!supersededBy) throw new Error("supersededBy is required");
      const existing = await this.getMemory(id);
      const note = normalizeString(input.note);
      const { data, error } = await supabase
        .from("codex_memories")
        .update({
          superseded_by: supersededBy,
          metadata: note ? { ...(existing.metadata || {}), supersedeNote: note } : existing.metadata,
        })
        .eq("id", id)
        .select("*")
        .single();
      return unwrap({ data, error });
    },
  };

  async function touchReturned(rows) {
    const ids = [...new Set((Array.isArray(rows) ? rows : []).map((row) => row.id).filter(Boolean))];
    await Promise.all(ids.map((memory_id) => supabase.rpc("codex_memory_touch", { memory_id })));
  }
}

function normalizeMemoryInput(input = {}) {
  const text = normalizeString(input.text);
  if (!text) throw new Error("text is required");
  return {
    external_id: normalizeString(input.externalId || input.external_id) || undefined,
    kind: normalizeKind(input.kind),
    text,
    summary: normalizeString(input.summary) || null,
    source: normalizeString(input.source) || "codex",
    tags: normalizeArray(input.tags),
    importance: clampNumber(input.importance, 0, 1, 0.5),
    confidence: clampNumber(input.confidence, 0, 1, 0.8),
    sensitivity: normalizeSensitivity(input.sensitivity),
    emotion_score: input.emotionScore === undefined && input.emotion_score === undefined
      ? null
      : clampNumber(input.emotionScore ?? input.emotion_score, -1, 1, 0),
    pinned: Boolean(input.pinned),
    metadata: normalizeObject(input.metadata),
  };
}

function normalizeMemoryPatch(input = {}) {
  const patch = {};
  if ("externalId" in input || "external_id" in input) patch.external_id = normalizeString(input.externalId || input.external_id) || null;
  if ("kind" in input) patch.kind = normalizeKind(input.kind);
  if ("text" in input) patch.text = requireText(input.text);
  if ("summary" in input) patch.summary = normalizeString(input.summary) || null;
  if ("source" in input) patch.source = normalizeString(input.source) || "codex";
  if ("tags" in input) patch.tags = normalizeArray(input.tags);
  if ("importance" in input) patch.importance = clampNumber(input.importance, 0, 1, 0.5);
  if ("confidence" in input) patch.confidence = clampNumber(input.confidence, 0, 1, 0.8);
  if ("sensitivity" in input) patch.sensitivity = normalizeSensitivity(input.sensitivity);
  if ("emotionScore" in input || "emotion_score" in input) patch.emotion_score = clampNumber(input.emotionScore ?? input.emotion_score, -1, 1, 0);
  if ("pinned" in input) patch.pinned = Boolean(input.pinned);
  if ("metadata" in input) patch.metadata = normalizeObject(input.metadata);
  return patch;
}

function requireText(value) {
  const text = normalizeString(value);
  if (!text) throw new Error("text cannot be empty");
  return text;
}

function normalizeKind(value) {
  const kind = normalizeString(value).toLowerCase() || "note";
  return KINDS.has(kind) ? kind : "note";
}

function normalizeSensitivity(value) {
  const sensitivity = normalizeString(value).toLowerCase() || "low";
  return SENSITIVITY.has(sensitivity) ? sensitivity : "low";
}

function normalizeArray(value) {
  const array = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(array.map(normalizeString).filter(Boolean))];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function unwrap(result) {
  if (result.error) {
    throw new Error(result.error.message || String(result.error));
  }
  return result.data;
}

module.exports = {
  createMemoryService,
  normalizeMemoryInput,
};

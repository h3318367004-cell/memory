const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const TOOL_NAMES = [
  "wakeup",
  "search",
  "remember",
  "revise",
  "pin",
  "archive",
  "supersede",
  "link",
  "dream",
  "state",
];

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    let toolName = "";
    let ok = false;
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
      if (url.pathname === "/health") return json({ ok: true, service: "codex-memory-cloud", storage: "d1" });
      if (url.pathname === "/openapi.json") return json(openapi(url.origin));
      authorize(request, env);
      if (url.pathname === "/mcp") return handleMcp(request, env);
      if (!url.pathname.startsWith("/tool/")) return json({ error: "not found" }, 404);
      toolName = url.pathname.slice("/tool/".length);
      if (!TOOL_NAMES.includes(toolName)) return json({ error: "unknown tool" }, 404);
      const input = await readJson(request);
      const result = await callTool(toolName, input, env, request);
      ok = true;
      return json(result);
    } catch (error) {
      return json({ error: error.message || String(error) }, error.status || 500);
    } finally {
      if (toolName) {
        ctx.waitUntil(audit(env, request, toolName, ok, Date.now() - startedAt));
      }
    }
  },
};

async function handleMcp(request, env) {
  const message = await readJson(request);
  if (message.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-memory-cloud", version: "2.0.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return json({ jsonrpc: "2.0", id: message.id, result: { tools: toolDefinitions() } });
  }
  if (message.method === "tools/call") {
    const result = await callTool(message.params?.name, message.params?.arguments || {}, env, request);
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
    });
  }
  return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
}

async function callTool(name, input, env, request) {
  if (name === "wakeup") return wakeup(env, input);
  if (name === "search") return search(env, input);
  if (name === "remember") return remember(env, input);
  if (name === "revise") return revise(env, input);
  if (name === "pin") return pin(env, input);
  if (name === "archive") return archiveMemory(env, input);
  if (name === "supersede") return supersede(env, input);
  if (name === "link") return link(env, input);
  if (name === "dream") return dream(env, input);
  if (name === "state") return state(env, input);
  throw new HttpError("unknown tool", 404);
}

async function wakeup(env, input = {}) {
  const limit = clampInteger(input.limit, 4, 60, 24);
  const stateRows = await env.MEMORY_DB.prepare("select key, value_json, note, updated_at from memory_state order by key").all();
  const [core, projects, feel, hot, recent, dreamRows] = await Promise.all([
    selectMemories(env, "layer in ('core','identity','relationship') and status = 'active' and archived_at is null", "locked desc, pinned desc, importance desc, updated_at desc", Math.min(limit, 12)),
    selectMemories(env, "layer = 'project' and status = 'active' and archived_at is null", "pinned desc, importance desc, updated_at desc", 8),
    selectMemories(env, "layer = 'feel' and status = 'active' and archived_at is null", "abs(coalesce(emotion_score, 0)) desc, importance desc, updated_at desc", 6),
    selectMemories(env, "status = 'active' and archived_at is null", "pinned desc, recall_count desc, importance desc, updated_at desc", Math.min(limit, 10)),
    selectMemories(env, "status = 'active' and archived_at is null", "coalesce(memory_date, created_at) desc, updated_at desc", Math.min(limit, 10)),
    selectMemories(env, "layer = 'dream' and status = 'active' and archived_at is null", "created_at desc", 4),
  ]);
  await touch(env, uniqueIds([...core, ...projects, ...feel, ...hot, ...recent, ...dreamRows]));
  return {
    state: stateRows.results.map(formatState),
    core,
    projects,
    feel,
    hot,
    recent,
    dream: dreamRows,
  };
}

async function search(env, input = {}) {
  const query = clean(input.query);
  const layers = normalizeArray(input.layers || input.layer);
  const kinds = normalizeArray(input.kinds || input.kind);
  const tags = normalizeArray(input.tags);
  const limit = clampInteger(input.limit, 1, 50, 8);
  const includeArchived = Boolean(input.includeArchived);
  const rows = await allMemories(env, { includeArchived, layers, kinds, tags });
  const queryEmbedding = query ? await embed(env, query) : null;
  const scored = rows.map((row) => {
    const memory = formatMemory(row);
    const lexical = query ? lexicalScore(memory, query) : 0;
    const semantic = queryEmbedding && memory.embedding ? cosine(queryEmbedding, memory.embedding) : 0;
    const heat = Math.log1p(memory.recall_count || 0) / 5;
    const recency = recencyScore(memory.updated_at);
    const score =
      lexical * 0.35 +
      semantic * 0.55 +
      memory.importance * 0.25 +
      memory.confidence * 0.1 +
      recency * 0.1 +
      heat * 0.15 +
      (memory.pinned ? 0.5 : 0) +
      (memory.locked ? 0.35 : 0);
    return { ...withoutEmbedding(memory), score, lexical_score: lexical, semantic_score: semantic };
  }).filter((row) => !query || row.lexical_score > 0 || row.semantic_score > 0);
  scored.sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at)));
  const result = scored.slice(0, limit);
  await touch(env, result.map((row) => row.id));
  return result;
}

async function remember(env, input = {}) {
  const memory = normalizeMemory(input);
  memory.embedding = await embed(env, embeddingText(memory));
  const existing = await findExisting(env, memory);
  if (existing) {
    await updateMemory(env, existing.id, memory);
    return withoutEmbedding(formatMemory({ ...existing, ...memory, id: existing.id }));
  }
  memory.id = crypto.randomUUID();
  const now = new Date().toISOString();
  memory.created_at = now;
  memory.updated_at = now;
  await env.MEMORY_DB.prepare(`
    insert into memories (
      id, external_id, canonical_key, layer, kind, title, text, summary, source, tags_json,
      importance, confidence, sensitivity, emotion_score, pinned, locked, status,
      memory_date, valid_from, valid_to, expires_at, metadata_json, embedding_json,
      created_at, updated_at, recall_count, dream_count
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).bind(
    memory.id, memory.external_id, memory.canonical_key, memory.layer, memory.kind, memory.title,
    memory.text, memory.summary, memory.source, JSON.stringify(memory.tags),
    memory.importance, memory.confidence, memory.sensitivity, memory.emotion_score,
    bool(memory.pinned), bool(memory.locked), memory.status, memory.memory_date,
    memory.valid_from, memory.valid_to, memory.expires_at, JSON.stringify(memory.metadata),
    JSON.stringify(memory.embedding || null), memory.created_at, memory.updated_at,
  ).run();
  return withoutEmbedding(memory);
}

async function revise(env, input = {}) {
  const id = requireText(input.id, "id");
  const existing = await getMemory(env, id);
  const patch = normalizeMemoryPatch(input);
  if (patch.text || patch.summary || patch.title || patch.tags || patch.kind || patch.layer) {
    patch.embedding = await embed(env, embeddingText({ ...formatMemory(existing), ...patch }));
  }
  await updateMemory(env, id, patch);
  return withoutEmbedding(formatMemory({ ...existing, ...patch, id }));
}

async function pin(env, input = {}) {
  return revise(env, { id: input.id, pinned: input.pinned !== false });
}

async function archiveMemory(env, input = {}) {
  return revise(env, {
    id: input.id,
    status: "archived",
    archived_at: new Date().toISOString(),
    metadata: clean(input.reason) ? { archiveReason: clean(input.reason) } : undefined,
  });
}

async function supersede(env, input = {}) {
  const newerId = requireText(input.supersededBy || input.superseded_by, "supersededBy");
  const updated = await revise(env, {
    id: input.id,
    status: "superseded",
    superseded_by: newerId,
  });
  await link(env, {
    fromMemoryId: input.id,
    toMemoryId: newerId,
    relation: "superseded_by",
    strength: 1,
    note: input.note,
  });
  return updated;
}

async function link(env, input = {}) {
  const id = crypto.randomUUID();
  const fromId = requireText(input.fromMemoryId || input.from_memory_id || input.from, "fromMemoryId");
  const toId = requireText(input.toMemoryId || input.to_memory_id || input.to, "toMemoryId");
  const relation = clean(input.relation) || "related";
  const strength = clampNumber(input.strength, 0, 1, 0.5);
  const note = clean(input.note) || null;
  const now = new Date().toISOString();
  await env.MEMORY_DB.prepare(`
    insert into memory_links (id, from_memory_id, to_memory_id, relation, strength, note, created_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(from_memory_id, to_memory_id, relation)
    do update set strength = excluded.strength, note = excluded.note
  `).bind(id, fromId, toId, relation, strength, note, now).run();
  return { id, from_memory_id: fromId, to_memory_id: toId, relation, strength, note, created_at: now };
}

async function dream(env, input = {}) {
  const kind = clean(input.kind) || "ad_hoc";
  const sourceRows = await search(env, { query: clean(input.query), limit: clampInteger(input.limit, 3, 80, 24), includeArchived: false });
  if (!sourceRows.length) throw new Error("no source memories available for dream");
  const text = await deepseekDream(env, sourceRows, input);
  const summaryMemory = await remember(env, {
    externalId: `dream:${new Date().toISOString()}`,
    layer: "dream",
    kind: "summary",
    title: `Dream ${kind} ${new Date().toISOString().slice(0, 10)}`,
    text,
    summary: firstLine(text),
    source: "deepseek dream",
    tags: ["dream", kind],
    importance: clampNumber(input.importance, 0, 1, 0.75),
    confidence: 0.78,
    pinned: Boolean(input.pinned),
    metadata: { sourceCount: sourceRows.length, model: env.DEEPSEEK_MODEL || "deepseek-chat" },
  });
  const dreamId = crypto.randomUUID();
  await env.MEMORY_DB.prepare(`
    insert into dream_runs (id, kind, source_ids_json, summary_memory_id, text, created_at)
    values (?, ?, ?, ?, ?, ?)
  `).bind(dreamId, kind, JSON.stringify(sourceRows.map((row) => row.id)), summaryMemory.id, text, new Date().toISOString()).run();
  for (const source of sourceRows) {
    await link(env, { fromMemoryId: summaryMemory.id, toMemoryId: source.id, relation: "summarizes", strength: 0.8 });
  }
  await env.MEMORY_DB.prepare(`
    update memories set last_dreamed_at = ?, dream_count = dream_count + 1
    where id in (${sourceRows.map(() => "?").join(",")})
  `).bind(new Date().toISOString(), ...sourceRows.map((row) => row.id)).run();
  return { summaryMemory, sourceCount: sourceRows.length, sourceIds: sourceRows.map((row) => row.id) };
}

async function state(env, input = {}) {
  const action = clean(input.action || "list").toLowerCase();
  if (action === "set") {
    const key = requireText(input.key, "key");
    const value = input.value ?? null;
    const note = clean(input.note) || null;
    const now = new Date().toISOString();
    await env.MEMORY_DB.prepare(`
      insert into memory_state (key, value_json, note, updated_at)
      values (?, ?, ?, ?)
      on conflict(key) do update set value_json = excluded.value_json, note = excluded.note, updated_at = excluded.updated_at
    `).bind(key, JSON.stringify(value), note, now).run();
    return { key, value, note, updated_at: now };
  }
  if (action === "get") {
    const row = await env.MEMORY_DB.prepare("select key, value_json, note, updated_at from memory_state where key = ?")
      .bind(requireText(input.key, "key")).first();
    return row ? formatState(row) : null;
  }
  const rows = await env.MEMORY_DB.prepare("select key, value_json, note, updated_at from memory_state order by key").all();
  return rows.results.map(formatState);
}

async function deepseekDream(env, rows, input) {
  if (!env.DEEPSEEK_API_KEY) return fallbackDream(rows);
  const content = [
    "整理这些私人记忆，输出一条可长期保存的中文记忆摘要。",
    "保留稳定事实、关系状态、项目状态、未完成事项；指出过时或冲突的部分；不要输出无关寒暄。",
    clean(input.instruction) ? `额外要求：${clean(input.instruction)}` : "",
    "",
    ...rows.map((row, index) => `${index + 1}. [${row.layer}/${row.kind}] ${row.title || row.summary || row.external_id}\n${row.text}`),
  ].filter(Boolean).join("\n");
  const response = await fetch(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [{ role: "user", content }],
      temperature: 0.2,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek ${response.status}`);
  return data?.choices?.[0]?.message?.content?.trim() || fallbackDream(rows);
}

async function embed(env, text) {
  const input = clean(text);
  if (!input || !env.ZHIPU_API_KEY) return null;
  const authToken = await zhipuAuthToken(env.ZHIPU_API_KEY);
  const response = await fetch(env.ZHIPU_EMBEDDING_URL || "https://open.bigmodel.cn/api/paas/v4/embeddings", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ZHIPU_EMBEDDING_MODEL || "embedding-3",
      input,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  const embedding = data?.data?.[0]?.embedding;
  return Array.isArray(embedding) ? embedding : null;
}

async function zhipuAuthToken(apiKey) {
  const key = clean(apiKey);
  if (!key.includes(".")) return key;
  const [id, secret] = key.split(".");
  if (!id || !secret) return key;
  const timestamp = Date.now();
  const header = { alg: "HS256", sign_type: "SIGN" };
  const payload = { api_key: id, exp: timestamp + 3600 * 1000, timestamp };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64urlBytes(signature)}`;
}

function base64urlJson(value) {
  return base64urlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64urlBytes(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function allMemories(env, filters = {}) {
  const clauses = [];
  const values = [];
  if (!filters.includeArchived) clauses.push("status = 'active' and archived_at is null");
  if (filters.layers?.length) {
    clauses.push(`layer in (${filters.layers.map(() => "?").join(",")})`);
    values.push(...filters.layers);
  }
  if (filters.kinds?.length) {
    clauses.push(`kind in (${filters.kinds.map(() => "?").join(",")})`);
    values.push(...filters.kinds);
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = await env.MEMORY_DB.prepare(`select * from memories ${where} order by updated_at desc limit 500`).bind(...values).all();
  const parsed = rows.results.map(formatMemory);
  return filters.tags?.length
    ? parsed.filter((row) => row.tags.some((tag) => filters.tags.includes(tag)))
    : parsed;
}

async function selectMemories(env, where, order, limit) {
  const rows = await env.MEMORY_DB.prepare(`select * from memories where ${where} order by ${order} limit ${limit}`).all();
  return rows.results.map((row) => withoutEmbedding(formatMemory(row)));
}

async function getMemory(env, id) {
  const row = await env.MEMORY_DB.prepare("select * from memories where id = ?").bind(id).first();
  if (!row) throw new Error(`memory not found: ${id}`);
  return row;
}

async function findExisting(env, memory) {
  if (memory.canonical_key) {
    const row = await env.MEMORY_DB.prepare("select * from memories where canonical_key = ?").bind(memory.canonical_key).first();
    if (row) return row;
  }
  if (memory.external_id) {
    const row = await env.MEMORY_DB.prepare("select * from memories where external_id = ?").bind(memory.external_id).first();
    if (row) return row;
  }
  return null;
}

async function updateMemory(env, id, patch) {
  const fields = normalizePatchColumns(patch);
  if (!fields.length) return;
  const now = new Date().toISOString();
  fields.push(["updated_at", now]);
  const assignments = fields.map(([key]) => `${key} = ?`).join(", ");
  await env.MEMORY_DB.prepare(`update memories set ${assignments} where id = ?`)
    .bind(...fields.map(([, value]) => value), id).run();
}

function normalizePatchColumns(patch) {
  const map = {
    external_id: patch.external_id,
    canonical_key: patch.canonical_key,
    layer: patch.layer,
    kind: patch.kind,
    title: patch.title,
    text: patch.text,
    summary: patch.summary,
    source: patch.source,
    tags_json: patch.tags ? JSON.stringify(patch.tags) : undefined,
    importance: patch.importance,
    confidence: patch.confidence,
    sensitivity: patch.sensitivity,
    emotion_score: patch.emotion_score,
    pinned: patch.pinned === undefined ? undefined : bool(patch.pinned),
    locked: patch.locked === undefined ? undefined : bool(patch.locked),
    status: patch.status,
    memory_date: patch.memory_date,
    valid_from: patch.valid_from,
    valid_to: patch.valid_to,
    expires_at: patch.expires_at,
    archived_at: patch.archived_at,
    superseded_by: patch.superseded_by,
    metadata_json: patch.metadata ? JSON.stringify(patch.metadata) : undefined,
    embedding_json: patch.embedding === undefined ? undefined : JSON.stringify(patch.embedding || null),
  };
  return Object.entries(map).filter(([, value]) => value !== undefined);
}

async function touch(env, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const now = new Date().toISOString();
  await Promise.all(unique.map((id) => env.MEMORY_DB.prepare(
    "update memories set recall_count = recall_count + 1, last_recalled_at = ?, updated_at = ? where id = ?",
  ).bind(now, now, id).run()));
}

async function audit(env, request, tool, ok, durationMs) {
  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ua = request.headers.get("user-agent") || "";
    const ipHash = await sha256(ip);
    const uaHash = await sha256(ua);
    await env.MEMORY_DB.prepare(`
      insert into audit_logs (id, tool, ok, duration_ms, ip_hash, user_agent_hash, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, tool, ok ? 1 : 0, durationMs, ipHash, uaHash, now).run();
  } catch {
    // Audit must never break memory calls.
  }
}

function normalizeMemory(input = {}) {
  const text = requireText(input.text, "text");
  const kind = clean(input.kind) || "note";
  const tags = normalizeArray(input.tags);
  return {
    external_id: clean(input.externalId || input.external_id) || null,
    canonical_key: clean(input.canonicalKey || input.canonical_key) || null,
    layer: clean(input.layer) || inferLayer(kind, tags),
    kind,
    title: clean(input.title) || clean(input.summary) || null,
    text,
    summary: clean(input.summary) || null,
    source: clean(input.source) || "codex",
    tags,
    importance: clampNumber(input.importance, 0, 1, 0.5),
    confidence: clampNumber(input.confidence, 0, 1, 0.8),
    sensitivity: clean(input.sensitivity) || "low",
    emotion_score: input.emotionScore ?? input.emotion_score ?? null,
    pinned: Boolean(input.pinned),
    locked: Boolean(input.locked),
    status: clean(input.status) || "active",
    memory_date: clean(input.memoryDate || input.memory_date) || new Date().toISOString(),
    valid_from: clean(input.validFrom || input.valid_from) || null,
    valid_to: clean(input.validTo || input.valid_to) || null,
    expires_at: clean(input.expiresAt || input.expires_at) || null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

function normalizeMemoryPatch(input = {}) {
  const patch = {};
  for (const [from, to] of [
    ["externalId", "external_id"], ["external_id", "external_id"],
    ["canonicalKey", "canonical_key"], ["canonical_key", "canonical_key"],
    ["layer", "layer"], ["kind", "kind"], ["title", "title"], ["text", "text"],
    ["summary", "summary"], ["source", "source"], ["importance", "importance"],
    ["confidence", "confidence"], ["sensitivity", "sensitivity"], ["pinned", "pinned"],
    ["locked", "locked"], ["status", "status"], ["metadata", "metadata"],
    ["archived_at", "archived_at"], ["superseded_by", "superseded_by"],
  ]) {
    if (from in input) patch[to] = input[from];
  }
  if ("tags" in input) patch.tags = normalizeArray(input.tags);
  if ("emotionScore" in input || "emotion_score" in input) patch.emotion_score = input.emotionScore ?? input.emotion_score;
  if ("memoryDate" in input || "memory_date" in input) patch.memory_date = clean(input.memoryDate || input.memory_date) || null;
  if ("validFrom" in input || "valid_from" in input) patch.valid_from = clean(input.validFrom || input.valid_from) || null;
  if ("validTo" in input || "valid_to" in input) patch.valid_to = clean(input.validTo || input.valid_to) || null;
  if ("expiresAt" in input || "expires_at" in input) patch.expires_at = clean(input.expiresAt || input.expires_at) || null;
  return patch;
}

function formatMemory(row) {
  return {
    ...row,
    tags: parseJson(row.tags_json, []),
    metadata: parseJson(row.metadata_json, {}),
    embedding: parseJson(row.embedding_json, null),
    pinned: Boolean(row.pinned),
    locked: Boolean(row.locked),
  };
}

function withoutEmbedding(memory) {
  const copy = { ...memory };
  delete copy.embedding;
  delete copy.embedding_json;
  delete copy.tags_json;
  delete copy.metadata_json;
  return copy;
}

function formatState(row) {
  return { key: row.key, value: parseJson(row.value_json, null), note: row.note, updated_at: row.updated_at };
}

function lexicalScore(memory, query) {
  const haystack = [memory.title, memory.summary, memory.text, memory.source, ...(memory.tags || [])].join(" ").toLowerCase();
  const terms = clean(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) / terms.length;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function embeddingText(memory) {
  return [memory.layer, memory.kind, memory.title, memory.summary, memory.text, ...(memory.tags || [])].filter(Boolean).join("\n");
}

function fallbackDream(rows) {
  const groups = {};
  for (const row of rows) {
    groups[row.layer || "note"] = groups[row.layer || "note"] || [];
    groups[row.layer || "note"].push(row);
  }
  return Object.entries(groups).map(([layer, items]) => {
    const lines = items.slice(0, 8).map((row) => `- ${row.title || row.summary || row.external_id}: ${row.summary || row.text}`);
    return `## ${layer}\n${lines.join("\n")}`;
  }).join("\n\n");
}

function inferLayer(kind, tags) {
  const lowered = tags.map((tag) => tag.toLowerCase());
  if (["preference", "boundary"].includes(kind)) return "core";
  if (lowered.includes("identity")) return "identity";
  if (lowered.includes("relationship")) return "relationship";
  if (kind === "event") return "episode";
  if (kind === "feel") return "feel";
  if (kind === "project") return "project";
  if (kind === "summary") return "dream";
  return "note";
}

function openapi(origin) {
  const path = (name) => ({
    post: {
      operationId: name,
      security: [{ bearerAuth: [] }],
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
      responses: { 200: { description: "OK" } },
    },
  });
  return {
    openapi: "3.1.0",
    info: { title: "Codex Memory Cloud", version: "2.0.0" },
    servers: [{ url: origin }],
    paths: Object.fromEntries(TOOL_NAMES.map((name) => [`/tool/${name}`, path(name)])),
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}

function toolDefinitions() {
  const base = { type: "object", properties: {} };
  return TOOL_NAMES.map((name) => ({ name, description: `${name} private cloud memory`, inputSchema: base }));
}

function authorize(request, env) {
  const expected = clean(env.CODEX_MEMORY_TOKEN);
  if (!expected) throw new HttpError("CODEX_MEMORY_TOKEN is not configured", 500);
  const auth = clean(request.headers.get("authorization"));
  if (auth !== `Bearer ${expected}`) throw new HttpError("unauthorized", 401);
}

async function readJson(request) {
  if (request.method === "GET") return {};
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...JSON_HEADERS, ...corsHeaders() } });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
}

async function sha256(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uniqueIds(rows) {
  return [...new Set(rows.map((row) => row.id).filter(Boolean))];
}

function recencyScore(value) {
  const timestamp = Date.parse(value || "");
  if (!timestamp) return 0;
  return 1 / (1 + Math.max(0, Date.now() - timestamp) / 86400000 / 30);
}

function firstLine(text) {
  return clean(text).split(/\r?\n/).find(Boolean)?.slice(0, 240) || "Dream summary";
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function requireText(value, name) {
  const text = clean(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function normalizeArray(value) {
  const array = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(array.map(clean).filter(Boolean))];
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value) {
  return value ? 1 : 0;
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

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

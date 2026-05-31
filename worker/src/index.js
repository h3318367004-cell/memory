const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true, service: "codex-memory-cloud" });
      authorize(request, env);
      if (url.pathname === "/tool/wakeup") return json(await wakeup(env, await readJson(request)));
      if (url.pathname === "/tool/search") return json(await search(env, await readJson(request)));
      if (url.pathname === "/tool/remember") return json(await remember(env, await readJson(request)));
      if (url.pathname === "/tool/revise") return json(await revise(env, await readJson(request)));
      if (url.pathname === "/tool/pin") return json(await pin(env, await readJson(request)));
      if (url.pathname === "/tool/archive") return json(await archive(env, await readJson(request)));
      if (url.pathname === "/tool/supersede") return json(await supersede(env, await readJson(request)));
      if (url.pathname === "/tool/link") return json(await link(env, await readJson(request)));
      if (url.pathname === "/tool/dream") return json(await dream(env, await readJson(request)));
      if (url.pathname === "/tool/state") return json(await state(env, await readJson(request)));
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error.message || String(error) }, error.status || 500);
    }
  },
};

async function wakeup(env, input = {}) {
  return rpc(env, "codex_memory_kernel_wakeup", {
    match_count: clampInteger(input.limit, 4, 80, 24),
  });
}

async function search(env, input = {}) {
  const rows = await rpc(env, "codex_memory_kernel_search", {
    query_text: clean(input.query),
    match_count: clampInteger(input.limit, 1, 50, 8),
    filter_layers: normalizeArray(input.layers || input.layer),
    filter_kinds: normalizeArray(input.kinds || input.kind),
    filter_tags: normalizeArray(input.tags),
    include_archived: Boolean(input.includeArchived),
  });
  return rows.map((row) => ({ ...row.memory, score: row.score, lexical_score: row.lexical_score }));
}

async function remember(env, input = {}) {
  const payload = normalizeMemory(input);
  const conflict = payload.canonical_key ? "canonical_key" : payload.external_id ? "external_id" : "";
  const suffix = conflict ? `?on_conflict=${conflict}` : "";
  const headers = conflict ? { Prefer: "resolution=merge-duplicates,return=representation" } : { Prefer: "return=representation" };
  const rows = await supabase(env, `/rest/v1/codex_memories${suffix}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return rows[0];
}

async function revise(env, input = {}) {
  const id = requireText(input.id, "id");
  const patch = normalizeMemoryPatch(input);
  const rows = await supabase(env, `/rest/v1/codex_memories?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  return rows[0] || null;
}

async function pin(env, input = {}) {
  return revise(env, { id: input.id, pinned: input.pinned !== false });
}

async function archive(env, input = {}) {
  const metadata = clean(input.reason) ? { archiveReason: clean(input.reason) } : {};
  return revise(env, {
    id: input.id,
    archived_at: new Date().toISOString(),
    status: "archived",
    metadata,
  });
}

async function supersede(env, input = {}) {
  const updated = await revise(env, {
    id: input.id,
    superseded_by: requireText(input.supersededBy || input.superseded_by, "supersededBy"),
    status: "superseded",
  });
  await link(env, {
    fromMemoryId: input.id,
    toMemoryId: input.supersededBy || input.superseded_by,
    relation: "superseded_by",
    strength: 1,
    note: input.note,
  });
  return updated;
}

async function link(env, input = {}) {
  const payload = {
    from_memory_id: requireText(input.fromMemoryId || input.from_memory_id || input.from, "fromMemoryId"),
    to_memory_id: requireText(input.toMemoryId || input.to_memory_id || input.to, "toMemoryId"),
    relation: clean(input.relation) || "related",
    strength: clampNumber(input.strength, 0, 1, 0.5),
    note: clean(input.note) || null,
  };
  const rows = await supabase(env, "/rest/v1/codex_memory_links?on_conflict=from_memory_id,to_memory_id,relation", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  return rows[0];
}

async function dream(env, input = {}) {
  const sources = await search(env, { query: "", limit: clampInteger(input.limit, 3, 80, 24) });
  if (!sources.length) throw new Error("no source memories available for dream");
  const text = buildDreamText(sources, input);
  const summary = await remember(env, {
    externalId: `dream:${new Date().toISOString()}`,
    kind: "summary",
    layer: "dream",
    title: `Dream ${clean(input.kind) || "ad_hoc"} ${new Date().toISOString().slice(0, 10)}`,
    text,
    summary: firstLine(text),
    source: "cloudflare-worker dream",
    tags: ["dream", clean(input.kind) || "ad_hoc"],
    importance: clampNumber(input.importance, 0, 1, 0.75),
    confidence: 0.75,
    pinned: Boolean(input.pinned),
    metadata: { sourceCount: sources.length },
  });
  await supabase(env, "/rest/v1/codex_memory_dreams", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      kind: clean(input.kind) || "ad_hoc",
      source_memory_ids: sources.map((source) => source.id),
      summary_memory_id: summary.id,
      text,
    }),
  });
  for (const source of sources) {
    await link(env, {
      fromMemoryId: summary.id,
      toMemoryId: source.id,
      relation: "summarizes",
      strength: 0.8,
    });
  }
  return { summaryMemory: summary, sourceCount: sources.length };
}

async function state(env, input = {}) {
  const action = clean(input.action || "list").toLowerCase();
  if (action === "set") {
    const payload = {
      key: requireText(input.key, "key"),
      value: input.value ?? null,
      note: clean(input.note) || null,
    };
    const rows = await supabase(env, "/rest/v1/codex_memory_state?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    return rows[0];
  }
  if (action === "get") {
    const rows = await supabase(env, `/rest/v1/codex_memory_state?key=eq.${encodeURIComponent(requireText(input.key, "key"))}`);
    return rows[0] || null;
  }
  return supabase(env, "/rest/v1/codex_memory_state?select=*&order=key.asc");
}

async function rpc(env, name, body) {
  return supabase(env, `/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

async function supabase(env, path, init = {}) {
  const url = `${env.SUPABASE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...JSON_HEADERS,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase ${response.status}`);
  }
  return data;
}

function normalizeMemory(input = {}) {
  const text = requireText(input.text, "text");
  const kind = clean(input.kind) || "note";
  const tags = normalizeArray(input.tags);
  return {
    external_id: clean(input.externalId || input.external_id) || null,
    canonical_key: clean(input.canonicalKey || input.canonical_key) || null,
    kind,
    layer: clean(input.layer) || inferLayer(kind, tags),
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
  const patch = { ...normalizeMemory({ ...input, text: input.text || "x" }) };
  if (!("text" in input)) delete patch.text;
  for (const key of ["id", "externalId", "canonicalKey", "memoryDate", "validFrom", "validTo", "expiresAt", "emotionScore"]) {
    delete patch[key];
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete patch[key];
  }
  if ("archived_at" in input) patch.archived_at = input.archived_at;
  if ("superseded_by" in input) patch.superseded_by = input.superseded_by;
  return patch;
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

function buildDreamText(sources) {
  const groups = {};
  for (const source of sources) {
    const layer = source.layer || "note";
    groups[layer] = groups[layer] || [];
    groups[layer].push(source);
  }
  return Object.entries(groups).map(([layer, rows]) => {
    const lines = rows.slice(0, 8).map((row) => `- ${row.title || row.summary || row.external_id}: ${row.summary || row.text}`);
    return `## ${layer}\n${lines.join("\n")}`;
  }).join("\n\n");
}

function firstLine(text) {
  return clean(text).split(/\r?\n/).find(Boolean)?.slice(0, 240) || "Dream summary";
}

function authorize(request, env) {
  if (!env.CODEX_MEMORY_TOKEN) throw new HttpError("CODEX_MEMORY_TOKEN is not configured", 500);
  const auth = (request.headers.get("authorization") || "").trim();
  const token = String(env.CODEX_MEMORY_TOKEN || "").trim();
  if (auth !== `Bearer ${token}`) throw new HttpError("unauthorized", 401);
}

async function readJson(request) {
  if (request.method === "GET") return {};
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
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

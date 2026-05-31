const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORKER_URL = clean(process.env.CODEX_MEMORY_WORKER_URL || "https://codex-memory-cloud.h3318367004.workers.dev").replace(/\/+$/, "");
const TOKEN = clean(process.env.CODEX_MEMORY_TOKEN || readTokenFile());

async function main() {
  if (!TOKEN) throw new Error("CODEX_MEMORY_TOKEN is required");
  const memories = [
    ...readRelationshipMemory(),
    ...readJsonl("feel.jsonl", mapFeel),
    ...readJsonl("event_log.jsonl", mapEvent),
  ];
  let saved = 0;
  for (const memory of memories) {
    await callWorker("remember", memory);
    saved += 1;
  }
  process.stdout.write(`Imported ${saved} memory records.\n`);
}

async function callWorker(tool, body) {
  const response = await fetch(`${WORKER_URL}/tool/${tool}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Worker ${response.status}`);
  return data;
}

function readRelationshipMemory() {
  const file = path.join(ROOT, "relationship_memory.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return (Array.isArray(parsed.items) ? parsed.items : []).map((item) => ({
    externalId: `relationship:${item.key}`,
    canonicalKey: `relationship:${item.key}`,
    kind: inferRelationshipKind(item),
    layer: inferRelationshipLayer(item),
    title: item.key,
    text: `${item.key}: ${formatValue(item.value)}`,
    summary: item.key,
    source: item.source || "local relationship_memory.json",
    tags: item.tags || [],
    importance: item.importance,
    confidence: item.confidence,
    sensitivity: item.sensitivity,
    metadata: {
      originalKey: item.key,
      originalCreatedAt: item.createdAt,
      originalUpdatedAt: item.updatedAt,
    },
    pinned: Number(item.importance) >= 0.95,
    memoryDate: item.updatedAt || item.createdAt,
  }));
}

function readJsonl(name, mapper) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => mapper(JSON.parse(line)));
}

function mapFeel(item) {
  return {
    externalId: `feel:${item.id}`,
    canonicalKey: `feel:${item.id}`,
    layer: "feel",
    kind: "feel",
    title: item.id,
    text: item.text,
    summary: item.summary || null,
    source: item.source || "local feel.jsonl",
    tags: item.tags || [],
    importance: item.importance,
    confidence: 0.8,
    emotionScore: item.emotionScore ?? item.emotion_score ?? 0.6,
    metadata: { originalId: item.id, timestamp: item.timestamp, ...(item.metadata || {}) },
    memoryDate: item.timestamp,
  };
}

function mapEvent(item) {
  return {
    externalId: `event:${item.id}`,
    canonicalKey: `event:${item.id}`,
    layer: "episode",
    kind: "event",
    title: item.summary || item.id,
    text: item.rawText || item.summary,
    summary: item.summary || null,
    source: item.source || "local event_log.jsonl",
    tags: item.tags || [],
    importance: item.importance,
    confidence: 0.8,
    metadata: { originalId: item.id, timestamp: item.timestamp, ...(item.metadata || {}) },
    pinned: Number(item.importance) >= 0.95,
    memoryDate: item.timestamp,
  };
}

function inferRelationshipKind(item) {
  const tags = new Set((item.tags || []).map((tag) => String(tag).toLowerCase()));
  if (tags.has("boundary")) return "boundary";
  if (tags.has("style") || tags.has("preference") || tags.has("preferences") || tags.has("tone")) return "preference";
  if (tags.has("relationship") || tags.has("identity")) return "fact";
  return "note";
}

function inferRelationshipLayer(item) {
  const tags = new Set((item.tags || []).map((tag) => String(tag).toLowerCase()));
  if (tags.has("identity")) return "identity";
  if (tags.has("relationship")) return "relationship";
  if (tags.has("boundary") || tags.has("style") || tags.has("preference") || tags.has("preferences")) return "core";
  return "note";
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function readTokenFile() {
  try {
    return fs.readFileSync("C:\\Users\\huangyi\\.codex\\codex-memory-token.txt", "utf8").trim();
  } catch {
    return "";
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});

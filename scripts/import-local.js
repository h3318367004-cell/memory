const fs = require("fs");
const path = require("path");
const { createMemoryService } = require("../src/memory-service");

const ROOT = path.join(__dirname, "..");

async function main() {
  const service = createMemoryService();
  const memories = [
    ...readRelationshipMemory(),
    ...readJsonl("feel.jsonl", mapFeel),
    ...readJsonl("event_log.jsonl", mapEvent),
  ];
  let saved = 0;
  for (const memory of memories) {
    await service.upsertMemory(memory);
    saved += 1;
  }
  process.stdout.write(`Imported ${saved} memory records.\n`);
}

function readRelationshipMemory() {
  const file = path.join(ROOT, "relationship_memory.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return (Array.isArray(parsed.items) ? parsed.items : []).map((item) => ({
    externalId: `relationship:${item.key}`,
    kind: inferRelationshipKind(item),
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
    kind: "feel",
    text: item.text,
    summary: item.summary || null,
    source: item.source || "local feel.jsonl",
    tags: item.tags || [],
    importance: item.importance,
    confidence: 0.8,
    emotionScore: item.emotionScore ?? item.emotion_score ?? 0.6,
    metadata: { originalId: item.id, timestamp: item.timestamp, ...(item.metadata || {}) },
  };
}

function mapEvent(item) {
  return {
    externalId: `event:${item.id}`,
    kind: "event",
    text: item.rawText || item.summary,
    summary: item.summary || null,
    source: item.source || "local event_log.jsonl",
    tags: item.tags || [],
    importance: item.importance,
    confidence: 0.8,
    metadata: { originalId: item.id, timestamp: item.timestamp, ...(item.metadata || {}) },
    pinned: Number(item.importance) >= 0.95,
  };
}

function inferRelationshipKind(item) {
  const tags = new Set((item.tags || []).map((tag) => String(tag).toLowerCase()));
  if (tags.has("boundary")) return "boundary";
  if (tags.has("style") || tags.has("preference") || tags.has("preferences") || tags.has("tone")) return "preference";
  if (tags.has("relationship") || tags.has("identity")) return "fact";
  return "note";
}

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});

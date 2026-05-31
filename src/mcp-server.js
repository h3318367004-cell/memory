const readline = require("readline");
const { createPostgresMemoryService } = require("./postgres-memory-service");
const { createWorkerMemoryService } = require("./worker-memory-service");

const service = process.env.CODEX_MEMORY_WORKER_URL
  ? createWorkerMemoryService()
  : createPostgresMemoryService();

const TOOLS = [
  {
    name: "wakeup",
    description: "Load private wakeup context grouped into state, core, projects, feel, hot, recent, and dream memory.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Soft maximum memories per wakeup." },
      },
    },
  },
  {
    name: "search",
    description: "Search private cloud memory by text, layer, kind, tags, heat, importance, and optional embeddings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Empty returns high scoring memory." },
        limit: { type: "number", description: "Maximum memories to return." },
        layers: { type: "array", items: { type: "string" }, description: "Allowed memory layers." },
        kinds: { type: "array", items: { type: "string" }, description: "Allowed memory kinds." },
        tags: { type: "array", items: { type: "string" }, description: "Required overlapping tags." },
        includeArchived: { type: "boolean", description: "Include archived or superseded memories." },
      },
    },
  },
  {
    name: "remember",
    description: "Save or upsert a private memory atom. Use canonicalKey for durable unique facts or states.",
    inputSchema: {
      type: "object",
      properties: memoryProperties(),
      required: ["text"],
    },
  },
  {
    name: "revise",
    description: "Revise an existing private memory atom.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        ...memoryProperties(),
      },
      required: ["id"],
    },
  },
  {
    name: "pin",
    description: "Pin or unpin a memory so it appears strongly in wakeup context.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        pinned: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "archive",
    description: "Archive a stale memory without deleting it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "supersede",
    description: "Mark one memory as replaced by a newer memory and link them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        supersededBy: { type: "string" },
        note: { type: "string" },
      },
      required: ["id", "supersededBy"],
    },
  },
  {
    name: "link",
    description: "Create or update a typed relation between two memory atoms.",
    inputSchema: {
      type: "object",
      properties: {
        fromMemoryId: { type: "string" },
        toMemoryId: { type: "string" },
        relation: { type: "string" },
        strength: { type: "number" },
        note: { type: "string" },
      },
      required: ["fromMemoryId", "toMemoryId"],
    },
  },
  {
    name: "dream",
    description: "Consolidate cloud memory into a durable dream summary and link it to source memories.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "ad_hoc, daily, weekly, monthly, project, or relationship." },
        limit: { type: "number", description: "How many source memories to consolidate." },
        instruction: { type: "string", description: "Optional consolidation instruction." },
        pinned: { type: "boolean" },
        importance: { type: "number" },
      },
    },
  },
  {
    name: "state",
    description: "Get, set, or list current private memory state keys used during wakeup.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "set"] },
        key: { type: "string" },
        value: {},
        note: { type: "string" },
      },
    },
  },
];

function memoryProperties() {
  return {
    externalId: { type: "string" },
    canonicalKey: { type: "string" },
    layer: {
      type: "string",
      enum: ["core", "identity", "relationship", "episode", "feel", "project", "dream", "working", "note"],
    },
    kind: {
      type: "string",
      enum: ["fact", "event", "feel", "preference", "boundary", "project", "note", "summary"],
    },
    title: { type: "string" },
    text: { type: "string" },
    summary: { type: "string" },
    source: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    importance: { type: "number" },
    confidence: { type: "number" },
    sensitivity: { type: "string", enum: ["low", "medium", "high"] },
    emotionScore: { type: "number" },
    pinned: { type: "boolean" },
    locked: { type: "boolean" },
    status: { type: "string", enum: ["active", "archived", "superseded", "draft"] },
    memoryDate: { type: "string" },
    validFrom: { type: "string" },
    validTo: { type: "string" },
    expiresAt: { type: "string" },
    metadata: { type: "object" },
  };
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function callTool(name, args = {}) {
  if (name === "wakeup") return service.wakeup(args);
  if (name === "search") return service.search(args);
  if (name === "remember") return service.remember(args);
  if (name === "revise") return service.revise(args);
  if (name === "pin") return service.pin(args);
  if (name === "archive") return service.archive(args);
  if (name === "supersede") return service.supersede(args);
  if (name === "link") return service.link(args);
  if (name === "dream") return service.dream(args);
  if (name === "state") return service.state(args);
  throw new Error(`unknown tool: ${name}`);
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-memory-cloud", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error.message || String(error) },
      });
    }
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const cleanLine = line.replace(/^\uFEFF/, "");
  if (!cleanLine.trim()) return;
  try {
    await handleMessage(JSON.parse(cleanLine));
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message || String(error) } });
  }
});

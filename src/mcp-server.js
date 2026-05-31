const readline = require("readline");
const { createMemoryService } = require("./memory-service");

const service = createMemoryService();

const TOOLS = [
  {
    name: "wakeupCodex",
    description: "Load Codex's private wakeup context: pinned, important, emotional, and recent memories.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum memories to return." },
      },
    },
  },
  {
    name: "searchMemory",
    description: "Search Codex private cloud memory by text, kind, tags, importance, heat, and optional embeddings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Empty returns high scoring memory." },
        limit: { type: "number", description: "Maximum memories to return." },
        kinds: { type: "array", items: { type: "string" }, description: "Allowed memory kinds." },
        tags: { type: "array", items: { type: "string" }, description: "Required overlapping tags." },
        includeArchived: { type: "boolean", description: "Include archived memories." },
      },
    },
  },
  {
    name: "saveMemory",
    description: "Save a Codex private memory atom.",
    inputSchema: {
      type: "object",
      properties: memoryProperties(),
      required: ["text"],
    },
  },
  {
    name: "updateMemory",
    description: "Update a Codex private memory atom.",
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
    name: "pinMemory",
    description: "Pin or unpin a memory so it appears in wakeup context.",
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
    name: "archiveMemory",
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
    name: "supersedeMemory",
    description: "Mark one memory as superseded by a newer memory.",
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
];

function memoryProperties() {
  return {
    externalId: { type: "string" },
    kind: {
      type: "string",
      enum: ["fact", "event", "feel", "preference", "boundary", "project", "note", "summary"],
    },
    text: { type: "string" },
    summary: { type: "string" },
    source: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    importance: { type: "number" },
    confidence: { type: "number" },
    sensitivity: { type: "string", enum: ["low", "medium", "high"] },
    emotionScore: { type: "number" },
    pinned: { type: "boolean" },
    metadata: { type: "object" },
  };
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function callTool(name, args = {}) {
  if (name === "wakeupCodex") return service.wakeup(args);
  if (name === "searchMemory") return service.searchMemory(args);
  if (name === "saveMemory") return service.saveMemory(args);
  if (name === "updateMemory") return service.updateMemory(args);
  if (name === "pinMemory") return service.pinMemory(args);
  if (name === "archiveMemory") return service.archiveMemory(args);
  if (name === "supersedeMemory") return service.supersedeMemory(args);
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
        serverInfo: { name: "codex-memory-cloud", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") {
    return;
  }
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

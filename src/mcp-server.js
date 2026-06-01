const readline = require("readline");

const WORKER_URL = clean(process.env.CODEX_MEMORY_WORKER_URL || "https://codex-memory-cloud.h3318367004.workers.dev").replace(/\/+$/, "");
const TOKEN = clean(process.env.CODEX_MEMORY_TOKEN || readTokenFile());

const TOOLS = [
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
].map((name) => ({
  name,
  description: `${name} private cloud memory`,
  inputSchema: { type: "object", properties: {} },
}));

async function callTool(name, args = {}) {
  if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name}`);
  if (!TOKEN) throw new Error("CODEX_MEMORY_TOKEN is required");
  const response = await fetch(`${WORKER_URL}/tool/${name}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Worker ${response.status}`);
  return body;
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "memory-cloud", version: "2.0.0" },
        instructions:
          "Private memory for one user. Call wakeup first to restore context. Use search before remember when updating an existing fact. Never expose secrets.",
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "resources/list") {
    send({ jsonrpc: "2.0", id, result: { resources: [] } });
    return;
  }
  if (method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
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
          structuredContent: { result },
        },
      });
    } catch (error) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message || String(error) } });
    }
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

function readTokenFile() {
  try {
    return require("fs").readFileSync("C:\\Users\\huangyi\\.codex\\codex-memory-token.txt", "utf8").trim();
  } catch {
    return "";
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
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

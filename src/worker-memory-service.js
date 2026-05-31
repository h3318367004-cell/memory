function createWorkerMemoryService(options = {}) {
  const workerUrl = clean(options.workerUrl || process.env.CODEX_MEMORY_WORKER_URL).replace(/\/+$/, "");
  const token = clean(options.token || process.env.CODEX_MEMORY_TOKEN);
  if (!workerUrl) throw new Error("CODEX_MEMORY_WORKER_URL is required");
  if (!token) throw new Error("CODEX_MEMORY_TOKEN is required");

  async function call(name, args = {}) {
    const response = await fetch(`${workerUrl}/tool/${name}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error || `Worker ${response.status}`);
    }
    return body;
  }

  return {
    wakeup: (args) => call("wakeup", args),
    search: (args) => call("search", args),
    remember: (args) => call("remember", args),
    revise: (args) => call("revise", args),
    pin: (args) => call("pin", args),
    archive: (args) => call("archive", args),
    supersede: (args) => call("supersede", args),
    link: (args) => call("link", args),
    dream: (args) => call("dream", args),
    state: (args) => call("state", args),
  };
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createWorkerMemoryService,
};

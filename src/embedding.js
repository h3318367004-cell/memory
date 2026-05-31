const { readConfig } = require("./config");

async function embedText(text, config = readConfig()) {
  const input = cleanText(text);
  if (!input || !config.openaiApiKey) {
    return null;
  }
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || response.statusText || "embedding request failed";
    throw new Error(`OpenAI embedding failed: ${message}`);
  }
  const embedding = body?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embedding response did not include an embedding");
  }
  return embedding;
}

function embeddingInput(memory = {}) {
  return [
    memory.kind ? `kind: ${memory.kind}` : "",
    memory.summary ? `summary: ${memory.summary}` : "",
    memory.text ? `text: ${memory.text}` : "",
    Array.isArray(memory.tags) && memory.tags.length ? `tags: ${memory.tags.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  embedText,
  embeddingInput,
};

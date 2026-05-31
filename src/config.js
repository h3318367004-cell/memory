const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config();

function readConfig(env = process.env) {
  const supabaseUrl = readRequired(env.CODEX_MEMORY_SUPABASE_URL || env.SUPABASE_URL, "CODEX_MEMORY_SUPABASE_URL");
  const supabaseServiceRoleKey = readRequired(
    env.CODEX_MEMORY_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    "CODEX_MEMORY_SUPABASE_SERVICE_ROLE_KEY",
  );
  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    openaiApiKey: clean(env.OPENAI_API_KEY),
    embeddingModel: clean(env.CODEX_MEMORY_EMBEDDING_MODEL) || "text-embedding-3-small",
  };
}

function readRequired(value, name) {
  const cleaned = clean(value);
  if (!cleaned) {
    throw new Error(`${name} is required`);
  }
  return cleaned;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  readConfig,
};

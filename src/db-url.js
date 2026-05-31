const fs = require("fs");

const PROJECT_HOST = "db.yapkbzfwtwzbzqufsgwr.supabase.co";
const DEFAULT_PASSWORD_FILE = "C:\\Users\\huangyi\\Desktop\\新建文本文档.txt";

function buildConnectionString(env = process.env) {
  const direct = clean(env.CODEX_MEMORY_DATABASE_URL || env.DATABASE_URL);
  if (direct) return direct;

  const passwordFile = clean(env.CODEX_MEMORY_DB_PASSWORD_FILE) || DEFAULT_PASSWORD_FILE;
  const secret = readSecret(passwordFile);
  if (secret.startsWith("postgresql://") || secret.startsWith("postgres://")) {
    return secret;
  }
  return `postgresql://postgres:${encodeURIComponent(secret)}@${PROJECT_HOST}:5432/postgres`;
}

function readSecret(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) {
    throw new Error(`database password file is empty: ${file}`);
  }
  const postgresLine = raw
    .split(/\s+/)
    .find((part) => part.startsWith("postgresql://") || part.startsWith("postgres://"));
  return postgresLine || raw.split(/\s+/)[0];
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildConnectionString,
};

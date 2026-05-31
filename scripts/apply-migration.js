const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PROJECT_HOST = "db.yapkbzfwtwzbzqufsgwr.supabase.co";
const DEFAULT_PASSWORD_FILE = "C:\\Users\\huangyi\\Desktop\\新建文本文档.txt";

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "001_codex_memory_cloud.sql"), "utf8");
  const client = new Client({
    connectionString: buildConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
  process.stdout.write("Applied codex memory cloud migration.\n");
}

function buildConnectionString(env = process.env) {
  const direct = clean(env.CODEX_MEMORY_DATABASE_URL || env.DATABASE_URL);
  if (direct) return direct;

  const passwordFile = clean(env.CODEX_MEMORY_DB_PASSWORD_FILE) || DEFAULT_PASSWORD_FILE;
  const password = readPassword(passwordFile);
  return `postgresql://postgres:${encodeURIComponent(password)}@${PROJECT_HOST}:5432/postgres`;
}

function readPassword(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) {
    throw new Error(`database password file is empty: ${file}`);
  }
  if (raw.startsWith("postgresql://") || raw.startsWith("postgres://")) {
    const url = new URL(raw);
    return decodeURIComponent(url.password);
  }
  return raw;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});

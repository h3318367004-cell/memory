const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { buildConnectionString } = require("./db-url");

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

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});

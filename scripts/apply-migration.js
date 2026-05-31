const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { buildConnectionString } = require("./db-url");

async function main() {
  const migrationDir = path.join(__dirname, "..", "supabase", "migrations");
  const migrations = fs.readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const client = new Client({
    connectionString: buildConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const name of migrations) {
      const sql = fs.readFileSync(path.join(migrationDir, name), "utf8");
      await client.query(sql);
      process.stdout.write(`Applied ${name}.\n`);
    }
  } finally {
    await client.end();
  }
  process.stdout.write("Applied all codex memory migrations.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});

// One-off migration runner: applies supabase/migrations/*.sql in filename order against
// SUPABASE_DB_URL, tracking what's already been applied in a schema_migrations table so
// re-running this script is a no-op for files it's already seen.
//
// Usage: node scripts/run-migrations.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('SUPABASE_DB_URL is not set (check .env.local).');
  process.exit(1);
}

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

async function main() {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query('select filename from schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`apply ${file}`);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`  ok`);
    } catch (err) {
      await client.query('rollback');
      console.error(`  FAILED: ${err.message}`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

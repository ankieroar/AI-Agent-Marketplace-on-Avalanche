import {readdir,readFile} from 'node:fs/promises';
import {pool} from './db.mjs';
try {
  // Base table used by both the legacy /evidence routes and the Day 2 schema.
  await pool.query('CREATE TABLE IF NOT EXISTS evidence (id UUID PRIMARY KEY, encrypted JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const directory = new URL('../migrations/',import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query('BEGIN');
    try {
      await pool.query(await readFile(new URL(file,directory),'utf8'));
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => {});
      throw new Error(file + ': ' + error.message);
    }
  }
  const {rows:[schema]} = await pool.query(`SELECT
    to_regclass('public.agent_listings_cache') IS NOT NULL AS listings,
    to_regclass('public.service_orders') IS NOT NULL AS orders,
    to_regclass('public.service_policies') IS NOT NULL AS policies,
    to_regclass('public.chain_events') IS NOT NULL AS events,
    to_regclass('public.worker_checkpoints') IS NOT NULL AS checkpoints,
    to_regclass('public.service_requests') IS NOT NULL AS requests,
    to_regclass('public.case_jobs') IS NOT NULL AS case_jobs`);
  const missing = Object.entries(schema).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) {
    throw new Error('migration completed but required tables are missing: ' + missing.join(', '));
  }
  console.log('Migrations complete ('+files.join(', ')+')');
} catch (error) {
  console.error('Migration failed: '+error.message);
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    console.error('Check DATABASE_URL and that the staging PostgreSQL host is reachable.');
  }
  if (process.env.MIGRATE_DEBUG === '1' && error.stack) console.error(error.stack);
  process.exitCode = 1;
} finally { await pool.end(); }

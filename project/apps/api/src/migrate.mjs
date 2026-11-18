import {pool} from './db.mjs';
import {readFile} from 'node:fs/promises';
try {
  const day2 = await readFile(new URL('../migrations/002-day2.sql',import.meta.url),'utf8');
  await pool.query('CREATE TABLE IF NOT EXISTS evidence (id UUID PRIMARY KEY, encrypted JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());\n'+day2);
  console.log('Migrations complete');
} finally { await pool.end(); }

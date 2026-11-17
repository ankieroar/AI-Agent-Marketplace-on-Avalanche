import {pool} from './db.mjs';
try {await pool.query('CREATE TABLE IF NOT EXISTS evidence (id UUID PRIMARY KEY, encrypted JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');console.log('Migration complete');}finally{await pool.end();}


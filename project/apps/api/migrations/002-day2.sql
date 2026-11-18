CREATE TABLE IF NOT EXISTS agent_listings_cache (
  agent_id TEXT PRIMARY KEY,
  listing JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_orders (
  order_id TEXT PRIMARY KEY,
  buyer TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES service_orders(order_id),
  snapshot JSONB NOT NULL
);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS case_id TEXT REFERENCES cases(case_id);
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS request_key TEXT UNIQUE;
CREATE TABLE IF NOT EXISTS agent_outputs (
  order_id TEXT PRIMARY KEY REFERENCES service_orders(order_id),
  input_hash TEXT NOT NULL,
  attempt UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','failed','delivered')),
  lease_until TIMESTAMPTZ NOT NULL,
  encrypted JSONB,
  result_hash TEXT,
  mode TEXT NOT NULL,
  CHECK (status <> 'delivered' OR (encrypted IS NOT NULL AND result_hash IS NOT NULL))
);

-- Day 3 backend worker state.
-- The worker is intentionally restart-safe: chain events are claimed once, case
-- processing holds a lease, and checkpoints are only advanced after a batch has
-- been fully handled.

CREATE TABLE IF NOT EXISTS chain_events (
  event_key TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  contract TEXT NOT NULL,
  event_name TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processed','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chain_events_status_idx
  ON chain_events(worker, status, updated_at);

CREATE TABLE IF NOT EXISTS worker_checkpoints (
  worker TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Buyer-supplied service input, encrypted with AES-256-GCM under
-- service-input:<orderId>. Only the service executor reads it.
CREATE TABLE IF NOT EXISTS service_requests (
  order_id TEXT PRIMARY KEY REFERENCES service_orders(order_id) ON DELETE CASCADE,
  buyer TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  ciphertext JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('buyer','demo')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per dispute case. A case is worked exactly once at a time; a stale
-- lease may be resumed, but a submitted case is never processed again.
CREATE TABLE IF NOT EXISTS case_jobs (
  case_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending','awaiting_evidence','awaiting_relay','analyzing',
    'proved','submitted','rejected','failed'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  evidence_hash TEXT,
  analysis_ciphertext JSONB,
  payout_amount TEXT,
  nullifier TEXT,
  proof_hash TEXT,
  proof TEXT,
  start_tx_hash TEXT,
  proof_tx_hash TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS case_jobs_status_idx
  ON case_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS case_jobs_order_idx
  ON case_jobs(order_id);

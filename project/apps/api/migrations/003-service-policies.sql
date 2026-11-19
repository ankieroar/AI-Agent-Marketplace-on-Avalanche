-- Private service policy witness for an order, encrypted at the application layer.
-- One policy per order: the commitment recorded here must match the on-chain
-- MerchantPolicyRegistry commitment written by purchaseService at checkout.
CREATE TABLE IF NOT EXISTS service_policies (
  order_id TEXT PRIMARY KEY REFERENCES service_orders(order_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  policy_version_hash TEXT NOT NULL,
  commitment TEXT NOT NULL,
  ciphertext JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('checkout','local-checkout')),
  checkout_tx_hash TEXT,
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_policies_commitment_idx ON service_policies(commitment);

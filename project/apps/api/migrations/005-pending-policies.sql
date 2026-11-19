CREATE TABLE IF NOT EXISTS pending_service_policies (
  order_id text NOT NULL, commitment text NOT NULL, agent_id text NOT NULL,
  policy_version_hash text NOT NULL, ciphertext jsonb NOT NULL,
  PRIMARY KEY (order_id, commitment)
);

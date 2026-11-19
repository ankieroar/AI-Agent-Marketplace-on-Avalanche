/**
 * PostgreSQL persistence for the Day 3 worker. Every method is small and
 * explicit so the orchestration can be unit-tested with an in-memory store.
 */
export function createPostgresStore(pool) {
  return {
    async checkSchema() {
      const { rows: [row] } = await pool.query(`SELECT current_database() AS database,
        to_regclass('public.service_orders') IS NOT NULL AS orders,
        to_regclass('public.service_policies') IS NOT NULL AS policies,
        to_regclass('public.agent_outputs') IS NOT NULL AS outputs,
        to_regclass('public.chain_events') IS NOT NULL AS events,
        to_regclass('public.worker_checkpoints') IS NOT NULL AS checkpoints,
        to_regclass('public.service_requests') IS NOT NULL AS requests,
        to_regclass('public.case_jobs') IS NOT NULL AS case_jobs`);
      return row;
    },

    /**
     * Claim an event exactly once. A processed/skipped event is never handled
     * again. A failed event is retried until maxAttempts, then reported dead.
     */
    async claimEvent({
      eventKey, worker, chainId, contract, eventName, blockNumber, txHash, logIndex,
      payload, maxAttempts = 5,
    }) {
      const { rows: [row] } = await pool.query(`INSERT INTO chain_events(
          event_key, worker, chain_id, contract, event_name, block_number, tx_hash, log_index, payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(event_key) DO UPDATE SET
          attempts = CASE WHEN chain_events.status = 'failed'
            THEN chain_events.attempts + 1 ELSE chain_events.attempts END,
          last_error = CASE WHEN chain_events.status = 'failed'
            THEN NULL ELSE chain_events.last_error END,
          updated_at = now()
        RETURNING status, attempts`,
      [eventKey, worker, String(chainId), contract.toLowerCase(), eventName, blockNumber,
        txHash.toLowerCase(), logIndex, payload]);
      if (row.status === 'processed' || row.status === 'skipped') {
        return { action: 'skip', reason: row.status };
      }
      if (row.status === 'failed' && row.attempts >= maxAttempts) {
        return { action: 'dead', attempts: row.attempts };
      }
      return { action: 'process', attempts: row.attempts };
    },

    async finishEvent(eventKey, status, error = null) {
      await pool.query(`UPDATE chain_events SET status=$2, last_error=$3,
        processed_at = CASE WHEN $2 IN ('processed','skipped') THEN now() ELSE processed_at END,
        updated_at = now() WHERE event_key=$1`, [eventKey, status, error]);
    },

    async getCheckpoint(worker) {
      const { rows: [row] } = await pool.query(
        'SELECT worker, chain_id, block_number FROM worker_checkpoints WHERE worker=$1', [worker]);
      return row ?? null;
    },

    async setCheckpoint(worker, chainId, blockNumber) {
      await pool.query(`INSERT INTO worker_checkpoints(worker, chain_id, block_number)
        VALUES($1,$2,$3)
        ON CONFLICT(worker) DO UPDATE SET chain_id=excluded.chain_id,
          block_number=excluded.block_number, updated_at=now()`,
      [worker, String(chainId), blockNumber]);
    },

    async saveListing(listing) {
      await pool.query(`INSERT INTO agent_listings_cache(agent_id, listing) VALUES($1,$2)
        ON CONFLICT(agent_id) DO UPDATE SET listing=excluded.listing, updated_at=now()`,
      [listing.agentId, listing]);
    },

    async saveOrder(order, buyer) {
      await pool.query(`INSERT INTO service_orders(order_id, buyer, snapshot) VALUES($1,$2,$3)
        ON CONFLICT(order_id) DO UPDATE SET buyer=excluded.buyer,
          snapshot=excluded.snapshot, updated_at=now()`,
      [order.orderId, buyer, order]);
    },

    async persistCheckoutPolicy(order) {
      const { persistCheckoutPolicy } = await import('./checkout-policy.mjs');
      await persistCheckoutPolicy(pool, order);
    },

    async getPolicy(orderId) {
      const { rows: [row] } = await pool.query(`SELECT order_id, agent_id,
        policy_version_hash, commitment, ciphertext, source, checkout_tx_hash
        FROM service_policies WHERE order_id=$1`, [orderId]);
      return row ?? null;
    },

    async saveServiceRequest({ orderId, buyer, inputHash, ciphertext, source = 'buyer' }) {
      const { rowCount } = await pool.query(`INSERT INTO service_requests(
          order_id, buyer, input_hash, ciphertext, source)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(order_id) DO UPDATE SET ciphertext=excluded.ciphertext,
          source=excluded.source, created_at=now()
        WHERE service_requests.input_hash = excluded.input_hash
        RETURNING order_id`, [orderId, buyer, inputHash, ciphertext, source]);
      return rowCount > 0;
    },

    async getServiceRequest(orderId) {
      const { rows: [row] } = await pool.query(`SELECT order_id, buyer, input_hash,
        ciphertext, source, created_at FROM service_requests WHERE order_id=$1`, [orderId]);
      return row ?? null;
    },

    async pendingServiceRequests(limit = 20) {
      const { rows } = await pool.query(`SELECT r.order_id
        FROM service_requests r
        JOIN service_orders o ON o.order_id = r.order_id
        LEFT JOIN agent_outputs a ON a.order_id = r.order_id
        WHERE a.order_id IS NULL OR a.status = 'failed'
          OR (a.status = 'running' AND a.lease_until < now())
        ORDER BY r.created_at ASC LIMIT $1`, [limit]);
      return rows.map((row) => row.order_id);
    },

    async getEvidence(caseId) {
      const { rows: [row] } = await pool.query(`SELECT id, encrypted FROM evidence
        WHERE case_id=$1 ORDER BY created_at DESC LIMIT 1`, [caseId]);
      return row ?? null;
    },

    async saveCase(caseId, orderId, snapshot) {
      await pool.query(`INSERT INTO cases(case_id, order_id, snapshot) VALUES($1,$2,$3)
        ON CONFLICT(case_id) DO UPDATE SET snapshot=excluded.snapshot`,
      [caseId, orderId, snapshot]);
    },

    async getCaseJob(caseId) {
      const { rows: [row] } = await pool.query('SELECT * FROM case_jobs WHERE case_id=$1', [caseId]);
      return row ?? null;
    },

    /**
     * Acquire the one-at-a-time case lease. Terminal or actively leased jobs
     * are returned as done/busy and are never processed twice.
     */
    async startCaseJob({ caseId, orderId, leaseSeconds = 120 }) {
      const { rows: [row] } = await pool.query(`INSERT INTO case_jobs(
          case_id, order_id, status, lease_until)
        VALUES($1,$2,'analyzing', now() + ($3::int * interval '1 second'))
        ON CONFLICT(case_id) DO UPDATE SET
          status='analyzing',
          attempts=case_jobs.attempts + 1,
          lease_until=excluded.lease_until,
          last_error=NULL,
          updated_at=now()
        WHERE case_jobs.status IN ('pending','awaiting_evidence','awaiting_relay','failed')
          OR (case_jobs.status IN ('analyzing','proved') AND case_jobs.lease_until < now())
        RETURNING case_id, order_id, status, attempts`,
      [caseId, orderId, leaseSeconds]);
      if (row) return { action: 'started', job: row };
      const job = await this.getCaseJob(caseId);
      if (!job) return { action: 'busy', job: null };
      if (job.status === 'submitted' || job.status === 'rejected') {
        return { action: 'done', job };
      }
      return { action: 'busy', job };
    },

    async finishCaseJob(caseId, patch = {}) {
      const allowed = ['status', 'lease_until', 'evidence_hash', 'analysis_ciphertext',
        'payout_amount', 'nullifier', 'proof_hash', 'proof', 'start_tx_hash',
        'proof_tx_hash', 'last_error'];
      const fields = [];
      const values = [caseId];
      let leaseCleared = false;
      for (const [key, value] of Object.entries(patch)) {
        if (!allowed.includes(key)) continue;
        if (key === 'lease_until') leaseCleared = true;
        values.push(value);
        fields.push(`${key}=$${values.length}`);
      }
      if (patch.status && ['submitted', 'rejected'].includes(patch.status) && !leaseCleared) {
        values.push(null);
        fields.push(`lease_until=$${values.length}`);
      }
      fields.push('updated_at=now()');
      const { rows: [row] } = await pool.query(
        `UPDATE case_jobs SET ${fields.join(', ')} WHERE case_id=$1 RETURNING *`, values);
      return row ?? null;
    },

    async pendingCaseJobs(limit = 20) {
      const { rows } = await pool.query(`SELECT case_id FROM case_jobs
        WHERE status IN ('pending','awaiting_evidence','awaiting_relay','failed')
          OR (status IN ('analyzing','proved') AND lease_until < now())
        ORDER BY updated_at ASC LIMIT $1`, [limit]);
      return rows.map((row) => row.case_id);
    },
  };
}

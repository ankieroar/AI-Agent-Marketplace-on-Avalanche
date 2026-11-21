/**
 * One service executor used by both POST /api/orders/:id/execute and the
 * Day 3 event worker. The agent_outputs row is the idempotency boundary: an
 * order can have exactly one input hash, one lease and one delivered result.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { mockSummary, summarizeDocument } from '@warranty/agents';
import { summaryInputSchema } from '@warranty/schema';
import { encrypt, decrypt } from './crypto.mjs';
import { ApiError } from './day2-chain.mjs';

export function digestInput(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function serviceInputAad(orderId) {
  return 'service-input:' + String(orderId).toLowerCase();
}

export function validateServiceInput(input) {
  return summaryInputSchema.parse(input);
}

/** Persist the buyer input so a retried worker can execute it after a crash. */
export async function saveBuyerServiceRequest({ pool, orderId, buyer, input }) {
  const parsed = validateServiceInput(input);
  const inputHash = digestInput(parsed);
  const ciphertext = encrypt(parsed, process.env.AES_KEY_HEX, serviceInputAad(orderId));
  const { rowCount } = await pool.query(`INSERT INTO service_requests(
      order_id, buyer, input_hash, ciphertext, source)
    SELECT $1,$2,$3,$4,'buyer'
    WHERE NOT EXISTS (SELECT 1 FROM agent_outputs WHERE order_id=$1 AND input_hash <> $3)
    ON CONFLICT(order_id) DO UPDATE SET ciphertext=excluded.ciphertext,
      source=excluded.source, created_at=now()
    WHERE service_requests.input_hash = excluded.input_hash AND service_requests.buyer = excluded.buyer
    RETURNING order_id`, [orderId, buyer, inputHash, ciphertext]);
  if (!rowCount) {
    throw new ApiError(409, 'Đơn đã gắn với tài liệu khác. Mở kết quả hoặc chạy lại tài liệu đã lưu trong workspace.');
  }
  return { inputHash };
}

export function readStoredServiceInput(row, orderId) {
  if (!row?.ciphertext) throw new ApiError(409, 'Stored service input is missing');
  return validateServiceInput(decrypt(row.ciphertext, process.env.AES_KEY_HEX, serviceInputAad(orderId)));
}

export function readStoredServiceOutput(row, orderId) {
  if (row?.status !== 'delivered') throw new ApiError(409, 'Order does not have a summary yet');
  return {
    orderId,
    status: 'DELIVERED',
    mode: row.mode,
    result: decrypt(row.encrypted, process.env.AES_KEY_HEX, 'agent-output:' + orderId),
    resultHash: row.result_hash,
  };
}

/**
 * Execute the Document Summary Agent for a confirmed paid order.
 * Returns DELIVERED, RUNNING or throws ApiError; never reports success before
 * the database row is updated.
 */
export async function executeServiceOrder({
  pool,
  order,
  input,
  mode,
  runMock = mockSummary,
  runLive = summarizeDocument,
}) {
  const parsed = validateServiceInput(input);
  const hash = digestInput(parsed);
  const attempt = randomUUID();
  const selectedMode = mode === 'mock' ? 'mock' : 'openrouter';

  if (order.status === 1) {
    const { rowCount } = await pool.query(`INSERT INTO agent_outputs(
        order_id, input_hash, attempt, status, lease_until, mode)
      VALUES($1,$2,$3,'running', now() + interval '2 minutes', $4)
      ON CONFLICT(order_id) DO UPDATE SET status='running', attempt=excluded.attempt,
        lease_until=excluded.lease_until, mode=excluded.mode
      WHERE agent_outputs.input_hash = excluded.input_hash AND
        (agent_outputs.status='failed' OR
         (agent_outputs.status='running' AND agent_outputs.lease_until < now()))
      RETURNING order_id`, [order.orderId, hash, attempt, selectedMode]);
    if (rowCount) {
      try {
        const result = selectedMode === 'mock'
          ? runMock(parsed.text)
          : await runLive(parsed.text);
        const resultHash = ethers.id(JSON.stringify(result));
        const stored = await pool.query(`UPDATE agent_outputs SET status='delivered',
          encrypted=$3, result_hash=$4 WHERE order_id=$1 AND attempt=$2`,
        [order.orderId, attempt,
          encrypt(result, process.env.AES_KEY_HEX, 'agent-output:' + order.orderId), resultHash]);
        if (!stored.rowCount) throw new ApiError(409, 'Execution lease expired. Read the current result.');
        return { orderId: order.orderId, status: 'DELIVERED', mode: selectedMode, result, resultHash };
      } catch (error) {
        await pool.query(`UPDATE agent_outputs SET status='failed'
          WHERE order_id=$1 AND attempt=$2 AND status='running'`, [order.orderId, attempt]);
        throw error;
      }
    }
  }

  const { rows: [job] } = await pool.query(
    'SELECT * FROM agent_outputs WHERE order_id=$1', [order.orderId]);
  if (!job || job.input_hash !== hash) {
    throw new ApiError(409, 'Order is not executable with this input');
  }
  if (job.status === 'running') return { orderId: order.orderId, status: 'RUNNING' };
  if (job.status !== 'delivered') throw new ApiError(409, 'Order is no longer executable');
  return readStoredServiceOutput(job, order.orderId);
}

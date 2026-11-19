/**
 * Generate a policy proof for an open dispute case from trusted data only.
 *
 * The API caller supplies a case id and (until the worker has stored an
 * analysis) a requested refund. The witness is always read from the encrypted
 * service_policies row, cross-checked against the claim and the confirmed
 * order, and never returned to the caller. This endpoint prepares a proof for
 * the reviewer wallet to submit; it does not send a transaction.
 */
import { ethers } from 'ethers';
import { decrypt } from './crypto.mjs';
import { ApiError } from './day2-chain.mjs';
import {
  PermanentWorkerError,
  verifyCaseClaim,
  verifyProofPublicInputs,
} from './day3-events.mjs';
import { policyAad } from './seed-policy.mjs';

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

async function defaultProve(claim, witness, payout) {
  // Loaded lazily: GET/POST routes that do not build proofs do not need nargo/bb.
  try {
    const { proveServicePolicy } = await import('../../../services/prover/day2.mjs');
    return await proveServicePolicy(claim, witness, payout);
  } catch (error) {
    // day2.mjs deliberately hides Noir diagnostics; keep that boundary here.
    throw new ApiError(503, 'Policy prover is unavailable: ' + error.message);
  }
}

function parseCaseId(caseId) {
  if (typeof caseId !== 'string' || !BYTES32.test(caseId)) {
    throw new ApiError(400, 'caseId must be bytes32');
  }
  return caseId.toLowerCase();
}

function parseWei(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ApiError(400, label + ' must be an unsigned integer string in wei');
  }
  return BigInt(value);
}

/**
 * The refund is never taken from the AI model or the browser unchecked. A
 * stored worker analysis wins; otherwise the explicit request is capped by
 * both maxRefund and the escrowed amount.
 */
export function resolvePayoutWei({ requested, job, maxRefund, lockedAmount }) {
  const cap = BigInt(maxRefund) < BigInt(lockedAmount)
    ? BigInt(maxRefund) : BigInt(lockedAmount);
  const analysed = job?.payout_amount;

  if (analysed != null) {
    const amount = parseWei(String(analysed), 'analysed payout');
    if (requested != null && parseWei(String(requested), 'refundWei') !== amount) {
      throw new ApiError(409, 'refundWei differs from the stored case analysis');
    }
    if (amount <= 0n) throw new ApiError(409, 'Analysed payout is zero; there is nothing to prove');
    if (amount > cap) throw new ApiError(409, 'Analysed payout exceeds the policy or escrow limit');
    return amount.toString();
  }

  if (requested == null) {
    throw new ApiError(409, 'refundWei is required until an analysis is available for this case');
  }
  const amount = parseWei(String(requested), 'refundWei');
  if (amount <= 0n) throw new ApiError(409, 'refundWei must be greater than zero');
  // A caller may ask for more than the policy allows; the public refund input
  // is always capped. The response reports the amount actually proved.
  return (amount > cap ? cap : amount).toString();
}

/**
 * @param {object} options
 * @param {string} options.caseId bytes32 case id on the dispute chain
 * @param {string} [options.refundWei] requested payout, capped server-side
 * @param {object} options.pool PostgreSQL pool (read-only here)
 * @param {object} options.settlement confirmed-order chain reader
 * @param {object} options.dispute dispute-chain reader
 * @param {Function} [options.prove] prover injection for offline tests
 */
export async function prepareProof({
  caseId, refundWei, pool, settlement, dispute, prove = defaultProve,
}) {
  const id = parseCaseId(caseId);
  const claim = await dispute.claim(id);
  if (!claim) throw new ApiError(404, 'Case not found on the dispute chain');
  const status = Number(claim.status);
  if (status < 1 || status > 2) {
    if (status === 3) throw new ApiError(409, 'Case proof is already verified');
    throw new ApiError(409, 'Case is closed for proof submission');
  }

  const order = await settlement.order(claim.orderId);
  if (!order) throw new ApiError(409, 'Disputed order is not confirmed on the settlement chain');

  const { rows: [policyRow] } = await pool.query(
    'SELECT ciphertext, commitment, policy_version_hash FROM service_policies WHERE order_id=$1',
    [String(claim.orderId).toLowerCase()],
  );
  if (!policyRow) {
    throw new ApiError(409, 'No seeded policy for this order; run seed:staging with the checkout commitment');
  }
  let witness;
  try {
    witness = decrypt(policyRow.ciphertext, process.env.AES_KEY_HEX, policyAad(claim.orderId));
  } catch {
    throw new ApiError(409, 'Stored policy cannot be decrypted with this key');
  }

  let verified;
  try {
    verified = verifyCaseClaim({ claim, policy: witness, order, caseStatus: status });
  } catch (error) {
    if (error instanceof PermanentWorkerError) throw new ApiError(409, error.message);
    throw error;
  }

  const { rows: [job] } = await pool.query(
    'SELECT status, payout_amount, proof_hash, proof FROM case_jobs WHERE case_id=$1',
    [id],
  );
  if (job && ['submitted', 'rejected'].includes(job.status)) {
    throw new ApiError(409, 'Case job is already ' + job.status);
  }
  const payout = resolvePayoutWei({
    requested: refundWei,
    job,
    maxRefund: witness.maxRefund,
    lockedAmount: verified.claim.lockedAmount,
  });

  const proofData = await prove(verified.claim, witness, payout);
  if (!proofData || typeof proofData.proof !== 'string' || !ethers.isHexString(proofData.proof)) {
    throw new ApiError(502, 'Prover returned an invalid proof');
  }
  let checked;
  try {
    checked = verifyProofPublicInputs({
      publicInputs: proofData.publicInputs, claim: verified.claim, payout,
    });
  } catch (error) {
    if (error instanceof PermanentWorkerError) throw new ApiError(502, error.message);
    throw error;
  }

  return {
    caseId: id,
    orderId: verified.claim.orderId,
    payoutWei: checked.payout,
    nullifier: checked.nullifier,
    proof: proofData.proof,
    publicInputs: proofData.publicInputs,
    proofHash: ethers.keccak256(proofData.proof),
  };
}

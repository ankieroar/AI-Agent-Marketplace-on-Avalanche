import { createHash } from 'node:crypto';
import { z } from 'zod';

const u64 = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 2n ** 64n);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const id = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const servicePolicyWitness = z.object({
  disputeWindow: u64, maxRefund: u64, nonce: z.string().regex(/^0x[0-9a-fA-F]{32}$/),
}).strict();
export const serviceClaim = z.object({
  caseId: id, orderId: id, policyCommitment: id, policyVersionHash: id,
  sourceBlockchainId: id, claimTimestamp: u64, purchaseTimestamp: u64, claimDeadline: u64,
  // Present on the Solidity Claim struct; the circuit does not consume them,
  // but accepting them keeps the full on-chain claim and prover input in sync.
  nonce: uint.optional(), lockedAmount: uint.optional(),
}).strict();

function domain(label) {
  const block = Buffer.alloc(32);
  block.write(label, 'ascii');
  return block;
}
const bytes = hex => Buffer.from(hex.slice(2), 'hex');
function intBytes(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}
const hash = chunks => createHash('blake2s256').update(Buffer.concat(chunks)).digest();
const hex = buf => '0x' + buf.toString('hex');
export function serviceCommitment(orderId, version, witness) {
  const p = servicePolicyWitness.parse(witness);
  return hex(hash([domain('avalanche.service.policy.v1'), bytes(id.parse(orderId)), bytes(id.parse(version)),
    intBytes(p.disputeWindow), intBytes(p.maxRefund), bytes(p.nonce)]));
}
export function witnessInputs(claimInput, policy, payout) {
  const c = serviceClaim.parse(claimInput);
  const p = servicePolicyWitness.parse(policy);
  u64.parse(payout);
  const nullifier = hex(hash([domain('avalanche.service.nullifier.v1'), bytes(c.orderId), bytes(c.caseId),
    bytes(c.sourceBlockchainId), bytes(c.policyCommitment), bytes(p.nonce)]).subarray(1));
  const x = {};
  for (const [name, value] of Object.entries({
    case: c.caseId, order: c.orderId, commitment: c.policyCommitment,
    version: c.policyVersionHash, source: c.sourceBlockchainId,
  })) {
    x[name + '_hi'] = '0x' + value.slice(2, 34);
    x[name + '_lo'] = '0x' + value.slice(34);
  }
  return {...x, claim_timestamp:c.claimTimestamp, payout_amount:payout, nullifier,
    purchase_timestamp:c.purchaseTimestamp, claim_deadline:c.claimDeadline,
    dispute_window:p.disputeWindow, max_refund:p.maxRefund, policy_nonce:[...bytes(p.nonce)]};
}

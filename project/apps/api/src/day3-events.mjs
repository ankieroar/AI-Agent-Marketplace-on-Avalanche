/**
 * Pure validation helpers shared by the Day 3 event worker and its tests.
 * No database or RPC access lives here.
 */
import { ethers } from 'ethers';
import {
  serviceClaim,
  serviceCommitment,
  servicePolicyWitness,
} from '../../../services/prover/service-policy-input.mjs';

export class PermanentWorkerError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PermanentWorkerError';
    this.permanent = true;
  }
}

const ZERO32 = ethers.ZeroHash;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export function eventKey({ chainId, contract, txHash, logIndex }) {
  return [String(chainId), String(contract).toLowerCase(), String(txHash).toLowerCase(), String(logIndex)]
    .join(':');
}

export function decodeEventLog(iface, log, expectedName) {
  let parsed;
  try {
    parsed = iface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== expectedName) return null;
  return parsed.args;
}

function requireBytes32(label, value) {
  if (typeof value !== 'string' || !BYTES32.test(value) || value.toLowerCase() === ZERO32) {
    throw new PermanentWorkerError(label + ' must be a non-zero bytes32');
  }
  return value.toLowerCase();
}

function requireUint(label, value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PermanentWorkerError(label + ' must be an unsigned integer string');
  }
  return BigInt(value);
}

/**
 * Cross-check the event payload against the confirmed order read from chain.
 * The event and the order must describe the same checkout.
 */
export function verifyPurchaseEventArgs(args, verified) {
  const checks = [
    ['orderId', verified.orderId],
    ['agentId', verified.agentId],
    ['buyer', verified.buyer],
    ['seller', verified.seller],
    ['policyCommitment', verified.commitment],
    ['policyVersionHash', verified.policyVersionHash],
  ];
  for (const [field, expected] of checks) {
    if (String(args[field]).toLowerCase() !== String(expected).toLowerCase()) {
      throw new PermanentWorkerError('ServicePurchased has a different ' + field);
    }
  }
  if (BigInt(args.priceWei) !== BigInt(verified.priceWei)) {
    throw new PermanentWorkerError('ServicePurchased has a different priceWei');
  }
  if (verified.purchaseTimestamp != null &&
      String(args.purchaseTimestamp) !== String(verified.purchaseTimestamp)) {
    throw new PermanentWorkerError('ServicePurchased has a different purchaseTimestamp');
  }
  return true;
}

/**
 * Validate an on-chain dispute claim against the stored private policy and the
 * disputed order. The circuit only accepts claims whose public fields match the
 * commitment, the purchase window and a payout below maxRefund.
 */
export function verifyCaseClaim({ claim, policy, order, caseStatus, allowedStatuses = [1, 2] }) {
  if (!claim) throw new PermanentWorkerError('Case was not found on the dispute chain');
  if (!allowedStatuses.includes(Number(caseStatus))) {
    throw new PermanentWorkerError('Case is not open for analysis');
  }
  const caseId = requireBytes32('caseId', claim.caseId);
  const orderId = requireBytes32('orderId', claim.orderId);
  const commitment = requireBytes32('policyCommitment', claim.policyCommitment);
  const version = requireBytes32('policyVersionHash', claim.policyVersionHash);
  requireBytes32('sourceBlockchainId', claim.sourceBlockchainId);

  let witness;
  try {
    witness = servicePolicyWitness.parse(policy);
  } catch {
    throw new PermanentWorkerError('Stored policy witness is malformed');
  }
  const recomputed = serviceCommitment(orderId, version, witness).toLowerCase();
  if (recomputed !== commitment) {
    throw new PermanentWorkerError('Dispute claim does not match the stored policy commitment');
  }

  const purchaseTimestamp = requireUint('purchaseTimestamp', String(claim.purchaseTimestamp));
  const claimTimestamp = requireUint('claimTimestamp', String(claim.claimTimestamp));
  const claimDeadline = requireUint('claimDeadline', String(claim.claimDeadline));
  const lockedAmount = requireUint('lockedAmount', String(claim.lockedAmount));
  const maxRefund = BigInt(witness.maxRefund);
  if (purchaseTimestamp === 0n) throw new PermanentWorkerError('purchaseTimestamp must be > 0');
  if (claimTimestamp < purchaseTimestamp) {
    throw new PermanentWorkerError('claimTimestamp is before purchaseTimestamp');
  }
  if (claimTimestamp > claimDeadline) {
    throw new PermanentWorkerError('claimTimestamp is outside the dispute window');
  }
  if (purchaseTimestamp + BigInt(witness.disputeWindow) !== claimDeadline) {
    throw new PermanentWorkerError('claimDeadline does not match purchaseTimestamp + disputeWindow');
  }
  if (lockedAmount === 0n) throw new PermanentWorkerError('lockedAmount must be > 0');
  if (maxRefund === 0n) throw new PermanentWorkerError('maxRefund must be > 0');
  if (maxRefund > lockedAmount) {
    throw new PermanentWorkerError('maxRefund exceeds the escrowed dispute amount');
  }
  if (claim.nonce != null && BigInt(claim.nonce) !== BigInt(caseId)) {
    throw new PermanentWorkerError('Claim nonce is not bound to the case id');
  }

  if (order) {
    if (String(order.orderId).toLowerCase() !== orderId) {
      throw new PermanentWorkerError('Case orderId does not match the order');
    }
    if (String(order.policyCommitment).toLowerCase() !== commitment ||
        String(order.policyVersionHash).toLowerCase() !== version) {
      throw new PermanentWorkerError('Case claim does not match the order policy record');
    }
    if (order.caseId && String(order.caseId).toLowerCase() !== ZERO32 &&
        String(order.caseId).toLowerCase() !== caseId) {
      throw new PermanentWorkerError('Case id does not match the disputed order');
    }
  }

  // Also run the strict public-claim schema so malformed values cannot reach
  // the prover or the submitter.
  serviceClaim.parse({
    caseId,
    orderId,
    policyCommitment: commitment,
    policyVersionHash: version,
    sourceBlockchainId: String(claim.sourceBlockchainId).toLowerCase(),
    claimTimestamp: String(claimTimestamp),
    purchaseTimestamp: String(purchaseTimestamp),
    claimDeadline: String(claimDeadline),
  });

  // Build only the fields of the on-chain Claim struct. Spreading the chain
  // reader result would also carry status/payoutAmount/proofRef and break the
  // strict prover schema when a real proof is generated.
  return {
    claim: {
      caseId,
      orderId,
      policyCommitment: commitment,
      policyVersionHash: version,
      sourceBlockchainId: String(claim.sourceBlockchainId).toLowerCase(),
      claimTimestamp: String(claimTimestamp),
      purchaseTimestamp: String(purchaseTimestamp),
      claimDeadline: String(claimDeadline),
      lockedAmount: String(lockedAmount),
      nonce: claim.nonce == null ? String(BigInt(caseId)) : String(claim.nonce),
    },
    witness,
  };
}

/**
 * Convert the untrusted AI recommendation into the refund public input. The
 * model cannot exceed maxRefund or the escrowed amount, and an ineligible case
 * always yields zero (no refund proof is submitted).
 */
export function computePayout({ analysis, resolution, maxRefund, lockedAmount }) {
  if (!analysis?.eligible) return '0';
  let proposed;
  try {
    proposed = BigInt(String(resolution?.proposedPayout ?? '0'));
  } catch {
    return '0';
  }
  if (proposed < 0n) return '0';
  let cap = BigInt(maxRefund);
  const escrow = BigInt(lockedAmount);
  if (escrow < cap) cap = escrow;
  return (proposed > cap ? cap : proposed).toString();
}

/**
 * Cross-check the C-Chain MarketplaceGateway.CaseOpened event against the
 * disputed order before queuing work. The L1 claim remains authoritative for
 * the proof; this only prevents acting on a stale or unrelated event.
 */
export function verifyGatewayCaseOpening({ args, order }) {
  if (!order) throw new PermanentWorkerError('Disputed order is not confirmed on the settlement chain');
  if (Number(order.status) !== 4) {
    throw new PermanentWorkerError('Order is not in Disputed state');
  }
  const orderId = requireBytes32('orderId', args.orderId);
  const caseId = requireBytes32('caseId', args.caseId);
  if (String(order.orderId).toLowerCase() !== orderId) {
    throw new PermanentWorkerError('Gateway event orderId does not match the order');
  }
  if (String(order.caseId ?? '').toLowerCase() !== caseId) {
    throw new PermanentWorkerError('Gateway event caseId does not match the order');
  }
  if (String(order.policyCommitment).toLowerCase() !== String(args.policyCommitment).toLowerCase()) {
    throw new PermanentWorkerError('Gateway event policyCommitment does not match the order');
  }
  if (String(order.policyVersionHash).toLowerCase() !== String(args.policyVersionHash).toLowerCase()) {
    throw new PermanentWorkerError('Gateway event policyVersionHash does not match the order');
  }
  return { caseId, orderId };
}

export function claimStruct(claim) {
  return [
    claim.caseId,
    claim.orderId,
    claim.policyCommitment,
    claim.claimTimestamp,
    claim.policyVersionHash,
    claim.sourceBlockchainId,
    claim.nonce,
    claim.lockedAmount,
    claim.purchaseTimestamp,
    claim.claimDeadline,
  ];
}

const MASK128 = (1n << 128n) - 1n;

/**
 * Confirm the prover's 15 public inputs match the on-chain claim and the
 * refund amount before submitting anything. This catches a swapped case,
 * order, commitment, timestamp or payout locally.
 */
export function verifyProofPublicInputs({ publicInputs, claim, payout }) {
  if (!Array.isArray(publicInputs) || publicInputs.length !== 15) {
    throw new PermanentWorkerError('Proof must expose exactly 15 public inputs');
  }
  const inputs = publicInputs.map((value) => BigInt(value));
  const pairs = [
    [0, claim.caseId], [2, claim.orderId], [4, claim.policyCommitment],
    [6, claim.policyVersionHash], [8, claim.sourceBlockchainId],
  ];
  for (const [index, value] of pairs) {
    const field = BigInt(value);
    if (inputs[index] !== (field >> 128n) || inputs[index + 1] !== (field & MASK128)) {
      throw new PermanentWorkerError('Proof public inputs do not match the on-chain claim');
    }
  }
  const scalars = [
    [10, claim.claimTimestamp], [11, payout],
    [13, claim.purchaseTimestamp], [14, claim.claimDeadline],
  ];
  for (const [index, value] of scalars) {
    if (inputs[index] !== BigInt(value)) {
      throw new PermanentWorkerError('Proof public input at index ' + index + ' does not match');
    }
  }
  if (inputs[12] === 0n) throw new PermanentWorkerError('Proof nullifier is zero');
  return {
    nullifier: '0x' + inputs[12].toString(16).padStart(64, '0'),
    payout: inputs[11].toString(),
  };
}

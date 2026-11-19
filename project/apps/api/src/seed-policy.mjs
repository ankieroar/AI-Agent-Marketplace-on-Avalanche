import { serviceCommitment, servicePolicyWitness } from '../../../services/prover/service-policy-input.mjs';

export class SeedError extends Error {}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = '0x' + '0'.repeat(64);

export function policyAad(orderId) {
  return 'service-policy:' + orderId.toLowerCase();
}

function requireHex32(label, value) {
  if (typeof value !== 'string' || !BYTES32.test(value) || value.toLowerCase() === ZERO32) {
    throw new SeedError(label + ' must be a non-zero bytes32 value');
  }
  return value.toLowerCase();
}

function requireUint(label, value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SeedError(label + ' must be an unsigned integer string');
  }
  return BigInt(value);
}

/**
 * Validate a seeded service policy against the checkout record read from chain.
 * The commitment is recomputed from the private witness exactly as the Noir
 * circuit does, so a seed can never silently diverge from `purchaseService`.
 */
export function verifyCheckout({ listing, order, policy }) {
  if (!listing) throw new SeedError('Agent listing not found');
  if (!order) throw new SeedError('Checkout order not found');
  if (listing.active === false) throw new SeedError('Agent listing is not active');
  if (order.agentId?.toLowerCase() !== listing.agentId?.toLowerCase()) {
    throw new SeedError('Order does not belong to the selected agent');
  }
  if (!Number.isInteger(order.status) || order.status < 1) {
    throw new SeedError('Order has no confirmed checkout state');
  }
  const commitment = requireHex32('On-chain policyCommitment', order.policyCommitment);
  const version = requireHex32('On-chain policyVersionHash', order.policyVersionHash);
  if (listing.policyVersionHash?.toLowerCase() !== version) {
    throw new SeedError('Listing policy version does not match the checkout record');
  }
  if (listing.priceWei != null && BigInt(listing.priceWei) !== BigInt(order.priceWei)) {
    throw new SeedError('Listing price does not match the escrowed order price');
  }

  let witness;
  try {
    witness = servicePolicyWitness.parse(policy);
  } catch {
    throw new SeedError('Policy witness must contain disputeWindow, maxRefund and a 16-byte nonce');
  }
  const recomputed = serviceCommitment(order.orderId, version, witness).toLowerCase();
  if (recomputed !== commitment) {
    throw new SeedError('Policy witness does not match the on-chain commitment from checkout');
  }
  if (listing.disputeWindow != null && BigInt(listing.disputeWindow) !== BigInt(witness.disputeWindow)) {
    throw new SeedError('Policy disputeWindow does not match the on-chain listing');
  }
  const priceWei = requireUint('Order priceWei', String(order.priceWei));
  if (BigInt(witness.maxRefund) > priceWei) {
    throw new SeedError('Policy maxRefund exceeds the escrowed order price');
  }
  if (BigInt(witness.disputeWindow) === 0n) {
    throw new SeedError('Policy disputeWindow must be greater than zero');
  }

  let purchaseTimestamp = null;
  let claimDeadline = null;
  if (order.purchaseTimestamp != null && BigInt(order.purchaseTimestamp) !== 0n) {
    purchaseTimestamp = String(order.purchaseTimestamp);
    claimDeadline = String(order.claimDeadline);
    const purchased = requireUint('Checkout purchaseTimestamp', purchaseTimestamp);
    const deadline = requireUint('Checkout claimDeadline', claimDeadline);
    if (purchased === 0n) throw new SeedError('Checkout purchaseTimestamp must be greater than zero');
    if (purchased + BigInt(witness.disputeWindow) !== deadline) {
      throw new SeedError('Checkout claimDeadline does not match purchaseTimestamp + disputeWindow');
    }
  }

  return {
    orderId: order.orderId.toLowerCase(),
    agentId: order.agentId.toLowerCase(),
    buyer: order.buyer.toLowerCase(),
    seller: order.seller.toLowerCase(),
    priceWei: String(order.priceWei),
    status: order.status,
    policyVersionHash: version,
    commitment: recomputed,
    purchaseTimestamp,
    claimDeadline,
    witness,
  };
}

/**
 * Require the supplied transaction receipt to contain the ServicePurchased
 * event for this order, with the exact commitment read from the policy
 * registry. This prevents attaching an unrelated tx hash to a seed receipt.
 */
export function verifyCheckoutEvent({ logs, iface, address, orderId, verified }) {
  const target = orderId.toLowerCase();
  const emitter = address.toLowerCase();
  for (const log of logs ?? []) {
    if (String(log.address).toLowerCase() !== emitter) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'ServicePurchased') continue;
    const args = parsed.args;
    if (String(args.orderId).toLowerCase() !== target) continue;
    const checks = [
      ['policyCommitment', verified.commitment],
      ['policyVersionHash', verified.policyVersionHash],
      ['agentId', verified.agentId],
      ['buyer', verified.buyer],
      ['seller', verified.seller],
    ];
    for (const [field, expected] of checks) {
      if (String(args[field]).toLowerCase() !== expected) {
        throw new SeedError('Checkout transaction event has a different ' + field);
      }
    }
    if (BigInt(args.priceWei) !== BigInt(verified.priceWei)) {
      throw new SeedError('Checkout transaction event has a different priceWei');
    }
    if (verified.purchaseTimestamp != null &&
        String(args.purchaseTimestamp) !== verified.purchaseTimestamp) {
      throw new SeedError('Checkout transaction event has a different purchaseTimestamp');
    }
    return {
      orderId: target,
      commitment: String(args.policyCommitment).toLowerCase(),
      purchaseTimestamp: String(args.purchaseTimestamp),
    };
  }
  throw new SeedError('Transaction does not contain ServicePurchased for this order');
}

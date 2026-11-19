import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { serviceCommitment } from '../services/prover/service-policy-input.mjs';
import { encrypt, decrypt } from '../apps/api/src/crypto.mjs';
import { SeedError, policyAad, verifyCheckout, verifyCheckoutEvent } from '../apps/api/src/seed-policy.mjs';

const orderId = ethers.id('seed-order-1');
const version = ethers.id('document-summary-policy-v1');
const agentId = ethers.id('document-summary');
const buyer = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const seller = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
const priceWei = ethers.parseEther('0.01').toString();

function checkout(policy, overrides = {}) {
  const commitment = serviceCommitment(orderId, version, policy);
  return {
    listing: { agentId, active: true, policyVersionHash: version, priceWei },
    order: {
      orderId, agentId, buyer, seller, priceWei, status: 1,
      policyCommitment: commitment, policyVersionHash: version,
      purchaseTimestamp: '1760000000', claimDeadline: '1760003600',
    },
    policy,
    ...overrides,
  };
}

const validPolicy = {
  disputeWindow: '3600',
  maxRefund: '7500000000000000',
  nonce: '0x' + '66'.repeat(16),
};

test('accepts a policy that reproduces the checkout commitment', () => {
  const result = verifyCheckout(checkout(validPolicy));
  assert.equal(result.orderId, orderId.toLowerCase());
  assert.equal(result.commitment, serviceCommitment(orderId, version, validPolicy).toLowerCase());
  assert.equal(result.priceWei, priceWei);
});

test('rejects a policy that does not match the on-chain commitment', () => {
  const fixture = checkout(validPolicy);
  fixture.policy = { ...validPolicy, maxRefund: '1' };
  assert.throws(() => verifyCheckout(fixture), SeedError);
});

test('rejects maxRefund above the escrowed amount even with a valid commitment', () => {
  const policy = { ...validPolicy, maxRefund: (BigInt(priceWei) + 1n).toString() };
  assert.throws(() => verifyCheckout(checkout(policy)), /exceeds the escrowed order price/);
});

test('rejects a listing whose policy version differs from checkout', () => {
  const fixture = checkout(validPolicy);
  fixture.listing.policyVersionHash = ethers.id('other-version');
  assert.throws(() => verifyCheckout(fixture), /policy version/);
});

test('rejects a listing whose price differs from the escrowed order', () => {
  const fixture = checkout(validPolicy);
  fixture.listing.priceWei = '1';
  assert.throws(() => verifyCheckout(fixture), /Listing price/);
});

test('rejects a witness window that differs from the listing window', () => {
  const fixture = checkout(validPolicy);
  fixture.listing.disputeWindow = '7200';
  assert.throws(() => verifyCheckout(fixture), /disputeWindow/);
});

test('rejects a checkout deadline that does not match purchaseTimestamp + window', () => {
  const fixture = checkout(validPolicy);
  fixture.order.claimDeadline = '1760007200';
  assert.throws(() => verifyCheckout(fixture), /claimDeadline/);
});

test('rejects an unchecked order without a checkout commitment', () => {
  const fixture = checkout(validPolicy);
  fixture.order.policyCommitment = ethers.ZeroHash;
  assert.throws(() => verifyCheckout(fixture), /non-zero bytes32/);
});

test('rejects a malformed nonce', () => {
  const fixture = checkout(validPolicy);
  fixture.policy = { ...validPolicy, nonce: '0x1234' };
  assert.throws(() => verifyCheckout(fixture), /16-byte nonce/);
});

const orderManager = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const servicePurchased = new ethers.Interface([
  'event ServicePurchased(bytes32 indexed orderId, bytes32 indexed agentId, address indexed buyer, address seller, uint256 priceWei, bytes32 policyCommitment, bytes32 policyVersionHash, uint64 purchaseTimestamp)',
]);

function checkoutLog(verified, overrides = {}) {
  const encoded = servicePurchased.encodeEventLog(
    servicePurchased.getEvent('ServicePurchased'),
    [
      verified.orderId, verified.agentId, verified.buyer, verified.seller,
      BigInt(verified.priceWei), overrides.commitment ?? verified.commitment,
      verified.policyVersionHash, BigInt(verified.purchaseTimestamp),
    ],
  );
  return { address: overrides.address ?? orderManager, topics: encoded.topics, data: encoded.data };
}

test('accepts the matching ServicePurchased checkout log', () => {
  const verified = verifyCheckout(checkout(validPolicy));
  const event = verifyCheckoutEvent({
    logs: [checkoutLog(verified)], iface: servicePurchased, address: orderManager, orderId, verified,
  });
  assert.equal(event.commitment, verified.commitment);
  assert.equal(event.purchaseTimestamp, verified.purchaseTimestamp);
});

test('rejects a checkout tx log with a different commitment', () => {
  const verified = verifyCheckout(checkout(validPolicy));
  const log = checkoutLog(verified, { commitment: ethers.id('other-policy') });
  assert.throws(() => verifyCheckoutEvent({
    logs: [log], iface: servicePurchased, address: orderManager, orderId, verified,
  }), /policyCommitment/);
});

test('rejects checkout logs from another emitter', () => {
  const verified = verifyCheckout(checkout(validPolicy));
  const log = checkoutLog(verified, { address: seller });
  assert.throws(() => verifyCheckoutEvent({
    logs: [log], iface: servicePurchased, address: orderManager, orderId, verified,
  }), /does not contain ServicePurchased/);
});

test('encrypts the private witness with the order-scoped AAD', () => {
  const key = 'a'.repeat(64);
  const sealed = encrypt(validPolicy, key, policyAad(orderId));
  assert.deepEqual(decrypt(sealed, key, policyAad(orderId)), validPolicy);
  assert.throws(() => decrypt(sealed, key, policyAad(ethers.id('other-order'))));
  assert.notEqual(JSON.stringify(sealed), JSON.stringify(validPolicy));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { serviceCommitment, witnessInputs } from '../services/prover/service-policy-input.mjs';
import { encrypt } from '../apps/api/src/crypto.mjs';
import { ApiError } from '../apps/api/src/day2-chain.mjs';
import { policyAad } from '../apps/api/src/seed-policy.mjs';
import { prepareProof, resolvePayoutWei } from '../apps/api/src/prepare-proof.mjs';

process.env.AES_KEY_HEX = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';

const caseId = ethers.id('prepare-proof-case');
const orderId = ethers.id('prepare-proof-order');
const agentId = ethers.id('document-summary');
const version = ethers.id('policy-v1');
const source = ethers.id('source-chain');
const buyer = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const witness = { disputeWindow: '3600', maxRefund: '7000', nonce: '0x' + '11'.repeat(16) };
const commitment = serviceCommitment(orderId, version, witness);
const purchaseTimestamp = '1760000000';
const claimDeadline = '1760003600';
const claim = {
  caseId,
  orderId,
  status: 1,
  policyCommitment: commitment,
  policyVersionHash: version,
  sourceBlockchainId: source,
  claimTimestamp: '1760000100',
  purchaseTimestamp,
  claimDeadline,
  lockedAmount: '10000',
  nonce: BigInt(caseId).toString(),
};
const order = {
  orderId, agentId, buyer, seller, priceWei: '10000', status: 1,
  caseId: ethers.ZeroHash, warranty: false,
  policyCommitment: commitment, policyVersionHash: version,
  purchaseTimestamp, claimDeadline,
};

/** Builds the 15 public inputs in the same order as verifyProofPublicInputs. */
function fakeProve(inputClaim, inputWitness, payout) {
  const inputs = witnessInputs(inputClaim, inputWitness, payout);
  return {
    proof: '0x' + 'cd'.repeat(32),
    publicInputs: [
      inputs.case_hi, inputs.case_lo,
      inputs.order_hi, inputs.order_lo,
      inputs.commitment_hi, inputs.commitment_lo,
      inputs.version_hi, inputs.version_lo,
      inputs.source_hi, inputs.source_lo,
      inputs.claim_timestamp, inputs.payout_amount, inputs.nullifier,
      inputs.purchase_timestamp, inputs.claim_deadline,
    ],
  };
}

function pool(policy = witness, job = null) {
  const policyRow = policy && {
    ciphertext: encrypt(policy, process.env.AES_KEY_HEX, policyAad(orderId)),
    commitment,
    policy_version_hash: version,
  };
  return {
    async query(sql) {
      if (sql.includes('service_policies')) return { rows: policyRow ? [policyRow] : [] };
      if (sql.includes('case_jobs')) return { rows: job ? [job] : [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
}

function chains(overrides = {}) {
  return {
    settlement: {
      async order(id) { return id.toLowerCase() === orderId ? order : null; },
    },
    dispute: {
      async claim(id) {
        return id.toLowerCase() === caseId ? { ...claim, ...overrides } : null;
      },
    },
  };
}

function run(options = {}) {
  return prepareProof({
    caseId, pool: pool(options.policy ?? witness, options.job ?? null),
    ...chains(options.claim ?? {}),
    prove: options.prove ?? fakeProve,
    refundWei: options.refundWei,
  });
}

test('builds a proof from the encrypted policy and returns only public data', async () => {
  let seen;
  const result = await run({
    refundWei: '5000',
    prove: (...args) => { seen = args; return fakeProve(...args); },
  });
  assert.equal(result.caseId, caseId);
  assert.equal(result.orderId, orderId);
  assert.equal(result.payoutWei, '5000');
  assert.equal(result.publicInputs.length, 15);
  assert.equal(result.proofHash, ethers.keccak256(result.proof));
  assert.ok(result.nullifier !== ethers.ZeroHash);
  assert.deepEqual(seen[1], witness);
  assert.ok(!JSON.stringify(result).includes(witness.nonce));
  assert.ok(!('witness' in result));
});

test('caps a refund above the policy or escrow limit', async () => {
  const result = await run({ refundWei: '7001' });
  assert.equal(result.payoutWei, '7000');
  assert.equal(result.publicInputs[11], '7000');
  await assert.rejects(run({ refundWei: '0' }), /greater than zero/);
  await assert.rejects(run(), /refundWei is required/);
});

test('a stored analysis payout wins and cannot be overridden by the caller', async () => {
  const job = { status: 'proved', payout_amount: '500', proof_hash: null, proof: null };
  const result = await run({ job, refundWei: '500' });
  assert.equal(result.payoutWei, '500');
  await assert.rejects(run({ job, refundWei: '600' }), /differs from the stored case analysis/);
});

test('rejects a claim that does not match the stored checkout policy', async () => {
  await assert.rejects(run({ claim: { policyCommitment: ethers.id('other') } }), (error) =>
    error instanceof ApiError && error.status === 409 && /commitment/i.test(error.message));
});

test('rejects a case that is already verified or closed', async () => {
  await assert.rejects(run({ claim: { status: 3 } }), /already verified/);
  await assert.rejects(run({ claim: { status: 4 } }), /closed/);
});

test('does not return a proof whose public inputs disagree with the claim', async () => {
  const badProve = (inputClaim, inputWitness, payout) => {
    const proof = fakeProve(inputClaim, inputWitness, payout);
    proof.publicInputs[11] = '0x' + (BigInt(payout) + 1n).toString(16).padStart(64, '0');
    return proof;
  };
  await assert.rejects(run({ refundWei: '100', prove: badProve }), (error) =>
    error instanceof ApiError && error.status === 502 && /public input/.test(error.message));
});

test('caps the requested payout with resolvePayoutWei', () => {
  assert.equal(resolvePayoutWei({ requested: '9000', maxRefund: '7000', lockedAmount: '10000' }), '7000');
  assert.equal(resolvePayoutWei({ requested: '11000', maxRefund: '20000', lockedAmount: '10000' }), '10000');
  assert.throws(() => resolvePayoutWei({ requested: '1x', maxRefund: '7000', lockedAmount: '10000' }), ApiError);
});

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ethers } from 'ethers';
import { serviceClaim, serviceCommitment, witnessInputs } from '../services/prover/service-policy-input.mjs';
import { mockServiceDisputePipeline, runServiceDisputePipeline } from '@warranty/agents';
import { encrypt } from '../apps/api/src/crypto.mjs';
import { policyAad } from '../apps/api/src/seed-policy.mjs';
import {
  computePayout,
  decodeEventLog,
  eventKey,
  PermanentWorkerError,
  verifyCaseClaim,
  verifyGatewayCaseOpening,
  verifyProofPublicInputs,
  verifyPurchaseEventArgs,
} from '../apps/api/src/day3-events.mjs';
import { sendConfirmed, waitForState } from '../apps/api/src/day3-tx.mjs';
import {
  handleCaseTrigger,
  processCaseJob,
  processChainEvent,
  processGatewayCaseOpened,
  processOrderById,
  processServicePurchase,
  resolveCaseEvent,
  resolveGatewayCaseEvent,
  submitProofOnL1,
} from '../apps/api/src/day3-worker.mjs';

const AES = 'ab'.repeat(32);
process.env.AES_KEY_HEX = AES;
process.env.NODE_ENV = 'test';

const buyer = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const caseId = ethers.id('case-1');
const orderId = ethers.id('order-1');
const agentId = ethers.id('document-summary');
const version = ethers.id('policy-v1');
const source = ethers.id('source-chain');
const witness = { disputeWindow: '3600', maxRefund: '7000', nonce: '0x' + '11'.repeat(16) };
const commitment = serviceCommitment(orderId, version, witness);
const purchaseTimestamp = '1760000000';
const claimDeadline = '1760003600';
const claim = {
  caseId,
  orderId,
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
const listing = {
  agentId, seller, active: true, priceWei: '10000',
  metadataURI: 'ipfs://demo', policyVersionHash: version,
  disputeWindow: witness.disputeWindow,
};
const purchaseArgs = {
  orderId, agentId, buyer, seller, priceWei: '10000',
  policyCommitment: commitment, policyVersionHash: version,
  purchaseTimestamp,
};

function config(overrides = {}) {
  return {
    agentId, aiMode: 'mock', serviceInput: { text: 'Summarize the document.' },
    inputText: '', inputFile: '', evidenceText: '', evidenceFile: '',
    leaseSeconds: 60, batchSize: 20, maxAttempts: 5, noSubmit: false,
    submitterKey: '', deployerKey: '', txTimeoutMs: 1_000, stateTimeoutMs: 1_000,
    service: { confirmations: 1 }, l1: { confirmations: 1 },
    ...overrides,
  };
}

class MemoryStore {
  constructor() {
    this.events = new Map();
    this.checkpoints = new Map();
    this.listings = new Map();
    this.orders = new Map();
    this.policies = new Map();
    this.requests = new Map();
    this.cases = new Map();
    this.jobs = new Map();
    this.evidence = new Map();
    this.clock = 1_000_000;
  }

  now() { return this.clock; }

  async claimEvent({ eventKey: key, maxAttempts = 5 }) {
    const existing = this.events.get(key);
    if (!existing) {
      this.events.set(key, { status: 'received', attempts: 0, error: null });
      return { action: 'process', attempts: 0 };
    }
    if (existing.status === 'processed' || existing.status === 'skipped') {
      return { action: 'skip', reason: existing.status };
    }
    if (existing.status === 'failed') {
      existing.attempts += 1;
      if (existing.attempts >= maxAttempts) return { action: 'dead', attempts: existing.attempts };
    }
    return { action: 'process', attempts: existing.attempts };
  }

  async finishEvent(key, status, error = null) {
    const existing = this.events.get(key);
    assert(existing, 'event must be claimed before it is finished');
    existing.status = status;
    existing.error = error;
  }

  async getCheckpoint(worker) { return this.checkpoints.get(worker) ?? null; }
  async setCheckpoint(worker, chainId, blockNumber) {
    this.checkpoints.set(worker, { worker, chain_id: String(chainId), block_number: blockNumber });
  }

  async saveListing(item) { this.listings.set(item.agentId, item); }
  async saveOrder(item) { this.orders.set(item.orderId, item); }
  async getPolicy(id) { return this.policies.get(id) ?? null; }
  async saveServiceRequest(row) {
    const existing = this.requests.get(row.orderId);
    if (existing && existing.inputHash !== row.inputHash) return false;
    this.requests.set(row.orderId, row);
    return true;
  }
  async getServiceRequest(id) { return this.requests.get(id) ?? null; }
  async pendingServiceRequests() { return [...this.requests.keys()]; }
  async getEvidence(id) { return this.evidence.get(id) ?? null; }
  async saveCase(id, orderIdValue, snapshot) { this.cases.set(id, { id, orderId: orderIdValue, snapshot }); }

  async getCaseJob(id) { return this.jobs.get(id) ?? null; }

  async startCaseJob({ caseId: id, orderId: idOrder, leaseSeconds = 120 }) {
    const job = this.jobs.get(id);
    const now = this.now();
    if (!job) {
      const created = {
        case_id: id, order_id: idOrder, status: 'analyzing', attempts: 0,
        lease_until: now + leaseSeconds * 1000, evidence_hash: null,
        analysis_ciphertext: null, payout_amount: null, nullifier: null,
        proof_hash: null, proof: null, start_tx_hash: null, proof_tx_hash: null,
        last_error: null,
      };
      this.jobs.set(id, created);
      return { action: 'started', job: created };
    }
    if (job.status === 'submitted' || job.status === 'rejected') {
      return { action: 'done', job };
    }
    const canStart = ['pending', 'awaiting_evidence', 'awaiting_relay', 'failed'].includes(job.status)
      || (['analyzing', 'proved'].includes(job.status) && (!job.lease_until || job.lease_until < now));
    if (!canStart) return { action: 'busy', job };
    job.status = 'analyzing';
    job.attempts += 1;
    job.lease_until = now + leaseSeconds * 1000;
    job.last_error = null;
    return { action: 'started', job };
  }

  async finishCaseJob(id, patch = {}) {
    const job = this.jobs.get(id);
    assert(job, 'case job must exist');
    const allowed = ['status', 'lease_until', 'evidence_hash', 'analysis_ciphertext',
      'payout_amount', 'nullifier', 'proof_hash', 'proof', 'start_tx_hash',
      'proof_tx_hash', 'last_error'];
    for (const [key, value] of Object.entries(patch)) {
      if (allowed.includes(key)) job[key] = value;
    }
    if (patch.status && ['submitted', 'rejected'].includes(patch.status) && !('lease_until' in patch)) {
      job.lease_until = null;
    }
    return job;
  }

  async pendingCaseJobs() { return [...this.jobs.keys()]; }
}

function chainFor(overrides = {}) {
  return {
    chainId: '31337',
    scope: '31337:service',
    provider: { getBlockNumber: async () => 100 },
    has: (name) => name === 'ServiceOrderManager',
    contract: () => { throw new Error('not expected'); },
    async order() { return { ...order }; },
    async listing() { return { ...listing }; },
    ...overrides,
  };
}

function seedPolicy(store, id = orderId) {
  store.policies.set(id, {
    order_id: id, agent_id: agentId,
    policy_version_hash: version, commitment,
    ciphertext: encrypt(witness, AES, policyAad(id)), source: 'checkout',
  });
}

function splitInput(inputs, index, value) {
  const big = BigInt(value);
  inputs[index] = '0x' + (big >> 128n).toString(16).padStart(64, '0');
  inputs[index + 1] = '0x' + (big & ((1n << 128n) - 1n)).toString(16).padStart(64, '0');
}

function proofInputs(claimValue, payout, nullifier) {
  const inputs = new Array(15);
  splitInput(inputs, 0, claimValue.caseId);
  splitInput(inputs, 2, claimValue.orderId);
  splitInput(inputs, 4, claimValue.policyCommitment);
  splitInput(inputs, 6, claimValue.policyVersionHash);
  splitInput(inputs, 8, claimValue.sourceBlockchainId);
  inputs[10] = claimValue.claimTimestamp;
  inputs[11] = payout;
  inputs[12] = nullifier;
  inputs[13] = claimValue.purchaseTimestamp;
  inputs[14] = claimValue.claimDeadline;
  return inputs.map(String);
}

function l1For(state) {
  return {
    chainId: '31337',
    scope: '31337:dispute',
    provider: { getBlockNumber: async () => 100 },
    has: () => true,
    contract: () => { throw new Error('not expected'); },
    async claim(id) {
      assert.equal(id, caseId);
      return {
        ...claim, status: state.status, payoutAmount: state.amount ?? '0',
        proofRef: state.proofRef ?? ethers.ZeroHash,
        reviewerApprovalRef: ethers.ZeroHash,
      };
    },
    async reviewer() { return seller.toLowerCase(); },
    async admin() { return buyer.toLowerCase(); },
  };
}

beforeEach(() => {
  process.env.AES_KEY_HEX = AES;
  process.env.NODE_ENV = 'test';
});

test('service dispute pipeline sends only public policy fields and caps the model payout', async () => {
  process.env.OPENROUTER_API_KEY = 'fake-for-injected-fetch';
  process.env.OPENROUTER_MODEL = 'openrouter/free';
  const replies = [
    { purchaseDate: '2026-01-01', faultDescription: 'Missing section', missingEvidence: [] },
    { eligible: true, reasons: ['within the dispute window'] },
    { proposedPayout: '999999', reason: 'incomplete service', requiresHumanReview: true },
  ];
  const bodies = [];
  let index = 0;
  const result = await runServiceDisputePipeline({ text: 'Synthetic evidence', claim, policy: witness }, {
    fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(replies[index++]) } }],
      }), { status: 200 });
    },
  });
  assert.equal(index, 3);
  assert.equal(result.analysis.eligible, true);
  assert.equal(result.resolution.proposedPayout, '7000');
  assert(!bodies.join('').includes(witness.nonce), 'private nonce must never reach the model');
  assert.match(bodies[1], /claimDeadline/);

  delete process.env.DAY3_MOCK_ELIGIBLE;
  const mock = mockServiceDisputePipeline({ text: 'Synthetic evidence', claim, policy: witness });
  assert.equal(mock.analysis.eligible, false);
  assert.equal(mock.resolution.proposedPayout, '0');
  process.env.DAY3_MOCK_ELIGIBLE = '1';
  const optedIn = mockServiceDisputePipeline({ text: 'Synthetic evidence', claim, policy: witness });
  assert.equal(optedIn.resolution.proposedPayout, '1');
  delete process.env.DAY3_MOCK_ELIGIBLE;
});

test('event keys are stable and log decoding rejects other events', () => {
  const key = eventKey({ chainId: 43113, contract: seller, txHash: buyer, logIndex: 3 });
  assert.equal(key, '43113:' + seller + ':' + buyer + ':3');
  assert.equal(key, eventKey({ chainId: '43113', contract: seller.toUpperCase(), txHash: buyer.toUpperCase(), logIndex: 3 }));

  const iface = new ethers.Interface([
    'event ServicePurchased(bytes32 indexed orderId, bytes32 indexed agentId, address indexed buyer, address seller, uint256 priceWei, bytes32 policyCommitment, bytes32 policyVersionHash, uint64 purchaseTimestamp)',
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent('ServicePurchased'), [
    orderId, agentId, buyer, seller, '10000', commitment, version, purchaseTimestamp,
  ]);
  const args = decodeEventLog(iface, { topics: encoded.topics, data: encoded.data }, 'ServicePurchased');
  assert.equal(args.orderId, orderId);
  assert.equal(args.priceWei, 10000n);
  assert.equal(decodeEventLog(iface, { topics: encoded.topics, data: encoded.data }, 'OtherEvent'), null);
  assert.equal(decodeEventLog(iface, { topics: [], data: '0x' }, 'ServicePurchased'), null);
});

test('purchase event validation requires the exact checkout record', () => {
  const verified = {
    ...order, commitment, policyVersionHash: version,
    purchaseTimestamp, orderId, agentId, buyer, seller, priceWei: '10000',
  };
  assert.equal(verifyPurchaseEventArgs(purchaseArgs, verified), true);
  assert.throws(() => verifyPurchaseEventArgs({ ...purchaseArgs, priceWei: '9999' }, verified),
    /different priceWei/);
  assert.throws(() => verifyPurchaseEventArgs({ ...purchaseArgs, buyer: seller }, verified),
    /different buyer/);
  assert.throws(() => verifyPurchaseEventArgs({ ...purchaseArgs, policyCommitment: ethers.ZeroHash }, verified),
    /different policyCommitment/);
});

test('case claim validation recomputes the commitment and checks the dispute window', () => {
  const verified = verifyCaseClaim({
    claim, policy: witness, order: { ...order, status: 4, caseId }, caseStatus: 1,
  });
  assert.equal(verified.claim.orderId, orderId);
  assert.equal(verified.claim.lockedAmount, '10000');
  // The prover schema is strict: chain-only fields must not leak into the claim.
  assert.doesNotThrow(() => serviceClaim.parse(verified.claim));
  assert.deepEqual(verified.witness, witness);

  assert.throws(() => verifyCaseClaim({
    claim, policy: { ...witness, nonce: '0x' + '22'.repeat(16) }, order, caseStatus: 1,
  }), /does not match the stored policy commitment/);

  const lateClaim = { ...claim, claimDeadline: String(BigInt(claimDeadline) + 1n) };
  assert.throws(() => verifyCaseClaim({ claim: lateClaim, policy: witness, order, caseStatus: 1 }),
    /purchaseTimestamp \+ disputeWindow/);

  const openWitness = { ...witness, maxRefund: '20000' };
  const openCommitment = serviceCommitment(orderId, version, openWitness);
  assert.throws(() => verifyCaseClaim({
    claim: { ...claim, policyCommitment: openCommitment },
    policy: openWitness,
    order: { ...order, policyCommitment: openCommitment },
    caseStatus: 1,
  }), /maxRefund exceeds the escrowed/);

  assert.throws(() => verifyCaseClaim({ claim, policy: witness, order, caseStatus: 3 }),
    /not open for analysis/);
  assert.throws(() => verifyCaseClaim({ claim: null, policy: witness, order, caseStatus: 1 }),
    /not found/);
  assert.throws(() => verifyCaseClaim({
    claim, policy: witness,
    order: { ...order, caseId: ethers.id('other-case') }, caseStatus: 1,
  }), /does not match the disputed order/);
});

test('payout is capped by policy and escrow, and ineligible cases pay zero', () => {
  assert.equal(computePayout({
    analysis: { eligible: true }, resolution: { proposedPayout: '9000' },
    maxRefund: '7000', lockedAmount: '10000',
  }), '7000');
  assert.equal(computePayout({
    analysis: { eligible: true }, resolution: { proposedPayout: '9000' },
    maxRefund: '7000', lockedAmount: '5000',
  }), '5000');
  assert.equal(computePayout({
    analysis: { eligible: false }, resolution: { proposedPayout: '9000' },
    maxRefund: '7000', lockedAmount: '10000',
  }), '0');
  assert.equal(computePayout({
    analysis: { eligible: true }, resolution: { proposedPayout: 'not-a-number' },
    maxRefund: '7000', lockedAmount: '10000',
  }), '0');
});

test('proof public inputs must match the on-chain claim, payout and nullifier', () => {
  const nullifier = witnessInputs(claim, witness, '7000').nullifier;
  const inputs = proofInputs(claim, '7000', nullifier);
  const checked = verifyProofPublicInputs({ publicInputs: inputs, claim, payout: '7000' });
  assert.equal(checked.payout, '7000');
  assert.equal(checked.nullifier, '0x' + BigInt(nullifier).toString(16).padStart(64, '0'));

  assert.throws(() => verifyProofPublicInputs({
    publicInputs: proofInputs(claim, '6000', nullifier), claim, payout: '7000',
  }), /index 11/);
  assert.throws(() => verifyProofPublicInputs({
    publicInputs: inputs.slice(0, 14), claim, payout: '7000',
  }), /exactly 15/);
  assert.throws(() => verifyProofPublicInputs({
    publicInputs: proofInputs(claim, '7000', ethers.ZeroHash), claim, payout: '7000',
  }), /nullifier is zero/);
});

test('event processing claims each event once and respects permanent/transient failures', async () => {
  const store = new MemoryStore();
  const event = {
    eventKey: 'e1', chainId: '31337', contract: seller, eventName: 'ServicePurchased',
    blockNumber: 10, txHash: buyer, logIndex: 0, payload: {},
  };
  let calls = 0;
  const first = await processChainEvent({
    store, event, worker: 'w', maxAttempts: 2,
    handler: async () => { calls += 1; return { status: 'ok' }; },
  });
  assert.equal(first.status, 'processed');
  const replay = await processChainEvent({
    store, event, worker: 'w', handler: async () => { calls += 1; },
  });
  assert.deepEqual(replay, { status: 'skipped', reason: 'processed' });
  assert.equal(calls, 1);

  const permanent = { ...event, eventKey: 'e2' };
  const skipped = await processChainEvent({
    store, event: permanent, worker: 'w',
    handler: async () => { throw new PermanentWorkerError('policy mismatch'); },
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(store.events.get('e2').error, 'policy mismatch');

  const transient = { ...event, eventKey: 'e3' };
  let flaky = 0;
  const failing = async () => { flaky += 1; throw new Error('rpc down'); };
  await assert.rejects(() => processChainEvent({
    store, event: transient, worker: 'w', maxAttempts: 2, handler: failing,
  }), /rpc down/);
  assert.equal(store.events.get('e3').status, 'failed');
  await assert.rejects(() => processChainEvent({
    store, event: transient, worker: 'w', maxAttempts: 2, handler: failing,
  }), /rpc down/);
  const dead = await processChainEvent({
    store, event: transient, worker: 'w', maxAttempts: 2, handler: failing,
  });
  assert.equal(dead.reason, 'max attempts exceeded');
  assert.equal(flaky, 2);
});

test('transaction helper only reports success after applied state, with retryable sends', async () => {
  let applied = false;
  let sends = 0;
  const contract = {
    connect() {
      return {
        async deliver() {
          sends += 1;
          applied = true;
          return { hash: '0x' + 'aa'.repeat(32) };
        },
      };
    },
    runner: { provider: { waitForTransaction: async () => ({ status: 1 }) } },
  };
  const confirmed = await sendConfirmed({
    contract, method: 'deliver', signer: {}, applied: async () => applied,
    timeoutMs: 100, stateTimeoutMs: 100,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(sends, 1);

  const replay = await sendConfirmed({
    contract, method: 'deliver', signer: {}, applied: async () => applied,
  });
  assert.equal(replay.status, 'already-applied');
  assert.equal(sends, 1);

  let flaky = 0;
  let retryApplied = false;
  const retrying = {
    connect() {
      return {
        async deliver() {
          flaky += 1;
          if (flaky === 1) {
            const error = new Error('socket hang up');
            error.code = 'ECONNRESET';
            throw error;
          }
          retryApplied = true;
          return { hash: '0x' + 'bb'.repeat(32) };
        },
      };
    },
    runner: { provider: { waitForTransaction: async () => ({ status: 1 }) } },
  };
  const retried = await sendConfirmed({
    contract: retrying, method: 'deliver', signer: {}, retries: 1, sleep: async () => {},
    timeoutMs: 100, stateTimeoutMs: 100, applied: async () => retryApplied,
  });
  assert.equal(retried.status, 'confirmed');
  assert.equal(flaky, 2);

  const reverted = {
    connect() { return { async deliver() { return { hash: '0x' + 'cc'.repeat(32) }; } }; },
    runner: { provider: { waitForTransaction: async () => ({ status: 0 }) } },
  };
  await assert.rejects(() => sendConfirmed({
    contract: reverted, method: 'deliver', signer: {}, applied: async () => false,
    timeoutMs: 100,
  }), /reverted/);
});

test('waitForState polls until the predicate is true or times out', async () => {
  let now = 0;
  const sleep = async (ms) => { now += ms; };
  let reads = 0;
  const value = await waitForState(async () => { reads += 1; return reads >= 3; }, Boolean, {
    timeoutMs: 100, intervalMs: 10, now: () => now, sleep,
  });
  assert.equal(value, true);
  assert.equal(reads, 3);

  assert.equal(await waitForState(async () => false, Boolean, {
    timeoutMs: 20, intervalMs: 10, now: () => now, sleep,
  }), null);
});

test('service purchase execution validates the event, policy and input exactly once', async () => {
  const store = new MemoryStore();
  seedPolicy(store);
  const executions = [];
  const execute = async (request) => {
    executions.push(request);
    return { status: 'DELIVERED', resultHash: '0x' + 'dd'.repeat(32) };
  };
  const base = { chain: chainFor(), store, config: config(), execute };

  const delivered = await processServicePurchase({ args: purchaseArgs, ...base });
  assert.equal(delivered.status, 'delivered');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].order.orderId, orderId);
  assert.equal(store.orders.get(orderId).buyer, buyer);
  const storedRequest = store.requests.get(orderId);
  assert.equal(storedRequest.source, 'demo');
  assert.equal(storedRequest.buyer, buyer);
  assert.equal(storedRequest.inputHash.length, 64);

  await assert.rejects(() => processServicePurchase({
    args: { ...purchaseArgs, priceWei: '1' }, ...base,
  }), /different priceWei/);
  assert.equal(executions.length, 1);

  const ignored = await processServicePurchase({
    args: purchaseArgs, chain: chainFor({ order: async () => ({ ...order, status: 2 }) }),
    store, config: config(), execute,
  });
  assert.equal(ignored.status, 'ignored');
  assert.equal(executions.length, 1);
});

test('direct order execution also requires a seeded policy and matching buyer', async () => {
  const store = new MemoryStore();
  seedPolicy(store);
  const result = await processOrderById({
    orderId, chain: chainFor(), store, config: config(),
    execute: async () => ({ status: 'DELIVERED', resultHash: '0x' + 'ee'.repeat(32) }),
  });
  assert.equal(result.status, 'delivered');

  const missing = new MemoryStore();
  await assert.rejects(() => processOrderById({
    orderId, chain: chainFor(), store: missing, config: config(),
    execute: async () => ({ status: 'DELIVERED' }),
  }), /No encrypted service policy/);
});

function caseHarness({ evidence = 'Proof the document was incomplete.', eligible = true, payout = '9000' } = {}) {
  const store = new MemoryStore();
  seedPolicy(store);
  const state = { status: 1, proofRef: ethers.ZeroHash, amount: '0' };
  const calls = { analyze: 0, prove: 0, submit: 0 };
  const harnessConfig = config({
    evidenceText: evidence,
    serviceInput: null,
  });
  const analyze = async () => {
    calls.analyze += 1;
    return {
      evidence: { summary: 'incomplete' },
      analysis: { eligible, reasons: eligible ? ['within window'] : ['out of window'] },
      resolution: { proposedPayout: payout, reason: 'demo', requiresHumanReview: true },
    };
  };
  const prove = async (_claim, _witness, amount) => {
    calls.prove += 1;
    const nullifier = witnessInputs(claim, witness, amount).nullifier;
    return { proof: '0x' + 'ab'.repeat(64), publicInputs: proofInputs(claim, amount, nullifier) };
  };
  const submit = async ({ amount }) => {
    calls.submit += 1;
    state.status = 3;
    state.amount = amount;
    state.proofRef = ethers.keccak256('0x' + 'ab'.repeat(64)).toLowerCase();
    return { startTxHash: '0x' + '01'.repeat(32), proofTxHash: '0x' + '02'.repeat(32) };
  };
  const l1 = l1For(state);
  return {
    store, state, calls, config: harnessConfig, analyze, prove, submit, l1,
    run: (overrides = {}) => processCaseJob({
      caseId, l1, serviceChain: chainFor(), store, config: harnessConfig,
      analyze: overrides.analyze ?? analyze,
      prove: overrides.prove ?? prove,
      submit: overrides.submit ?? submit,
    }),
  };
}

test('case job runs agents, proves, submits and never analyzes a submitted case twice', async () => {
  const harness = caseHarness();
  const result = await harness.run();
  assert.equal(result.status, 'submitted');
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.calls.prove, 1);
  assert.equal(harness.calls.submit, 1);
  assert.equal(result.payout, '7000');
  const job = harness.store.jobs.get(caseId);
  assert.equal(job.status, 'submitted');
  assert.equal(job.payout_amount, '7000');
  assert.equal(job.proof_hash, ethers.keccak256('0x' + 'ab'.repeat(64)));
  assert.equal(job.start_tx_hash, '0x' + '01'.repeat(32));
  assert.equal(job.proof_tx_hash, '0x' + '02'.repeat(32));

  const replay = await harness.run();
  assert.equal(replay.status, 'submitted');
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.calls.prove, 1);
  assert.equal(harness.calls.submit, 1);
});

test('case job waits for evidence, then resumes without redoing a completed step', async () => {
  const harness = caseHarness({ evidence: '' });
  const waiting = await harness.run();
  assert.equal(waiting.status, 'awaiting-evidence');
  assert.equal(harness.store.jobs.get(caseId).status, 'awaiting_evidence');
  assert.equal(harness.calls.analyze, 0);

  harness.config.evidenceText = 'Late evidence arrives.';
  const resumed = await harness.run();
  assert.equal(resumed.status, 'submitted');
  assert.equal(harness.calls.analyze, 1);
  assert.equal(harness.calls.submit, 1);
});

test('ineligible cases never prove or submit', async () => {
  const harness = caseHarness({ eligible: false, payout: '9000' });
  const result = await harness.run();
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'policy recommendation is zero');
  assert.equal(harness.calls.prove, 0);
  assert.equal(harness.calls.submit, 0);
  assert.equal(harness.store.jobs.get(caseId).status, 'rejected');
});

test('transient agent failures leave a retryable failed job; permanent failures reject it', async () => {
  const harness = caseHarness();
  await assert.rejects(() => harness.run({
    analyze: async () => { throw new Error('model provider unavailable'); },
  }), /model provider unavailable/);
  assert.equal(harness.store.jobs.get(caseId).status, 'failed');

  const permanent = caseHarness();
  const result = await permanent.run({
    analyze: async () => { throw new PermanentWorkerError('claim is outside policy'); },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(permanent.store.jobs.get(caseId).status, 'rejected');
  assert.equal(permanent.calls.submit, 0);
});

test('case trigger waits for the relayed claim and records an awaiting-relay job', async () => {
  const store = new MemoryStore();
  const l1 = l1For({ status: 1 });
  const original = l1.claim;
  l1.claim = async () => null;
  const pending = await handleCaseTrigger({
    caseId, orderId, l1, serviceChain: chainFor(), store, config: config(),
    analyze: async () => { throw new Error('should not analyze'); },
    prove: async () => { throw new Error('should not prove'); },
    submit: async () => { throw new Error('should not submit'); },
  });
  assert.equal(pending.status, 'awaiting-relay');
  assert.equal(store.jobs.get(caseId).status, 'awaiting_relay');

  l1.claim = original;
  const workspace = caseHarness();
  const completed = await handleCaseTrigger({
    caseId, orderId, l1: workspace.l1, serviceChain: chainFor(),
    store: workspace.store, config: workspace.config,
    analyze: workspace.analyze, prove: workspace.prove, submit: workspace.submit,
  });
  assert.equal(completed.status, 'submitted');
});

test('case event selection supports CaseOpened and L1 CaseStatusChanged triggers', () => {
  const abi = [
    'event CaseOpened(bytes32 indexed caseId, bytes32 indexed orderId, bytes32 policyCommitment, uint64 claimTimestamp, bytes32 policyVersionHash, bytes32 sourceBlockchainId, uint256 nonce, bytes32 messageId)',
    'event CaseStatusChanged(bytes32 indexed caseId, uint8 status)',
  ];
  const opened = resolveCaseEvent({ contract: () => ({ interface: new ethers.Interface(abi) }) }, config());
  assert.equal(opened.eventName, 'CaseOpened');
  const changed = resolveCaseEvent({
    contract: () => ({ interface: new ethers.Interface([abi[1]]) }),
  }, config());
  assert.equal(changed.eventName, 'CaseStatusChanged');
});

test('gateway CaseOpened is cross-checked and queued until the L1 claim is relayed', async () => {
  const gatewayAbi = [
    'event CaseOpened(bytes32 indexed caseId, bytes32 indexed orderId, bytes32 policyCommitment, uint64 claimTimestamp, bytes32 policyVersionHash, bytes32 sourceBlockchainId, uint256 nonce, bytes32 messageId)',
  ];
  const gateway = { interface: new ethers.Interface(gatewayAbi) };
  const service = { has: (name) => name === 'MarketplaceGateway', contract: () => gateway };
  assert.equal(resolveGatewayCaseEvent(service, {}).eventName, 'CaseOpened');
  assert.equal(resolveGatewayCaseEvent({ has: () => false }, {}), null);
  assert.throws(() => resolveGatewayCaseEvent({ has: () => false }, { gatewayCaseEvent: 'CaseOpened' }),
    /no MarketplaceGateway/);

  const store = new MemoryStore();
  seedPolicy(store);
  const disputed = { ...order, status: 4, caseId };
  const args = { caseId, orderId, policyCommitment: commitment, policyVersionHash: version };
  assert.throws(() => verifyGatewayCaseOpening({ args, order: { ...disputed, status: 1 } }),
    /not in Disputed/);
  assert.throws(() => verifyGatewayCaseOpening({
    args, order: { ...disputed, caseId: ethers.id('other-case') },
  }), /caseId does not match/);

  let relayed = false;
  const baseL1 = l1For({ status: 1 });
  const l1 = {
    ...baseL1,
    async claim(id) { return relayed ? baseL1.claim(id) : null; },
  };
  const queued = await processGatewayCaseOpened({
    args, serviceChain: chainFor({ order: async () => disputed }), l1,
    store, config: config(),
    analyze: async () => { throw new Error('must not analyze before relay'); },
  });
  assert.equal(queued.status, 'awaiting-relay');
  assert.equal(store.jobs.get(caseId).status, 'awaiting_relay');

  relayed = true;
  const resumed = await handleCaseTrigger({
    caseId, orderId, l1, serviceChain: chainFor({ order: async () => disputed }),
    store, config: config({ evidenceText: 'Evidence after relay.' }),
    analyze: async () => ({
      evidence: { summary: 'fixture' },
      analysis: { eligible: false, reasons: ['fixture'] },
      resolution: { proposedPayout: '0', reason: 'fixture', requiresHumanReview: true },
    }),
  });
  assert.equal(resumed.status, 'rejected');
  assert.equal(store.jobs.get(caseId).status, 'rejected');
});

test('submitter must be the reviewer, not admin or deployer, and reports confirmed tx hashes', async () => {
  const submitterKey = '0x' + '11'.repeat(32);
  const deployerKey = '0x' + '22'.repeat(32);
  const submitter = new ethers.Wallet(submitterKey);
  const admin = new ethers.Wallet('0x' + '33'.repeat(32));
  const state = { status: 1, proofRef: ethers.ZeroHash, amount: '0' };
  const proof = '0x' + 'ab'.repeat(64);
  const manager = {
    connect() {
      return {
        async startAnalysis() {
          state.status = 2;
          return { hash: '0x' + 'aa'.repeat(32) };
        },
        async submitProof(_id, amount, _nullifier, submittedProof) {
          assert.equal(amount, '7000');
          state.status = 3;
          state.amount = amount;
          state.proofRef = ethers.keccak256(submittedProof).toLowerCase();
          return { hash: '0x' + 'bb'.repeat(32) };
        },
      };
    },
    runner: { provider: { waitForTransaction: async () => ({ status: 1 }) } },
  };
  const l1 = {
    chainId: '31337',
    provider: { getBalance: async () => 1n },
    async claim() {
      return {
        ...claim, status: state.status, proofRef: state.proofRef,
        payoutAmount: state.amount, reviewerApprovalRef: ethers.ZeroHash,
      };
    },
    async reviewer() { return submitter.address.toLowerCase(); },
    async admin() { return admin.address.toLowerCase(); },
    contract(name) {
      return name === 'DisputeManager' ? manager : { verify: async () => true };
    },
  };
  const nullifier = witnessInputs(claim, witness, '7000').nullifier;
  const baseConfig = {
    submitterKey, deployerKey: '', txTimeoutMs: 100, stateTimeoutMs: 100,
    l1: { confirmations: 1 },
  };
  const submitted = await submitProofOnL1({
    l1, caseId, claim, amount: '7000', nullifier, proof, config: baseConfig,
  });
  assert.equal(submitted.startTxHash, '0x' + 'aa'.repeat(32));
  assert.equal(submitted.proofTxHash, '0x' + 'bb'.repeat(32));
  assert.equal(state.status, 3);

  const replay = await submitProofOnL1({
    l1, caseId, claim, amount: '7000', nullifier, proof, config: baseConfig,
  });
  assert.equal(replay.proofTxHash, null);
  assert.equal(replay.startTxHash, null);

  await assert.rejects(() => submitProofOnL1({
    l1, caseId, claim, amount: '7000', nullifier, proof,
    config: { ...baseConfig, submitterKey: deployerKey },
  }), /not DisputeManager.reviewer/);

  const deployingReviewer = {
    ...l1,
    async reviewer() { return new ethers.Wallet(deployerKey).address.toLowerCase(); },
    async admin() { return admin.address.toLowerCase(); },
  };
  await assert.rejects(() => submitProofOnL1({
    l1: deployingReviewer, caseId, claim, amount: '7000', nullifier, proof,
    config: { ...baseConfig, submitterKey: deployerKey, deployerKey },
  }), /not the deployer key/);
});

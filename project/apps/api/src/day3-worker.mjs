/**
 * Day 3 backend worker.
 *
 *  - Watch ServiceOrderManager.ServicePurchased on the settlement chain and
 *    trigger the service executor for a confirmed paid order.
 *  - Watch the dispute-chain case trigger (CaseOpened, or the L1
 *    CaseStatusChanged(Opened) emitted after DisputeInbox ingest), run the
 *    Evidence/Policy/Resolution agents, generate the policy proof and submit it
 *    with a dedicated least-privilege reviewer/submitter key.
 *  - Persist every event in chain_events, hold a lease per case and advance
 *    checkpoints only after a batch is handled. A replay never executes twice.
 *
 * Nothing here logs private witness, service input, evidence or model output.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { pool } from './db.mjs';
import { decrypt, encrypt } from './crypto.mjs';
import { createChain } from './day2-chain.mjs';
import { createPostgresStore } from './day3-state.mjs';
import { delay, sendConfirmed, TxError } from './day3-tx.mjs';
import {
  claimStruct,
  computePayout,
  decodeEventLog,
  eventKey,
  PermanentWorkerError,
  verifyCaseClaim,
  verifyGatewayCaseOpening,
  verifyProofPublicInputs,
  verifyPurchaseEventArgs,
} from './day3-events.mjs';
import { policyAad, verifyCheckout } from './seed-policy.mjs';
import {
  digestInput,
  executeServiceOrder,
  readStoredServiceInput,
  serviceInputAad,
  validateServiceInput,
} from './service-executor.mjs';
import { mockServiceDisputePipeline, runServiceDisputePipeline } from '@warranty/agents';

const root = new URL('../../../', import.meta.url);
const localPath = (url) => fileURLToPath(url);
const defaultManifest = localPath(new URL('.runtime/day2/day2-local.json', root));

const SERVICE_WORKER = 'service-purchased';
const CASE_WORKER = 'case-opened';
const GATEWAY_WORKER = 'gateway-case-opened';
const ANALYSIS_AAD = (caseId) => 'case-analysis:' + String(caseId).toLowerCase();

function positiveInt(value, fallback, label, { min = 1 } = {}) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min) throw new Error(label + ' must be an integer >= ' + min);
  return number;
}

export function configFromEnv(overrides = {}) {
  return {
    service: {
      rpcUrl: process.env.DAY3_SERVICE_RPC_URL || process.env.DAY2_RPC_URL
        || process.env.FUJI_RPC_URL || 'http://127.0.0.1:8545',
      manifestPath: process.env.DAY3_SERVICE_MANIFEST || process.env.DAY2_CONTRACTS_FILE
        || defaultManifest,
      confirmations: positiveInt(process.env.DAY3_CONFIRMATIONS ?? process.env.DAY2_CONFIRMATIONS,
        1, 'DAY3_CONFIRMATIONS'),
    },
    l1: {
      rpcUrl: process.env.DAY3_L1_RPC_URL || process.env.DISPUTE_L1_RPC_URL
        || process.env.DAY2_RPC_URL || 'http://127.0.0.1:8545',
      manifestPath: process.env.DAY3_L1_MANIFEST || process.env.DAY2_CONTRACTS_FILE
        || defaultManifest,
      confirmations: positiveInt(process.env.DAY3_L1_CONFIRMATIONS
        ?? process.env.DAY2_CONFIRMATIONS, 1, 'DAY3_L1_CONFIRMATIONS'),
    },
    pollMs: positiveInt(process.env.DAY3_POLL_MS, 5_000, 'DAY3_POLL_MS', { min: 500 }),
    lookback: positiveInt(process.env.DAY3_LOOKBACK_BLOCKS, 500, 'DAY3_LOOKBACK_BLOCKS'),
    startBlock: process.env.DAY3_START_BLOCK ? positiveInt(process.env.DAY3_START_BLOCK, 0, 'DAY3_START_BLOCK', { min: 0 }) : null,
    maxAttempts: positiveInt(process.env.DAY3_MAX_ATTEMPTS, 5, 'DAY3_MAX_ATTEMPTS'),
    leaseSeconds: positiveInt(process.env.DAY3_LEASE_SECONDS, 120, 'DAY3_LEASE_SECONDS'),
    batchSize: positiveInt(process.env.DAY3_BATCH_SIZE, 20, 'DAY3_BATCH_SIZE'),
    aiMode: process.env.DAY3_AI_MODE || process.env.DAY2_AI_MODE || 'openrouter',
    agentId: process.env.DAY3_SERVICE_AGENT_ID || ethers.id('document-summary'),
    inputText: process.env.DAY3_SERVICE_INPUT_TEXT || '',
    inputFile: process.env.DAY3_SERVICE_INPUT_FILE || '',
    evidenceText: process.env.DAY3_EVIDENCE_TEXT || '',
    evidenceFile: process.env.DAY3_EVIDENCE_FILE || '',
    caseEvent: process.env.DAY3_CASE_EVENT || '',
    gatewayCaseEvent: process.env.DAY3_GATEWAY_CASE_EVENT || '',
    submitterKey: process.env.DAY3_SUBMITTER_PRIVATE_KEY || '',
    deployerKey: process.env.PRIVATE_KEY || '',
    txTimeoutMs: positiveInt(process.env.DAY3_TX_TIMEOUT_MS, 120_000, 'DAY3_TX_TIMEOUT_MS'),
    stateTimeoutMs: positiveInt(process.env.DAY3_STATE_TIMEOUT_MS, 15_000, 'DAY3_STATE_TIMEOUT_MS'),
    noSubmit: false,
    ...overrides,
  };
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(label + ' not found: ' + file);
    throw new Error('Cannot read ' + label + ': ' + error.message);
  }
}

export async function openChains(config) {
  const [serviceManifest, l1Manifest] = await Promise.all([
    readJson(config.service.manifestPath, 'service manifest'),
    readJson(config.l1.manifestPath, 'dispute L1 manifest'),
  ]);
  const [service, l1] = await Promise.all([
    createChain({
      manifest: serviceManifest, rpcUrl: config.service.rpcUrl,
      confirmations: config.service.confirmations,
    }),
    createChain({
      manifest: l1Manifest, rpcUrl: config.l1.rpcUrl,
      confirmations: config.l1.confirmations,
    }),
  ]);
  return { service, l1, serviceManifest, l1Manifest };
}

/**
 * Claim the event, run the handler once, and record processed/skipped/failed.
 * A transient failure is left retryable and the caller must not advance the
 * block checkpoint past it.
 */
export async function processChainEvent({
  store, event, worker, handler, maxAttempts = 5, logger = () => {},
}) {
  const claim = await store.claimEvent({ ...event, worker, maxAttempts });
  if (claim.action === 'skip') return { status: 'skipped', reason: claim.reason };
  if (claim.action === 'dead') {
    await store.finishEvent(event.eventKey, 'skipped', 'max attempts exceeded');
    logger({ event: 'event-dead', eventKey: event.eventKey, attempts: claim.attempts });
    return { status: 'skipped', reason: 'max attempts exceeded' };
  }
  try {
    const result = await handler();
    await store.finishEvent(event.eventKey, 'processed');
    return { status: 'processed', result };
  } catch (error) {
    if (error instanceof PermanentWorkerError || error.permanent === true) {
      await store.finishEvent(event.eventKey, 'skipped', error.message);
      logger({ event: 'event-skipped', eventKey: event.eventKey, reason: error.message });
      return { status: 'skipped', reason: error.message };
    }
    await store.finishEvent(event.eventKey, 'failed', error.message);
    logger({ event: 'event-failed', eventKey: event.eventKey, reason: error.message });
    throw error;
  }
}

async function prepareOrder({ orderId, chain, store, config }) {
  const order = await chain.order(orderId);
  if (!order) throw new PermanentWorkerError('Order is not confirmed on chain: ' + orderId);
  if (order.warranty) throw new PermanentWorkerError('Warranty order is not a service order');
  if (order.status !== 1) {
    return { order, execution: { status: 'ignored', reason: 'order status ' + order.status } };
  }
  if (config.agentId && order.agentId.toLowerCase() !== String(config.agentId).toLowerCase()) {
    return { order, execution: { status: 'ignored', reason: 'agent is not handled by this worker' } };
  }
  const listing = await chain.listing(order.agentId);
  if (!listing) throw new PermanentWorkerError('Agent listing is not active/approved');
  if (store.persistCheckoutPolicy) {
    await store.saveOrder(order, order.buyer);
    await store.persistCheckoutPolicy(order);
  }
  const policyRow = await store.getPolicy(orderId);
  if (!policyRow) {
    // The purchase may be observed before the operator seeds the private
    // policy. Keep this retryable so a later seed can still deliver the order.
    throw new Error('No encrypted service policy for order; run seed:staging and migrate');
  }
  const policy = decrypt(policyRow.ciphertext, process.env.AES_KEY_HEX, policyAad(orderId));
  let verified;
  try {
    verified = verifyCheckout({ listing, order, policy });
  } catch (error) {
    throw new PermanentWorkerError('Checkout validation failed: ' + error.message);
  }
  if (String(policyRow.commitment).toLowerCase() !== verified.commitment ||
      String(policyRow.policy_version_hash).toLowerCase() !== verified.policyVersionHash) {
    throw new PermanentWorkerError('Stored policy record does not match the on-chain checkout');
  }
  await store.saveListing(listing);
  await store.saveOrder(order, order.buyer);
  return { order, listing, policy, verified };
}

function pickDemoInput(data, orderId) {
  if (typeof data === 'string') return { text: data };
  if (data && typeof data === 'object') {
    const direct = data[orderId];
    if (typeof direct === 'string') return { text: direct };
    if (direct && typeof direct.text === 'string') return { text: direct.text };
    if (typeof data.text === 'string') return { text: data.text };
    if (data.orders && typeof data.orders[orderId] === 'string') return { text: data.orders[orderId] };
  }
  throw new PermanentWorkerError('Demo service input has no entry for ' + orderId);
}

export async function resolveServiceInput({ store, orderId, config }) {
  const row = await store.getServiceRequest(orderId);
  if (row) return readStoredServiceInput(row, orderId);
  if (config.serviceInput) return validateServiceInput(config.serviceInput);
  if (config.inputText) {
    return validateServiceInput({ text: String(config.inputText).replaceAll('{{orderId}}', orderId) });
  }
  if (config.inputFile) {
    let raw;
    try {
      raw = await readFile(config.inputFile, 'utf8');
    } catch (error) {
      throw new Error('Cannot read DAY3_SERVICE_INPUT_FILE: ' + error.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return validateServiceInput(pickDemoInput(parsed, orderId));
  }
  return null;
}

async function defaultExecute({ order, input, mode }) {
  return executeServiceOrder({ pool, order, input, mode });
}

export async function processServicePurchase({
  args, chain, store, config, execute = defaultExecute, logger = () => {}, verifyEvent = true,
}) {
  const prepared = await prepareOrder({
    orderId: String(args.orderId).toLowerCase(), chain, store, config,
  });
  if (prepared.execution) return prepared.execution;
  if (verifyEvent) verifyPurchaseEventArgs(args, prepared.verified);
  const input = await resolveServiceInput({ store, orderId: prepared.order.orderId, config });
  if (!input) {
    logger({ event: 'service-awaiting-input', orderId: prepared.order.orderId });
    return { status: 'awaiting-input' };
  }
  if (!await store.getServiceRequest(prepared.order.orderId)) {
    // Persist demo/env input once so a crash or a transient executor failure
    // can be retried from the database, not from a mutable environment.
    await store.saveServiceRequest({
      orderId: prepared.order.orderId,
      buyer: prepared.order.buyer,
      inputHash: digestInput(input),
      ciphertext: encrypt(input, process.env.AES_KEY_HEX, serviceInputAad(prepared.order.orderId)),
      source: 'demo',
    });
  }
  const result = await execute({ order: prepared.order, input, mode: config.aiMode });
  return {
    status: result.status === 'DELIVERED' ? 'delivered' : String(result.status).toLowerCase(),
    resultHash: result.resultHash ?? null,
  };
}

export async function processOrderById({ orderId, chain, store, config, execute, logger }) {
  return processServicePurchase({
    args: { orderId },
    chain, store, config, execute, logger,
    // Direct order execution skips event-vs-order matching; the chain read is
    // still validated against the stored policy by prepareOrder.
    verifyEvent: false,
  });
}

export async function pollServicePurchases({
  chain, store, config, execute, logger = () => {},
}) {
  if (!chain.has('ServiceOrderManager')) throw new Error('service manifest has no ServiceOrderManager');
  const manager = chain.contract('ServiceOrderManager');
  const address = String(manager.target);
  const latest = await chain.provider.getBlockNumber();
  const safeBlock = latest - (config.service.confirmations - 1);
  const checkpoint = await store.getCheckpoint(SERVICE_WORKER);
  let from = config.startBlock ?? Math.max(0, safeBlock - config.lookback + 1);
  if (checkpoint && String(checkpoint.chain_id) === String(chain.chainId)) {
    from = Number(checkpoint.block_number) + 1;
  }
  if (from > safeBlock) {
    return { worker: SERVICE_WORKER, status: 'idle', from, to: safeBlock, logs: 0 };
  }

  const logs = await manager.queryFilter(manager.filters.ServicePurchased(), from, safeBlock);
  let processed = 0;
  let skipped = 0;
  let awaiting = 0;
  let failure = null;
  for (const log of logs) {
    const args = decodeEventLog(manager.interface, log, 'ServicePurchased');
    if (!args) continue;
    const event = {
      eventKey: eventKey({
        chainId: chain.chainId, contract: address,
        txHash: log.transactionHash, logIndex: log.index ?? log.logIndex,
      }),
      chainId: chain.chainId, contract: address, eventName: 'ServicePurchased',
      blockNumber: log.blockNumber, txHash: log.transactionHash,
      logIndex: log.index ?? log.logIndex,
      payload: { orderId: String(args.orderId).toLowerCase() },
    };
    try {
      const result = await processChainEvent({
        store, event, worker: SERVICE_WORKER, maxAttempts: config.maxAttempts, logger,
        handler: () => processServicePurchase({ args, chain, store, config, execute, logger }),
      });
      if (result.status === 'skipped') skipped += 1;
      else if (result.result?.status === 'awaiting-input') awaiting += 1;
      else processed += 1;
    } catch (error) {
      failure = error;
      break;
    }
  }
  if (failure) {
    return {
      worker: SERVICE_WORKER, status: 'retry', from, to: safeBlock,
      logs: logs.length, processed, skipped, awaiting, error: failure.message,
    };
  }
  await store.setCheckpoint(SERVICE_WORKER, chain.chainId, safeBlock);
  return {
    worker: SERVICE_WORKER, status: 'ok', from, to: safeBlock,
    logs: logs.length, processed, skipped, awaiting,
  };
}

export async function processPendingServiceRequests({
  chain, store, config, execute = defaultExecute, logger = () => {},
}) {
  const orderIds = await store.pendingServiceRequests(config.batchSize);
  const results = [];
  for (const orderId of orderIds) {
    try {
      const prepared = await prepareOrder({ orderId, chain, store, config });
      if (prepared.execution) {
        results.push({ orderId, status: prepared.execution.status, reason: prepared.execution.reason });
        continue;
      }
      const input = await resolveServiceInput({ store, orderId, config });
      if (!input) {
        results.push({ orderId, status: 'awaiting-input' });
        continue;
      }
      const result = await execute({ order: prepared.order, input, mode: config.aiMode });
      results.push({ orderId, status: result.status });
    } catch (error) {
      logger({ event: 'service-request-failed', orderId, reason: error.message });
      results.push({ orderId, status: 'failed', error: error.message });
    }
  }
  return results;
}

export function resolveCaseEvent(l1, config) {
  const manager = l1.contract('DisputeManager');
  const eventName = config.caseEvent
    || (manager.interface.getEvent('CaseOpened') ? 'CaseOpened' : 'CaseStatusChanged');
  if (!manager.interface.getEvent(eventName)) {
    throw new Error('DisputeManager ABI has no ' + eventName + ' event');
  }
  return { contract: manager, eventName };
}

/**
 * The C-Chain Gateway emits CaseOpened when the buyer disputes; the L1
 * DisputeManager only emits CaseStatusChanged(Opened) after the Teleporter
 * relay ingests the claim. Watching the gateway lets the worker queue the case
 * early without pretending the L1 claim already exists.
 */
export function resolveGatewayCaseEvent(serviceChain, config = {}) {
  if (!serviceChain.has('MarketplaceGateway')) {
    if (config.gatewayCaseEvent) {
      throw new Error('DAY3_GATEWAY_CASE_EVENT is set but the manifest has no MarketplaceGateway');
    }
    return null;
  }
  const gateway = serviceChain.contract('MarketplaceGateway');
  const eventName = config.gatewayCaseEvent || 'CaseOpened';
  if (!gateway.interface.getEvent(eventName)) {
    throw new Error('MarketplaceGateway ABI has no ' + eventName + ' event');
  }
  return { contract: gateway, eventName };
}

async function ensureRelayJob({ caseId, orderId, store, config }) {
  const existing = await store.getCaseJob(caseId);
  if (existing) return existing;
  const lease = await store.startCaseJob({
    caseId, orderId, leaseSeconds: config.leaseSeconds,
  });
  if (lease.action === 'started') {
    await store.finishCaseJob(caseId, { status: 'awaiting_relay', lease_until: null });
  }
  return store.getCaseJob(caseId);
}

export async function handleCaseTrigger({
  caseId, orderId, l1, serviceChain, store, config,
  analyze, prove = proveCaseWithNoir,
  submit = submitProofOnL1, logger = () => {},
}) {
  const chainCase = await l1.claim(caseId);
  if (!chainCase) {
    if (!orderId) {
      logger({ event: 'case-missing-order', caseId });
      return { status: 'ignored', reason: 'case has no claim yet and the event has no orderId' };
    }
    await ensureRelayJob({ caseId, orderId, store, config });
    logger({ event: 'case-awaiting-relay', caseId, orderId });
    return { status: 'awaiting-relay' };
  }
  return processCaseJob({
    caseId, l1, serviceChain, store, config, analyze, prove, submit, logger,
  });
}

export async function processGatewayCaseOpened({
  args, serviceChain, l1, store, config,
  analyze, prove, submit, logger = () => {},
}) {
  const orderId = String(args.orderId).toLowerCase();
  const order = await serviceChain.order(orderId);
  const { caseId } = verifyGatewayCaseOpening({ args, order });
  await store.saveOrder(order, order.buyer).catch(() => {});
  logger({ event: 'gateway-case-opened', caseId, orderId });
  return handleCaseTrigger({
    caseId, orderId, l1, serviceChain, store, config, analyze, prove, submit, logger,
  });
}

export async function processCaseJob({
  caseId, l1, serviceChain, store, config,
  analyze, prove = proveCaseWithNoir,
  submit = submitProofOnL1, logger = () => {},
}) {
  const analyzer = analyze ?? (config.aiMode === 'mock'
    ? mockServiceDisputePipeline
    : runServiceDisputePipeline);
  const chainCase = await l1.claim(caseId);
  if (!chainCase) return { status: 'awaiting-relay' };
  if ([4, 5].includes(chainCase.status)) {
    const job = await store.getCaseJob(caseId);
    if (job && job.status !== 'submitted') {
      await store.finishCaseJob(caseId, { status: 'submitted', last_error: null });
    }
    return { status: 'submitted', reason: 'case already reviewed' };
  }
  if (chainCase.status === 6) {
    const job = await store.getCaseJob(caseId);
    if (job && job.status !== 'rejected') {
      await store.finishCaseJob(caseId, { status: 'rejected', last_error: 'reviewer rejected the case' });
    }
    return { status: 'rejected' };
  }
  if (chainCase.status === 3) {
    const job = await store.getCaseJob(caseId);
    if (job && job.status !== 'submitted') {
      await store.finishCaseJob(caseId, { status: 'submitted', last_error: null });
    }
    return { status: 'submitted', reason: 'case proof already verified' };
  }

  const order = await serviceChain.order(chainCase.orderId);
  if (!order) throw new PermanentWorkerError('Disputed order is not on the settlement chain');
  if (store.persistCheckoutPolicy) {
    await store.saveOrder(order, order.buyer);
    await store.persistCheckoutPolicy(order);
  }
  const policyRow = await store.getPolicy(chainCase.orderId);
  if (!policyRow) {
    // Seeding may lag the relayed case; keep the job retryable instead of
    // permanently rejecting a real on-chain dispute.
    throw new Error('No encrypted policy for disputed order; run seed:staging and migrate');
  }
  const witness = decrypt(policyRow.ciphertext, process.env.AES_KEY_HEX, policyAad(chainCase.orderId));
  const verified = verifyCaseClaim({
    claim: chainCase, policy: witness, order, caseStatus: chainCase.status,
  });
  await store.saveOrder(order, order.buyer).catch(() => {});
  await store.saveCase(caseId, chainCase.orderId, chainCase).catch(() => {});

  const lease = await store.startCaseJob({
    caseId, orderId: chainCase.orderId, leaseSeconds: config.leaseSeconds,
  });
  if (lease.action !== 'started') return { status: lease.action };

  const existing = await store.getCaseJob(caseId);
  try {
    if (existing?.proof && existing?.payout_amount && existing?.nullifier) {
      const proofRef = ethers.keccak256(existing.proof);
      const current = await l1.claim(caseId);
      if (current.status === 3) {
        if (String(current.proofRef).toLowerCase() !== proofRef) {
          throw new PermanentWorkerError('A different proof is already verified for this case');
        }
        await store.finishCaseJob(caseId, { status: 'submitted', last_error: null });
        return { status: 'submitted', resumed: true, proofHash: proofRef };
      }
      if (config.noSubmit) {
        return { status: 'proved', resumed: true, proofHash: proofRef };
      }
      const submitted = await submit({
        l1, caseId, claim: verified.claim, amount: String(existing.payout_amount),
        nullifier: String(existing.nullifier), proof: existing.proof, config, logger,
      });
      await store.finishCaseJob(caseId, {
        status: 'submitted', start_tx_hash: submitted.startTxHash ?? existing.start_tx_hash,
        proof_tx_hash: submitted.proofTxHash ?? existing.proof_tx_hash, last_error: null,
      });
      return { status: 'submitted', resumed: true, ...submitted };
    }

    const evidence = await resolveCaseEvidence({ store, caseId, config });
    if (!evidence) {
      await store.finishCaseJob(caseId, { status: 'awaiting_evidence', lease_until: null });
      logger({ event: 'case-awaiting-evidence', caseId });
      return { status: 'awaiting-evidence' };
    }
    const evidenceHash = createHash('sha256').update(evidence.text).digest('hex');
    const pipeline = await analyzer({
      text: evidence.text, claim: verified.claim, policy: verified.witness,
    });
    const payout = computePayout({
      analysis: pipeline.analysis, resolution: pipeline.resolution,
      maxRefund: verified.witness.maxRefund, lockedAmount: verified.claim.lockedAmount,
    });
    const sealedAnalysis = encrypt(
      { mode: config.aiMode, evidenceHash, evidence: pipeline.evidence,
        analysis: pipeline.analysis, resolution: pipeline.resolution },
      process.env.AES_KEY_HEX, ANALYSIS_AAD(caseId));
    await store.finishCaseJob(caseId, {
      status: 'analyzing', evidence_hash: evidenceHash,
      analysis_ciphertext: sealedAnalysis, last_error: null,
    });
    if (payout === '0') {
      await store.finishCaseJob(caseId, { status: 'rejected', payout_amount: '0', lease_until: null });
      return { status: 'rejected', reason: 'policy recommendation is zero' };
    }

    const proofData = await prove(verified.claim, verified.witness, payout);
    const checked = verifyProofPublicInputs({
      publicInputs: proofData.publicInputs, claim: verified.claim, payout,
    });
    const proofHash = ethers.keccak256(proofData.proof);
    await store.finishCaseJob(caseId, {
      status: 'proved', payout_amount: checked.payout, nullifier: checked.nullifier,
      proof_hash: proofHash, proof: proofData.proof, last_error: null,
    });
    if (config.noSubmit) {
      logger({ event: 'case-proved', caseId, payout: checked.payout, proofHash });
      return { status: 'proved', payout: checked.payout, nullifier: checked.nullifier, proofHash };
    }
    const submitted = await submit({
      l1, caseId, claim: verified.claim, amount: checked.payout,
      nullifier: checked.nullifier, proof: proofData.proof, config, logger,
    });
    await store.finishCaseJob(caseId, {
      status: 'submitted', start_tx_hash: submitted.startTxHash ?? null,
      proof_tx_hash: submitted.proofTxHash ?? null, last_error: null,
    });
    logger({
      event: 'case-submitted', caseId, payout: checked.payout, proofHash,
      startTxHash: submitted.startTxHash ?? null, proofTxHash: submitted.proofTxHash ?? null,
    });
    return { status: 'submitted', ...checked, proofHash, ...submitted };
  } catch (error) {
    if (error instanceof PermanentWorkerError || error.permanent === true) {
      await store.finishCaseJob(caseId, {
        status: 'rejected', last_error: error.message, lease_until: null,
      });
      logger({ event: 'case-rejected', caseId, reason: error.message });
      return { status: 'rejected', reason: error.message };
    }
    await store.finishCaseJob(caseId, { status: 'failed', last_error: error.message });
    logger({ event: 'case-failed', caseId, reason: error.message });
    throw error;
  }
}

export async function pollCaseOpened({
  l1, serviceChain, store, config, analyze, prove, submit, logger = () => {},
}) {
  const { contract: manager, eventName } = resolveCaseEvent(l1, config);
  const address = String(manager.target);
  const latest = await l1.provider.getBlockNumber();
  const safeBlock = latest - (config.l1.confirmations - 1);
  const checkpoint = await store.getCheckpoint(CASE_WORKER);
  let from = config.startBlock ?? Math.max(0, safeBlock - config.lookback + 1);
  if (checkpoint && String(checkpoint.chain_id) === String(l1.chainId)) {
    from = Number(checkpoint.block_number) + 1;
  }
  if (from > safeBlock) {
    return { worker: CASE_WORKER, event: eventName, status: 'idle', from, to: safeBlock, logs: 0 };
  }

  const logs = await manager.queryFilter(manager.filters[eventName](), from, safeBlock);
  let processed = 0;
  let skipped = 0;
  let awaiting = 0;
  let failure = null;
  for (const log of logs) {
    const args = decodeEventLog(manager.interface, log, eventName);
    if (!args) continue;
    if (eventName === 'CaseStatusChanged' && Number(args.status) !== 1) continue;
    const caseId = String(args.caseId).toLowerCase();
    const orderId = args.orderId ? String(args.orderId).toLowerCase() : null;
    const event = {
      eventKey: eventKey({
        chainId: l1.chainId, contract: address,
        txHash: log.transactionHash, logIndex: log.index ?? log.logIndex,
      }),
      chainId: l1.chainId, contract: address, eventName,
      blockNumber: log.blockNumber, txHash: log.transactionHash,
      logIndex: log.index ?? log.logIndex,
      payload: { caseId, orderId },
    };
    try {
      const result = await processChainEvent({
        store, event, worker: CASE_WORKER, maxAttempts: config.maxAttempts, logger,
        handler: () => handleCaseTrigger({
          caseId, orderId, l1, serviceChain, store, config, analyze, prove, submit, logger,
        }),
      });
      if (result.status === 'skipped') skipped += 1;
      else if (['awaiting-relay', 'awaiting-evidence'].includes(result.result?.status)) awaiting += 1;
      else processed += 1;
    } catch (error) {
      failure = error;
      break;
    }
  }
  if (failure) {
    return {
      worker: CASE_WORKER, event: eventName, status: 'retry', from, to: safeBlock,
      logs: logs.length, processed, skipped, awaiting, error: failure.message,
    };
  }
  await store.setCheckpoint(CASE_WORKER, l1.chainId, safeBlock);
  return {
    worker: CASE_WORKER, event: eventName, status: 'ok', from, to: safeBlock,
    logs: logs.length, processed, skipped, awaiting,
  };
}

export async function pollGatewayCaseOpened({
  serviceChain, l1, store, config, analyze, prove, submit, logger = () => {},
}) {
  const resolved = resolveGatewayCaseEvent(serviceChain, config);
  if (!resolved) {
    return { worker: GATEWAY_WORKER, status: 'unsupported', reason: 'manifest has no MarketplaceGateway' };
  }
  const { contract: gateway, eventName } = resolved;
  const address = String(gateway.target);
  const latest = await serviceChain.provider.getBlockNumber();
  const safeBlock = latest - (config.service.confirmations - 1);
  const checkpoint = await store.getCheckpoint(GATEWAY_WORKER);
  let from = config.startBlock ?? Math.max(0, safeBlock - config.lookback + 1);
  if (checkpoint && String(checkpoint.chain_id) === String(serviceChain.chainId)) {
    from = Number(checkpoint.block_number) + 1;
  }
  if (from > safeBlock) {
    return { worker: GATEWAY_WORKER, event: eventName, status: 'idle', from, to: safeBlock, logs: 0 };
  }

  const logs = await gateway.queryFilter(gateway.filters[eventName](), from, safeBlock);
  let processed = 0;
  let skipped = 0;
  let awaiting = 0;
  let failure = null;
  for (const log of logs) {
    const args = decodeEventLog(gateway.interface, log, eventName);
    if (!args || !args.caseId || !args.orderId) continue;
    const caseId = String(args.caseId).toLowerCase();
    const orderId = String(args.orderId).toLowerCase();
    const event = {
      eventKey: eventKey({
        chainId: serviceChain.chainId, contract: address,
        txHash: log.transactionHash, logIndex: log.index ?? log.logIndex,
      }),
      chainId: serviceChain.chainId, contract: address, eventName,
      blockNumber: log.blockNumber, txHash: log.transactionHash,
      logIndex: log.index ?? log.logIndex,
      payload: { caseId, orderId },
    };
    try {
      const result = await processChainEvent({
        store, event, worker: GATEWAY_WORKER, maxAttempts: config.maxAttempts, logger,
        handler: () => processGatewayCaseOpened({
          args, serviceChain, l1, store, config, analyze, prove, submit, logger,
        }),
      });
      if (result.status === 'skipped') skipped += 1;
      else if (result.result?.status === 'awaiting-relay') awaiting += 1;
      else processed += 1;
    } catch (error) {
      failure = error;
      break;
    }
  }
  if (failure) {
    return {
      worker: GATEWAY_WORKER, event: eventName, status: 'retry', from, to: safeBlock,
      logs: logs.length, processed, skipped, awaiting, error: failure.message,
    };
  }
  await store.setCheckpoint(GATEWAY_WORKER, serviceChain.chainId, safeBlock);
  return {
    worker: GATEWAY_WORKER, event: eventName, status: 'ok', from, to: safeBlock,
    logs: logs.length, processed, skipped, awaiting,
  };
}

export async function processPendingCaseJobs({
  l1, serviceChain, store, config, analyze, prove, submit, logger = () => {},
}) {
  const caseIds = await store.pendingCaseJobs(config.batchSize);
  const results = [];
  for (const caseId of caseIds) {
    try {
      const result = await processCaseJob({
        caseId, l1, serviceChain, store, config, analyze, prove, submit, logger,
      });
      results.push({ caseId, status: result.status });
    } catch (error) {
      logger({ event: 'case-retry-failed', caseId, reason: error.message });
      results.push({ caseId, status: 'failed', error: error.message });
    }
  }
  return results;
}

function pickEvidence(data, caseId) {
  if (typeof data === 'string') return { text: data };
  if (data && typeof data === 'object') {
    const direct = data[caseId];
    if (typeof direct === 'string') return { text: direct };
    if (direct && typeof direct.text === 'string') return { text: direct.text };
    if (typeof data.text === 'string') return { text: data.text };
    if (data.cases && typeof data.cases[caseId] === 'string') return { text: data.cases[caseId] };
  }
  throw new PermanentWorkerError('Evidence file has no entry for ' + caseId);
}

export async function resolveCaseEvidence({ store, caseId, config }) {
  const row = await store.getEvidence(caseId);
  if (row) {
    const value = decrypt(row.encrypted, process.env.AES_KEY_HEX, row.id);
    const text = typeof value === 'string' ? value : value?.text;
    if (typeof text === 'string' && text.trim()) return { text, source: 'database' };
  }
  if (config.evidenceText) return { text: String(config.evidenceText), source: 'env' };
  if (config.evidenceFile) {
    let raw;
    try {
      raw = await readFile(config.evidenceFile, 'utf8');
    } catch (error) {
      throw new Error('Cannot read DAY3_EVIDENCE_FILE: ' + error.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    const picked = pickEvidence(parsed, caseId);
    if (picked.text.trim()) return { ...picked, source: 'file' };
  }
  return null;
}

async function proveCaseWithNoir(claim, witness, payout) {
  // Imported lazily so service-only deployments do not need nargo/bb.js.
  const { proveServicePolicy } = await import('../../../services/prover/day2.mjs');
  return proveServicePolicy(claim, witness, payout);
}

export async function submitProofOnL1({
  l1, caseId, claim, amount, nullifier, proof, config, logger = () => {},
}) {
  if (!config.submitterKey) {
    throw new Error('DAY3_SUBMITTER_PRIVATE_KEY is required to submit a proof (or use --no-submit)');
  }
  const wallet = new ethers.Wallet(config.submitterKey);
  const reviewer = await l1.reviewer();
  const admin = await l1.admin('DisputeManager');
  const deployer = config.deployerKey ? new ethers.Wallet(config.deployerKey).address.toLowerCase() : null;
  if (wallet.address.toLowerCase() !== reviewer) {
    throw new PermanentWorkerError('Submitter is not DisputeManager.reviewer(); the contract only accepts the reviewer role');
  }
  if (wallet.address.toLowerCase() === admin) {
    throw new PermanentWorkerError('Submitter must not hold the DisputeManager admin role');
  }
  if (deployer && wallet.address.toLowerCase() === deployer) {
    throw new PermanentWorkerError('Submitter must be a dedicated key, not the deployer key');
  }

  const gate = l1.contract('ProofGate');
  if (!await gate.verify(claimStruct(claim), amount, nullifier, proof)) {
    throw new PermanentWorkerError('ProofGate rejected the proof for this claim');
  }
  const manager = l1.contract('DisputeManager');
  const proofHash = ethers.keccak256(proof).toLowerCase();
  let item = await l1.claim(caseId);
  let startTxHash = null;
  let proofTxHash = null;

  if (item.status === 1) {
    const started = await sendConfirmed({
      contract: manager, method: 'startAnalysis', args: [caseId], signer: wallet,
      confirmations: config.l1.confirmations, timeoutMs: config.txTimeoutMs,
      stateTimeoutMs: config.stateTimeoutMs, logger,
      before: async () => {
        const current = await l1.claim(caseId);
        if (!current || current.status < 1) throw new PermanentWorkerError('Case is not open');
      },
      applied: async () => {
        const current = await l1.claim(caseId);
        return Boolean(current && current.status >= 2);
      },
    });
    startTxHash = started.txHash ?? null;
  }

  item = await l1.claim(caseId);
  if (item.status === 2) {
    const submitted = await sendConfirmed({
      contract: manager, method: 'submitProof',
      args: [caseId, amount, nullifier, proof], signer: wallet,
      confirmations: config.l1.confirmations, timeoutMs: config.txTimeoutMs,
      stateTimeoutMs: config.stateTimeoutMs, logger,
      before: async () => {
        const current = await l1.claim(caseId);
        if (!current || current.status !== 2) throw new PermanentWorkerError('Case is not in Analyzing state');
        if (current.proofRef && current.proofRef !== ethers.ZeroHash &&
            String(current.proofRef).toLowerCase() !== proofHash) {
          throw new PermanentWorkerError('A different proof is already verified');
        }
      },
      applied: async () => {
        const current = await l1.claim(caseId);
        if (!current) return false;
        if (current.status === 3 &&
            String(current.proofRef).toLowerCase() !== proofHash) {
          throw new PermanentWorkerError('A different proof is already verified');
        }
        return current.status >= 3 && String(current.proofRef).toLowerCase() === proofHash;
      },
    });
    proofTxHash = submitted.txHash ?? null;
  } else if (item.status === 3) {
    if (String(item.proofRef).toLowerCase() !== proofHash) {
      throw new PermanentWorkerError('A different proof is already verified');
    }
  } else if (item.status > 3) {
    return { startTxHash, proofTxHash: null, status: 'already-reviewed' };
  } else {
    throw new PermanentWorkerError('Case is not in a submit-ready state');
  }

  const final = await l1.claim(caseId);
  if (!final || final.status < 3 || String(final.proofRef).toLowerCase() !== proofHash) {
    throw new TxError('Proof transaction confirmed but the case does not show the verified proof');
  }
  return { startTxHash, proofTxHash, proofRef: proofHash };
}

export async function preflight({ store, service, l1, config }) {
  const schema = await store.checkSchema();
  const missing = Object.entries(schema)
    .filter(([key, value]) => key !== 'database' && value !== true)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error('Database schema is missing: ' + missing.join(', ')
      + '. Run: npm run migrate -w @warranty/api');
  }
  if (!service.has('ServiceOrderManager')) throw new Error('service manifest has no ServiceOrderManager');
  if (!service.has('AgentRegistry')) throw new Error('service manifest has no AgentRegistry');
  if (!service.has('MerchantPolicyRegistry')) throw new Error('service manifest has no MerchantPolicyRegistry');
  if (!l1.has('DisputeManager')) throw new Error('L1 manifest has no DisputeManager');
  if (!l1.has('ProofGate')) throw new Error('L1 manifest has no ProofGate');
  if (config.aiMode === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    throw new Error('DAY3_AI_MODE=openrouter requires OPENROUTER_API_KEY on the server');
  }

  const reviewer = await l1.reviewer();
  const admin = await l1.admin('DisputeManager');
  let submitter = 'not configured (analysis only until a key is provided)';
  if (config.submitterKey) {
    const wallet = new ethers.Wallet(config.submitterKey);
    const deployer = config.deployerKey ? new ethers.Wallet(config.deployerKey).address.toLowerCase() : null;
    const issues = [];
    if (wallet.address.toLowerCase() !== reviewer) issues.push('not DisputeManager.reviewer()');
    if (wallet.address.toLowerCase() === admin) issues.push('also DisputeManager admin');
    if (deployer && wallet.address.toLowerCase() === deployer) issues.push('same as deployer key');
    const balance = await l1.provider.getBalance(wallet.address);
    submitter = {
      address: wallet.address, reviewer, admin, balanceWei: String(balance),
      issue: issues.length ? issues.join('; ') : null,
    };
    if (issues.length) {
      throw new Error('Submitter is not least-privilege: ' + issues.join('; '));
    }
  }

  return {
    database: schema.database,
    schema: { ok: true },
    service: {
      chainId: service.chainId, rpc: config.service.rpcUrl,
      confirmations: config.service.confirmations,
      orderManager: String(service.contract('ServiceOrderManager').target),
      agentRegistry: String(service.contract('AgentRegistry').target),
    },
    l1: {
      chainId: l1.chainId, rpc: config.l1.rpcUrl,
      confirmations: config.l1.confirmations,
      disputeManager: String(l1.contract('DisputeManager').target),
      proofGate: String(l1.contract('ProofGate').target),
      reviewer, admin,
    },
    submitter,
    aiMode: config.aiMode,
    caseEvent: resolveCaseEvent(l1, config).eventName,
    gatewayCaseEvent: resolveGatewayCaseEvent(service, config)?.eventName ?? null,
    noSubmit: config.noSubmit,
  };
}

function argument(argv, name) {
  const index = argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--' + name + ' requires a value');
  return value;
}

function jsonLog(entry) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
}

function usage() {
  console.log(`Day 3 worker

Usage:
  node --env-file=.env apps/api/src/day3-worker.mjs [options]

Options:
  --check              Validate DB schema, both RPCs, contracts and submitter; no writes
  --once               Process one batch and exit
  --watch              Keep polling (default)
  --service-only       Only watch ServicePurchased and pending service requests
  --cases-only         Only watch the dispute case trigger and pending case jobs
  --no-submit          Run analysis and proof generation, but stop before submitting
  --order-id 0x...     Process one order directly (validates chain/policy/input)
  --case-id 0x...      Process one dispute case directly
  --from-block N       Override the first start block for this run
  --help               Show this help

Environment: see docs/DAY3-NGUOI2.md and project/.env.example.`);
}

async function runOnce({
  service, l1, store, config, serviceOnly, casesOnly, orderId, caseId, logger,
}) {
  const summary = {};
  if (orderId) {
    summary.order = await processOrderById({
      orderId: orderId.toLowerCase(), chain: service, store, config, logger,
    });
  }
  if (caseId) {
    summary.case = await processCaseJob({
      caseId: caseId.toLowerCase(), l1, serviceChain: service, store, config, logger,
    });
  }
  if (!casesOnly) {
    summary.service = await pollServicePurchases({ chain: service, store, config, logger });
    summary.requests = await processPendingServiceRequests({
      chain: service, store, config, logger,
    });
  }
  if (!serviceOnly) {
    summary.gatewayCases = await pollGatewayCaseOpened({
      serviceChain: service, l1, store, config, logger,
    });
    summary.cases = await pollCaseOpened({
      l1, serviceChain: service, store, config, logger,
    });
    summary.caseJobs = await processPendingCaseJobs({
      l1, serviceChain: service, store, config, logger,
    });
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const check = argv.includes('--check');
  const once = check || argv.includes('--once') || argv.includes('--order-id') || argv.includes('--case-id');
  const serviceOnly = argv.includes('--service-only');
  const casesOnly = argv.includes('--cases-only');
  if (serviceOnly && casesOnly) throw new Error('--service-only and --cases-only are mutually exclusive');
  const config = configFromEnv({
    noSubmit: argv.includes('--no-submit'),
    startBlock: argument(argv, 'from-block') ? positiveInt(argument(argv, 'from-block'), 0, '--from-block', { min: 0 }) : configFromEnv().startBlock,
  });
  const chains = await openChains(config);
  const store = createPostgresStore(pool);
  const logger = jsonLog;

  if (check) {
    const report = await preflight({ store, service: chains.service, l1: chains.l1, config });
    console.log(JSON.stringify({ status: 'checked', ...report }, null, 2));
    return 0;
  }

  if (once) {
    const summary = await runOnce({
      ...chains, store, config, serviceOnly, casesOnly,
      orderId: argument(argv, 'order-id'), caseId: argument(argv, 'case-id'), logger,
    });
    console.log(JSON.stringify({ status: 'once', ...summary }, null, 2));
    return 0;
  }

  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  logger({ event: 'worker-start', pollMs: config.pollMs, serviceOnly, casesOnly, noSubmit: config.noSubmit });
  while (running) {
    try {
      const summary = await runOnce({
        ...chains, store, config, serviceOnly, casesOnly, logger,
      });
      logger({ event: 'worker-tick', ...summary });
    } catch (error) {
      logger({ event: 'worker-tick-failed', reason: error.message });
      if (process.env.DAY3_DEBUG === '1' && error.stack) console.error(error.stack);
    }
    if (running) await delay(config.pollMs);
  }
  logger({ event: 'worker-stop' });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error('Day 3 worker failed: ' + error.message);
    if (process.env.DAY3_DEBUG === '1') {
      if (error.cause?.message) console.error('Cause: ' + error.cause.message);
      if (error.stack) console.error(error.stack);
    }
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

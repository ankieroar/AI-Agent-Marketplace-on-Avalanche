import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';

const manifestFile = new URL('../../../.runtime/day2/day2-local.json', import.meta.url);
const catalogIds = () => (process.env.DAY2_AGENT_IDS ?? ethers.id('document-summary'))
  .split(',').map(id => id.trim().toLowerCase()).filter(Boolean);

export class ApiError extends Error {
  constructor(status, message, options) { super(message, options); this.status = status; }
}

function normalizeOrder(id, o, policy) {
  return {
    orderId: id, agentId: o.agentId, buyer: o.buyer.toLowerCase(), seller: o.seller.toLowerCase(),
    priceWei: String(o.priceWei), status: Number(o.status), caseId: o.caseId, warranty: o.warranty,
    policyCommitment: policy?.commitment ?? null, policyVersionHash: policy?.version ?? null,
    purchaseTimestamp: policy ? String(policy.purchaseTimestamp) : null,
    claimDeadline: policy ? String(policy.claimDeadline) : null,
  };
}

/**
 * Build a chain reader from an explicit manifest/RPC pair. The Day 2 API uses
 * one settlement chain; the Day 3 worker uses two instances (Fuji C-Chain and
 * Dispute L1) with independent manifests, RPCs and confirmation depths.
 */
export async function createChain({ manifest, rpcUrl, confirmations = 1 }) {
  if (!manifest?.chainId) throw new Error('manifest is missing chainId');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(manifest.chainId)) {
    throw new Error(`wrong chain: manifest expects ${manifest.chainId}, RPC returned ${network.chainId}`);
  }
  const depth = Number(confirmations);
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error('invalid confirmations');

  const cache = new Map();
  const has = (name) => Boolean(manifest.contracts?.[name]?.address && manifest.contracts?.[name]?.abi);
  const contract = (name) => {
    if (cache.has(name)) return cache.get(name);
    const item = manifest.contracts?.[name];
    if (!item?.address || !item?.abi) {
      throw new Error('manifest is missing ' + name + ' address/ABI');
    }
    const instance = new ethers.Contract(item.address, item.abi, provider);
    cache.set(name, instance);
    return instance;
  };

  const listingFor = async (agentId) => {
    const agents = contract('AgentRegistry');
    const a = await agents.getAgent(agentId);
    if (!a.active || !(await agents.approvedSeller(a.seller))) return null;
    return {
      agentId, seller: a.seller, active: true, priceWei: String(a.priceWei),
      metadataURI: a.metadataURI, policyVersionHash: a.policyVersionHash,
      disputeWindow: String(a.disputeWindow),
    };
  };

  const scopeContract = has('ServiceOrderManager') ? 'ServiceOrderManager'
    : has('DisputeManager') ? 'DisputeManager' : null;
  if (!scopeContract) throw new Error('manifest has neither ServiceOrderManager nor DisputeManager');
  const scope = String(network.chainId) + ':' + String(contract(scopeContract).target).toLowerCase();

  return {
    chainId: String(network.chainId),
    scope,
    manifest,
    provider,
    contract,
    has,
    listing: listingFor,
    async agents() {
      const listings = await Promise.all(catalogIds().map(listingFor));
      return listings.filter(Boolean);
    },
    async order(id) {
      if (!has('ServiceOrderManager')) throw new Error('manifest has no ServiceOrderManager');
      const orders = contract('ServiceOrderManager');
      const blockTag = (await provider.getBlockNumber()) - (depth - 1);
      if (blockTag < 0) return null;
      const [confirmed, latest] = await Promise.all([
        orders.orders(id, { blockTag }), orders.orders(id),
      ]);
      if (Number(confirmed.status) === 0 || Number(latest.status) === 0) return null;
      const policies = has('MerchantPolicyRegistry') ? contract('MerchantPolicyRegistry') : null;
      const policy = policies ? await policies.policies(id) : null;
      return normalizeOrder(id, latest, policy);
    },
    async claim(id) {
      const disputes = contract('DisputeManager');
      const item = await disputes.getCase(id);
      if (!Number(item.status)) return null;
      const c = item.claim;
      return {
        caseId: c.caseId, orderId: c.orderId, policyCommitment: c.policyCommitment,
        policyVersionHash: c.policyVersionHash, sourceBlockchainId: c.sourceBlockchainId,
        claimTimestamp: String(c.claimTimestamp), purchaseTimestamp: String(c.purchaseTimestamp),
        claimDeadline: String(c.claimDeadline), nonce: String(c.nonce),
        lockedAmount: String(c.lockedAmount), status: Number(item.status),
        payoutAmount: String(item.payoutAmount), proofRef: item.proofRef,
        reviewerApprovalRef: item.reviewerApprovalRef,
      };
    },
    async reviewer() {
      return String(await contract('DisputeManager').reviewer()).toLowerCase();
    },
    async admin(name = scopeContract) {
      return String(await contract(name).admin()).toLowerCase();
    },
  };
}

export async function day2Chain() {
  if (process.env.DAY2_CHAIN_MODE === 'mock') {
    return mockChain();
  }
  try {
    const manifest = JSON.parse(await readFile(process.env.DAY2_CONTRACTS_FILE || manifestFile, 'utf8'));
    return await createChain({
      manifest,
      rpcUrl: process.env.DAY2_RPC_URL || 'http://127.0.0.1:8545',
      confirmations: Number(process.env.DAY2_CONFIRMATIONS || 1),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'Contracts unavailable. Check DAY2_RPC_URL, DAY2_CONTRACTS_FILE and the deployed Day 2 manifest.', { cause: error });
  }
}

/**
 * Dispute L1 reader. On local both chains share one manifest/RPC; on staging
 * the L1 manifest and RPC are separate from the Fuji settlement chain.
 */
export async function day2CaseChain() {
  if (process.env.DAY2_CHAIN_MODE === 'mock') {
    return mockChain();
  }
  try {
    const manifest = JSON.parse(await readFile(
      process.env.DAY3_L1_MANIFEST || process.env.DAY2_CONTRACTS_FILE || manifestFile, 'utf8'));
    return await createChain({
      manifest,
      rpcUrl: process.env.DAY3_L1_RPC_URL || process.env.DISPUTE_L1_RPC_URL
        || process.env.DAY2_RPC_URL || 'http://127.0.0.1:8545',
      confirmations: Number(process.env.DAY3_L1_CONFIRMATIONS
        || process.env.DAY2_CONFIRMATIONS || 1),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'Dispute L1 contracts unavailable. Check DAY3_L1_RPC_URL and DAY3_L1_MANIFEST.', { cause: error });
  }
}

function mockChain() {
  if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'Mock chain is disabled in production');
  const listing = {
    agentId: ethers.id('document-summary'), seller: '0x1111111111111111111111111111111111111111',
    active: true, priceWei: '10000000000000000', metadataURI: 'ipfs://demo/document-summary',
    policyVersionHash: ethers.id('fixture-policy'), disputeWindow: '3600',
  };
  const paid = ethers.id('day2-mock-paid'), disputed = ethers.id('day2-mock-disputed'), caseId = ethers.id('day2-mock-case');
  return {
    scope: 'mock:day2',
    async agents() { return [listing]; },
    async listing(agentId) { return agentId.toLowerCase() === listing.agentId.toLowerCase() ? listing : null; },
    async order(id) {
      if (![paid, disputed].includes(id) || !ethers.isAddress(process.env.DAY2_MOCK_BUYER ?? '')) return null;
      return {
        orderId: id, agentId: listing.agentId, buyer: process.env.DAY2_MOCK_BUYER.toLowerCase(),
        seller: listing.seller, priceWei: listing.priceWei, status: id === paid ? 1 : 4,
        caseId: id === disputed ? caseId : ethers.ZeroHash, warranty: false,
        policyCommitment: null, policyVersionHash: null, purchaseTimestamp: null, claimDeadline: null,
      };
    },
    async claim(id) {
      return id === caseId ? {
        caseId, orderId: disputed, status: 1, policyCommitment: null, policyVersionHash: null,
        claimTimestamp: '0', purchaseTimestamp: '0', claimDeadline: '0', nonce: '0', lockedAmount: '0',
        payoutAmount: '0', proofRef: ethers.ZeroHash, reviewerApprovalRef: ethers.ZeroHash,
      } : null;
    },
  };
}

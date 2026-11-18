import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';

const manifestFile = new URL('../../../.runtime/day2/day2-local.json',import.meta.url);
const catalogIds = () => (process.env.DAY2_AGENT_IDS ?? ethers.id('document-summary'))
  .split(',').map(id=>id.trim().toLowerCase()).filter(Boolean);

export class ApiError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
function normalizeOrder(id,o) {
  return {orderId:id,agentId:o.agentId,buyer:o.buyer.toLowerCase(),seller:o.seller.toLowerCase(),
    priceWei:String(o.priceWei),status:Number(o.status),caseId:o.caseId,warranty:o.warranty};
}

export async function day2Chain() {
  if (process.env.DAY2_CHAIN_MODE === 'mock') {
    return mockChain();
  }
  try {
    const manifest = JSON.parse(await readFile(process.env.DAY2_CONTRACTS_FILE || manifestFile,'utf8'));
    const provider = new ethers.JsonRpcProvider(process.env.DAY2_RPC_URL || 'http://127.0.0.1:8545');
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(manifest.chainId)) throw new Error('wrong chain');
    const contract = name => new ethers.Contract(manifest.contracts[name].address,manifest.contracts[name].abi,provider);
    const agents=contract('AgentRegistry'), orders=contract('ServiceOrderManager'), disputes=contract('DisputeManager');
    const confirmations=Number(process.env.DAY2_CONFIRMATIONS || 1);
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('invalid confirmations');
    return {
      scope: network.chainId+':'+(await orders.getAddress()).toLowerCase(),
      async agents() {
        const listings=await Promise.all(catalogIds().map(async agentId=>{
          const a=await agents.getAgent(agentId);
          return {agentId,seller:a.seller,active:a.active && await agents.approvedSeller(a.seller),
            priceWei:String(a.priceWei),metadataURI:a.metadataURI,policyVersionHash:a.policyVersionHash,
            disputeWindow:String(a.disputeWindow)};
        }));
        return listings.filter(a=>a.active);
      },
      async order(id) {
        const blockTag = (await provider.getBlockNumber()) - (confirmations - 1);
        if (blockTag < 0) return null;
        const [confirmed,latest] = await Promise.all([orders.orders(id,{blockTag}),orders.orders(id)]);
        if (Number(confirmed.status) === 0 || Number(latest.status) === 0) return null;
        return normalizeOrder(id,latest);
      },
      async claim(id) {
        const item = await disputes.getCase(id);
        if (!Number(item.status)) return null;
        const c=item.claim;
        return {caseId:c.caseId,orderId:c.orderId,policyCommitment:c.policyCommitment,
          policyVersionHash:c.policyVersionHash,sourceBlockchainId:c.sourceBlockchainId,
          claimTimestamp:String(c.claimTimestamp),purchaseTimestamp:String(c.purchaseTimestamp),
          claimDeadline:String(c.claimDeadline),status:Number(item.status)};
      },
    };
  } catch {
    throw new ApiError(503,'Local contracts unavailable. Keep Hardhat node running and deploy Day 2.');
  }
}

function mockChain() {
  if(process.env.NODE_ENV==='production') throw new ApiError(503,'Mock chain is disabled in production');
  const listing = {agentId:ethers.id('document-summary'),seller:'0x1111111111111111111111111111111111111111',
    active:true,priceWei:'10000000000000000',metadataURI:'ipfs://demo/document-summary',
    policyVersionHash:ethers.id('fixture-policy'),disputeWindow:'3600'};
  const paid=ethers.id('day2-mock-paid'), disputed=ethers.id('day2-mock-disputed'), caseId=ethers.id('day2-mock-case');
  return {
    scope:'mock:day2',
    async agents(){ return [listing]; },
    async order(id) {
      if (![paid,disputed].includes(id) || !ethers.isAddress(process.env.DAY2_MOCK_BUYER ?? '')) return null;
      return {orderId:id,agentId:listing.agentId,buyer:process.env.DAY2_MOCK_BUYER.toLowerCase(),
        seller:listing.seller,priceWei:listing.priceWei,status:id===paid?1:4,
        caseId:id===disputed?caseId:ethers.ZeroHash,warranty:false};
    },
    async claim(id) { return id===caseId ? {caseId,orderId:disputed,status:1} : null; },
  };
}

import { parseAbi, keccak256, stringToHex, encodeAbiParameters } from 'viem';

// --- Chain definitions ---
export const FUJI_CHAIN_ID = 43113;
export const DISPUTE_CHAIN_ID = 662831;
export const LOCAL_CHAIN_ID = 31337;

export const EXPLORERS: Record<number, { name: string; txUrl: (hash: string) => string; addressUrl: (addr: string) => string }> = {
  [FUJI_CHAIN_ID]: {
    name: 'Snowtrace Fuji',
    txUrl: (h) => `https://testnet.snowtrace.io/tx/${h}`,
    addressUrl: (a) => `https://testnet.snowtrace.io/address/${a}`,
  },
  [DISPUTE_CHAIN_ID]: {
    name: 'Dispute L1 Explorer',
    txUrl: (h) => `https://subnets-test.avax.network/dispute-l1/tx/${h}`,
    addressUrl: (a) => `https://subnets-test.avax.network/dispute-l1/address/${a}`,
  },
  [LOCAL_CHAIN_ID]: {
    name: 'Local Hardhat',
    txUrl: (h) => `#local-tx-${h}`,
    addressUrl: (a) => `#local-addr-${a}`,
  },
};

// --- Known Addresses (Defaults from Day 1 / Day 2 / Testnet) ---
export const DEFAULT_ADDRESSES = {
  fuji: {
    serviceOrderManager: (process.env.NEXT_PUBLIC_FUJI_SERVICE_ORDER_MANAGER || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    marketplaceGateway: (process.env.NEXT_PUBLIC_FUJI_MARKETPLACE_GATEWAY || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    agentRegistry: (process.env.NEXT_PUBLIC_FUJI_AGENT_REGISTRY || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    escrow: (process.env.NEXT_PUBLIC_FUJI_ESCROW || '0x0000000000000000000000000000000000000000') as `0x${string}`,
  },
  disputeL1: {
    disputeManager: (process.env.NEXT_PUBLIC_L1_DISPUTE_MANAGER || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    proofGate: (process.env.NEXT_PUBLIC_L1_PROOF_GATE || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    resultSender: (process.env.NEXT_PUBLIC_L1_RESULT_SENDER || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    verifier: '0x4e5FE516e05804bc27AE0a67d7Ce8750bd8aD955' as `0x${string}`, // Deployed Day 1 Verifier
  },
  // Local deployments change on every Hardhat restart. The Day 3 page loads the
  // real addresses from .runtime/day2/day2-local.json via /api/day3/config.
  local: {
    serviceOrderManager: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    marketplaceGateway: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    agentRegistry: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    escrow: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    disputeManager: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    resultSender: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
};

export type LocalAddresses = {
  serviceOrderManager: `0x${string}`;
  marketplaceGateway: `0x${string}`;
  agentRegistry: `0x${string}`;
  escrow: `0x${string}`;
  disputeManager: `0x${string}`;
  resultSender: `0x${string}`;
};

// --- ABIs ---
export const serviceOrderManagerAbi = parseAbi([
  'function orderIdFor(address buyer, bytes32 salt) view returns (bytes32)',
  'function purchaseService(bytes32 agentId, bytes32 salt, bytes32 commitment, uint64 validUntil, uint8 v, bytes32 r, bytes32 s) payable returns (bytes32)',
  'function accept(bytes32 id)',
  'function markDelivered(bytes32 id, bytes32 resultHash)',
  'function settleExpired(bytes32 id)',
  'function orders(bytes32 id) view returns (bytes32 agentId, address buyer, address seller, uint256 priceWei, uint8 status, bytes32 resultHash, bytes32 caseId, bool warranty)',
  'event ServicePurchased(bytes32 indexed orderId, bytes32 indexed agentId, address indexed buyer, address seller, uint256 priceWei, bytes32 policyCommitment, bytes32 policyVersionHash, uint64 purchaseTimestamp)',
  'event OrderDelivered(bytes32 indexed orderId, bytes32 resultHash)',
  'event OrderStatusChanged(bytes32 indexed orderId, uint8 status)',
]);

export const marketplaceGatewayAbi = parseAbi([
  'function openCase(bytes32 id) returns (bytes32)',
  'function sourceBlockchainId() view returns (bytes32)',
  'event CaseOpened(bytes32 indexed caseId, bytes32 indexed orderId, bytes32 policyCommitment, uint64 claimTimestamp, bytes32 policyVersionHash, bytes32 sourceBlockchainId, uint256 nonce, bytes32 messageId)',
]);

export const agentRegistryAbi = parseAbi([
  'struct Listing { address seller; uint256 priceWei; string metadataURI; bytes32 policyVersionHash; uint64 disputeWindow; bool active; }',
  'function getAgent(bytes32 agentId) view returns (Listing)',
  'function approvedSeller(address seller) view returns (bool)',
]);

export const disputeManagerAbi = parseAbi([
  'struct Claim { bytes32 caseId; bytes32 orderId; bytes32 policyCommitment; uint64 claimTimestamp; bytes32 policyVersionHash; bytes32 sourceBlockchainId; uint256 nonce; uint256 lockedAmount; uint64 purchaseTimestamp; uint64 claimDeadline; }',
  'struct Case { Claim claim; uint8 status; uint256 payoutAmount; bytes32 proofRef; bytes32 reviewerApprovalRef; }',
  'struct Resolution { bytes32 caseId; bytes32 orderId; uint8 outcomeCode; uint256 payoutAmount; bytes32 reviewerApprovalRef; bytes32 proofRef; uint256 nonce; }',
  'function reviewer() view returns (address)',
  'function getCase(bytes32 id) view returns (Case)',
  'function startAnalysis(bytes32 id)',
  'function submitProof(bytes32 id, uint256 amount, bytes32 nullifier, bytes proof)',
  'function beginReview(bytes32 id)',
  'function decide(bytes32 id, bool approve, bytes32 approvalRef)',
  'function resolutionFor(bytes32 id) view returns (Resolution)',
  'event CaseStatusChanged(bytes32 indexed caseId, uint8 status)',
  'event CaseProofVerified(bytes32 indexed caseId, uint256 payoutAmount, bytes32 proofRef, bytes32 nullifier)',
]);

export const disputeResultSenderAbi = parseAbi([
  'function sendResolution(bytes32 caseId) returns (bytes32)',
  'function sent(bytes32 caseId) view returns (bool)',
  'event CaseResolutionCommitted(bytes32 indexed caseId, bytes32 indexed orderId, uint8 outcomeCode, uint256 payoutAmount, bytes32 reviewerApprovalRef, bytes32 proofRef, uint256 nonce, bytes32 messageId)',
]);

export const settlementEscrowAbi = parseAbi([
  'function claimable(address account) view returns (uint256)',
  'function withdraw()',
]);

// --- Enums & Helpers ---
export const ORDER_STATUS_LABELS: Record<number, string> = {
  0: 'Chưa tạo (Missing)',
  1: 'Đã thanh toán (Paid)',
  2: 'Đã bàn giao kết quả (Delivered)',
  3: 'Đã chấp nhận (Accepted - Payout Seller)',
  4: 'Đang khiếu nại (Disputed)',
  5: 'Đã xử lý tranh chấp (Resolved)',
  6: 'Hết hạn (Expired)',
};

export const CASE_STATUS_LABELS: Record<number, string> = {
  0: 'Chưa có hồ sơ (Missing)',
  1: 'Đã mở hồ sơ (Opened)',
  2: 'Đang phân tích chứng cứ (Analyzing)',
  3: 'Đã xác minh ZK Proof (ProofVerified)',
  4: 'Chờ Merchant/Reviewer duyệt (MerchantReview)',
  5: 'Đã phê duyệt hoàn tiền (Approved)',
  6: 'Bị từ chối hoàn tiền (Rejected)',
};

export const DEFAULT_AGENT_ID = keccak256(stringToHex('document-summary'));
export const DEFAULT_POLICY_VERSION = keccak256(stringToHex('document-summary-policy-v1'));

export const serviceQuoteTypes = {
  ServiceQuote: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'agentId', type: 'bytes32' },
    { name: 'policyCommitment', type: 'bytes32' },
    { name: 'policyVersionHash', type: 'bytes32' },
    { name: 'priceWei', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

export function serviceQuoteDomain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: 'ServiceOrderManager',
    version: '1',
    chainId,
    verifyingContract,
  } as const;
}

export function zeroAddress(value: string) {
  return /^0x0{40}$/i.test(value);
}

export function computeCaseId(sourceBlockchainId: `0x${string}`, gatewayAddress: `0x${string}`, orderId: `0x${string}`) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
      [sourceBlockchainId, gatewayAddress, orderId]
    )
  );
}

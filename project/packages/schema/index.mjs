import { z } from 'zod';
import { AbiCoder, keccak256 } from 'ethers';
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<2n**256n);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const policySchema = z.object({purchaseTimestamp:uint,warrantyEndTimestamp:uint,maxPayout:uint,nonce:bytes32}).strict().refine(p=>BigInt(p.warrantyEndTimestamp)>=BigInt(p.purchaseTimestamp),'Invalid warranty interval');
export function policyCommitment(input) {
 const p=policySchema.parse(input);
 return keccak256(AbiCoder.defaultAbiCoder().encode(['string','uint256','uint256','uint256','bytes32'],['warranty.policy.v1',p.purchaseTimestamp,p.warrantyEndTimestamp,p.maxPayout,p.nonce]));
}
export const caseMessageSchema=z.object({version:z.literal(1),caseId:bytes32,policyCommitment:bytes32,claimTimestamp:uint,policyVersionHash:bytes32,sourceBlockchainId:bytes32,nonce:uint}).strict();
const uint64 = uint.refine(value => BigInt(value) < 2n ** 64n);
export const day2CaseMessageSchema = z.object({
  caseId: bytes32,
  orderId: bytes32,
  policyCommitment: bytes32,
  claimTimestamp: uint64,
  policyVersionHash: bytes32,
  sourceBlockchainId: bytes32,
  nonce: uint,
  lockedAmount: uint,
  purchaseTimestamp: uint64,
  claimDeadline: uint64,
}).strict();
export const day2ResolutionMessageSchema = z.object({
  caseId: bytes32,
  orderId: bytes32,
  outcomeCode: z.union([z.literal(1), z.literal(2)]),
  payoutAmount: uint,
  reviewerApprovalRef: bytes32,
  proofRef: bytes32,
  nonce: uint,
}).strict();
export const summaryInputSchema = z.object({text:z.string().trim().min(1).max(12000)}).strict();
export const summarySchema = z.object({
  summary:z.string().trim().min(1).max(2000),
  keyPoints:z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  caveats:z.array(z.string().trim().min(1).max(500)).max(8),
}).strict();
export const evidenceSchema=z.object({purchaseDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),faultDescription:z.string().max(2000),missingEvidence:z.array(z.string()).max(20)}).strict();
export const policyResultSchema=z.object({eligible:z.boolean(),reasons:z.array(z.string()).max(20)}).strict();
export const resolutionSchema=z.object({proposedPayout:uint,reason:z.string().max(2000),requiresHumanReview:z.literal(true)}).strict();


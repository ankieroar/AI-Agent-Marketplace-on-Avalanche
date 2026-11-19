import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { day2Chain } from './day2-chain.mjs';
import { verifyCaseClaim } from './day3-events.mjs';
import { proveServicePolicy } from '../../../services/prover/day2.mjs';

try {
  const [caseId, amount, policyFile] = process.argv.slice(2);
  if (!ethers.isHexString(caseId,32) || !policyFile) throw new Error('Usage: prove-case.mjs CASE_ID REFUND_WEI TRUSTED_POLICY_JSON');
  const chain=await day2Chain();
  const item=await chain.claim(caseId);
  if (!item?.policyCommitment || item.status>3) throw new Error('Open on-chain case not found');
  const order=await chain.order(item.orderId);
  if (!order || order.caseId!==caseId.toLowerCase() || order.status!==4 || BigInt(amount)>BigInt(order.priceWei)) {
    throw new Error('Case is not backed by the disputed order or payout exceeds escrow');
  }
  const policy=JSON.parse(await readFile(policyFile,'utf8'));
  const { claim, witness } = verifyCaseClaim({
    claim: item, policy, order, caseStatus: item.status, allowedStatuses: [1, 2, 3],
  });
  const data=await proveServicePolicy(claim,witness,amount);
  process.stdout.write(JSON.stringify(data));
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}

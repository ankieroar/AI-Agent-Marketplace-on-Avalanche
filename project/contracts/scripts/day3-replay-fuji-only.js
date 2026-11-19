const assert = require("node:assert/strict");
const {randomBytes} = require("node:crypto");
const {ethers} = require("hardhat");
const {deployDay2} = require("./day2-local-fixture");

async function main() {
  const {serviceCommitment} = await import("../../services/prover/service-policy-input.mjs");
  const {proveServicePolicy} = await import("../../services/prover/day2.mjs");
  const policy = {disputeWindow:"3600",maxRefund:"7500000000000000",nonce:"0x"+randomBytes(16).toString("hex")};
  const d = await deployDay2({sameChain:true, verifierName:"ServicePolicyUltraVerifier",
    policyCommitmentFor:(id,version)=>serviceCommitment(id,version,policy)});
  const accepted = await d.buy("accepted");
  const resultHash = ethers.id("Synthetic document summary for settlement replay");
  await d.send(d.orders.connect(d.seller).markDelivered(accepted,resultHash));
  await d.send(d.orders.connect(d.buyer).accept(accepted));
  assert.equal(await d.escrow.claimable(d.seller.address),d.price);
  const disputed = await d.buy("disputed");
  await d.send(d.orders.connect(d.seller).markDelivered(disputed,resultHash));
  const caseId = await d.open(disputed);
  const reviewer = d.manager.connect(d.reviewer);
  await d.send(reviewer.startAnalysis(caseId));
  const {claim} = await reviewer.getCase(caseId);
  const input = Object.fromEntries(Object.entries(claim.toObject()).map(([k,v])=>[k,String(v)]));
  const refund = d.price / 2n;
  const proof = await proveServicePolicy(input,policy,String(refund));
  const verified = await d.send(reviewer.submitProof(caseId,refund,proof.publicInputs[12],proof.proof));
  await d.send(reviewer.beginReview(caseId));
  await d.send(reviewer.decide(caseId,true,ethers.id("reviewed")));
  const settled = await d.send(d.sender.connect(d.reviewer).sendResolution(caseId));
  assert.equal(await d.escrow.totalLocked(),0n);
  assert.equal(await d.escrow.claimable(d.buyer.address),refund);
  assert.equal(await d.escrow.claimable(d.seller.address),2n*d.price-refund);
  await d.send(d.escrow.connect(d.buyer).withdraw());
  await d.send(d.escrow.connect(d.seller).withdraw());
  console.log({network:"Hardhat local",accepted,disputed,caseId,proofTx:verified.hash,settlementTx:settled.hash,refundWei:String(refund)});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

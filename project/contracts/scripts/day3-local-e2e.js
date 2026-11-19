// Day 3 / Person 1: narrated local end-to-end run of the two-domain wiring.
//
//   npx hardhat node                                         (terminal 1)
//   npx hardhat run scripts/day3-local-e2e.js --network localhost   (terminal 2)
//
// Uses two V2MockMessenger instances to stand in for Teleporter relays, but every contract,
// constructor argument, peer allowlist, role check and state transition is the real Day 3
// stack. The run writes manifests to .runtime/day3/deployments so you can inspect them with:
//
//   node scripts/day3-verify.js --dir .runtime/day3/deployments --local
const assert = require("node:assert/strict");
const path = require("node:path");
const hre = require("hardhat");

const {
  emptyManifest, writeManifest, deployFujiSide, deployL1Side,
  wireFuji, wireL1, inspectWiring,
} = require("./lib/day3-deploy");

const { ethers } = hre;

const quoteTypes = {
  ServiceQuote: [
    { name: "orderId", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "policyCommitment", type: "bytes32" },
    { name: "policyVersionHash", type: "bytes32" },
    { name: "priceWei", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
};

let passed = 0;
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
async function expectRevert(label, promise, fragment) {
  try {
    await promise;
  } catch (error) {
    const message = error.shortMessage || error.message || String(error);
    if (fragment && !message.includes(fragment)) {
      throw new Error(`${label}: reverted with "${message}", expected "${fragment}"`);
    }
    ok(label);
    return;
  }
  throw new Error(`${label}: transaction did not revert`);
}

async function main() {
  if (hre.network.name !== "localhost") throw new Error("Use --network localhost with `npx hardhat node` running.");
  const [admin, seller, buyer, reviewer, outsider] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const sourceBytes32 = ethers.id("local-fuji-c-chain");
  const disputeBytes32 = ethers.id("local-dispute-l1");

  console.log(`\nDay 3 local end-to-end (chain ${chainId}, admin ${admin.address})`);
  console.log("Deploying both domains with mock Teleporter messengers...\n");

  const fujiMessenger = await (await ethers.deployContract("V2MockMessenger")).waitForDeployment();
  const l1Messenger = await (await ethers.deployContract("V2MockMessenger")).waitForDeployment();

  const fujiManifest = emptyManifest({
    role: "fuji", network: "localhost", chainId: Number(chainId), blockchainId: sourceBytes32, blockchainIdBytes32: sourceBytes32,
  });
  fujiManifest.deployer = admin.address;
  const fuji = await deployFujiSide({ manifest: fujiManifest, messenger: await fujiMessenger.getAddress(), log: m => console.log(`  ${m}`) });

  const l1Manifest = emptyManifest({
    role: "dispute-l1", network: "localhost", chainId: Number(chainId), blockchainId: disputeBytes32, blockchainIdBytes32: disputeBytes32,
  });
  l1Manifest.reviewer = reviewer.address;
  l1Manifest.deployer = admin.address;
  const l1 = await deployL1Side({
    manifest: l1Manifest, messenger: await l1Messenger.getAddress(), reviewer: reviewer.address,
    verifierName: "MockServicePolicyVerifier", log: m => console.log(`  ${m}`),
  });

  console.log("\nWiring allowlists and roles...\n");
  await wireFuji({
    contracts: fuji,
    peer: {
      blockchainIdBytes32: disputeBytes32,
      inbox: await l1.inbox.getAddress(),
      sender: await l1.sender.getAddress(),
    },
    manifest: fujiManifest, log: m => console.log(`  ${m}`),
  });
  await wireL1({
    contracts: l1,
    peer: {
      blockchainIdBytes32: sourceBytes32,
      gateway: await fuji.gateway.getAddress(),
      receiver: await fuji.receiver.getAddress(),
    },
    manifest: l1Manifest, log: m => console.log(`  ${m}`),
  });

  console.log("\nChecking wiring...");
  const wiring = await inspectWiring({ fuji, l1, fujiManifest, l1Manifest });
  const broken = wiring.filter(item => !item.ok);
  assert.equal(broken.length, 0, `Broken wiring: ${broken.map(item => item.id).join(", ")}`);
  ok(`${wiring.length} wiring checks passed (peers, chain IDs, reviewer, gate, order manager)`);

  // ------------------------------------------------------------ listing + quote
  const agentId = ethers.id("document-summary");
  const version = ethers.id("document-summary-policy-v1");
  const price = ethers.parseEther("0.01");
  const disputeWindow = 3600;
  const send = async promise => (await promise).wait();

  await send(fuji.agents.setSellerApproved(seller.address, true));
  await send(fuji.agents.connect(seller).registerAgent(agentId, price, "ipfs://demo/document-summary", version, disputeWindow));
  ok("admin approved seller and seller registered the agent listing");

  async function signedQuote(label) {
    const salt = ethers.id(label);
    const orderId = await fuji.orders.orderIdFor(buyer.address, salt);
    const policyCommitment = ethers.id(`local-policy:${orderId}`);
    const validUntil = (await ethers.provider.getBlock("latest")).timestamp + 900;
    const signature = ethers.Signature.from(await seller.signTypedData(
      { name: "ServiceOrderManager", version: "1", chainId, verifyingContract: await fuji.orders.getAddress() },
      quoteTypes,
      { orderId, agentId, policyCommitment, policyVersionHash: version, priceWei: price, validUntil },
    ));
    return { orderId, policyCommitment, args: [agentId, salt, policyCommitment, validUntil, signature.v, signature.r, signature.s] };
  }

  // ------------------------------------------------------------ scenario A: buy
  const accepted = await signedQuote("accepted-order");
  await send(fuji.orders.connect(buyer).purchaseService(...accepted.args, { value: price }));
  assert.equal((await fuji.orders.orders(accepted.orderId)).status, 1n); // Paid
  assert.equal(await fuji.escrow.totalLocked(), price);
  assert.equal((await fuji.policies.policies(accepted.orderId)).commitment, accepted.policyCommitment);
  ok("purchaseService locked 0.01 AVAX and recorded the signed policy commitment");

  await send(fuji.orders.connect(seller).markDelivered(accepted.orderId, ethers.id("result-hash")));
  await send(fuji.orders.connect(buyer).accept(accepted.orderId));
  assert.equal((await fuji.orders.orders(accepted.orderId)).status, 3n); // Accepted
  assert.equal(await fuji.escrow.claimable(seller.address), price);
  ok("seller delivered, buyer accepted, escrow credited the seller exactly once");

  // ------------------------------------------------------------ scenario B: dispute + reject
  console.log("\nScenario B: buyer opens a cross-chain dispute (reject path)...\n");
  const disputed = await signedQuote("disputed-order");
  await send(fuji.orders.connect(buyer).purchaseService(...disputed.args, { value: price }));

  const openReceipt = await (await fuji.gateway.connect(buyer).openCase(disputed.orderId)).wait();
  const opened = openReceipt.logs.map(log => { try { return fuji.gateway.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === "CaseOpened");
  const caseId = opened.args.caseId;
  assert.equal((await fuji.orders.orders(disputed.orderId)).status, 4n); // Disputed
  ok(`openCase set order to Disputed and emitted case ${caseId.slice(0, 12)}...`);

  const claimPayload = await fujiMessenger.lastPayload();
  await expectRevert("claim from the wrong sender is rejected by the allowlist",
    l1Messenger.deliver(l1.inbox, sourceBytes32, outsider.address, claimPayload), "Untrusted origin");
  await expectRevert("claim from the wrong source chain is rejected by the allowlist",
    l1Messenger.deliver(l1.inbox, disputeBytes32, await fuji.gateway.getAddress(), claimPayload), "Untrusted origin");
  await send(l1Messenger.deliver(l1.inbox, sourceBytes32, await fuji.gateway.getAddress(), claimPayload));
  assert.equal((await l1.manager.getCase(caseId)).status, 1n); // Opened
  ok("authentic claim delivered to DisputeInbox and ingested as Opened");

  await expectRevert("replaying the same claim is rejected",
    l1Messenger.deliver(l1.inbox, sourceBytes32, await fuji.gateway.getAddress(), claimPayload), "BadState");
  await expectRevert("buyer cannot accept a disputed order",
    send(fuji.orders.connect(buyer).accept(disputed.orderId)), "BadState");
  await expectRevert("non-reviewer cannot start analysis",
    send(l1.manager.connect(outsider).startAnalysis(caseId)), "Unauthorized");
  await expectRevert("non-reviewer cannot send a resolution",
    send(l1.sender.connect(outsider).sendResolution(caseId)), "Only reviewer");
  ok("role checks reject outsider actions on both sides");

  const review = l1.manager.connect(reviewer);
  await send(review.startAnalysis(caseId));
  await send(review.beginReview(caseId));
  assert.equal((await l1.manager.getCase(caseId)).status, 4n); // MerchantReview
  await expectRevert("approve without a verified proof is rejected",
    send(review.decide(caseId, true, ethers.id("approval"))), "Invalid");
  await send(review.decide(caseId, false, ethers.id("approval")));
  ok("reject path: analyze -> review -> decide(false) without a ZK proof");

  await send(l1.sender.connect(reviewer).sendResolution(caseId));
  const resolutionPayload = await l1Messenger.lastPayload();
  await expectRevert("resolution from the wrong sender is rejected",
    fujiMessenger.deliver(fuji.receiver, disputeBytes32, await l1.inbox.getAddress(), resolutionPayload), "Untrusted origin");
  await send(fujiMessenger.deliver(fuji.receiver, disputeBytes32, await l1.sender.getAddress(), resolutionPayload));
  assert.equal((await fuji.orders.orders(disputed.orderId)).status, 5n); // Resolved
  ok("authentic reject resolution applied on Fuji: order Resolved, no refund");

  await expectRevert("replaying the resolution is rejected",
    fujiMessenger.deliver(fuji.receiver, disputeBytes32, await l1.sender.getAddress(), resolutionPayload), "BadState");

  // ------------------------------------------------------------ scenario C: approve with mock proof
  console.log("\nScenario C: approve path with the mock verifier (not a real ZK proof)...\n");
  const refund = price / 2n;
  const approved = await signedQuote("approved-order");
  await send(fuji.orders.connect(buyer).purchaseService(...approved.args, { value: price }));
  const approveReceipt = await (await fuji.gateway.connect(buyer).openCase(approved.orderId)).wait();
  const approvedCaseId = approveReceipt.logs.map(log => { try { return fuji.gateway.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === "CaseOpened").args.caseId;
  await send(l1Messenger.deliver(l1.inbox, sourceBytes32, await fuji.gateway.getAddress(), await fujiMessenger.lastPayload()));

  await send(review.startAnalysis(approvedCaseId));
  const { claim } = await l1.manager.getCase(approvedCaseId);
  const nullifier = ethers.toBeHex(42, 32);
  const inputs = await l1.gate.publicInputs(claim.toObject(), refund, nullifier);
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [[...inputs]]);
  await send(review.submitProof(approvedCaseId, refund, nullifier, proof));
  assert.equal((await l1.manager.getCase(approvedCaseId)).status, 3n); // ProofVerified
  await send(review.beginReview(approvedCaseId));
  await send(review.decide(approvedCaseId, true, ethers.id("approval-approved")));
  await send(l1.sender.connect(reviewer).sendResolution(approvedCaseId));
  await send(fujiMessenger.deliver(fuji.receiver, disputeBytes32, await l1.sender.getAddress(), await l1Messenger.lastPayload()));

  assert.equal((await fuji.orders.orders(approved.orderId)).status, 5n); // Resolved
  assert.equal(await fuji.escrow.claimable(buyer.address), refund);
  assert.equal(await fuji.escrow.claimable(seller.address), 2n * price + (price - refund));
  ok("proof-gated refund applied: buyer credited 0.005 AVAX, seller credited the remainder");
  await expectRevert("the same nullifier cannot be reused for a second proof",
    send(review.submitProof(approvedCaseId, refund, nullifier, proof)), "BadState");

  // ------------------------------------------------------------ persist manifests + summary
  const outputDir = path.resolve(__dirname, "..", "..", ".runtime", "day3", "deployments");
  fujiManifest.generatedAt = new Date().toISOString();
  l1Manifest.generatedAt = new Date().toISOString();
  const fujiFile = writeManifest(fujiManifest, outputDir);
  const l1File = writeManifest(l1Manifest, outputDir);

  console.log(`\n${passed} checks passed.`);
  console.log(`Manifests written to:\n  ${fujiFile}\n  ${l1File}`);
  console.log("\nVerify the same manifests read-only:");
  console.log("  node scripts/day3-verify.js --dir .runtime/day3/deployments --local");
  console.log("\nNote: V2MockMessenger replaces Teleporter locally. On testnet the same script");
  console.log("deploys against 0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf and the real relayer.");
}

main().catch(error => { console.error(`\nFAILED: ${error.message || error}`); process.exitCode = 1; });

const { ethers } = require("hardhat");
const { artifacts } = require("hardhat");
const fs = require("node:fs/promises");
const path = require("node:path");
const { deployDay2 } = require("./day2-local-fixture");

async function main() {
  const d = await deployDay2();
  const accepted = await d.buy("accept-demo");
  await d.send(d.orders.connect(d.seller).markDelivered(accepted, ethers.id("demo-result")));
  await d.send(d.orders.connect(d.buyer).accept(accepted));

  const disputed = await d.buy("dispute-demo");
  const caseId = await d.open(disputed);
  const refund = d.price / 2n;
  const nullifier = ethers.toBeHex(1, 32);
  await d.send(d.manager.connect(d.reviewer).startAnalysis(caseId));
  await d.send(d.manager.connect(d.reviewer).submitProof(caseId, refund, nullifier,
    await d.fakeProof(caseId, refund, nullifier)));
  await d.send(d.manager.connect(d.reviewer).beginReview(caseId));
  await d.send(d.manager.connect(d.reviewer).decide(caseId, true, ethers.id("demo-review")));
  await d.send(d.sender.connect(d.reviewer).sendResolution(caseId));
  await d.send(d.fujiMessenger.deliver(d.receiver, d.dispute, d.sender, await d.l1Messenger.lastPayload()));

  const addresses = Object.fromEntries(await Promise.all(Object.entries(d.contracts)
    .map(async ([name, contract]) => [name, await contract.getAddress()])));
  addresses.L1MockMessenger = await d.l1Messenger.getAddress();
  const manifest = { chainId: 31337, contracts: {} };
  for (const [name, address] of Object.entries(addresses)) {
    const artifact = await artifacts.readArtifact(name === "L1MockMessenger" ? "V2MockMessenger" : name);
    manifest.contracts[name] = { address, abi: artifact.abi };
  }
  const manifestPath = path.resolve(__dirname, "../artifacts/day2-local.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`ABI and addresses: ${manifestPath}`);
  console.log(JSON.stringify({
    chainId: 31337, addresses, accepted, disputed, caseId,
    acceptedStatus: Number((await d.orders.orders(accepted)).status),
    disputeStatus: Number((await d.orders.orders(disputed)).status),
    caseStatus: Number((await d.manager.getCase(caseId)).status),
    buyerClaimableWei: String(await d.escrow.claimable(d.buyer.address)),
    sellerClaimableWei: String(await d.escrow.claimable(d.seller.address)),
    totalLockedWei: String(await d.escrow.totalLocked()),
  }, null, 2));

  await d.send(d.escrow.connect(d.buyer).withdraw());
  await d.send(d.escrow.connect(d.seller).withdraw());
  console.log("Buyer and seller withdrew their balances.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { CHAINS, emptyManifest, readManifest, writeManifest, deployFujiSide, deployL1Side,
  wireFuji, wireL1 } = require("./lib/day3-deploy");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 43113 || network.name !== "fuji") throw Error("Select --network fuji (43113)");
  if (!process.env.DAY3_REVIEWER) throw Error("Set DAY3_REVIEWER to the reviewer's public address before deploying");
  const reviewer = ethers.getAddress(process.env.DAY3_REVIEWER);
  const seller = process.env.DAY3_SELLER ? ethers.getAddress(process.env.DAY3_SELLER) : null;
  if (reviewer === ethers.ZeroAddress) throw Error("Reviewer cannot be zero");
  const dir = path.resolve(__dirname, "../../deployments/fuji-only");
  const manifest = readManifest("fuji", dir) || emptyManifest(CHAINS.fuji);
  if (manifest.reviewer && manifest.reviewer !== reviewer) throw Error("Reviewer differs from previous deployment");
  manifest.reviewer = reviewer;
  manifest.transport = "same-chain";
  if (!manifest.contracts.FujiDisputeMessenger) {
    const messenger = await ethers.deployContract("FujiDisputeMessenger", [manifest.blockchainIdBytes32]);
    const receipt = await messenger.deploymentTransaction().wait();
    manifest.contracts.FujiDisputeMessenger = {address: await messenger.getAddress(), txHash: receipt.hash, blockNumber: receipt.blockNumber};
    writeManifest(manifest, dir);
  }
  const messenger = manifest.contracts.FujiDisputeMessenger.address;
  const options = { manifest, messenger, reviewer, log: console.log };
  try {
    const market = await deployFujiSide(options);
    if (seller && !await market.agents.approvedSeller(seller)) {
      await (await market.agents.setSellerApproved(seller, true)).wait();
    }
    const dispute = await deployL1Side(options);
    const peer = {blockchainIdBytes32: manifest.blockchainIdBytes32,
      inbox: await dispute.inbox.getAddress(), sender: await dispute.sender.getAddress(),
      gateway: await market.gateway.getAddress(), receiver: await market.receiver.getAddress()};
    await wireFuji({ ...options, contracts: market, peer });
    await wireL1({ ...options, contracts: dispute, peer });
  } finally {
    writeManifest(manifest, dir);
  }
  const runtime = JSON.parse(fs.readFileSync(path.join(dir, "fuji.json"), "utf8"));
  for (const entry of Object.values(runtime.contracts)) entry.abi = JSON.parse(fs.readFileSync(path.join(dir, entry.abi), "utf8"));
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify(runtime, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

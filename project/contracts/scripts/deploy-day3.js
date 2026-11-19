// Day 3 / Person 1: deploy the marketplace + dispute stack to the real test networks.
//
//   npx hardhat run scripts/deploy-day3.js --network disputeL1
//   npx hardhat run scripts/deploy-day3.js --network fuji
//   node scripts/day3-configure.js            # finishes allowlist/peer wiring on both sides
//   node scripts/day3-verify.js               # read-only wiring report
//
// Manifests land in project/deployments/<role>.json (+ ABI files under deployments/abi/).
// The script is resumable: every contract already present in the manifest is reused when
// it still has code, so an interrupted deployment can be retried without double spending.
const hre = require("hardhat");
const path = require("node:path");
const {
  CHAINS, MESSENGER, deploymentsDir,
  deployFujiSide, deployL1Side, wireFuji, wireL1,
  emptyManifest, readManifest, writeManifest, sameAddress,
} = require("./lib/day3-deploy");

function log(message) { console.log(message); }

function peerFromManifest(manifest) {
  if (!manifest?.contracts) return null;
  const address = name => manifest.contracts[name]?.address;
  return {
    blockchainIdBytes32: manifest.blockchainIdBytes32,
    gateway: address("MarketplaceGateway"),
    receiver: address("DisputeResultReceiver"),
    inbox: address("DisputeInbox"),
    sender: address("DisputeResultSender"),
  };
}

function printSummary(manifest, file) {
  console.log("\n==================================================");
  console.log(`Deployed ${manifest.role} (${manifest.network})`);
  console.log("==================================================");
  for (const [name, entry] of Object.entries(manifest.contracts)) {
    console.log(`  ${name.padEnd(26)} ${entry.address}`);
  }
  console.log(`\nManifest: ${file}`);
  console.log(`ABIs:     ${path.join(deploymentsDir(), "abi")}`);
}

async function main() {
  const { ethers, network } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const role = chainId === CHAINS.fuji.chainId ? "fuji"
    : chainId === CHAINS["dispute-l1"].chainId ? "dispute-l1" : null;
  if (!role) {
    throw new Error(`Unsupported chain ${chainId}. Use --network fuji (43113) or --network disputeL1 (662831).`);
  }
  if (network.name === "hardhat") {
    throw new Error("Refusing to write a testnet manifest from the in-process network. Use --network fuji/disputeL1.");
  }

  const chain = CHAINS[role];
  const previous = readManifest(role);
  const fresh = emptyManifest(chain);
  const force = process.env.DAY3_FORCE_DEPLOY === "1";

  if (previous && !force) {
    if (Number(previous.chainId) !== chain.chainId) {
      throw new Error(`Manifest ${role}.json was written for chain ${previous.chainId}, not ${chain.chainId}.`);
    }
    if (previous.blockchainIdBytes32 !== fresh.blockchainIdBytes32) {
      throw new Error(`Manifest ${role}.json has blockchain ID ${previous.blockchainIdBytes32}, `
        + `env now says ${fresh.blockchainIdBytes32}. Fix the env or redeploy with DAY3_FORCE_DEPLOY=1.`);
    }
  }

  const manifest = force
    ? { ...fresh, deployer: previous?.deployer }
    : { ...fresh, ...(previous || {}) };
  if (force) log("! DAY3_FORCE_DEPLOY=1: redeploying every contract (old addresses are abandoned).");

  const [deployer] = await ethers.getSigners();
  manifest.deployer = deployer.address;
  log(`Deploying ${role} with ${deployer.address} on chain ${chainId}`);
  log(`Teleporter messenger: ${MESSENGER}`);
  if ((await ethers.provider.getCode(MESSENGER)) === "0x") {
    throw new Error(`No code at ${MESSENGER}. Check TELEPORTER_MESSENGER / the RPC you are pointed at.`);
  }

  if (role === "fuji") {
    const contracts = await deployFujiSide({ manifest, messenger: MESSENGER, force, log });
    const l1 = readManifest("dispute-l1");
    const peer = l1 ? peerFromManifest(l1) : null;
    if (peer && !peer.inbox) throw new Error("Decoded Dispute L1 manifest has no DisputeInbox address");
    await wireFuji({ contracts, peer, manifest, log });
    if (!peer) log("! Dispute L1 manifest missing: rerun this command after deploying Dispute L1.");
  } else {
    const reviewer = process.env.DAY3_REVIEWER || process.env.REVIEWER_ADDRESS || previous.reviewer;
    if (!reviewer) {
      throw new Error("Set DAY3_REVIEWER=<address> to the arbitration wallet before deploying Dispute L1.");
    }
    if (!ethers.isAddress(reviewer)) throw new Error(`DAY3_REVIEWER is not an address: ${reviewer}`);
    if (!force && previous?.reviewer && !sameAddress(previous.reviewer, reviewer)) {
      throw new Error(`Reviewer is immutable (manifest ${previous.reviewer}, env ${reviewer}). `
        + "Redeploy with DAY3_FORCE_DEPLOY=1 to change it.");
    }
    manifest.reviewer = ethers.getAddress(reviewer);

    const verifierAddress = process.env.DAY3_VERIFIER_ADDRESS || undefined;
    const verifierName = process.env.DAY3_VERIFIER_CONTRACT || "ServicePolicyUltraVerifier";
    const contracts = await deployL1Side({
      manifest, messenger: MESSENGER, reviewer: manifest.reviewer, verifierName, verifierAddress, force, log,
    });
    const fuji = readManifest("fuji");
    const peer = fuji ? peerFromManifest(fuji) : null;
    if (peer && !peer.gateway) throw new Error("Decoded Fuji manifest has no MarketplaceGateway address");
    await wireL1({ contracts, peer, manifest, log });
    if (!peer) log("! Fuji manifest missing: rerun this command after deploying Fuji C-Chain.");
  }

  manifest.generatedAt = new Date().toISOString();
  const file = writeManifest(manifest);
  printSummary(manifest, file);

  const other = role === "fuji" ? readManifest("dispute-l1") : readManifest("fuji");
  console.log("\nNext steps:");
  if (!other) {
    console.log(role === "fuji"
      ? "  1. npx hardhat run scripts/deploy-day3.js --network disputeL1"
      : "  1. npx hardhat run scripts/deploy-day3.js --network fuji");
    console.log("  2. node scripts/day3-configure.js");
  } else {
    console.log("  1. node scripts/day3-configure.js");
  }
  console.log("  2. node scripts/day3-verify.js");
  console.log("  3. Share deployments/fuji.json + deployments/dispute-l1.json (public addresses only).");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

// Day 3 / Person 1: finish the cross-chain allowlist after both sides are deployed.
//
//   node scripts/day3-configure.js            # send any missing wiring transactions
//   node scripts/day3-configure.js --dry-run  # show what would be sent
//   node scripts/day3-configure.js --local --dir ../.runtime/day3/deployments
const path = require("node:path");
const fs = require("node:fs");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const {
  readManifest, deploymentsDir, wireFuji, wireL1, inspectWiring, sameAddress,
} = require("./lib/day3-deploy");

// Public Hardhat account #0. Only accepted with --local.
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function load(manifest, dir, provider, wallet) {
  const contracts = {};
  for (const [name, entry] of Object.entries(manifest.contracts)) {
    const abiFile = path.resolve(dir, entry.abi || path.join("abi", `${name}.json`));
    if (!fs.existsSync(abiFile)) throw new Error(`Missing ABI ${abiFile}; run the deploy script again.`);
    contracts[name] = new ethers.Contract(entry.address, JSON.parse(fs.readFileSync(abiFile, "utf8")), wallet);
  }
  return contracts;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const local = process.argv.includes("--local");
  if (dryRun) process.env.DAY3_DRY_RUN = "1";

  const dir = path.resolve(arg("--dir") || (local
    ? path.join(__dirname, "..", "..", ".runtime", "day3", "deployments")
    : deploymentsDir()));
  const fujiManifest = readManifest("fuji", dir);
  const l1Manifest = readManifest("dispute-l1", dir);
  if (!fujiManifest) throw new Error(`Missing ${path.join(dir, "fuji.json")}. Deploy fuji first.`);
  if (!l1Manifest) throw new Error(`Missing ${path.join(dir, "dispute-l1.json")}. Deploy dispute-l1 first.`);

  const key = local ? HARDHAT_KEY : process.env.PRIVATE_KEY;
  if (!key) throw new Error("PRIVATE_KEY is not set in project/.env.");
  const fujiRpc = local ? (process.env.DAY2_RPC_URL || "http://127.0.0.1:8545")
    : (process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc");
  const l1Rpc = local ? (process.env.DAY2_RPC_URL || "http://127.0.0.1:8545")
    : process.env.DISPUTE_L1_RPC_URL;
  if (!l1Rpc) throw new Error("DISPUTE_L1_RPC_URL is not set in project/.env.");

  const fujiProvider = new ethers.JsonRpcProvider(fujiRpc, undefined, { batchMaxCount: 1 });
  const l1Provider = new ethers.JsonRpcProvider(l1Rpc, undefined, { batchMaxCount: 1 });
  const fujiWallet = new ethers.Wallet(key, fujiProvider);
  const l1Wallet = new ethers.Wallet(key, l1Provider);

  const [fujiNetwork, l1Network] = await Promise.all([fujiProvider.getNetwork(), l1Provider.getNetwork()]);
  if (Number(fujiNetwork.chainId) !== Number(fujiManifest.chainId)) {
    throw new Error(`Fuji RPC chain ${fujiNetwork.chainId} != manifest ${fujiManifest.chainId}`);
  }
  if (Number(l1Network.chainId) !== Number(l1Manifest.chainId)) {
    throw new Error(`Dispute L1 RPC chain ${l1Network.chainId} != manifest ${l1Manifest.chainId}`);
  }

  const fuji = load(fujiManifest, dir, fujiProvider, fujiWallet);
  const l1 = load(l1Manifest, dir, l1Provider, l1Wallet);

  for (const [label, contract, wallet, provider] of [
    ["Fuji MerchantPolicyRegistry", fuji.MerchantPolicyRegistry, fujiWallet, fujiProvider],
    ["Dispute L1 DisputeManager", l1.DisputeManager, l1Wallet, l1Provider],
  ]) {
    const admin = await contract.admin();
    if (!sameAddress(admin, wallet.address)) {
      throw new Error(`${label} admin is ${admin}, but PRIVATE_KEY is ${wallet.address}. Use the deployer key.`);
    }
    const balance = await provider.getBalance(wallet.address);
    console.log(`${label}: admin ok, balance ${ethers.formatEther(balance)} AVAX`);
  }

  console.log(`\n${dryRun ? "DRY RUN" : "Wiring"} Fuji C-Chain -> Dispute L1`);
  await wireFuji({
    contracts: {
      policies: fuji.MerchantPolicyRegistry, escrow: fuji.SettlementEscrow, orders: fuji.ServiceOrderManager,
      gateway: fuji.MarketplaceGateway, receiver: fuji.DisputeResultReceiver,
    },
    peer: {
      blockchainIdBytes32: l1Manifest.blockchainIdBytes32,
      inbox: l1Manifest.contracts.DisputeInbox.address,
      sender: l1Manifest.contracts.DisputeResultSender.address,
    },
    manifest: fujiManifest,
    log: message => console.log(`  ${message}`),
  });

  console.log(`\n${dryRun ? "DRY RUN" : "Wiring"} Dispute L1 -> Fuji C-Chain`);
  await wireL1({
    contracts: { manager: l1.DisputeManager, inbox: l1.DisputeInbox, sender: l1.DisputeResultSender },
    peer: {
      blockchainIdBytes32: fujiManifest.blockchainIdBytes32,
      gateway: fujiManifest.contracts.MarketplaceGateway.address,
      receiver: fujiManifest.contracts.DisputeResultReceiver.address,
    },
    manifest: l1Manifest,
    log: message => console.log(`  ${message}`),
  });

  if (!dryRun) {
    const { writeManifest } = require("./lib/day3-deploy");
    writeManifest(fujiManifest, dir);
    writeManifest(l1Manifest, dir);
  }

  console.log("\nRead-only wiring report:");
  const checks = await inspectWiring({
    fuji: {
      policies: fuji.MerchantPolicyRegistry, escrow: fuji.SettlementEscrow, orders: fuji.ServiceOrderManager,
      gateway: fuji.MarketplaceGateway, receiver: fuji.DisputeResultReceiver,
    },
    l1: {
      verifier: l1.Verifier, gate: l1.ProofGate, manager: l1.DisputeManager,
      inbox: l1.DisputeInbox, sender: l1.DisputeResultSender,
    },
    fujiManifest, l1Manifest,
  });
  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed++;
    console.log(`  ${check.ok ? "PASS" : "FAIL"} ${check.id}`);
    if (!check.ok) console.log(`       actual ${check.actual} expected ${check.expected}`);
  }
  if (failed) throw new Error(`${failed} wiring check(s) failed. Run: node scripts/day3-verify.js`);
  console.log(`\nAll ${checks.length} wiring checks passed.`);

  fujiProvider.destroy();
  l1Provider.destroy();
}

main().catch(error => { console.error(`\n${error.message || error}`); process.exitCode = 1; });

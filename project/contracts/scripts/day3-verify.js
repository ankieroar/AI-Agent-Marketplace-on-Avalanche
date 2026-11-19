// Day 3 / Person 1: read-only verification of the deployed marketplace + dispute stack.
//
//   node scripts/day3-verify.js
//   node scripts/day3-verify.js --dir .runtime/day3/deployments --local
//
// Checks: RPC chain IDs, deployed bytecode, Teleporter messenger, peer allowlist in both
// directions, role wiring (reviewer/inbox/proof gate/order manager) and manifest IDs.
// Exit code 1 on any failure, so it can gate a demo or CI job.
const path = require("node:path");
const fs = require("node:fs");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { blockchainIdBytes32 } = require("./lib/day3-deploy");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function readManifest(dir, role) {
  const file = path.join(dir, `${role}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Deploy ${role} first.`);
  return { file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function load(manifest, dir, runner) {
  const contracts = {};
  for (const [name, entry] of Object.entries(manifest.contracts)) {
    const abiFile = path.resolve(dir, entry.abi || path.join("abi", `${name}.json`));
    if (!fs.existsSync(abiFile)) throw new Error(`Missing ABI ${abiFile}.`);
    contracts[name] = new ethers.Contract(entry.address, JSON.parse(fs.readFileSync(abiFile, "utf8")), runner);
  }
  return contracts;
}

async function main() {
  const local = process.argv.includes("--local");
  const dir = path.resolve(arg("--dir") || path.join(__dirname, "..", "..", "deployments"));
  const fujiRpc = local ? (process.env.DAY2_RPC_URL || "http://127.0.0.1:8545")
    : (process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc");
  const l1Rpc = local ? (process.env.DAY2_RPC_URL || "http://127.0.0.1:8545")
    : process.env.DISPUTE_L1_RPC_URL;
  if (!l1Rpc) throw new Error("DISPUTE_L1_RPC_URL is not set.");

  const fujiFile = readManifest(dir, "fuji");
  const l1File = readManifest(dir, "dispute-l1");
  const fujiManifest = fujiFile.manifest;
  const l1Manifest = l1File.manifest;

  const checks = [];
  const pass = (id, detail) => checks.push({ id, ok: true, detail });
  const fail = (id, detail) => checks.push({ id, ok: false, detail });

  const fujiProvider = new ethers.JsonRpcProvider(fujiRpc, undefined, { batchMaxCount: 1 });
  const l1Provider = new ethers.JsonRpcProvider(l1Rpc, undefined, { batchMaxCount: 1 });
  const [fujiNetwork, l1Network] = await Promise.all([fujiProvider.getNetwork(), l1Provider.getNetwork()]);

  const check = (id, ok, detail) => (ok ? pass(id, detail) : fail(id, detail));

  check(`fuji rpc chain ${fujiNetwork.chainId} == manifest ${fujiManifest.chainId}`,
    Number(fujiNetwork.chainId) === Number(fujiManifest.chainId), `rpc ${fujiRpc}`);
  check(`l1 rpc chain ${l1Network.chainId} == manifest ${l1Manifest.chainId}`,
    Number(l1Network.chainId) === Number(l1Manifest.chainId), `rpc ${l1Rpc}`);

  for (const [label, manifest] of [["fuji", fujiManifest], ["l1", l1Manifest]]) {
    check(`${label}: schema`, manifest.schema === "day3-deploy/v1", manifest.schema);
    check(`${label}: role`, manifest.role === (label === "fuji" ? "fuji" : "dispute-l1"), manifest.role);
    const expectedBytes32 = blockchainIdBytes32(manifest.blockchainId);
    check(`${label}: blockchainIdBytes32`, expectedBytes32 === manifest.blockchainIdBytes32, expectedBytes32);
    check(`${label}: teleporter messenger`, ethers.isAddress(manifest.teleporterMessenger), manifest.teleporterMessenger);
  }

  for (const [label, manifest, provider] of [
    ["fuji", fujiManifest, fujiProvider], ["l1", l1Manifest, l1Provider],
  ]) {
    const code = await provider.getCode(manifest.teleporterMessenger);
    check(`${label}: messenger has code`, code !== "0x", manifest.teleporterMessenger);
    for (const [name, entry] of Object.entries(manifest.contracts)) {
      if (!ethers.isAddress(entry.address)) { fail(`${label}: ${name} address`, entry.address); continue; }
      const deployed = await provider.getCode(entry.address);
      check(`${label}: ${name} has code`, deployed !== "0x", entry.address);
    }
  }
  check("l1: reviewer is a real address", ethers.isAddress(l1Manifest.reviewer), l1Manifest.reviewer);

  const fujiLoaded = load(fujiManifest, dir, fujiProvider);
  const l1Loaded = load(l1Manifest, dir, l1Provider);
  const fuji = {
    policies: fujiLoaded.MerchantPolicyRegistry, escrow: fujiLoaded.SettlementEscrow,
    orders: fujiLoaded.ServiceOrderManager, gateway: fujiLoaded.MarketplaceGateway,
    receiver: fujiLoaded.DisputeResultReceiver,
  };
  const l1 = {
    verifier: l1Loaded.Verifier, gate: l1Loaded.ProofGate, manager: l1Loaded.DisputeManager,
    inbox: l1Loaded.DisputeInbox, sender: l1Loaded.DisputeResultSender,
  };

  // Reuse the same wiring inspector as the deployment tests.
  const { inspectWiring } = require("./lib/day3-deploy");
  for (const result of await inspectWiring({ fuji, l1, fujiManifest, l1Manifest })) {
    check(result.id, result.ok, result.ok ? "" : `actual ${result.actual} expected ${result.expected}`);
  }

  console.log(`\nDay 3 wiring report (${local ? "local" : "testnet"})`);
  console.log(`  fuji: ${fujiFile.file}`);
  console.log(`  l1:   ${l1File.file}\n`);
  for (const result of checks) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.id}${result.detail ? `  [${result.detail}]` : ""}`);
  }
  const failed = checks.filter(result => !result.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) {
    console.log("\nNext steps:");
    console.log("  node scripts/day3-configure.js        # set missing peers/roles");
    console.log("  redeploy both sides if a locked value points at the wrong contract");
    process.exitCode = 1;
  }

  fujiProvider.destroy();
  l1Provider.destroy();
}

main().catch(error => { console.error(`\n${error.message || error}`); process.exitCode = 1; });

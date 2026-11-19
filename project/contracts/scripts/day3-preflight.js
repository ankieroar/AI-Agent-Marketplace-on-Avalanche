// Day 3 / Person 1: preflight the testnet environment before spending gas.
//
//   node scripts/day3-preflight.js              # full check (needs PRIVATE_KEY + DAY3_REVIEWER)
//   node scripts/day3-preflight.js --read-only  # only RPC, chain IDs, messenger code, IDs
//
// Exit code 1 on any failure, so it can gate the deploy step.
const path = require("node:path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { decodeCb58, MESSENGER } = require("./lib/day3-deploy");

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  const readOnly = process.argv.includes("--read-only");
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });

  const fujiRpc = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
  const l1Rpc = process.env.DISPUTE_L1_RPC_URL
    || "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc";
  add("FUJI_RPC_URL set", Boolean(fujiRpc), fujiRpc);
  add("DISPUTE_L1_RPC_URL set", Boolean(l1Rpc), l1Rpc || "missing");
  if (!l1Rpc) return report(checks);

  for (const [label, url, expected] of [
    ["fuji", fujiRpc, Number(process.env.FUJI_CHAIN_ID || 43113)],
    ["dispute-l1", l1Rpc, Number(process.env.DISPUTE_L1_CHAIN_ID || 662831)],
  ]) {
    try {
      const chainId = Number(BigInt(await rpc(url, "eth_chainId", [])));
      add(`${label} RPC chain ID ${expected}`, chainId === expected, `got ${chainId}`);
      const code = await rpc(url, "eth_getCode", [MESSENGER, "latest"]);
      add(`${label} Teleporter messenger has code`, code !== "0x", `${(code.length - 2) / 2} bytes at ${MESSENGER}`);
    } catch (error) {
      add(`${label} RPC reachable`, false, error.message);
    }
  }

  for (const [label, value] of [
    ["FUJI_BLOCKCHAIN_ID", process.env.FUJI_BLOCKCHAIN_ID || "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp"],
    ["DISPUTE_L1_BLOCKCHAIN_ID", process.env.DISPUTE_L1_BLOCKCHAIN_ID || "CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz"],
  ]) {
    try {
      const decoded = decodeCb58(value);
      add(`${label} cb58 checksum`, decoded.checksumOk, decoded.bytes32);
    } catch (error) {
      add(`${label} decodes`, false, error.message);
    }
  }

  const reviewer = process.env.DAY3_REVIEWER || process.env.REVIEWER_ADDRESS;
  if (!readOnly) {
    add("DAY3_REVIEWER set", Boolean(reviewer), reviewer || "missing (immutable after deploy)");
    add("DAY3_REVIEWER is an address", Boolean(reviewer) && ethers.isAddress(reviewer), reviewer || "");
  }

  if (!readOnly) {
    const key = process.env.PRIVATE_KEY;
    add("PRIVATE_KEY set", Boolean(key), key ? "present" : "missing");
    if (key) {
      const wallet = new ethers.Wallet(key);
      for (const [label, url] of [["fuji", fujiRpc], ["dispute-l1", l1Rpc]]) {
        try {
          const balance = BigInt(await rpc(url, "eth_getBalance", [wallet.address, "latest"]));
          add(`${label} deployer balance > 0`, balance > 0n, `${ethers.formatEther(balance)} AVAX (${wallet.address})`);
        } catch (error) {
          add(`${label} deployer balance`, false, error.message);
        }
      }
    }
  }

  report(checks);
}

function report(checks) {
  console.log(`\nDay 3 preflight${process.argv.includes("--read-only") ? " (read-only)" : ""}\n`);
  for (const check of checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.label}${check.detail ? `  [${check.detail}]` : ""}`);
  }
  const failed = checks.filter(check => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) {
    console.log("\nFix the FAIL lines in project/.env before running deploy-day3.js.");
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(`\n${error.message || error}`); process.exitCode = 1; });

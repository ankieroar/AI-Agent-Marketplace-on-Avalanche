// Shared deployment/wiring helpers for Day 3 (Person 1: Fuji C-Chain <-> Dispute L1).
// Used by scripts/deploy-day3.js, scripts/day3-configure.js and test/day3-deployment.js
// so the code exercised by the tests is the same code used for the real deployment.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers, artifacts } = require("hardhat");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_DEPLOYMENTS_DIR = path.join(PROJECT_ROOT, "deployments");
const MESSENGER = process.env.TELEPORTER_MESSENGER || "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf";
const FUJI_BLOCKCHAIN_ID = process.env.FUJI_BLOCKCHAIN_ID || "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp";
const L1_BLOCKCHAIN_ID = process.env.DISPUTE_L1_BLOCKCHAIN_ID || "CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz";

const CHAINS = {
  fuji: { role: "fuji", network: "fuji", chainId: 43113, blockchainId: FUJI_BLOCKCHAIN_ID, rpcEnv: "FUJI_RPC_URL" },
  "dispute-l1": { role: "dispute-l1", network: "disputeL1", chainId: 662831, blockchainId: L1_BLOCKCHAIN_ID, rpcEnv: "DISPUTE_L1_RPC_URL" },
};

// ---------------------------------------------------------------- chain IDs

// Avalanche cb58: base58(data || last-4-bytes-of-sha256(data)).
function decodeCb58(value) {
  if (typeof value !== "string" || value.length < 20) throw new Error("Blockchain ID must be a cb58 string");
  const raw = ethers.toBeHex(ethers.decodeBase58(value), 36);
  const bytes32 = raw.slice(0, 66);
  const checksum = raw.slice(66);
  const calculated = crypto.createHash("sha256")
    .update(Buffer.from(bytes32.slice(2), "hex")).digest().subarray(28).toString("hex");
  return { bytes32, checksumOk: calculated === checksum };
}

function blockchainIdBytes32(value) {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  const decoded = decodeCb58(value);
  if (!decoded.checksumOk) throw new Error(`Invalid cb58 checksum in blockchain ID: ${value}`);
  return decoded.bytes32;
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function isZeroAddress(value) {
  return !value || value === ethers.ZeroAddress;
}

function deploymentsDir() {
  return process.env.DAY3_DEPLOYMENTS_DIR
    ? path.resolve(process.env.DAY3_DEPLOYMENTS_DIR)
    : DEFAULT_DEPLOYMENTS_DIR;
}

function manifestPath(role, dir) {
  return path.join(dir || deploymentsDir(), `${role}.json`);
}

function readManifest(role, dir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(role, dir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function emptyManifest(chain) {
  return {
    schema: "day3-deploy/v1",
    role: chain.role,
    network: chain.network,
    chainId: chain.chainId,
    blockchainId: chain.blockchainId,
    blockchainIdBytes32: chain.blockchainIdBytes32 || blockchainIdBytes32(chain.blockchainId),
    teleporterMessenger: MESSENGER,
    generatedAt: new Date().toISOString(),
    contracts: {},
    wiring: [],
  };
}

function abiFor(name) {
  const artifact = artifacts.readArtifactSync(name);
  return artifact.abi;
}

function writeManifest(manifest, dir) {
  const target = dir || deploymentsDir();
  const abiDir = path.join(target, "abi");
  fs.mkdirSync(abiDir, { recursive: true });
  const output = { ...manifest, contracts: {} };
  for (const [name, entry] of Object.entries(manifest.contracts)) {
    let abi = entry.abiData;
    if (!abi) {
      const existing = path.resolve(target, entry.abi || path.join("abi", `${name}.json`));
      abi = fs.existsSync(existing) ? JSON.parse(fs.readFileSync(existing, "utf8")) : abiFor(name);
    }
    fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(abi, null, 2));
    output.contracts[name] = {
      address: entry.address,
      txHash: entry.txHash || null,
      blockNumber: entry.blockNumber ?? null,
      abi: `abi/${name}.json`,
    };
  }
  fs.writeFileSync(manifestPath(manifest.role, target), JSON.stringify(output, null, 2));
  return manifestPath(manifest.role, target);
}

// ---------------------------------------------------------------- deployment

async function contractAt(name, address) {
  return ethers.getContractAt(name, address);
}

async function deployOnce(name, args, manifest, options = {}) {
  const { log = () => {}, force = false, abiName = name, key = name } = options;
  const existing = manifest.contracts[key];
  if (!force && existing?.address) {
    const code = await ethers.provider.getCode(existing.address);
    if (code !== "0x") {
      log(`= ${key} ${existing.address} (reuse)`);
      return contractAt(name, existing.address);
    }
  }
  const contract = await ethers.deployContract(name, args);
  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  manifest.contracts[key] = {
    address,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    abiData: abiFor(abiName),
  };
  log(`+ ${key} ${address} (tx ${receipt.hash})`);
  return contract;
}

async function deployFujiSide({ manifest, messenger, force = false, log = () => {} }) {
  const m = messenger || MESSENGER;
  if ((await ethers.provider.getCode(m)) === "0x") {
    throw new Error(`No Teleporter messenger code at ${m}. V2MockMessenger is only for local runs.`);
  }
  manifest.teleporterMessenger = m;
  const agents = await deployOnce("AgentRegistry", [], manifest, { force, log });
  const policies = await deployOnce("MerchantPolicyRegistry", [], manifest, { force, log });
  const escrow = await deployOnce("SettlementEscrow", [], manifest, { force, log });
  const orders = await deployOnce("ServiceOrderManager",
    [await agents.getAddress(), await policies.getAddress(), await escrow.getAddress()], manifest, { force, log });
  const gateway = await deployOnce("MarketplaceGateway",
    [m, manifest.blockchainIdBytes32, await orders.getAddress()], manifest, { force, log });
  const receiver = await deployOnce("DisputeResultReceiver",
    [m, await orders.getAddress()], manifest, { force, log });
  return { agents, policies, escrow, orders, gateway, receiver };
}

async function deployL1Side({ manifest, messenger, reviewer, verifierName = "ServicePolicyUltraVerifier",
  verifierAddress, force = false, log = () => {} }) {
  const m = messenger || MESSENGER;
  if ((await ethers.provider.getCode(m)) === "0x") {
    throw new Error(`No Teleporter messenger code at ${m}. V2MockMessenger is only for local runs.`);
  }
  manifest.teleporterMessenger = m;
  if (reviewer) manifest.reviewer = reviewer;
  if (!manifest.reviewer || manifest.reviewer === ethers.ZeroAddress) {
    throw new Error("Missing reviewer address. Set DAY3_REVIEWER (or REVIEWER_ADDRESS) before deploying Dispute L1.");
  }

  let verifier;
  if (verifierAddress) {
    if ((await ethers.provider.getCode(verifierAddress)) === "0x") {
      throw new Error(`DAY3_VERIFIER_ADDRESS has no code: ${verifierAddress}`);
    }
    verifier = await contractAt(verifierName, verifierAddress);
    manifest.contracts.Verifier = {
      address: verifierAddress, txHash: null, blockNumber: null, abiData: abiFor(verifierName),
    };
    log(`= Verifier ${verifierAddress} (external)`);
  } else {
    // The generated UltraVerifier has no constructor arguments.
    verifier = await deployOnce(verifierName, [], manifest, { force, log, key: "Verifier" });
  }
  const gate = await deployOnce("ProofGate", [await verifier.getAddress()], manifest, { force, log });
  const manager = await deployOnce("DisputeManager",
    [await gate.getAddress(), manifest.reviewer], manifest, { force, log });
  const inbox = await deployOnce("DisputeInbox",
    [m, await manager.getAddress()], manifest, { force, log });
  const sender = await deployOnce("DisputeResultSender",
    [m, await manager.getAddress()], manifest, { force, log });
  return { verifier, gate, manager, inbox, sender };
}

// ---------------------------------------------------------------- wiring

function record(manifest, label, status, txHash) {
  manifest.wiring = (manifest.wiring || []).filter(item => item.label !== label);
  manifest.wiring.push({ label, status, txHash: txHash || null, at: new Date().toISOString() });
}

async function ensureValue({ label, current, expected, send, manifest, log = () => {} }) {
  if (sameAddress(current, expected)) {
    log(`= ${label} (already set)`);
    record(manifest, label, "already-set");
    return false;
  }
  if (!isZeroAddress(current)) {
    throw new Error(`${label} is ${current} but expected ${expected}. Peers/roles are locked; redeploy both sides and rewire.`);
  }
  if (process.env.DAY3_DRY_RUN === "1") {
    log(`~ ${label} would be set to ${expected}`);
    record(manifest, label, "planned");
    return false;
  }
  const tx = await send();
  const receipt = await tx.wait();
  log(`✓ ${label} (tx ${receipt.hash})`);
  record(manifest, label, "sent", receipt.hash);
  return true;
}

async function wireFuji({ contracts, peer, manifest, log = () => {} }) {
  const { policies, escrow, orders, gateway, receiver } = contracts;
  const ordersAddress = await orders.getAddress();
  await ensureValue({
    label: "MerchantPolicyRegistry.orderManager", current: await policies.orderManager(),
    expected: ordersAddress, send: () => policies.setOrderManager(ordersAddress), manifest, log,
  });
  await ensureValue({
    label: "SettlementEscrow.orderManager", current: await escrow.orderManager(),
    expected: ordersAddress, send: () => escrow.setOrderManager(ordersAddress), manifest, log,
  });

  const gatewayAddress = await gateway.getAddress();
  const receiverAddress = await receiver.getAddress();
  const currentGateway = await orders.gateway();
  const currentReceiver = await orders.resultReceiver();
  if (sameAddress(currentGateway, gatewayAddress) && sameAddress(currentReceiver, receiverAddress)) {
    log("= ServiceOrderManager.dispute (already set)");
    record(manifest, "ServiceOrderManager.dispute", "already-set");
  } else if (isZeroAddress(currentGateway) && isZeroAddress(currentReceiver)) {
    if (process.env.DAY3_DRY_RUN === "1") {
      log(`~ ServiceOrderManager.configureDispute(${gatewayAddress}, ${receiverAddress})`);
      record(manifest, "ServiceOrderManager.dispute", "planned");
    } else {
      const tx = await orders.configureDispute(gatewayAddress, receiverAddress);
      const receipt = await tx.wait();
      log(`✓ ServiceOrderManager.dispute (tx ${receipt.hash})`);
      record(manifest, "ServiceOrderManager.dispute", "sent", receipt.hash);
    }
  } else {
    throw new Error("ServiceOrderManager already has a different dispute wiring; redeploy both sides.");
  }

  if (!peer) {
    log("! Gateway peer not set: deploy Dispute L1 first, then rerun this command.");
    return;
  }
  await ensureValue({
    label: "MarketplaceGateway.peer", current: await gateway.peer(), expected: peer.inbox,
    send: () => gateway.setPeer(peer.blockchainIdBytes32, peer.inbox), manifest, log,
  });
  if (peer.sender) {
    await ensureValue({
      label: "DisputeResultReceiver.peer", current: await receiver.peer(), expected: peer.sender,
      send: () => receiver.setPeer(peer.blockchainIdBytes32, peer.sender), manifest, log,
    });
  } else {
    log("! DisputeResultReceiver peer not set: DisputeResultSender address missing from the L1 manifest.");
  }
}

async function wireL1({ contracts, peer, manifest, log = () => {} }) {
  const { manager, inbox, sender } = contracts;
  const inboxAddress = await inbox.getAddress();
  await ensureValue({
    label: "DisputeManager.inbox", current: await manager.inbox(),
    expected: inboxAddress, send: () => manager.setInbox(inboxAddress), manifest, log,
  });

  if (!peer) {
    log("! Dispute L1 peers not set: deploy Fuji C-Chain first, then rerun this command.");
    return;
  }
  await ensureValue({
    label: "DisputeInbox.peer", current: await inbox.peer(), expected: peer.gateway,
    send: () => inbox.setPeer(peer.blockchainIdBytes32, peer.gateway), manifest, log,
  });
  await ensureValue({
    label: "DisputeResultSender.peer", current: await sender.peer(), expected: peer.receiver,
    send: () => sender.setPeer(peer.blockchainIdBytes32, peer.receiver), manifest, log,
  });
}

// Read-only wiring check shared by scripts/day3-verify.js and the deployment tests.
async function inspectWiring({ fuji, l1, fujiManifest, l1Manifest }) {
  const checks = [];
  const add = (id, actual, expected) => checks.push({ id, ok: sameAddress(actual, expected), actual, expected });

  const fujiOrderManager = fujiManifest.contracts.ServiceOrderManager.address;
  const fujiGateway = fujiManifest.contracts.MarketplaceGateway.address;
  const fujiReceiver = fujiManifest.contracts.DisputeResultReceiver.address;
  const l1Manager = l1Manifest.contracts.DisputeManager.address;
  const l1Inbox = l1Manifest.contracts.DisputeInbox.address;
  const l1Sender = l1Manifest.contracts.DisputeResultSender.address;
  const l1Verifier = l1Manifest.contracts.Verifier.address;
  const fujiBytes32 = fujiManifest.blockchainIdBytes32;
  const l1Bytes32 = l1Manifest.blockchainIdBytes32;

  add("fuji: policies.orderManager", await fuji.policies.orderManager(), fujiOrderManager);
  add("fuji: escrow.orderManager", await fuji.escrow.orderManager(), fujiOrderManager);
  add("fuji: orders.gateway", await fuji.orders.gateway(), fujiGateway);
  add("fuji: orders.resultReceiver", await fuji.orders.resultReceiver(), fujiReceiver);
  add("fuji: gateway.orders", await fuji.gateway.orders(), fujiOrderManager);
  add("fuji: gateway.peer", await fuji.gateway.peer(), l1Inbox);
  add("fuji: gateway.sourceBlockchainId", await fuji.gateway.sourceBlockchainId(), fujiBytes32);
  add("fuji: gateway.peerBlockchainID", await fuji.gateway.peerBlockchainID(), l1Bytes32);
  add("fuji: receiver.orders", await fuji.receiver.orders(), fujiOrderManager);
  add("fuji: receiver.peer", await fuji.receiver.peer(), l1Sender);
  add("fuji: receiver.peerBlockchainID", await fuji.receiver.peerBlockchainID(), l1Bytes32);

  add("l1: manager.inbox", await l1.manager.inbox(), l1Inbox);
  add("l1: manager.reviewer", await l1.manager.reviewer(), l1Manifest.reviewer);
  add("l1: manager.proofGate", await l1.manager.proofGate(), l1Manifest.contracts.ProofGate.address);
  add("l1: gate.verifier", await l1.gate.verifier(), l1Verifier);
  add("l1: inbox.manager", await l1.inbox.manager(), l1Manager);
  add("l1: inbox.peer", await l1.inbox.peer(), fujiGateway);
  add("l1: inbox.peerBlockchainID", await l1.inbox.peerBlockchainID(), fujiBytes32);
  add("l1: sender.manager", await l1.sender.manager(), l1Manager);
  add("l1: sender.peer", await l1.sender.peer(), fujiReceiver);
  add("l1: sender.peerBlockchainID", await l1.sender.peerBlockchainID(), fujiBytes32);

  return checks;
}

module.exports = {
  CHAINS, MESSENGER, FUJI_BLOCKCHAIN_ID, L1_BLOCKCHAIN_ID,
  deploymentsDir, manifestPath, readManifest, writeManifest, emptyManifest,
  blockchainIdBytes32, decodeCb58,
  deployFujiSide, deployL1Side, wireFuji, wireL1, inspectWiring,
  sameAddress, isZeroAddress, abiFor,
};

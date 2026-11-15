/**
 * Native Cross-Chain AWM / Teleporter Relayer Daemon
 * Listens for cross-chain ping messages between Fuji C-Chain and Dispute L1
 * Uses resilient block polling (eth_getLogs) compatible with public Avalanche RPCs.
 */

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const FUJI_RPC = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const DISPUTE_L1_RPC = process.env.DISPUTE_L1_RPC_URL || "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PING_SENDER_ADDRESS = process.env.PING_SENDER_ADDRESS;
const PONG_RECEIVER_ADDRESS = process.env.PONG_RECEIVER_ADDRESS;
const FUJI_BLOCKCHAIN_ID = "0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5";

const PING_ABI = [
  "event PingSent(bytes32 indexed destinationBlockchainID, address indexed destinationAddress, uint256 indexed messageID, string messageText, uint256 timestamp)"
];

const PONG_ABI = [
  "function receiveTeleporterMessage(bytes32 originBlockchainID, address originSenderAddress, bytes calldata message) external",
  "event PongReceived(bytes32 indexed originBlockchainID, address indexed originSenderAddress, address indexed initialCaller, string messageText, uint256 sentTimestamp, uint256 receivedTimestamp)",
  "function totalReceivedMessages() external view returns (uint256)",
  "function lastMessage() external view returns (string)",
  "function lastCaller() external view returns (address)"
];

const processedTxs = new Set();

async function deliverMessage(fujiWallet, pongContract, destinationAddress, messageID, messageText, timestamp, txHash) {
  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`[Cross-Chain Event Detected]`);
  console.log(`  Source Chain        : Fuji C-Chain`);
  console.log(`  Message ID          : #${messageID.toString()}`);
  console.log(`  Target L1 Address   : ${destinationAddress}`);
  console.log(`  Payload             : "${messageText}"`);
  console.log(`  Timestamp           : ${new Date(Number(timestamp) * 1000).toISOString()}`);
  console.log(`  Origin Tx Hash      : ${txHash}`);

  try {
    console.log(`  -> Delivering message to Dispute L1 PongReceiver...`);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encodedPayload = abiCoder.encode(
      ["address", "string", "uint256"],
      [fujiWallet.address, messageText, timestamp]
    );

    const tx = await pongContract.receiveTeleporterMessage(
      FUJI_BLOCKCHAIN_ID,
      PING_SENDER_ADDRESS,
      encodedPayload
    );

    console.log(`  -> Delivery transaction broadcasted on Dispute L1! Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  [SUCCESS] Message confirmed on Dispute L1 in block #${receipt.blockNumber}!`);
    console.log("--------------------------------------------------------------------------------\n");
  } catch (err) {
    console.error(`  [ERROR] Delivery failed:`, err.message);
  }
}

async function startRelayer() {
  console.log("================================================================================");
  console.log("          AVALANCHE PRIVATE DISPUTE PROTOCOL - NATIVE RELAYER DAEMON           ");
  console.log("================================================================================");

  if (!PRIVATE_KEY) {
    console.error("FATAL: PRIVATE_KEY is not defined in .env! Relayer requires a key to deliver transactions.");
    process.exit(1);
  }

  const fujiProvider = new ethers.JsonRpcProvider(FUJI_RPC);
  const disputeProvider = new ethers.JsonRpcProvider(DISPUTE_L1_RPC);

  const disputeWallet = new ethers.Wallet(PRIVATE_KEY, disputeProvider);
  const fujiWallet = new ethers.Wallet(PRIVATE_KEY, fujiProvider);

  console.log(`Relayer Operator Address : ${disputeWallet.address}`);
  console.log(`Fuji C-Chain RPC         : ${FUJI_RPC}`);
  console.log(`Dispute L1 RPC           : ${DISPUTE_L1_RPC}`);
  console.log(`PingSender on C-Chain    : ${PING_SENDER_ADDRESS || "(Pending deployment)"}`);
  console.log(`PongReceiver on L1       : ${PONG_RECEIVER_ADDRESS || "(Pending deployment)"}`);
  console.log("================================================================================");

  if (!PING_SENDER_ADDRESS || !PONG_RECEIVER_ADDRESS) {
    console.log("WARNING: PING_SENDER_ADDRESS or PONG_RECEIVER_ADDRESS is missing in .env.");
    return;
  }

  const pingContract = new ethers.Contract(PING_SENDER_ADDRESS, PING_ABI, fujiProvider);
  const pongContract = new ethers.Contract(PONG_RECEIVER_ADDRESS, PONG_ABI, disputeWallet);

  let currentBlock = await fujiProvider.getBlockNumber();
  let lastCheckedBlock = Math.max(0, currentBlock - 30);
  console.log(`🛰️  Relayer active! Scanning from Fuji block #${lastCheckedBlock} onwards...`);

  async function poll() {
    try {
      const latestBlock = await fujiProvider.getBlockNumber();
      if (latestBlock >= lastCheckedBlock) {
        const events = await pingContract.queryFilter("PingSent", lastCheckedBlock, latestBlock);
        for (const ev of events) {
          const [destinationBlockchainID, destinationAddress, messageID, messageText, timestamp] = ev.args;
          await deliverMessage(fujiWallet, pongContract, destinationAddress, messageID, messageText, timestamp, ev.transactionHash);
        }
        lastCheckedBlock = latestBlock + 1;
      }
    } catch (err) {
      // Keep going on temporary RPC glitch
    }
    setTimeout(poll, 3000);
  }

  poll();
}

startRelayer().catch((err) => {
  console.error("Relayer error:", err);
});

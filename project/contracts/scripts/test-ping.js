const { ethers } = require("hardhat");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  const pingSenderAddress = process.env.PING_SENDER_ADDRESS;
  const pongReceiverAddress = process.env.PONG_RECEIVER_ADDRESS;
  const disputeL1BlockchainIdBytes32 =
    process.env.DISPUTE_L1_BLOCKCHAIN_ID_BYTES32 ||
    "0x1ac4f03783f66f0733d25e7b8df833da1d739e7b20404cd2cfd867bf1d270539";

  if (!pingSenderAddress || !pongReceiverAddress) {
    console.error("ERROR: Missing contract addresses in .env!");
    console.log("PING_SENDER_ADDRESS=" + (pingSenderAddress || "(missing)"));
    console.log("PONG_RECEIVER_ADDRESS=" + (pongReceiverAddress || "(missing)"));
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  console.log("==================================================");
  console.log("Caller:", signer.address);
  console.log("PingSender on Fuji C-Chain:", pingSenderAddress);
  console.log("PongReceiver on Dispute L1:", pongReceiverAddress);
  console.log("Target Blockchain ID Bytes32:", disputeL1BlockchainIdBytes32);
  console.log("==================================================");

  const pingSender = await ethers.getContractAt("PingSender", pingSenderAddress);

  const testMessage = "CaseOpened: Order #001 warranty claim verified via Teleporter";
  console.log(`Sending ping: "${testMessage}"...`);

  const tx = await pingSender.sendPing(
    disputeL1BlockchainIdBytes32,
    pongReceiverAddress,
    testMessage
  );

  console.log("Ping transaction broadcasted. Tx Hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Ping confirmed in Fuji block #" + receipt.blockNumber);
  console.log("SOURCE CONFIRMED ONLY: PingSent emitted on Fuji; Dispute L1 delivery is NOT verified.");
  console.log("Require an L1 transaction receipt with PongReceived. Run npm run delivery -- <L1_TX_HASH>.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

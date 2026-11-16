import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  const pingSenderAddress = process.env.PING_SENDER_ADDRESS;
  const pongReceiverAddress = process.env.PONG_RECEIVER_ADDRESS;
  const disputeL1BlockchainIdBytes32 =
    process.env.DISPUTE_L1_BLOCKCHAIN_ID_BYTES32 ||
    "0x1ac4f03783f66f0733d25e7b8df833da1d739e7b20404cd2cfd867bf1d270539";

  if (!pingSenderAddress || !pongReceiverAddress) {
    console.error("ERROR: Missing contract addresses!");
    console.log("Please define in your .env file:");
    console.log("PING_SENDER_ADDRESS=" + (pingSenderAddress || "0x..."));
    console.log("PONG_RECEIVER_ADDRESS=" + (pongReceiverAddress || "0x..."));
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  console.log("--------------------------------------------------");
  console.log("Caller:", signer.address);
  console.log("PingSender on C-Chain:", pingSenderAddress);
  console.log("PongReceiver on Dispute L1:", pongReceiverAddress);
  console.log("Dispute L1 Bytes32 ID:", disputeL1BlockchainIdBytes32);
  console.log("--------------------------------------------------");

  const pingSender = await ethers.getContractAt("PingSender", pingSenderAddress);

  const testMessage = "CaseOpened: Order #001 warranty claim verified via Teleporter";
  console.log(`Sending ping: "${testMessage}"...`);

  const tx = await pingSender.sendPing(
    disputeL1BlockchainIdBytes32,
    pongReceiverAddress,
    testMessage
  );

  console.log("Ping transaction submitted. Hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Ping confirmed in C-Chain block:", receipt?.blockNumber);
  console.log("SOURCE CONFIRMED ONLY: Dispute L1 delivery is NOT verified.");
  console.log("Awaiting Relayer delivery to Dispute L1 PongReceiver...");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("--------------------------------------------------");
  console.log("Account:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance));

  const network = await ethers.provider.getNetwork();
  console.log("Chain ID:", network.chainId.toString());
  console.log("--------------------------------------------------");

  if (network.chainId === 43113n) {
    console.log("Deploying PingSender to Fuji C-Chain...");
    const PingSender = await ethers.getContractFactory("PingSender");
    const pingSender = await PingSender.deploy();
    await pingSender.waitForDeployment();
    const address = await pingSender.getAddress();
    console.log("SUCCESS: PingSender deployed on Fuji C-Chain at:", address);
    console.log("Save this address to your .env file as PING_SENDER_ADDRESS=" + address);
  } else if (network.chainId === 662831n) {
    console.log("Deploying PongReceiver to Dispute L1...");
    const PongReceiver = await ethers.getContractFactory("PongReceiver");
    const pongReceiver = await PongReceiver.deploy();
    await pongReceiver.waitForDeployment();
    const address = await pongReceiver.getAddress();
    console.log("SUCCESS: PongReceiver deployed on Dispute L1 at:", address);
    console.log("Save this address to your .env file as PONG_RECEIVER_ADDRESS=" + address);
  } else {
    console.error("Unknown chain ID:", network.chainId.toString());
    console.log("Run with --network fuji or --network disputeL1");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

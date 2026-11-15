const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

async function check() {
  const fujiRpc = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
  const l1Rpc = process.env.DISPUTE_L1_RPC_URL || "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc";
  const fuji = new ethers.JsonRpcProvider(fujiRpc);
  const l1 = new ethers.JsonRpcProvider(l1Rpc);

  let deployerAddress = "0x342482d83aB3E03745a96dc377aF806D19726Fa7";
  if (process.env.PRIVATE_KEY) {
    try {
      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
      deployerAddress = wallet.address;
    } catch (e) {}
  }

  console.log("==================================================");
  console.log("Deployer Address        :", deployerAddress);

  try {
    const fujiBal = await fuji.getBalance(deployerAddress);
    console.log("Fuji C-Chain Balance    :", ethers.formatEther(fujiBal), "AVAX");
  } catch (e) {
    console.log("Fuji C-Chain Balance    : Error fetching");
  }

  try {
    const l1Bal = await l1.getBalance(deployerAddress);
    console.log("Dispute L1 Balance      :", ethers.formatEther(l1Bal), "DISP");
  } catch (e) {
    console.log("Dispute L1 Balance      : Error fetching");
  }

  console.log("--------------------------------------------------");

  const pingAddr = process.env.PING_SENDER_ADDRESS;
  const pongAddr = process.env.PONG_RECEIVER_ADDRESS;

  if (pingAddr) {
    const codeFuji = await fuji.getCode(pingAddr);
    console.log("PingSender on Fuji      : Active (" + codeFuji.length + " bytes)");
  }
  if (pongAddr) {
    const codeL1 = await l1.getCode(pongAddr);
    console.log("PongReceiver on Dispute : Active (" + codeL1.length + " bytes)");
  }
  console.log("==================================================");
}

check().catch(console.error);

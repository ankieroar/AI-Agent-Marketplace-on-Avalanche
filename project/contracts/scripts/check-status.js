const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

async function check() {
  const fujiRpc = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
  const l1Rpc = process.env.DISPUTE_L1_RPC_URL || "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc";
  const fuji = new ethers.JsonRpcProvider(fujiRpc);
  const l1 = new ethers.JsonRpcProvider(l1Rpc);

  const pingAddr = process.env.PING_SENDER_ADDRESS;
  const pongAddr = process.env.PONG_RECEIVER_ADDRESS;

  if (pingAddr) {
    const codeFuji = await fuji.getCode(pingAddr);
    console.log("PingSender on Fuji (length):", codeFuji.length);
  }
  if (pongAddr) {
    const codeL1 = await l1.getCode(pongAddr);
    console.log("PongReceiver on Dispute L1 (length):", codeL1.length);
  }
}
check().catch(console.error);

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

async function checkPong() {
  const l1Rpc = process.env.DISPUTE_L1_RPC_URL || "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc";
  const l1 = new ethers.JsonRpcProvider(l1Rpc);
  const pongAddr = process.env.PONG_RECEIVER_ADDRESS || "0x83620E38fcDF5BF361494932dA91261C006C64d3";

  const abi = [
    "function totalReceivedMessages() external view returns (uint256)",
    "function lastMessage() external view returns (string)",
    "function lastCaller() external view returns (address)"
  ];
  const pong = new ethers.Contract(pongAddr, abi, l1);
  const count = await pong.totalReceivedMessages();
  const lastMsg = await pong.lastMessage();
  const lastCaller = await pong.lastCaller();
  console.log("Total received messages on Dispute L1:", count.toString());
  console.log("Last Message:", lastMsg);
  console.log("Last Caller:", lastCaller);
}
checkPong().catch(console.error);

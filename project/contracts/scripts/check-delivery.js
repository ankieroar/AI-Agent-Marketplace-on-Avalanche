// Read-only: verifies destination receipt, or prints current receiver state.
const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.DISPUTE_L1_RPC_URL ||
    "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc",
    undefined, { polling: true, batchMaxCount: 1 });
  try {
    if ((await provider.getNetwork()).chainId !== 662831n) throw new Error("Wrong destination chain");
    const address = process.env.PONG_RECEIVER_ADDRESS;
    if (!address || await provider.getCode(address) === "0x") throw new Error("PongReceiver missing or not deployed");
    const receiver = new ethers.Contract(address, [
      "function totalReceivedMessages() view returns (uint256)",
      "function lastMessage() view returns (string)",
      "function lastCaller() view returns (address)",
      "event PongReceived(bytes32 indexed originBlockchainID,address indexed originSenderAddress,address indexed initialCaller,string messageText,uint256 sentTimestamp,uint256 receivedTimestamp)"
    ], provider);
    console.log("Dispute L1 chain ID: 662831; receiver:", address);
    const block = await provider.getBlockNumber();
    console.log("Snapshot block:", block);
    console.log("totalReceivedMessages:", String(await receiver.totalReceivedMessages({ blockTag: block })));
    console.log("lastMessage:", await receiver.lastMessage({ blockTag: block }));
    console.log("lastCaller:", await receiver.lastCaller({ blockTag: block }));
    const hash = process.argv[2];
    if (!hash) {
      console.log("State only; this does not prove delivery of a specific ping.");
      console.log("Verify a destination transaction: npm run delivery -- <L1_TX_HASH>");
      return;
    }
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1) throw new Error("L1 transaction missing, pending, or reverted");
    const events = receipt.logs.filter(log => log.address.toLowerCase() === address.toLowerCase())
      .map(log => { try { return receiver.interface.parseLog(log); } catch { return null; } })
      .filter(event => event?.name === "PongReceived");
    if (!events.length) throw new Error("No PongReceived event from configured receiver");
    for (const event of events) {
      console.log("VERIFIED PongReceived; L1 tx:", hash, "block:", receipt.blockNumber);
      for (const key of ["originBlockchainID", "originSenderAddress", "initialCaller", "messageText", "sentTimestamp", "receivedTimestamp"]) {
        console.log(key + ":", String(event.args[key]));
      }
    }
  } finally { provider.destroy(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

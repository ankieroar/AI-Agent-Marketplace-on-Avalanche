// Read-only audit: no private key is used to sign or broadcast transactions.
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { root, chains } = require('../../services/relayer-monitor/icm-runtime');
const { MESSENGER, ABI, WARP } = require('../../services/relayer-monitor/warp-delivery');
async function main() {
  const providers = chains.map(c => {
    const request = new ethers.FetchRequest(c['rpc-url']); request.timeout = 20000;
    return new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1, polling: true });
  });
  try {
    for (let i = 0; i < 2; i++) if ((await providers[i].getNetwork()).chainId !== [43113n, 662831n][i]) throw new Error('Unexpected chain');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'docs/icm-v2.json')));
    const ping = new ethers.Contract(state.apps[0].address, ['function completed(bytes32) view returns(bool)'], providers[0]);
    const pong = new ethers.Contract(state.apps[1].address, ['function received(bytes32) view returns(bool)'], providers[1]);
    const messengers = providers.map(p => new ethers.Contract(MESSENGER, ABI, p));
    const rounds = [];
    for (const round of state.rounds) {
      const receipt = round.l1ReceiveTx && await providers[1].getTransactionReceipt(round.l1ReceiveTx);
      const tx = receipt && await providers[1].getTransaction(receipt.hash);
      rounds.push({
        roundTripId: round.roundTripId, sourceTx: round.sourceTx, l1ReceiveTx: round.l1ReceiveTx,
        pingMessageID: round.pingMessageID, pongMessageID: round.pongMessageID,
        l1MessengerReceived: await messengers[1].messageReceived(round.pingMessageID),
        l1ApplicationReceived: await pong.received(round.roundTripId),
        l1ReceiptSucceeded: receipt?.status === 1,
        l1ReceiptBlock: receipt?.blockNumber,
        l1DeliveryToMessenger: tx?.to?.toLowerCase() === MESSENGER.toLowerCase(),
        l1DeliveryHasWarpPredicate: !!tx?.accessList?.some(x => x.address.toLowerCase() === WARP.toLowerCase() && x.storageKeys.length),
        fujiMessengerReceived: !!round.pongMessageID && await messengers[0].messageReceived(round.pongMessageID),
        fujiApplicationCompleted: await ping.completed(round.roundTripId),
      });
    }
    const report = { checkedAt: new Date().toISOString(), testnetOnly: true, rounds };
    fs.writeFileSync(path.join(root, 'docs/icm-v2-audit.json'), JSON.stringify(report, null, 2));
    console.log(report);
  } finally { providers.forEach(p => p.destroy()); }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1; });

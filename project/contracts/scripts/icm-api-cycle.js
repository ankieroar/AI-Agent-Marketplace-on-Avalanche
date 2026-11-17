const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');
const { root, chains, signer } = require('../../services/relayer-monitor/icm-runtime');
const { MESSENGER, ABI, deliver } = require('../../services/relayer-monitor/warp-delivery');

async function main() {
  const providers = chains.map(c => {
    const request = new ethers.FetchRequest(c['rpc-url']); request.timeout = 20000;
    return new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1, polling: true });
  });
  const file = path.join(root, 'docs/icm-v2.json');
  try {
    for (let i = 0; i < 2; i++) {
      if ((await providers[i].getNetwork()).chainId !== [43113n, 662831n][i]) throw new Error('Testnet chain ID mismatch');
    }
    const state = JSON.parse(fs.readFileSync(file));
    const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
    const artifacts = await Promise.all(['PingSenderV2', 'PongReceiverV2'].map(n => hre.artifacts.readArtifact(n)));
    const apps = state.apps.map((a, i) => new ethers.Contract(a.address, artifacts[i].abi, providers[i]));
    const operator = signer();
    const wallets = providers.map(p => new ethers.Wallet(operator.privateKey, p));
    let round = state.rounds.find(r => !r.verified);
    if (!round && !state.pendingPingTx) {
      const owner = new ethers.Wallet(process.env.PRIVATE_KEY, providers[0]);
      const tx = await apps[0].connect(owner).sendPing('Authenticated ICM roundtrip ' + new Date().toISOString());
      // Persist the hash before waiting so a restart can recover this send.
      state.pendingPingTx = tx.hash; save();
      await tx.wait(1, 60000);
    }
    if (!round && state.pendingPingTx) {
      const receipt = await providers[0].getTransactionReceipt(state.pendingPingTx);
      if (!receipt || receipt.status !== 1) throw new Error('Pending ping not yet confirmed; do not resend');
      const sent = receipt.logs.map(l => { try { return apps[0].interface.parseLog(l); } catch { return null; } })
        .find(e => e?.name === 'PingSent');
      if (!sent) throw new Error('Missing PingSent');
      round = { roundTripId: sent.args.roundTripId, pingMessageID: sent.args.messageID, sourceTx: receipt.hash, sourceBlock: receipt.blockNumber };
      state.rounds.push(round); delete state.pendingPingTx; save();
    }
    console.log('Round:', round.roundTripId, 'Source:', round.sourceTx);
    const config = await providers[1].send('eth_getChainConfig', []);
    // This testnet deployment requires Primary Network signatures for C-Chain.
    if (config.warpConfig?.requirePrimaryNetworkSigners !== true || config.upgrades?.precompileUpgrades?.length) {
      throw new Error('Review destination Warp signing policy before delivery');
    }
    async function resumeOrDeliver(index, sourceTx, messageID, hashField) {
      if (round[hashField]) {
        const receipt = await providers[1 - index].getTransactionReceipt(round[hashField]);
        if (!receipt) throw new Error('Delivery transaction still pending; do not resend');
        if (receipt.status !== 1) throw new Error('Prior delivery reverted; inspect receipt before retry');
      }
      return deliver({ source: providers[index], destination: wallets[1 - index], sourceTx, messageID,
        signingSubnetId: chains[index]['subnet-id'], onBroadcast: hash => { round[hashField] = hash; save(); } });
    }
    await resumeOrDeliver(0, round.sourceTx, round.pingMessageID, 'l1DeliveryBroadcastTx');
    if (!await apps[1].received(round.roundTripId)) throw new Error('Messenger received, application execution not confirmed');
    const pingReceipt = round.l1DeliveryBroadcastTx ? await providers[1].getTransactionReceipt(round.l1DeliveryBroadcastTx) : null;
    const pingEvents = pingReceipt ? pingReceipt.logs.filter(l => l.address.toLowerCase() === state.apps[1].address.toLowerCase())
      .map(l => { try { return apps[1].interface.parseLog(l); } catch { return null; } }) : [];
    if (!pingEvents.some(e => e?.name === 'PongReceived' && e.args.roundTripId === round.roundTripId)) {
      throw new Error('Missing PongReceived receipt for this round');
    }
    round.l1ReceiveTx = pingReceipt.hash;
    round.pongMessageID = await apps[1].replyMessageIDs(round.roundTripId);
    round.forwardVerified = true; save();
    console.log('VERIFIED FUJI -> L1:', round.l1ReceiveTx, 'Pong:', round.pongMessageID);
    if (round.pongMessageID === ethers.ZeroHash) throw new Error('L1 has not emitted a pong');
    await resumeOrDeliver(1, round.l1ReceiveTx, round.pongMessageID, 'fujiDeliveryBroadcastTx');
    if (!await apps[0].completed(round.roundTripId)) throw new Error('Fuji application reply not confirmed');
    const replyReceipt = await providers[0].getTransactionReceipt(round.fujiDeliveryBroadcastTx);
    const reply = replyReceipt.logs.filter(l => l.address.toLowerCase() === state.apps[0].address.toLowerCase())
      .map(l => { try { return apps[0].interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === 'ReplyReceived' && e.args.roundTripId === round.roundTripId);
    if (!reply) throw new Error('Missing ReplyReceived receipt');
    for (const [i, id] of [[1, round.pingMessageID], [0, round.pongMessageID]]) {
      if (!await new ethers.Contract(MESSENGER, ABI, providers[i]).messageReceived(id)) throw new Error('Missing Messenger confirmation');
    }
    round.fujiReplyTx = replyReceipt.hash; round.verified = true; round.verifiedAt = new Date().toISOString();
    round.transport = 'self-delivery with anonymous public signature aggregator'; save();
    console.log('VERIFIED REAL ICM BOTH DIRECTIONS', round);
  } finally { providers.forEach(p => p.destroy()); }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1; });

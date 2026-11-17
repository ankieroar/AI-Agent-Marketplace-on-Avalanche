// Self-delivery of authenticated ICM messages. The destination Warp precompile
// verifies the BLS signature; this never calls the application receiver directly.
const { ethers } = require('ethers');
const WARP = '0x0200000000000000000000000000000000000005';
const MESSENGER = '0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
const ABI = [
  'function receiveCrossChainMessage(uint32 messageIndex,address relayerRewardAddress)',
  'function messageReceived(bytes32 messageID) view returns(bool)',
];

function predicateKeys(signedMessage, unsignedMessage) {
  const signed = ethers.getBytes(signedMessage);
  const unsigned = ethers.getBytes(unsignedMessage);
  if (signed.length <= unsigned.length ||
      !Buffer.from(signed.subarray(0, unsigned.length)).equals(Buffer.from(unsigned))) {
    throw new Error('Aggregator returned a different unsigned Warp message');
  }
  // AvalancheGo v1.15.0 vms/evm/predicate: message, FF delimiter, zero padding.
  const padded = Buffer.alloc(Math.ceil((signed.length + 1) / 32) * 32);
  padded.set(signed); padded[signed.length] = 0xff;
  return Array.from({ length: padded.length / 32 }, (_, i) =>
    ethers.hexlify(padded.subarray(i * 32, i * 32 + 32)));
}

async function aggregate(unsignedMessage, signingSubnetId) {
  // Anonymous public endpoint only: no API key, paid account or paid fallback.
  const response = await fetch('https://data-api.avax.network/v1/signatureAggregator/fuji/aggregateSignatures', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: unsignedMessage, signingSubnetId, quorumPercentage: 67 }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`Signature aggregation failed: HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result.signedMessage !== 'string') throw new Error('Missing signed Warp message');
  const signed = result.signedMessage.startsWith('0x') ? result.signedMessage : '0x' + result.signedMessage;
  predicateKeys(signed, unsignedMessage);
  return signed;
}

async function deliver({ source, destination, sourceTx, messageID, signingSubnetId, onBroadcast }) {
  const messenger = new ethers.Contract(MESSENGER, ABI, destination);
  if (await messenger.messageReceived(messageID)) return null;
  const receipt = await source.getTransactionReceipt(sourceTx);
  if (!receipt || receipt.status !== 1) throw new Error('Source transaction is not confirmed successfully');
  const warpLogs = receipt.logs.filter(l => l.address.toLowerCase() === WARP.toLowerCase());
  if (warpLogs.length !== 1) throw new Error('Expected exactly one Warp message in source receipt');
  // SendWarpMessage log data is ABI-encoded bytes, not the raw Warp message.
  const [unsigned] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], warpLogs[0].data);
  const signed = await aggregate(unsigned, signingSubnetId);
  const request = {
    to: MESSENGER,
    data: messenger.interface.encodeFunctionData('receiveCrossChainMessage', [0, destination.address]),
    accessList: [{ address: WARP, storageKeys: predicateKeys(signed, unsigned) }],
    type: 2,
    gasLimit: 2500000n,
  };
  const tx = await destination.sendTransaction(request);
  if (onBroadcast) onBroadcast(tx.hash);
  console.log('Warp delivery broadcast:', tx.hash);
  const delivered = await tx.wait(1, 60000);
  if (!delivered || delivered.status !== 1 || !await messenger.messageReceived(messageID)) {
    throw new Error('Destination Messenger did not confirm delivery');
  }
  return delivered;
}

module.exports = { WARP, MESSENGER, ABI, predicateKeys, aggregate, deliver };

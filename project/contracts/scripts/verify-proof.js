const hre = require('hardhat');
const fs = require('fs');
const path = require('path');
async function main() {
  const { ethers } = hre;
  if ((await ethers.provider.getNetwork()).chainId !== 662831n) throw new Error('Use Dispute L1 testnet');
  const root = path.resolve(__dirname, '../..');
  const deployment = JSON.parse(fs.readFileSync(path.join(root, 'docs/verifier-deployment.json')));
  const proof = JSON.parse(fs.readFileSync(path.join(root, 'circuits/hello_world/target/proof-data.json')));
  const code = await ethers.provider.getCode(deployment.address);
  if (ethers.keccak256(code) !== deployment.codeHash) throw new Error('Verifier code hash mismatch');
  const verifier = await ethers.getContractAt(deployment.contract, deployment.address);
  console.log('Checking valid proof on L1...');
  if (!await verifier.verify.staticCall(proof.proof, proof.publicInputs, {gasLimit:8000000})) throw new Error('Valid proof rejected on L1');
  console.log('Valid proof accepted. Checking intentionally invalid inputs...');
  async function mustReject(bytes, inputs) {
    try {
      if (await verifier.verify.staticCall(bytes, inputs, {gasLimit:8000000})) throw new Error('Invalid proof/input accepted');
    } catch (error) {
      // Hardhat's HTTP provider preserves JSON-RPC code 3 on this L1;
      // ethers JsonRpcProvider usually wraps the same revert in CALL_EXCEPTION.
      if (error.code !== 'CALL_EXCEPTION' && !(error.code === 3 && ethers.isHexString(error.data))) throw error;
    }
  }
  const wrongInputs = [...proof.publicInputs];
  wrongInputs[0] = ethers.toBeHex(BigInt(wrongInputs[0]) + 1n, 32);
  await mustReject(proof.proof, wrongInputs);
  const badProof = ethers.getBytes(proof.proof); badProof[0] ^= 1;
  await mustReject(badProof, proof.publicInputs);
  console.log('Valid proof accepted and negative calls rejected; submitting verify transaction...');
  const tx = await verifier.verify.send(proof.proof, proof.publicInputs, {gasLimit:1000000});
  const receipt = await tx.wait(1, 60000);
  if (!receipt || receipt.status !== 1) throw new Error('Verification transaction failed');
  const report = {
    chainId: 662831, verifier: deployment.address, transactionHash: receipt.hash,
    block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(),
    validProofAccepted: true, wrongPublicInputRejected: true, tamperedProofRejected: true,
    proofKeccak256: ethers.keccak256(proof.proof), publicInputs: proof.publicInputs,
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, 'docs/zk-l1-verification.json'), JSON.stringify(report, null, 2));
  console.log(report);
}
main().catch(e => { console.error(JSON.stringify({message:e.shortMessage||e.message,code:e.code,data:e.data})); process.exitCode = 1; });

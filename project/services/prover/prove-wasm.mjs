import { UltraPlonkBackend } from '@aztec/bb.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'circuits/hello_world/target');
const circuit = JSON.parse(fs.readFileSync(path.join(target, 'hello_world.json')));
// UltraPlonk provides blinded proofs and a Solidity verifier. WASM avoids the
// CPU instruction requirements of the downloaded native bb executable.
const backend = new UltraPlonkBackend(circuit.bytecode, {
  threads: 1, crsPath: path.join(root, '.tools/bb-crs'),
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  console.log('Generating real UltraPlonk proof with Barretenberg WASM 0.82.2...');
  const proofData = await backend.generateProof(new Uint8Array(fs.readFileSync(path.join(target, 'hello_world.gz'))));
  if (!await backend.verifyProof(proofData)) throw new Error('Generated proof failed local verification');
  const wrongInputs = { ...proofData, publicInputs: proofData.publicInputs.map((x, i) => i === 0 ? '0x' + (BigInt(x) + 1n).toString(16).padStart(64, '0') : x) };
  if (await backend.verifyProof(wrongInputs)) throw new Error('Verifier accepted wrong public input');
  console.log('Valid proof accepted; altered public input rejected. Exporting VK and Solidity...');
  const vk = await backend.getVerificationKey();
  const solidity = await backend.getSolidityVerifier();
  fs.writeFileSync(path.join(target, 'vk'), vk);
  fs.writeFileSync(path.join(target, 'proof'), proofData.proof);
  fs.writeFileSync(path.join(target, 'proof-data.json'), JSON.stringify({
    proof: '0x' + Buffer.from(proofData.proof).toString('hex'), publicInputs: proofData.publicInputs,
  }, null, 2));
  const generated = path.join(root, 'contracts/contracts/generated');
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, 'UltraVerifier.sol'), solidity);
  const report = {
    backend: '@aztec/bb.js@0.82.2', provingSystem: 'UltraPlonk', runtime: 'WebAssembly',
    noirVersion: circuit.noir_version, circuit: 'hello_world', publicInputs: proofData.publicInputs,
    proofBytes: proofData.proof.length, vkBytes: vk.length, circuitSha256: sha256(circuit.bytecode),
    proofSha256: sha256(proofData.proof), vkSha256: sha256(vk), verifierSourceSha256: sha256(solidity),
    validProofAccepted: true, wrongPublicInputRejected: true, generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, 'docs/zk-proof-generation.json'), JSON.stringify(report, null, 2));
  console.log(report);
} finally { await backend.destroy(); }

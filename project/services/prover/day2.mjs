import { UltraPlonkBackend } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';
import { compile, createFileManager } from '@noir-lang/noir_wasm';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceCommitment, witnessInputs } from './service-policy-input.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const circuit = path.join(root, 'circuits/service_policy');
const target = path.join(circuit, 'target');

let compiledCircuit;
async function compileCircuit() {
  const files = createFileManager(circuit);
  // Noir beta.3 enumerates source paths with slashes on Windows, but resolves
  // its entry point with node:path. Give both sides the same path format.
  const readdir = files.readdir.bind(files);
  files.readdir = async (...args) => (await readdir(...args)).map(file => path.normalize(file));
  const { program } = await compile(files, undefined, () => {}, () => {});
  return program;
}

function loadCircuit() {
  compiledCircuit ??= compileCircuit().catch(error => {
    compiledCircuit = undefined;
    throw new Error('Cannot compile the service policy circuit', { cause: error });
  });
  return compiledCircuit;
}

/** Internal service. Caller supplies a trusted on-chain case and the stored signed policy witness. */
export async function proveServicePolicy(claim, committedPolicy, payout, { validate = false, exportVerifier = false } = {}) {
  if (serviceCommitment(claim.orderId, claim.policyVersionHash, committedPolicy) !== claim.policyCommitment.toLowerCase()) {
    throw new Error('Stored policy does not match the on-chain commitment');
  }
  const compiled = await loadCircuit();
  const noir = new Noir(compiled);
  const inputs = witnessInputs(claim,committedPolicy,payout);
  if (validate) {
    for (const [label, invalid] of [
      ['overdue',{...inputs,claim_timestamp:String(BigInt(claim.claimDeadline)+1n)}],
      ['refund over limit',{...inputs,payout_amount:String(BigInt(committedPolicy.maxRefund)+1n)}],
      ['changed case',{...inputs,case_lo:String(BigInt(inputs.case_lo)^1n)}],
    ]) {
      try { await noir.execute(invalid); } catch (error) {
        if (!/assertion|constraint/i.test(error.message)) throw error;
        console.log('Rejected '+label); continue;
      }
      throw new Error('Circuit accepted '+label);
    }
  }
  let witness;
  try {
    ({ witness } = await noir.execute(inputs));
  } catch {
    throw new Error('Service policy witness does not satisfy the circuit');
  }
  const backend = new UltraPlonkBackend(compiled.bytecode,{threads:1,crsPath:path.join(root,'.tools/bb-crs')});
  try {
    const data = await backend.generateProof(witness);
    if (data.publicInputs.length !== 15 || !await backend.verifyProof(data)) {
      throw new Error('Proof verification failed');
    }
    if (validate) {
      const wrong = {...data,publicInputs:data.publicInputs.map((x,i)=>i===11
        ? '0x'+(BigInt(x)+1n).toString(16).padStart(64,'0') : x)};
      if (await backend.verifyProof(wrong)) throw new Error('Altered refund was accepted');
    }
    if (exportVerifier) {
      const solidity = (await backend.getSolidityVerifier())
        .replace(/\b(BaseUltraVerifier|UltraVerificationKey|UltraVerifier)\b/g, 'ServicePolicy$1')
        .replace(/[ \t]+$/gm, '').trimEnd() + '\n';
      await writeFile(path.join(root,'contracts/contracts/generated/ServicePolicyUltraVerifier.sol'),solidity);
    }
    return {proof:'0x'+Buffer.from(data.proof).toString('hex'),publicInputs:data.publicInputs};
  } finally {
    await backend.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const id = byte => '0x'+byte.repeat(32);
  const policy = {disputeWindow:'3600',maxRefund:'7500000000000000',nonce:'0x'+'66'.repeat(16)};
  const claim = {caseId:id('11'),orderId:id('22'),policyVersionHash:id('33'),sourceBlockchainId:id('44'),
    purchaseTimestamp:'1760000000',claimTimestamp:'1760000010',claimDeadline:'1760003600'};
  claim.policyCommitment = serviceCommitment(claim.orderId,claim.policyVersionHash,policy);
  try {
    const data=await proveServicePolicy(claim,policy,'5000000000000000',{
      validate:true,exportVerifier:process.argv.includes('--export-verifier'),
    });
    await mkdir(target,{recursive:true});
    await writeFile(path.join(target,'proof-data.json'),JSON.stringify({claim,...data},null,2));
    console.log('Noir beta.3 + bb.js 0.82.2 WASM: real policy proof verified (15 public inputs).');
  } catch(error) {
    // A compiler diagnostic can include witness details. Never log it in the demo/service.
    console.error(error.message);
    process.exitCode=1;
  }
}

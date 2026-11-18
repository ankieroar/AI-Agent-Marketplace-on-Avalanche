import { UltraPlonkBackend } from '@aztec/bb.js';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceCommitment, witnessInputs } from './service-policy-input.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const circuit = path.join(root, 'circuits/service_policy');
const target = path.join(circuit, 'target');

function nargo(directory, args) {
  const pinned = path.join(root, '.tools/noir/nargo');
  const result = process.platform === 'win32'
    ? spawnSync('docker', ['run','--rm','-v',root.replaceAll('\\','/')+':/work',
      '-w','/work/'+path.relative(root,directory).replaceAll('\\','/'),
      '--entrypoint','/work/.tools/noir/nargo','mirror.gcr.io/library/ubuntu:24.04',...args],
      {encoding:'utf8',windowsHide:true})
    : spawnSync(existsSync(pinned) ? pinned : 'nargo', args, {cwd:directory,encoding:'utf8'});
  if (result.error || result.status !== 0) {
    const error = new Error('Noir command failed: '+args[0]);
    error.diagnostic = result.stderr || result.error?.message;
    throw error;
  }
  return result.stdout;
}

async function solve(folder, args) {
  const toml = Object.entries(args).map(([k,v])=>k+' = '+JSON.stringify(v)).join('\n')+'\n';
  await writeFile(path.join(folder,'Prover.toml'),toml);
  nargo(folder,['execute']);
  return new Uint8Array(await readFile(path.join(folder,'target/service_policy.gz')));
}

/** Internal service. Caller supplies a trusted on-chain case and the stored signed policy witness. */
export async function proveServicePolicy(claim, committedPolicy, payout, { validate = false, exportVerifier = false } = {}) {
  if (serviceCommitment(claim.orderId, claim.policyVersionHash, committedPolicy) !== claim.policyCommitment.toLowerCase()) {
    throw new Error('Stored policy does not match the on-chain commitment');
  }
  if (!nargo(circuit,['--version']).includes('1.0.0-beta.3')) throw new Error('Expected Noir 1.0.0-beta.3');
  await mkdir(target,{recursive:true});
  const jobs = path.join(root,'.tools/prover-jobs');
  await mkdir(jobs,{recursive:true,mode:0o700});
  const folder = await mkdtemp(path.join(jobs,'job-'));
  try {
    await cp(path.join(circuit,'src'),path.join(folder,'src'),{recursive:true});
    await cp(path.join(circuit,'Nargo.toml'),path.join(folder,'Nargo.toml'));
    const inputs = witnessInputs(claim,committedPolicy,payout);
    if (validate) {
      for (const [label, invalid] of [
        ['overdue',{...inputs,claim_timestamp:String(BigInt(claim.claimDeadline)+1n)}],
        ['refund over limit',{...inputs,payout_amount:String(BigInt(committedPolicy.maxRefund)+1n)}],
        ['changed case',{...inputs,case_lo:String(BigInt(inputs.case_lo)^1n)}],
      ]) {
        try { await solve(folder,invalid); } catch(e) {
          if (!/assertion|constraint/i.test(e.diagnostic ?? '')) throw e;
          console.log('Rejected '+label); continue;
        }
        throw new Error('Circuit accepted '+label);
      }
    }
    const witness = await solve(folder,inputs);
    const compiled = JSON.parse(await readFile(path.join(folder,'target/service_policy.json'),'utf8'));
    const backend = new UltraPlonkBackend(compiled.bytecode,{threads:1,crsPath:path.join(root,'.tools/bb-crs')});
    try {
      const data = await backend.generateProof(witness);
      if (data.publicInputs.length !== 15 || !await backend.verifyProof(data)) throw new Error('Proof verification failed');
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
    } finally { await backend.destroy(); }
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const id = byte => '0x'+byte.repeat(32);
  const policy = {disputeWindow:'3600',maxRefund:'7500000000000000',nonce:'0x'+'66'.repeat(16)};
  const claim = {caseId:id('11'),orderId:id('22'),policyVersionHash:id('33'),sourceBlockchainId:id('44'),
    purchaseTimestamp:'1760000000',claimTimestamp:'1760000010',claimDeadline:'1760003600'};
  claim.policyCommitment = serviceCommitment(claim.orderId,claim.policyVersionHash,policy);
  try {
    const data=await proveServicePolicy(claim,policy,'5000000000000000',{validate:true,exportVerifier:true});
    await writeFile(path.join(target,'proof-data.json'),JSON.stringify({claim,...data},null,2));
    console.log('Noir beta.3 + bb.js 0.82.2 WASM: real policy proof verified (15 public inputs).');
  } catch(error) {
    // A compiler diagnostic can include witness details. Never log it in the demo/service.
    console.error(error.message);
    if (process.env.DAY2_FIXTURE_DEBUG === "1" && error.diagnostic) console.error(error.diagnostic);
    process.exitCode=1;
  }
}

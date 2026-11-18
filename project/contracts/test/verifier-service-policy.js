const fs = require('node:fs');
const path = require('node:path');
const { ethers, artifacts } = require('hardhat');
const { expect } = require('chai');

const file = path.resolve(__dirname,'../../circuits/service_policy/target/proof-data.json');
const source = path.resolve(__dirname,'../contracts/generated/ServicePolicyUltraVerifier.sol');

describe('Real Day 2 service policy proof (generate with day2.mjs)', function() {
  before(function() { if (!fs.existsSync(file) || !fs.existsSync(source)) this.skip(); });

  it('matches all 15 ProofGate inputs and verifies in the Solidity verifier',async function() {
    const {claim,proof,publicInputs}=JSON.parse(fs.readFileSync(file,'utf8'));
    const verifier=await ethers.deployContract('ServicePolicyUltraVerifier');
    const gate=await ethers.deployContract('ProofGate',[await verifier.getAddress()]);
    const c={...claim,nonce:BigInt(claim.caseId),lockedAmount:ethers.parseEther('0.01')};
    const amount=BigInt(publicInputs[11]), nullifier=publicInputs[12];
    const {deployedBytecode}=await artifacts.readArtifact('ServicePolicyUltraVerifier');
    const size=(deployedBytecode.length-2)/2;
    expect(size).to.be.lessThanOrEqual(24576);
    console.log('Policy verifier deployed bytecode: '+size+' bytes');
    expect(await gate.publicInputs(c,amount,nullifier)).to.deep.equal(publicInputs);
    expect(await gate.verify(c,amount,nullifier,proof)).to.equal(true);
    for (const wrongInputs of [
      publicInputs.map((v,i)=>i===11?ethers.toBeHex(amount+1n,32):v),
      publicInputs.map((v,i)=>i===1?ethers.toBeHex(BigInt(v)^1n,32):v),
    ]) {
      const valid=await verifier.verify(proof,wrongInputs).catch(()=>false);
      expect(valid).to.equal(false);
    }
  });
});

const { expect } = require('chai');
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '../../circuits/hello_world/target/proof-data.json');
(fs.existsSync(file) ? describe : describe.skip)('Real Noir UltraPlonk proof (generate with services/prover first)', function () {
  it('accepts a real proof and rejects a changed public input and corrupted proof', async function () {
    const verifier = await (await ethers.getContractFactory('UltraVerifier')).deploy();
    const { proof, publicInputs } = JSON.parse(fs.readFileSync(file));
    expect(await verifier.verify(proof, publicInputs)).to.equal(true);
    const changed = [...publicInputs]; changed[0] = ethers.toBeHex(BigInt(changed[0]) + 1n, 32);
    await expect(verifier.verify(proof, changed)).to.be.reverted;
    const broken = ethers.getBytes(proof); broken[0] ^= 1;
    await expect(verifier.verify(broken, publicInputs)).to.be.reverted;
    expect((await ethers.provider.getCode(await verifier.getAddress())).length / 2 - 1).to.be.lessThanOrEqual(24576);
  });
});

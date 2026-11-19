const { artifacts, network } = require("hardhat");
const fs = require("node:fs/promises");
const path = require("node:path");
const { deployDay2 } = require("./day2-local-fixture");

async function main() {
  if (network.name !== "localhost") throw new Error("Use --network localhost with Hardhat node running");
  const demo = await deployDay2({ sameChain: true, verifierName: "ServicePolicyUltraVerifier" });
  const manifest = { chainId: 31337, transport: "same-chain", contracts: {} };
  for (const [name, contract] of Object.entries(demo.contracts)) {
    const { abi } = await artifacts.readArtifact(name);
    manifest.contracts[name] = { abi, address: await contract.getAddress() };
  }
  const output = path.resolve(__dirname, "../../.runtime/day2");
  const file = path.join(output, "day2-local.json");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  console.log({
    seller: demo.seller.address,
    buyer: demo.buyer.address,
    reviewer: demo.reviewer.address,
    manifest: file,
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

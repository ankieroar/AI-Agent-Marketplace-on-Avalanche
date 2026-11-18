const { ethers, artifacts, network } = require("hardhat");
const { randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { deployDay2 } = require("./day2-local-fixture");

async function main() {
  if(network.name!=="localhost") throw new Error("Use --network localhost with Hardhat node running");
  const {serviceCommitment}=await import("../../services/prover/service-policy-input.mjs");
  const policy = {disputeWindow:"3600",maxRefund:"7500000000000000",nonce:"0x"+randomBytes(16).toString("hex")};
  const d = await deployDay2({
    verifierName:"ServicePolicyUltraVerifier",
    policyCommitmentFor:(id,version)=>serviceCommitment(id,version,policy),
  });
  const paid = await d.buy("paid-api-"+randomUUID());
  const disputed = await d.buy("disputed-api-"+randomUUID());
  const caseId = await d.open(disputed);
  const manifest = {chainId:31337,contracts:{}};
  for (const [name, contract] of Object.entries(d.contracts)) {
    const {abi}=await artifacts.readArtifact(name);
    manifest.contracts[name]={abi,address:await contract.getAddress()};
  }
  const output = process.env.DAY2_OUTPUT_DIR || path.resolve(__dirname,"../../.runtime/day2");
  await fs.mkdir(output,{recursive:true});
  const mockArtifact=await artifacts.readArtifact("V2MockMessenger");
  manifest.contracts.L1MockMessenger={abi:mockArtifact.abi,address:await d.l1Messenger.getAddress()};
  await fs.writeFile(path.join(output,"day2-local.json"), JSON.stringify(manifest,null,2));
  await fs.writeFile(path.join(output,"day2-api-fixture.json"),
    JSON.stringify({paid,disputed,caseId,buyer:d.buyer.address},null,2));
  await fs.writeFile(path.join(output,"day2-mock-policy.json"),JSON.stringify(policy,null,2));
  console.log({paid,disputed,caseId,buyer:d.buyer.address,manifest:path.join(output,"day2-local.json")});
}
main().catch(error=>{console.error(error);process.exitCode=1;});

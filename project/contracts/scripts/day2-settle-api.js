const { ethers,network } = require("hardhat");
const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  if(network.name!=="localhost" || (await ethers.provider.getNetwork()).chainId!==31337n)
    throw new Error("Use local Hardhat network");
  const folder=process.env.DAY2_OUTPUT_DIR || path.resolve(__dirname,"../../.runtime/day2");
  const read=async file=>JSON.parse(await fs.readFile(file,"utf8"));
  const manifest=await read(path.join(folder,"day2-local.json"));
  const fixture=await read(path.join(folder,"day2-api-fixture.json"));
  const data=await read(process.env.DAY2_CASE_PROOF || path.join(folder,"day2-case-proof.json"));
  const {caseId,disputed}=fixture;
  const [,,,reviewer]=await ethers.getSigners();
  const get=name=>new ethers.Contract(manifest.contracts[name].address,manifest.contracts[name].abi,reviewer);
  const manager=get("DisputeManager"), sender=get("DisputeResultSender"), gate=get("ProofGate");
  const orders=get("ServiceOrderManager"), escrow=get("SettlementEscrow");
  const receiver=get("DisputeResultReceiver"), messenger=get("V2MockMessenger"), l1=get("L1MockMessenger");
  const send=async tx=>(await tx).wait();
  const load=async()=>manager.getCase(caseId);
  let item=await load();
  const refund=BigInt(data.publicInputs[11]), nullifier=data.publicInputs[12];
  if(item.claim.orderId!==disputed ||
      !await gate.verify(item.claim.toObject(),refund,nullifier,data.proof))
    throw new Error("Proof does not verify against the live case");

  if(item.status===1n){await send(manager.startAnalysis(caseId));item=await load();}
  if(item.status===2n){await send(manager.submitProof(caseId,refund,nullifier,data.proof));item=await load();}
  if(item.proofRef!==ethers.keccak256(data.proof) || item.payoutAmount!==refund)
    throw new Error("Case already contains a different verified proof");
  if(item.status===3n){await send(manager.beginReview(caseId));item=await load();}
  if(item.status===4n){await send(manager.decide(caseId,true,ethers.id("local-review")));item=await load();}
  if(item.status!==5n) throw new Error("Case is not approved");
  if(!await sender.sent(caseId)) await send(sender.sendResolution(caseId));
  if((await orders.orders(disputed)).status===4n){
    await send(messenger.deliver(receiver,await receiver.peerBlockchainID(),sender,await l1.lastPayload()));
  }
  console.log({
    caseId,orderStatus:Number((await orders.orders(disputed)).status),
    refundWei:String(refund),buyerClaimableWei:String(await escrow.claimable(fixture.buyer)),
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});

// Uses a real external ICM relayer; never directly calls receiveTeleporterMessage.
const hre=require('hardhat');const {ethers}=hre;const fs=require('fs');const path=require('path');
const file=path.resolve(__dirname,'../../docs/icm-roundtrip.json');
const cfg=require('../../infra/avalanche-l1/network-config.json');
async function main(){
 const artifact=await hre.artifacts.readArtifact('TeleporterPingPong');
 const endpoints=[process.env.FUJI_RPC_URL||'https://api.avax-test.network/ext/bc/C/rpc',process.env.DISPUTE_L1_RPC_URL||cfg.rpcUrl];
 const ids=['0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5',cfg.blockchainIdBytes32];
 const providers=endpoints.map(url=>new ethers.JsonRpcProvider(url,undefined,{polling:true,batchMaxCount:1}));
 const wallets=providers.map(p=>new ethers.Wallet(process.env.PRIVATE_KEY,p));
 let result=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)): {apps:[],directions:[]};
 const save=()=>fs.writeFileSync(file,JSON.stringify(result,null,2));
 try{
 for(let i=0;i<2;i++){
  if((await providers[i].getNetwork()).chainId!==[43113n,662831n][i])throw new Error('Wrong chain');
  if(!result.apps[i]){
   const app=await new ethers.ContractFactory(artifact.abi,artifact.bytecode,wallets[i]).deploy('0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf');await app.waitForDeployment();
   result.apps[i]={address:await app.getAddress(),deployTx:app.deploymentTransaction().hash};save();
  }
 }
 const apps=result.apps.map((a,i)=>new ethers.Contract(a.address,artifact.abi,wallets[i]));
 for(let i=0;i<2;i++){if(await apps[i].peer()===ethers.ZeroAddress){await (await apps[i].setPeer(ids[1-i],result.apps[1-i].address)).wait();}}
 for(let i=0;i<2;i++){
  if(result.directions[i]?.verified)continue;
  if(!result.directions[i]){
   const tx=await apps[i].send('Day 1 real ICM '+i);const r=await tx.wait();
   const sent=r.logs.map(l=>{try{return apps[i].interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='Sent');
   result.directions[i]={sourceTx:tx.hash,messageID:sent.args.messageID,payloadID:sent.args.payloadID,destinationStart:await providers[1-i].getBlockNumber()};save();
  }
  const direction=result.directions[i];
  if(!await apps[1-i].received(direction.payloadID))throw new Error('WAITING FOR REAL RELAYER: direction '+i+'; rerun later without resending');
  const logs=await apps[1-i].queryFilter(apps[1-i].filters.Received(direction.payloadID),direction.destinationStart,'latest');
  if(!logs.length)throw new Error('Missing destination event');
  const messenger=new ethers.Contract('0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf',['function messageReceived(bytes32) view returns(bool)'],providers[1-i]);
  if(!await messenger.messageReceived(direction.messageID))throw new Error('Messenger did not confirm message');
  direction.destinationTx=logs[0].transactionHash;direction.verified=true;save();
 }
 console.log('Both directions verified',result);
 }finally{providers.forEach(p=>p.destroy());}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

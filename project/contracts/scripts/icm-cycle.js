const hre=require('hardhat');const {ethers}=hre;const fs=require('fs');const path=require('path');const {spawn,spawnSync}=require('child_process');
const {root,chains,signer,prepareConfig}=require('../../services/relayer-monitor/icm-runtime');
const file=path.join(root,'docs/icm-v2.json');
const messenger='0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
const chainIDs=['0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5','0x1ac4f03783f66f0733d25e7b8df833da1d739e7b20404cd2cfd867bf1d270539'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const forwardOnly=process.argv.includes('--forward-only');
 const containerName=forwardOnly?'warranty-icm-forward':'warranty-icm-v184';
 const healthURL=`http://127.0.0.1:${forwardOnly?8082:8080}/health`;
 const providers=chains.map(c=>{const request=new ethers.FetchRequest(c['rpc-url']);request.timeout=20000;return new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1,polling:true});});
 let child;
 try{
 const wallets=providers.map(p=>new ethers.Wallet(process.env.PRIVATE_KEY,p));
 for(let i=0;i<2;i++)if((await providers[i].getNetwork()).chainId!==[43113n,662831n][i])throw new Error('Testnet chain ID mismatch');
 const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{apps:[],rounds:[]};
 const save=()=>fs.writeFileSync(file,JSON.stringify(state,null,2));
 const artifacts=await Promise.all(['PingSenderV2','PongReceiverV2'].map(n=>hre.artifacts.readArtifact(n)));
 for(let i=0;i<2;i++){
 if(!state.apps[i]){
 const app=await new ethers.ContractFactory(artifacts[i].abi,artifacts[i].bytecode,wallets[i]).deploy(messenger);
 await app.waitForDeployment();const receipt=await app.deploymentTransaction().wait();
 state.apps[i]={name:['PingSenderV2','PongReceiverV2'][i],address:await app.getAddress(),deployTx:receipt.hash,block:receipt.blockNumber};save();
 }}
 const apps=state.apps.map((a,i)=>new ethers.Contract(a.address,artifacts[i].abi,wallets[i]));
 for(let i=0;i<2;i++){
 if(await apps[i].peer()===ethers.ZeroAddress)await(await apps[i].setPeer(chainIDs[1-i],state.apps[1-i].address)).wait();
 if((await apps[i].peer()).toLowerCase()!==state.apps[1-i].address.toLowerCase()||await apps[i].peerBlockchainID()!==chainIDs[1-i])throw new Error('Peer mismatch');
 }
 const operator=signer();state.relayerAddress=operator.address;save();
 for(let i=0;i<2;i++){
 const target=ethers.parseEther(i===0?'0.03':'0.2'),balance=await providers[i].getBalance(operator.address);
 if(balance<target){const tx=await wallets[i].sendTransaction({to:operator.address,value:target-balance});await tx.wait();console.log('Funded testnet relayer',i,tx.hash);}
 }
 prepareConfig(state,{forwardOnly});
 if(process.argv.includes('--prepare')){console.log('Prepared',state.apps,'Relayer:',operator.address);return;}
 let health=false;try{health=(await fetch(healthURL,{signal:AbortSignal.timeout(1500)})).ok;}catch{}
 if(!health){
 const running=spawnSync('docker',['ps','--filter',`name=^${containerName}$`,'--format','{{.Names}}'],{encoding:'utf8',windowsHide:true});
 if(!running.stdout?.trim())child=spawn(process.execPath,[path.join(root,'services/relayer-monitor/relayer.js'),...(forwardOnly?['--forward-only']:[])],{stdio:'inherit',windowsHide:true});
 const readyUntil=Date.now()+90000;
 while(Date.now()<readyUntil){if(child&&child.exitCode!==null)throw new Error('Official relayer exited before ready');try{if((await fetch(healthURL,{signal:AbortSignal.timeout(2000)})).ok){health=true;break;}}catch{}await pause(2500);}
 if(!health)throw new Error('Official relayer not healthy; inspect P2P/WS/config logs. No fallback used.');
 }
 let round=state.rounds.find(r=>!r.verified);
 if(!round){
 const receipt=await(await apps[0].sendPing('Authenticated ICM roundtrip '+new Date().toISOString())).wait();
 const sent=receipt.logs.map(l=>{try{return apps[0].interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='PingSent');
 round={roundTripId:sent.args.roundTripId,pingMessageID:sent.args.messageID,sourceTx:receipt.hash,sourceBlock:receipt.blockNumber};state.rounds.push(round);save();console.log('SOURCE CONFIRMED',round);
 }
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){
 const received=await apps[1].received(round.roundTripId);
 if(received&&!round.l1ReceiveTx){
 const logs=await apps[1].queryFilter(apps[1].filters.PongReceived(round.roundTripId),state.apps[1].block,'latest');
 if(logs.length)round.l1ReceiveTx=logs[0].transactionHash;
 round.pongMessageID=await apps[1].replyMessageIDs(round.roundTripId);save();console.log('L1 received / emitted reply',round);
 }
 if(forwardOnly&&received){
 const ms=new ethers.Contract(messenger,['function messageReceived(bytes32) view returns(bool)'],providers[1]);
 if(!round.l1ReceiveTx||!await ms.messageReceived(round.pingMessageID))throw new Error('Forward Messenger confirmation missing');
 round.forwardVerified=true;save();console.log('VERIFIED REAL ICM FUJI -> L1 ONLY; return still requires verification',round);return;
 }
 if(await apps[0].completed(round.roundTripId)){
 const logs=await apps[0].queryFilter(apps[0].filters.ReplyReceived(round.roundTripId),round.sourceBlock,'latest');
 if(!logs.length)throw new Error('No application reply receipt');
 const ms=providers.map(p=>new ethers.Contract(messenger,['function messageReceived(bytes32) view returns(bool)'],p));
 if(!round.pongMessageID||!await ms[1].messageReceived(round.pingMessageID)||!await ms[0].messageReceived(round.pongMessageID))throw new Error('Messenger confirmation missing');
 round.fujiReplyTx=logs[0].transactionHash;round.verified=true;round.verifiedAt=new Date().toISOString();save();console.log('VERIFIED REAL ICM BOTH DIRECTIONS',round);return;
 }
 console.log(received?'Awaiting L1 -> Fuji':'Awaiting Fuji -> L1');await pause(5000);
 }
 throw new Error('PENDING_RELAY; progress saved, rerun without resending');
 }finally{providers.forEach(p=>p.destroy());if(child){spawnSync('docker',['stop','-t','5',containerName],{stdio:'ignore',windowsHide:true});}}
}
main().catch(e=>{console.error(e.shortMessage||e.message);process.exitCode=1;});


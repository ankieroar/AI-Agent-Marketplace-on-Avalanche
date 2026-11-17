const {ethers}=require('ethers');const fs=require('fs');const path=require('path');
require('dotenv').config({path:path.resolve(__dirname,'../../.env')});
async function main(){
 const config=require('../../infra/avalanche-l1/network-config.json');
 const results=[];
 for(const [name,url] of [['fuji',process.env.FUJI_RPC_URL||'https://api.avax-test.network/ext/bc/C/rpc'],['disputeL1',process.env.DISPUTE_L1_RPC_URL||config.rpcUrl]]){
 const request=new ethers.FetchRequest(url);request.timeout=15000;
 const p=new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1,polling:true});
 try{const address=new ethers.Wallet(process.env.PRIVATE_KEY).address;const messenger='0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
 const [network,block,balance,code]=await Promise.all([p.getNetwork(),p.getBlockNumber(),p.getBalance(address),p.getCode(messenger)]);
 results.push({name,chainId:String(network.chainId),block,wallet:address,balance:ethers.formatEther(balance),messenger,codeBytes:(code.length-2)/2,codeHash:ethers.keccak256(code)});
 }catch(e){results.push({name,error:e.shortMessage||e.message});}finally{p.destroy();}
 }
 fs.mkdirSync(path.resolve(__dirname,'../../docs'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../../docs/day1-chain-audit.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});


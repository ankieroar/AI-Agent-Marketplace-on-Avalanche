// Launch the official ICM relayer; never deliver by directly calling an app receiver.
const fs=require('fs');const path=require('path');const {spawn}=require('child_process');
const {root,dir,chains,prepareConfig}=require('./icm-runtime');
const {startProxy}=require('./fuji-rpc-proxy');
const manifest=path.join(root,'docs/icm-v2.json');
if(!fs.existsSync(manifest)){console.error('Run npm run icm:prepare from project/contracts first.');process.exit(1);}
const state=JSON.parse(fs.readFileSync(manifest));
const forwardOnly=process.argv.includes('--forward-only');
console.log('Official ICM relayer signer:',prepareConfig(state,{forwardOnly}));
console.log(forwardOnly?'Direction: Fuji -> L1 only':'Directions: Fuji <-> L1');
const args=['run','--rm','--name',forwardOnly?'warranty-icm-forward':'warranty-icm-v184','--env-file',path.join(dir,'relay.env'),'-p',forwardOnly?'127.0.0.1:8082:8082':'127.0.0.1:8080:8080','-v',root.replace(/\\/g,'/')+':/work','warranty-icm:1.8.4','--config-file',forwardOnly?'/work/.runtime/icm/config-forward.json':'/work/.runtime/icm/config.json'];
async function main(){
 const server=await startProxy(process.env.FUJI_RELAYER_RPC_URL||'https://avalanche-fuji-c-chain-rpc.publicnode.com',forwardOnly?8548:8547);
 try{
  process.exitCode=await new Promise((resolve,reject)=>{
   const child=spawn('docker',args,{stdio:'inherit',windowsHide:true});
   child.once('error',reject);child.once('exit',code=>resolve(code??1));
  });
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

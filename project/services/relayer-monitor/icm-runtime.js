const {ethers}=require('ethers');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'../..');require('dotenv').config({path:path.join(root,'.env')});
const dir=path.join(root,'.runtime/icm');fs.mkdirSync(dir,{recursive:true});
const config=require('../../infra/icm/relayer-config.json');
const chains=[config['fuji-c-chain'],config['dispute-l1']];
chains[0]['rpc-url']=process.env.FUJI_RPC_URL||chains[0]['rpc-url'];
chains[1]['rpc-url']=process.env.DISPUTE_L1_RPC_URL||chains[1]['rpc-url'];
function signer(){
 const file=path.join(dir,'signer.json');
 if(!fs.existsSync(file)){const w=ethers.Wallet.createRandom();fs.writeFileSync(file,JSON.stringify({address:w.address,privateKey:w.privateKey}),{mode:0o600});}
 return JSON.parse(fs.readFileSync(file));
}
function prepareConfig(state,{forwardOnly=false}={}){
 const wallet=signer();
 const messenger='0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf';
 const cfg={'log-level':'info','storage-location':'/work/.runtime/icm/state','p-chain-api':{'base-url':'https://api.avax-test.network'},'info-api':{'base-url':'https://api.avax-test.network'},'api-port':8080,'metrics-port':9090,'initial-connection-timeout-seconds':60,'max-concurrent-messages':2,'process-missed-blocks':true,
 'source-blockchains':chains.map((c,i)=>({'subnet-id':c['subnet-id'],'blockchain-id':c['blockchain-id'],'rpc-endpoint':{'base-url':c['rpc-url']},'ws-endpoint':{'base-url':process.env[i===0?'FUJI_WS_URL':'DISPUTE_L1_WS_URL']||c['ws-url']},'message-contracts':{[messenger]:{'message-format':'teleporter',settings:{'reward-address':wallet.address}}},'supported-destinations':[{'blockchain-id':chains[1-i]['blockchain-id'],addresses:[state.apps[1-i].address]}],'allowed-origin-sender-addresses':[state.apps[i].address],'process-historical-blocks-from-height':Math.max(1,state.apps[i].block)})),
 'destination-blockchains':chains.map(c=>({'subnet-id':c['subnet-id'],'blockchain-id':c['blockchain-id'],'rpc-endpoint':{'base-url':c['rpc-url']},'block-gas-limit':8000000}))};
 if(process.env.L1_VALIDATOR_P2P){
  const endpoint=process.env.L1_VALIDATOR_P2P;
  const parsed=new URL('tcp://'+endpoint);
  if(!require('net').isIP(parsed.hostname.replace(/^\[|\]$/g,''))||!parsed.port)throw new Error('L1_VALIDATOR_P2P must be an IP:port');
  cfg['manually-tracked-peers']=[{id:process.env.L1_VALIDATOR_NODE_ID||'NodeID-Fvet9DW7LD65DL8ek1de49xBXUiJJgEt4',ip:endpoint}];
 }
 if(forwardOnly){
  cfg['source-blockchains']=cfg['source-blockchains'].slice(0,1);
  cfg['destination-blockchains']=cfg['destination-blockchains'].slice(1);
  cfg['storage-location']='/work/.runtime/icm/state-forward';
  cfg['api-port']=8082;
 }
 cfg['source-blockchains'][0]['rpc-endpoint']['base-url']=`http://host.docker.internal:${forwardOnly?8548:8547}`;
 fs.writeFileSync(path.join(dir,forwardOnly?'config-forward.json':'config.json'),JSON.stringify(cfg,null,2));
 fs.writeFileSync(path.join(dir,'relay.env'),'ACCOUNT_PRIVATE_KEY='+wallet.privateKey.replace(/^0x/,'')+'\n',{mode:0o600});
 return wallet.address;
}
module.exports={root,dir,chains,signer,prepareConfig};


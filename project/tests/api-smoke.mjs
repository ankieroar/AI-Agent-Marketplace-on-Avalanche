import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
const port=3301;
const child=spawn(process.execPath,['--env-file=.env','apps/api/src/server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','ignore','ignore']});
const base='http://127.0.0.1:'+port;
try{
 let ready=false;for(let i=0;i<40;i++){try{const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
 assert.equal(ready,true,'API/database readiness');
 assert.equal((await fetch(base+'/evidence/anything')).status,401);
 const headers={Authorization:'Bearer '+process.env.API_ACCESS_TOKEN,'Content-Type':'application/json'};
 assert.equal((await fetch(base+'/evidence',{method:'POST',headers,body:JSON.stringify({bad:true})})).status,400);
 console.log('PASS: HTTP health with real DB, unauthorized request rejected, malformed payload rejected');
}finally{child.kill();}

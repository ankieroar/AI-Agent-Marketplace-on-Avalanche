import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { pool } from '../apps/api/src/db.mjs';

const base = 'http://127.0.0.1:'+(process.env.PORT||3001)+'/api';
const chain = new ethers.JsonRpcProvider(process.env.DAY2_RPC_URL || 'http://127.0.0.1:8545');
const fixture = JSON.parse(await readFile(process.argv[2] ||
  new URL('../.runtime/day2/day2-api-fixture.json',import.meta.url),'utf8'));
const buyer = await chain.getSigner(fixture.buyer);
const outsider = await chain.getSigner(4);
const {scope,agents} = await (await fetch(base+'/agents')).json();
assert(agents.some(a=>a.active && a.agentId===ethers.id('document-summary')));

async function request(endpoint,action,id,body,signer=buyer) {
  const expires=Math.floor(Date.now()/1000)+240;
  const json=JSON.stringify(body);
  const digest=createHash('sha256').update(json).digest('hex');
  const signature=await signer.signMessage(['Warranty Day 2 request',scope,action,id,String(expires),digest].join('\n'));
  const result=await fetch(base+endpoint,{method:'POST',body:json,headers:{
    'Content-Type':'application/json','X-Wallet-Expires':String(expires),'X-Wallet-Signature':signature,
  }});
  return {status:result.status,data:await result.json()};
}

try {
  const paid=await(await fetch(base+'/orders/'+fixture.paid)).json();
  assert.equal(paid.status,1);
  const url='/orders/'+fixture.paid+'/execute';
  const resultUrl='/orders/'+fixture.paid+'/result';
  const chatUrl='/orders/'+fixture.paid+'/chat';
  const retryUrl='/orders/'+fixture.paid+'/retry';
  const body={text:'Synthetic order 001: delivery takes a day; start time is unspecified.'};
  assert.equal((await request(resultUrl,'read-result',fixture.paid,{})).status,409);
  assert.equal((await request(retryUrl,'retry-execute',fixture.paid,{})).status,409);
  assert.equal((await request(url,'execute',fixture.paid,body,outsider)).status,403);
  const completed=await request(url,'execute',fixture.paid,body);
  assert.equal(completed.status,200,JSON.stringify(completed.data));
  assert.equal(completed.data.status,'DELIVERED');
  const repeated=await request(url,'execute',fixture.paid,body);
  assert.equal(repeated.data.resultHash,completed.data.resultHash);
  assert.equal((await request(resultUrl,'read-result',fixture.paid,{},outsider)).status,403);
  const loaded=await request(resultUrl,'read-result',fixture.paid,{});
  assert.equal(loaded.status,200);
  assert.deepEqual(loaded.data.result,completed.data.result);
  assert.equal(loaded.data.resultHash,completed.data.resultHash);
  assert.equal(loaded.data.document,body.text);
  assert.equal((await request(retryUrl,'retry-execute',fixture.paid,{},outsider)).status,403);
  const retried=await request(retryUrl,'retry-execute',fixture.paid,{});
  assert.equal(retried.status,200);
  assert.equal(retried.data.resultHash,completed.data.resultHash);
  const chat={messages:[{role:'user',content:'How long does delivery take?'}]};
  assert.equal((await request(chatUrl,'order-chat',fixture.paid,chat,outsider)).status,403);
  assert.equal((await request(chatUrl,'chat',fixture.paid,chat)).status,403);
  assert.equal((await fetch(base+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(chat)})).status,404);
  const list=await(await fetch(base+'/buyers/'+fixture.buyer+'/orders')).json();
  assert.equal(list.scope,scope);
  assert(list.orders.some(order=>order.orderId===fixture.paid));
  assert(!JSON.stringify(list).includes(body.text));
  assert.equal((await request(url,'execute',fixture.paid,{text:'Different input'})).status,409);
  assert.equal((await request('/orders/'+fixture.disputed+'/execute','execute',fixture.disputed,body)).status,409);
  const upload={caseId:fixture.caseId,text:'Synthetic evidence 001: missing start time.'};
  const evidence=await request('/cases/upload','upload',fixture.caseId,upload);
  assert.equal(evidence.status,201,JSON.stringify(evidence.data));
  const repeatedEvidence=await request('/cases/upload','upload',fixture.caseId,upload);
  assert.equal(repeatedEvidence.status,201,JSON.stringify(repeatedEvidence.data));
  assert.equal(repeatedEvidence.data.id,evidence.data.id);
  const {rows:[saved]}=await pool.query('SELECT encrypted FROM evidence WHERE id=$1',[evidence.data.id]);
  assert(saved.encrypted.iv && saved.encrypted.tag && saved.encrypted.data);
  assert(!JSON.stringify(saved.encrypted).includes(upload.text));
  console.log('Day 2 API smoke passed: real Hardhat orders, wallet authorization, idempotency and encrypted PostgreSQL storage. AI mode: '+completed.data.mode);
} finally {
  await pool.end();
  chain.destroy();
}

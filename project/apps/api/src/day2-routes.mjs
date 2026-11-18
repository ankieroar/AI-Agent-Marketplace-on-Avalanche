import { createHash, randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { z } from 'zod';
import express from 'express';
import { pool } from './db.mjs';
import { encrypt, decrypt } from './crypto.mjs';
import { ApiError, day2Chain } from './day2-chain.mjs';
import { mockSummary, summarizeDocument } from '@warranty/agents';
import { summaryInputSchema } from '@warranty/schema';

const hexId = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s=>s.toLowerCase());
const evidenceInput = z.object({caseId:hexId,text:z.string().trim().min(1).max(30000)}).strict();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wrap = handler => (req,res,next) => Promise.resolve(handler(req,res)).catch(next);
const buckets = new Map();
let minute = 0;

export function authMessage(scope, action, id, expires, input) {
  return ['Warranty Day 2 request',scope,action,id,String(expires),digest(input)].join('\n');
}
function wallet(req,scope,action,id,input) {
  const expires = Number(req.get('X-Wallet-Expires'));
  const now = Math.floor(Date.now()/1000);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + 300) {
    throw new ApiError(401,'Signature expired or missing');
  }
  try {
    return ethers.verifyMessage(authMessage(scope,action,id,expires,input),req.get('X-Wallet-Signature')).toLowerCase();
  } catch {
    throw new ApiError(401,'Invalid wallet signature');
  }
}
function rateLimit(owner,action) {
  const current = Math.floor(Date.now()/60_000);
  if (current !== minute) { buckets.clear(); minute=current; }
  const key = action+':'+owner;
  const walletCount = buckets.get(key) ?? 0;
  const total = buckets.get('total') ?? 0;
  if (walletCount >= 5 || total >= 20) throw new ApiError(429,'Local execution rate limit');
  buckets.set(key,walletCount+1);
  buckets.set('total',total+1);
}
async function saveOrder(order) {
  await pool.query(`INSERT INTO service_orders(order_id,buyer,snapshot) VALUES($1,$2,$3)
    ON CONFLICT(order_id) DO UPDATE SET snapshot=excluded.snapshot, updated_at=now()`,
  [order.orderId,order.buyer,order]);
}

export const day2Routes = express.Router();
day2Routes.get('/agents',wrap(async (req,res)=>{
  const chain = await day2Chain();
  const listings = await chain.agents();
  for (const listing of listings) {
    await pool.query(`INSERT INTO agent_listings_cache(agent_id,listing) VALUES($1,$2)
      ON CONFLICT(agent_id) DO UPDATE SET listing=excluded.listing,updated_at=now()`,[listing.agentId,listing]);
  }
  res.json({scope:chain.scope,agents:listings});
}));
day2Routes.get('/orders/:id',wrap(async (req,res)=>{
  const id=hexId.parse(req.params.id);
  const chain=await day2Chain();
  const order=await chain.order(id);
  if(!order) throw new ApiError(404,'Confirmed order not found');
  await saveOrder(order);
  const {rows:[job]}=await pool.query('SELECT status,result_hash,mode FROM agent_outputs WHERE order_id=$1',[id]);
  res.json({scope:chain.scope,...order,execution:job??null});
}));
day2Routes.post('/orders/:id/execute',wrap(async (req,res)=>{
  const id=hexId.parse(req.params.id);
  const body=summaryInputSchema.parse(req.body);
  const chain=await day2Chain();
  const owner=wallet(req,chain.scope,'execute',id,body);
  const order=await chain.order(id);
  if(!order) throw new ApiError(404,'Confirmed order not found');
  if(order.buyer!==owner) throw new ApiError(403,'Only the confirmed buyer can execute');
  if(order.warranty || order.agentId!==ethers.id('document-summary') || BigInt(order.priceWei)<=0n)
    throw new ApiError(409,'Service order is not eligible');
  rateLimit(owner,'execute');
  await saveOrder(order);

  const mode=process.env.DAY2_AI_MODE==='mock'?'mock':'openrouter';
  const hash=digest(body), attempt=randomUUID();
  if (order.status===1) {
    const {rowCount}=await pool.query(`INSERT INTO agent_outputs(order_id,input_hash,attempt,status,lease_until,mode)
      VALUES($1,$2,$3,'running',now()+interval '2 minutes',$4)
      ON CONFLICT(order_id) DO UPDATE SET status='running',attempt=excluded.attempt,
      lease_until=excluded.lease_until,mode=excluded.mode
      WHERE agent_outputs.input_hash=excluded.input_hash AND
      (agent_outputs.status='failed' OR (agent_outputs.status='running' AND agent_outputs.lease_until<now()))`,
    [id,hash,attempt,mode]);
    if (rowCount) {
      try {
        const result=mode==='mock'?mockSummary(body.text):await summarizeDocument(body.text);
        const resultHash=ethers.id(JSON.stringify(result));
        const stored=await pool.query(`UPDATE agent_outputs SET status='delivered',encrypted=$3,result_hash=$4
          WHERE order_id=$1 AND attempt=$2`,[id,attempt,encrypt(result,process.env.AES_KEY_HEX,'agent-output:'+id),resultHash]);
        if (!stored.rowCount) throw new ApiError(409,'Execution lease expired. Read the current result.');
        return res.json({orderId:id,status:'DELIVERED',mode,result,resultHash});
      } catch(e) {
        await pool.query("UPDATE agent_outputs SET status='failed' WHERE order_id=$1 AND attempt=$2 AND status='running'",[id,attempt]);
        throw e;
      }
    }
  }
  const {rows:[job]}=await pool.query('SELECT * FROM agent_outputs WHERE order_id=$1',[id]);
  if(!job || job.input_hash!==hash) throw new ApiError(409,'Order is not executable with this input');
  if(job.status==='running') return res.status(202).json({orderId:id,status:'RUNNING'});
  if(job.status!=='delivered') throw new ApiError(409,'Order is no longer executable');
  res.json({orderId:id,status:'DELIVERED',mode:job.mode,
    result:decrypt(job.encrypted,process.env.AES_KEY_HEX,'agent-output:'+id),resultHash:job.result_hash});
}));
day2Routes.post('/cases/upload',wrap(async (req,res)=>{
  const body=evidenceInput.parse(req.body);
  const chain=await day2Chain();
  const owner=wallet(req,chain.scope,'upload',body.caseId,body);
  const claim=await chain.claim(body.caseId);
  if(!claim) throw new ApiError(404,'Case not found');
  const order=await chain.order(claim.orderId);
  if(!order || order.buyer!==owner) throw new ApiError(403,'Only the case buyer can upload');
  if(order.caseId!==body.caseId || order.status!==4 || claim.status>4) throw new ApiError(409,'Case is closed');
  rateLimit(owner,'upload');
  await saveOrder(order);
  await pool.query('INSERT INTO cases(case_id,order_id,snapshot) VALUES($1,$2,$3) ON CONFLICT(case_id) DO UPDATE SET snapshot=excluded.snapshot',
    [body.caseId,order.orderId,claim]);
  const id=randomUUID();
  const key=digest([chain.scope,owner,body]);
  const {rows:[record]}=await pool.query(`INSERT INTO evidence(id,encrypted,case_id,request_key)
    VALUES($1,$2,$3,$4) ON CONFLICT(request_key) DO UPDATE SET request_key=excluded.request_key RETURNING id`,
  [id,encrypt({text:body.text},process.env.AES_KEY_HEX,id),body.caseId,key]);
  res.status(201).json({id:record.id,caseId:body.caseId});
}));

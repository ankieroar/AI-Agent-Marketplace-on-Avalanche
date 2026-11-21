import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { serviceCommitment } from '../../../services/prover/service-policy-input.mjs';
import { policyAad } from './seed-policy.mjs';
import { persistCheckoutPolicy } from './checkout-policy.mjs';
import { ethers } from 'ethers';
import { z } from 'zod';
import express from 'express';
import { pool } from './db.mjs';
import { encrypt } from './crypto.mjs';
import { ApiError, day2Chain, day2CaseChain } from './day2-chain.mjs';
import { chatWithModel, runPipeline } from '@warranty/agents';
import { policySchema, summaryInputSchema } from '@warranty/schema';
import {
  executeServiceOrder, readStoredServiceInput, readStoredServiceOutput, saveBuyerServiceRequest,
} from './service-executor.mjs';
import { prepareProof } from './prepare-proof.mjs';

const hexId = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s=>s.toLowerCase());
const evidenceInput = z.object({caseId:hexId,text:z.string().trim().min(1).max(30000)}).strict();
const prepareProofInput = z.object({
  refundWei:z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
}).strict();
const chatInput = z.object({messages:z.array(z.object({
  role:z.enum(['user','assistant']),content:z.string().trim().min(1).max(4000),
}).strict()).min(1).max(12)}).strict();
const orderChatInput = chatInput.refine(({ messages }) => messages.at(-1).role === 'user');
const emptyInput = z.object({}).strict();
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase());
const summaryAgentId = ethers.id('document-summary');
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
  const now = Date.now();
  const current = Math.floor(now/60_000);
  if (current !== minute) { buckets.clear(); minute=current; }
  const key = action+':'+owner;
  const walletCount = buckets.get(key) ?? 0;
  const isProof = action === 'prepare-proof';
  const totalKey = isProof ? 'total:prepare-proof' : 'total';
  const total = buckets.get(totalKey) ?? 0;
  if (walletCount >= 5 || total >= 20) {
    const seconds = Math.ceil(((current + 1) * 60_000 - now)/1000);
    const operation = isProof ? 'tạo proof' : 'gửi yêu cầu';
    throw new ApiError(429,`Đã đạt giới hạn ${operation}. Thử lại sau ${seconds} giây.`);
  }
  buckets.set(key,walletCount+1);
  buckets.set(totalKey,total+1);
}
async function saveOrder(order) {
  await pool.query(`INSERT INTO service_orders(order_id,buyer,snapshot) VALUES($1,$2,$3)
    ON CONFLICT(order_id) DO UPDATE SET snapshot=excluded.snapshot, updated_at=now()`,
  [order.orderId,order.buyer,order]);
  await persistCheckoutPolicy(pool,order);
}

function isSummaryOrder(order) {
  return order && !order.warranty && order.agentId === summaryAgentId && BigInt(order.priceWei) > 0n;
}

async function requireBuyerOrder(req, id, action, body) {
  const chain = await day2Chain();
  const owner = wallet(req, chain.scope, action, id, body);
  const order = await chain.order(id);
  if (!order) throw new ApiError(404, 'Confirmed order not found');
  if (order.buyer !== owner) throw new ApiError(403, 'Only the confirmed buyer can use this service order');
  if (!isSummaryOrder(order)) throw new ApiError(409, 'Service order is not eligible');
  rateLimit(owner, action);
  return order;
}

async function readBuyerWorkspace(order) {
  const { rows: [row] } = await pool.query(`SELECT ao.status, ao.mode, ao.encrypted, ao.result_hash,
      sr.ciphertext
    FROM agent_outputs ao
    LEFT JOIN service_requests sr ON sr.order_id=ao.order_id AND sr.input_hash=ao.input_hash AND sr.buyer=$2
    WHERE ao.order_id=$1`, [order.orderId, order.buyer]);
  const output = readStoredServiceOutput(row, order.orderId);
  const document = row.ciphertext ? readStoredServiceInput(row, order.orderId).text : undefined;
  return { ...output, document };
}

export const day2Routes = express.Router();
day2Routes.post('/dispute-preview',wrap(async(req,res)=>{
  rateLimit(req.ip || 'local','dispute-preview');
  const input=z.object({text:z.string().trim().min(1).max(30000),
    claimTimestamp:z.string().regex(/^[0-9]+$/),policy:policySchema}).strict().parse(req.body);
  res.json({mode:'openrouter_live',...await runPipeline(input)});
}));
day2Routes.post('/quote',wrap(async(req,res)=>{
  rateLimit(req.ip || 'local','quote');
  const positive = z.string().regex(/^[1-9][0-9]{0,38}$/);
  const quote = z.object({orderId:hexId,agentId:hexId,policyVersionHash:hexId,
    priceWei:positive,disputeWindow:positive.default('3600')}).strict().parse(req.body);
  const witness = {disputeWindow:quote.disputeWindow,
    maxRefund:String(BigInt(quote.priceWei)*3n/4n),nonce:'0x'+randomBytes(16).toString('hex')};
  const commitment = serviceCommitment(quote.orderId,quote.policyVersionHash,witness);
  await pool.query(`INSERT INTO pending_service_policies
    (order_id,commitment,agent_id,policy_version_hash,ciphertext) VALUES($1,$2,$3,$4,$5)`,
    [quote.orderId,commitment,quote.agentId,quote.policyVersionHash,
      encrypt(witness,process.env.AES_KEY_HEX,policyAad(quote.orderId))]);
  res.set('Cache-Control','no-store').json({orderId:quote.orderId,policyCommitment:commitment});
}));
day2Routes.get('/agents',wrap(async (req,res)=>{
  const chain = await day2Chain();
  const listings = await chain.agents();
  for (const listing of listings) {
    await pool.query(`INSERT INTO agent_listings_cache(agent_id,listing) VALUES($1,$2)
      ON CONFLICT(agent_id) DO UPDATE SET listing=excluded.listing,updated_at=now()`,[listing.agentId,listing]);
  }
  res.json({scope:chain.scope,agents:listings});
}));
day2Routes.get('/buyers/:address/orders',wrap(async (req,res)=>{
  const buyer = evmAddress.parse(req.params.address);
  const chain = await day2Chain();
  const { rows } = await pool.query(
    'SELECT order_id FROM service_orders WHERE buyer=$1 ORDER BY updated_at DESC, order_id LIMIT 20',
    [buyer],
  );
  // The local index locates candidates. The current chain determines which
  // orders belong to this wallet and are available for this deployment.
  const confirmed = await Promise.all(rows.map(row => chain.order(row.order_id)));
  const orders = confirmed.filter(order => isSummaryOrder(order) && order.buyer === buyer)
    .map(({ orderId, agentId, priceWei, status }) => ({ orderId, agentId, priceWei, status }));
  res.set('Cache-Control', 'no-store').json({ scope: chain.scope, orders });
}));
day2Routes.get('/orders/:id',wrap(async (req,res)=>{
  const id=hexId.parse(req.params.id);
  const chain=await day2Chain();
  const order=await chain.order(id);
  if(!order) throw new ApiError(404,'Confirmed order not found');
  await saveOrder(order);
  const {rows:[job]}=await pool.query('SELECT status,result_hash,mode FROM agent_outputs WHERE order_id=$1',[id]);
  const {rows:[request]}=await pool.query(
    'SELECT source,input_hash,created_at FROM service_requests WHERE order_id=$1 AND buyer=$2',[id,order.buyer]);
  const {rows:[caseJob]}=await pool.query(
    'SELECT status,attempts,payout_amount,proof_hash,start_tx_hash,proof_tx_hash,last_error,updated_at FROM case_jobs WHERE order_id=$1',[id]);
  res.json({scope:chain.scope,...order,execution:job??null,
    request:request??null,case:caseJob??null});
}));
day2Routes.get('/cases/:id',wrap(async (req,res)=>{
  const id=hexId.parse(req.params.id);
  const chain=await day2CaseChain();
  const claim=await chain.claim(id);
  if(!claim) throw new ApiError(404,'Case not found on the dispute chain');
  const {rows:[job]}=await pool.query(`SELECT status,attempts,payout_amount,nullifier,
    proof_hash,start_tx_hash,proof_tx_hash,last_error,updated_at
    FROM case_jobs WHERE case_id=$1`,[id]);
  res.json({scope:chain.scope,...claim,worker:job??null});
}));
day2Routes.post('/cases/:id/prepare-proof',wrap(async (req,res)=>{
  const caseId=hexId.parse(req.params.id);
  const body=prepareProofInput.parse(req.body ?? {});
  // Proof generation is CPU-expensive but non-privileged: the witness stays on
  // the server and no transaction is sent. Limit it per caller.
  rateLimit(req.ip || 'local','prepare-proof');
  const result=await prepareProof({
    caseId, refundWei:body.refundWei, pool,
    settlement:await day2Chain(), dispute:await day2CaseChain(),
  });
  res.json(result);
}));
day2Routes.post('/orders/:id/execute',wrap(async (req,res)=>{
  const id=hexId.parse(req.params.id);
  const body=summaryInputSchema.parse(req.body);
  const order=await requireBuyerOrder(req,id,'execute',body);
  await saveOrder(order);
  await saveBuyerServiceRequest({pool,orderId:id,buyer:order.buyer,input:body});

  const mode=process.env.DAY2_AI_MODE==='mock'?'mock':'openrouter';
  const result=await executeServiceOrder({pool,order,input:body,mode});
  res.status(result.status==='RUNNING'?202:200).json(result);
}));
day2Routes.post('/orders/:id/retry',wrap(async (req,res)=>{
  const id = hexId.parse(req.params.id);
  const body = emptyInput.parse(req.body);
  const order = await requireBuyerOrder(req,id,'retry-execute',body);
  const { rows: [row] } = await pool.query(
    'SELECT ciphertext FROM service_requests WHERE order_id=$1 AND buyer=$2', [id, order.buyer],
  );
  const input = readStoredServiceInput(row,id);
  const result = await executeServiceOrder({pool,order,input,mode:process.env.DAY2_AI_MODE});
  if (result.status === 'RUNNING') return res.status(202).json(result);
  res.set('Cache-Control', 'no-store').json({ ...result, document: input.text });
}));
day2Routes.post('/orders/:id/result',wrap(async (req,res)=>{
  const id = hexId.parse(req.params.id);
  const body = emptyInput.parse(req.body);
  const order = await requireBuyerOrder(req,id,'read-result',body);
  res.set('Cache-Control', 'no-store').json(await readBuyerWorkspace(order));
}));
day2Routes.post('/orders/:id/chat',wrap(async (req,res)=>{
  const id = hexId.parse(req.params.id);
  const body = orderChatInput.parse(req.body);
  const order = await requireBuyerOrder(req,id,'order-chat',body);
  const { document, result } = await readBuyerWorkspace(order);
  const answer = await chatWithModel(body,{orderContext:{document,summary:result}});
  res.set('Cache-Control', 'no-store').json({ orderId:id,...answer });
}));
day2Routes.post('/cases/upload',wrap(async (req,res)=>{
  const body=evidenceInput.parse(req.body);
  const chain=await day2Chain();
  const dispute=await day2CaseChain();
  const owner=wallet(req,chain.scope,'upload',body.caseId,body);
  const claim=await dispute.claim(body.caseId);
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

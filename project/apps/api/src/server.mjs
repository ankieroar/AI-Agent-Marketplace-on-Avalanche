import express from 'express';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {pool} from './db.mjs';
import {encrypt,decrypt} from './crypto.mjs';
import {AgentError,runPipeline} from '@warranty/agents';
import {policySchema} from '@warranty/schema';
import {ApiError} from './day2-chain.mjs';
import {day2Routes} from './day2-routes.mjs';
const app=express();app.use(express.json({limit:'64kb'}));
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({database:'ready'});}catch{res.status(503).json({database:'unavailable'});}});
app.use('/api',day2Routes,(_req,res)=>res.status(404).json({error:'Unknown Day 2 endpoint'}));
app.use((req,res,next)=>{
 const expected=process.env.API_ACCESS_TOKEN, supplied=req.get('Authorization')?.replace(/^Bearer /,'');
 if(!expected || !supplied || Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||!timingSafeEqual(Buffer.from(expected),Buffer.from(supplied))) return res.status(401).json({error:'Unauthorized'});
 next();
});
app.post('/evidence',async(req,res,next)=>{try{
 const body=z.object({text:z.string().min(1).max(30000)}).strict().parse(req.body);
 const id=randomUUID(),encrypted=encrypt(body,process.env.AES_KEY_HEX,id);
 await pool.query('INSERT INTO evidence(id,encrypted) VALUES($1,$2)',[id,encrypted]);res.status(201).json({id});
}catch(e){next(e);}});
app.get('/evidence/:id',async(req,res,next)=>{try{const id=z.string().uuid().parse(req.params.id);const {rows}=await pool.query('SELECT encrypted FROM evidence WHERE id=$1 AND case_id IS NULL',[id]);if(!rows.length)return res.sendStatus(404);res.json(decrypt(rows[0].encrypted,process.env.AES_KEY_HEX,id));}catch(e){next(e);}});
app.post('/pipeline',async(req,res,next)=>{try{const input=z.object({text:z.string().max(30000),policy:policySchema,claimTimestamp:z.string().regex(/^[0-9]+$/)}).strict().parse(req.body);res.json(await runPipeline(input));}catch(e){next(e);}});
app.use((e,req,res,next)=>{
 if(e instanceof ApiError || e instanceof AgentError) return res.status(e.status).json({error:e.message});
 if(e instanceof z.ZodError || e.type==='entity.parse.failed') return res.status(400).json({error:'Invalid schema'});
 if(e.type==='entity.too.large') return res.status(413).json({error:'Request too large'});
 return res.status(502).json({error:'Operation failed; check configuration'});
});
const port=Number(process.env.PORT||3001);
app.listen(port,'127.0.0.1',()=>console.log(`API on http://127.0.0.1:${port}`));


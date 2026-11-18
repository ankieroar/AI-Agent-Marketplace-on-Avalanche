import test from 'node:test';import assert from 'node:assert/strict';
import {encrypt,decrypt} from '../apps/api/src/crypto.mjs';
import {policyCommitment,evidenceSchema} from '@warranty/schema';
import {callAgent,runPipeline} from '@warranty/agents';
const key='ab'.repeat(32);
test('AES roundtrip, unique IV, rejects tampering / wrong record / wrong key',()=>{
 const a=encrypt({text:'private'},key,'case-a'),b=encrypt({text:'private'},key,'case-a');
 assert.notEqual(a.iv,b.iv);assert.deepEqual(decrypt(a,key,'case-a'),{text:'private'});
 assert.throws(()=>decrypt(a,key,'case-b'));assert.throws(()=>decrypt(a,'cd'.repeat(32),'case-a'));
 assert.throws(()=>decrypt({...a,data:'00'+a.data.slice(2)},key,'case-a'));
});
const policy={purchaseTimestamp:'1',warrantyEndTimestamp:'9',maxPayout:'100',nonce:'0x'+'11'.repeat(32)};
test('commitment binds policy and nonce',()=>{
 assert.notEqual(policyCommitment(policy),policyCommitment({...policy,maxPayout:'101'}));
 assert.notEqual(policyCommitment(policy),policyCommitment({...policy,nonce:'0x'+'22'.repeat(32)}));
 assert.throws(()=>policyCommitment({...policy,warrantyEndTimestamp:'0'}));
});
test('free-only rejects paid model before network',async()=>{
 process.env.OPENROUTER_MODEL='openai/paid';let called=false;
 await assert.rejects(callAgent('evidence',{},evidenceSchema,{fetchImpl:()=>{called=true;}}),/FREE_ONLY/);assert.equal(called,false);delete process.env.OPENROUTER_MODEL;
});
test('three-agent pipeline validates JSON and payout limits',async()=>{
 process.env.OPENROUTER_API_KEY='test-not-real';
 const outputs=[{purchaseDate:null,faultDescription:'screen failure',missingEvidence:['receipt']},{eligible:true,reasons:['review needed']},{proposedPayout:'50',reason:'partial refund',requiresHumanReview:true}];
 let calls=0;const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(outputs[calls++])}}]})});
 const result=await runPipeline({text:'broken screen',policy,claimTimestamp:'5'},{fetchImpl});assert.equal(calls,3);assert.equal(result.resolution.proposedPayout,'50');
 outputs[2].proposedPayout='101';calls=0;
 await assert.rejects(runPipeline({text:'broken',policy,claimTimestamp:'5'},{fetchImpl}),/exceeds/);
 await assert.rejects(callAgent('evidence',{},evidenceSchema,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'not json'}}]})})}));
 await assert.rejects(callAgent('evidence',{},evidenceSchema,{fetchImpl:async()=>({ok:false,status:429})}),{status:429});
 delete process.env.OPENROUTER_API_KEY;
});


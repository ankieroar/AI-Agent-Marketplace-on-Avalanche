import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runPipeline,summarizeDocument} from '@warranty/agents';

const canned=[
  {purchaseDate:'2026-01-01',faultDescription:'Missing section',missingEvidence:[]},
  {eligible:true,reasons:['Within the policy period']},
  {proposedPayout:'5',reason:'Incomplete service',requiresHumanReview:true},
];
const policy={purchaseTimestamp:'100',warrantyEndTimestamp:'200',maxPayout:'10',nonce:'0x'+'11'.repeat(32)};
const reply=content=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200});
const summary={summary:'The document is incomplete.',keyPoints:['A section is missing.'],caveats:[]};

test('Day 2 summary and dispute adapters validate JSON and propagate provider failures',async ()=>{
  process.env.OPENROUTER_API_KEY='fake-for-injected-fetch';
  process.env.OPENROUTER_MODEL='openrouter/free';
  const data=await summarizeDocument('Synthetic document',{fetchImpl:async(_,options)=>{
    const sent=JSON.parse(options.body);
    assert.equal(sent.model,'openrouter/free');
    assert.equal(sent.provider.max_price.completion,0);
    return reply(JSON.stringify(summary));
  }});
  assert.deepEqual(data,summary);
  let n=0;
  const pipeline=await runPipeline({text:'Synthetic evidence',policy,claimTimestamp:'150'},
    {fetchImpl:async(_,options)=>{
      assert(!options.body.includes(policy.nonce));
      return reply(JSON.stringify(canned[n++]));
    }});
  assert.equal(n,3);
  assert.deepEqual(pipeline.resolution,canned[2]);
  await assert.rejects(summarizeDocument('Sample',{fetchImpl:async()=>reply('oops')}),{status:502});
  await assert.rejects(summarizeDocument('Sample',{fetchImpl:async()=>new Response(null,{status:429})}),{status:429});
  await assert.rejects(summarizeDocument('Sample',{fetchImpl:async()=>{throw new DOMException('timeout','TimeoutError');}}),{status:504});
  await assert.rejects(runPipeline({text:'Sample',policy,claimTimestamp:'150'},{fetchImpl:async()=>{
    const next=[...canned.slice(0,2),{...canned[2],proposedPayout:'11'}];
    return reply(JSON.stringify(next[n++%3]));
  }}),/Payout exceeds policy/);
  process.env.OPENROUTER_MODEL='paid/model';
  await assert.rejects(summarizeDocument('Sample',{fetchImpl:async()=>{throw new Error('paid contact');}}),/FREE_ONLY/);
});

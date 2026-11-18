import { summarizeDocument,runPipeline } from '@warranty/agents';
try {
  const sample='Synthetic document: order 001 was purchased on 2026-01-01. One page of the summary is missing.';
  const summary=await summarizeDocument(sample);
  console.log(JSON.stringify({provider:'OpenRouter Free',summary},null,2));
  if(process.argv.includes('--pipeline')){
    const policy={purchaseTimestamp:'1767225600',warrantyEndTimestamp:'1767312000',
      maxPayout:'7500000000000000',nonce:'0x'+'11'.repeat(32)};
    const pipeline=await runPipeline({text:sample,policy,claimTimestamp:'1767230000'});
    console.log(JSON.stringify(pipeline,null,2));
  }
} catch(error){
  console.error(error.message);
  process.exitCode=1;
}

const hre=require('hardhat');const fs=require('fs');const path=require('path');
async function main(){
 if((await hre.ethers.provider.getNetwork()).chainId!==662831n)throw new Error('Use disputeL1');
 const names=(await hre.artifacts.getAllFullyQualifiedNames()).filter(n=>n.includes('/generated/')&&/:UltraVerifier$|:HonkVerifier$/.test(n));
 if(names.length!==1)throw new Error('Generate real verifier first');
 const artifact=await hre.artifacts.readArtifact(names[0]);
 const bytes=(artifact.deployedBytecode.length-2)/2;if(bytes>24576)throw new Error('Verifier too large');
 const file=path.resolve(__dirname,'../../docs/verifier-deployment.json');
 if(fs.existsSync(file)){
  const previous=JSON.parse(fs.readFileSync(file));
  if((await hre.ethers.provider.getCode(previous.address))!==artifact.deployedBytecode)throw new Error('Existing verifier differs; review deployment manifest before replacing');
  console.log('Reusing verified deployed bytecode',previous);return;
 }
 const verifier=await (await hre.ethers.getContractFactory(names[0])).deploy();await verifier.waitForDeployment();
 const receipt=await verifier.deploymentTransaction().wait();
 const code=await hre.ethers.provider.getCode(await verifier.getAddress());
 if(code!==artifact.deployedBytecode)throw new Error('Deployed bytecode mismatch');
 const result={address:await verifier.getAddress(),deployTx:receipt.hash,block:receipt.blockNumber,deployedBytecodeBytes:bytes,chainId:662831,contract:names[0],codeHash:hre.ethers.keccak256(code)};
 fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(result);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

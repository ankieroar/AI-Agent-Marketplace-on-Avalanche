const hre=require('hardhat');const fs=require('fs');const path=require('path');
async function main(){
 if((await hre.ethers.provider.getNetwork()).chainId!==662831n)throw new Error('Use disputeL1');
 const names=(await hre.artifacts.getAllFullyQualifiedNames()).filter(n=>n.includes('/generated/')&&n.endsWith(':HonkVerifier'));
 if(names.length!==1)throw new Error('Generate real verifier first');
 const artifact=await hre.artifacts.readArtifact(names[0]);
 const bytes=(artifact.deployedBytecode.length-2)/2;if(bytes>24576)throw new Error('Verifier too large');
 const verifier=await (await hre.ethers.getContractFactory(names[0])).deploy();await verifier.waitForDeployment();
 const receipt=await verifier.deploymentTransaction().wait();
 const result={address:await verifier.getAddress(),deployTx:receipt.hash,block:receipt.blockNumber,deployedBytecodeBytes:bytes};
 fs.writeFileSync(path.resolve(__dirname,'../../docs/verifier-deployment.json'),JSON.stringify(result,null,2));console.log(result);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

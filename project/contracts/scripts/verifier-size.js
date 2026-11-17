const hre=require('hardhat');
async function main(){
 await hre.run('compile');
 const names=(await hre.artifacts.getAllFullyQualifiedNames()).filter(n=>n.includes('/generated/')&&/:UltraVerifier$|:HonkVerifier$/.test(n));
 if(names.length!==1)throw new Error('Generate verifier first; expected one UltraVerifier or HonkVerifier artifact');
 const artifact=await hre.artifacts.readArtifact(names[0]);
 const bytes=(artifact.deployedBytecode.length-2)/2;
 console.log(JSON.stringify({contract:names[0],deployedBytecodeBytes:bytes,limit:24576}));
 if(bytes>24576)throw new Error('Verifier exceeds EIP-170 limit');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

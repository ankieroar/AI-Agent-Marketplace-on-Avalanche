// Downloads a pinned official release; verifies its checksum before execution.
const fs=require('fs');const path=require('path');const crypto=require('crypto');const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'.tools/icm-relayer-1.8.4');
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',windowsHide:true});if(r.status!==0)throw new Error(command+' failed');}
async function main(){
 fs.mkdirSync(dir,{recursive:true});
 const name='icm-relayer_1.8.4_linux_amd64.tar.gz';
 const base='https://github.com/ava-labs/icm-services/releases/download/icm-relayer-v1.8.4/';
 const sums=await fetch(base+'icm-relayer_1.8.4_checksums.txt');if(!sums.ok)throw new Error('Checksum download failed');
 const expected=(await sums.text()).split(/\r?\n/).find(l=>l.trim().endsWith(name))?.trim().split(/\s+/)[0];
 if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw new Error('Invalid checksum manifest');
 const archive=path.join(dir,'release.tar.gz');
 let data=fs.existsSync(archive)?fs.readFileSync(archive):null;
 if(!data||crypto.createHash('sha256').update(data).digest('hex')!==expected){const r=await fetch(base+name);if(!r.ok)throw new Error('Binary download failed');data=Buffer.from(await r.arrayBuffer());}
 if(crypto.createHash('sha256').update(data).digest('hex')!==expected)throw new Error('Checksum mismatch');
 fs.writeFileSync(archive,data);run('tar',['-xzf',archive,'-C',dir]);
 console.log('Official release SHA256 verified:',expected);
 run('docker',['build','-t','warranty-icm:1.8.4','-f',path.join(root,'infra/icm/Dockerfile'),dir]);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

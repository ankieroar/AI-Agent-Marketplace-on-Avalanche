import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const env=readFileSync(path.join(root,'project/.env'),'utf8');
const names=/^(PRIVATE_KEY|PROOF_SUBMITTER_PRIVATE_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|API_ACCESS_TOKEN|AES_KEY_HEX|ENCRYPTION_KEY|POSTGRES_PASSWORD|DATABASE_URL)$/;
const secrets=env.split(/\r?\n/).flatMap(line=>{const i=line.indexOf('=');if(i<0||!names.test(line.slice(0,i)))return [];const value=line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');return value.length>=16?[value,value.startsWith('0x')?value.slice(2):value]:[];});
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
const findings=[];
for(const file of files){let content;try{content=readFileSync(path.join(root,file),'utf8');}catch{continue;}
 if(secrets.some(secret=>content.includes(secret)) || /\b(?:sk-or-v1-|sk-proj-|gsk_)[A-Za-z0-9_-]{20,}/.test(content)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))findings.push(file);
}
const history=execFileSync('git',['log','--all','-p','--no-ext-diff'],{cwd:root,maxBuffer:32*1024*1024}).toString();
const currentSecretsFoundInHistory=secrets.some(secret=>history.includes(secret));
console.log(JSON.stringify({checkedFiles:files.length,filesWithPossibleSecrets:findings,currentSecretsFoundInHistory}));
if(findings.length||currentSecretsFoundInHistory)process.exitCode=1;

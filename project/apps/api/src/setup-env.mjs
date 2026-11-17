import {randomBytes} from 'node:crypto';
import {readFileSync,appendFileSync} from 'node:fs';
const file=new URL('../../../.env',import.meta.url);
let current='';try{current=readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const password=randomBytes(24).toString('hex');
const entries={AES_KEY_HEX:randomBytes(32).toString('hex'),API_ACCESS_TOKEN:randomBytes(32).toString('hex'),POSTGRES_PASSWORD:password,DATABASE_URL:'postgresql://warranty:'+password+'@127.0.0.1:5432/warranty',OPENROUTER_MODEL:'openrouter/free'};
// Never print secrets; preserve values already configured by the operator.
if(/^POSTGRES_PASSWORD=/m.test(current)&&!/^DATABASE_URL=/m.test(current))throw new Error('Set DATABASE_URL matching existing POSTGRES_PASSWORD');
for(const [key,value] of Object.entries(entries)){if(!new RegExp('^'+key+'=','m').test(current))appendFileSync(file,'\n'+key+'='+value+'\n');}
console.log('Local configuration prepared; existing values preserved.');

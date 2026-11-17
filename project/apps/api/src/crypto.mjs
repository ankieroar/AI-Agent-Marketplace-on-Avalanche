import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
function key(hex){if(!/^[0-9a-fA-F]{64}$/.test(hex||''))throw new Error('AES_KEY_HEX must contain 32 bytes');return Buffer.from(hex,'hex');}
export function encrypt(value,hex,aad){
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(hex),iv);c.setAAD(Buffer.from(aad));
 const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
 return {v:1,iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:data.toString('hex')};
}
export function decrypt(value,hex,aad){
 if(value.v!==1)throw new Error('Unsupported encryption version');
 const c=createDecipheriv('aes-256-gcm',key(hex),Buffer.from(value.iv,'hex'));c.setAAD(Buffer.from(aad));c.setAuthTag(Buffer.from(value.tag,'hex'));
 return JSON.parse(Buffer.concat([c.update(Buffer.from(value.data,'hex')),c.final()]).toString('utf8'));
}


import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../apps/api/src/db.mjs';
import {encrypt,decrypt} from '../apps/api/src/crypto.mjs';
const client=await pool.connect();
try{
 await client.query('BEGIN');
 const id=randomUUID(),plain={text:'synthetic private receipt'};
 await client.query('INSERT INTO evidence(id,encrypted) VALUES($1,$2)',[id,encrypt(plain,process.env.AES_KEY_HEX,id)]);
 const {rows}=await client.query('SELECT encrypted FROM evidence WHERE id=$1',[id]);
 assert.equal(JSON.stringify(rows[0]).includes(plain.text),false);
 assert.deepEqual(decrypt(rows[0].encrypted,process.env.AES_KEY_HEX,id),plain);
 console.log('PASS: PostgreSQL encrypted insert/read/decrypt; test transaction rolled back');
}finally{await client.query('ROLLBACK');client.release();await pool.end();}

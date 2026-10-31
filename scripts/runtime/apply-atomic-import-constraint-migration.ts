/** 职责：只读核对待迁移清单；显式--apply仅应用055，存在其他待迁移时拒绝执行。 */
import {readdir,readFile} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {createPool} from '../../server/db';
const target='059_allow_atomic_revision_seal.sql',pool=createPool();
let db:PoolClient|undefined;
try{
 db=await pool.connect();await db.query('BEGIN');
 await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='15s'");
 await db.query("SELECT pg_advisory_xact_lock(hashtext('ai-distill-migrations'))");
 const names=(await readdir(new URL('../../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
 const applied=new Set((await db.query('SELECT name FROM ai_distill.schema_migrations')).rows.map(row=>row.name));
 const pending=names.filter(name=>!applied.has(name));console.log(JSON.stringify({target,pending}));
 if(process.argv.includes('--apply')){
  if(pending.some(name=>name!==target))throw new Error('存在其他待迁移项，未执行059');
  if(!applied.has(target)){await db.query(await readFile(new URL(`../../migrations/${target}`,import.meta.url),'utf8'));await db.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)',[target]);}
  console.log(JSON.stringify({applied:target}));
 }
 await db.query('COMMIT');
}catch(error){if(db)await db.query('ROLLBACK');console.error('059迁移未完成，已回滚；请核对数据库和待迁移清单。');process.exitCode=1;}
finally{db?.release();await pool.end();}

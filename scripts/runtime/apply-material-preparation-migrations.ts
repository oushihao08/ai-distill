/**
 * 职责：只读核对或定向应用可选材料整理及题目范围登记迁移。
 * 入口：默认列出全部待迁移文件；显式 `--apply` 仅应用051与053，其他待迁移项存在时拒绝。
 * 副作用：--apply会修改PostgreSQL schema，不运行全量迁移、不改业务记录、不重启服务。
 */
import {readdir,readFile} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {createPool} from '../../server/db';

const targets=['051_optional_material_preparation.sql','053_question_material_scope_uses.sql'];
const pool=createPool();let db:PoolClient|undefined;
try{
 db=await pool.connect();await db.query('BEGIN');
 await db.query("SET LOCAL lock_timeout='2s'");
 await db.query("SET LOCAL statement_timeout='30s'");
 await db.query("SELECT pg_advisory_xact_lock(hashtext('ai-distill-migrations'))");
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort();
 const applied=new Set((await db.query('SELECT name FROM ai_distill.schema_migrations')).rows.map(row=>String(row.name)));
 const pending=files.filter(name=>!applied.has(name));
 console.log(JSON.stringify({targets,pending}));
 if(process.argv.includes('--apply')){
  if(pending.some(name=>!targets.includes(name)))throw new Error('存在目标以外的待迁移项，未执行任何迁移');
  for(const name of targets){
   if(applied.has(name))continue;
   await db.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
   await db.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)',[name]);
  }
  await db.query('COMMIT');
  console.log(JSON.stringify({applied:targets.filter(name=>!applied.has(name))}));
 }else await db.query('ROLLBACK');
}catch(error){
 if(db)try{await db.query('ROLLBACK');}catch{console.error('迁移事务回滚状态未知，请只读核对schema_migrations后再操作。');}
 console.error(error instanceof Error?error.message:'定向迁移失败；事务已回滚。');process.exitCode=1;
}
finally{db?.release();await pool.end();}

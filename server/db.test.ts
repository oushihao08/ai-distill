/** 数据库连接与日志边界：覆盖必需连接配置、TLS／channel binding、查询和事务日志脱敏；确认 SQL 参数及原始错误不会进入日志。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import{test,expect}from'bun:test';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createPool}from'./db';
import{configureLogger,withLogContext}from'./logging';
test('database URL is required',()=>{expect(()=>createPool({})).toThrow('DATABASE_URL');});
test('database configuration verifies TLS and retains channel binding',async()=>{
 const pool=createPool({DATABASE_URL:'postgresql://test:test@example.invalid/test?sslmode=require&channel_binding=require'});
 try{expect(pool.options.ssl).toEqual({rejectUnauthorized:true});expect(pool.options.enableChannelBinding).toBe(true);expect(pool.options.max).toBe(4);expect(pool.options.connectionString).not.toContain('sslmode');expect(pool.options.connectionString).not.toContain('channel_binding');}finally{await pool.end();}
});
test('database query and transaction logs keep SQL values and raw errors private',async()=>{
 const root=await mkdtemp(join(tmpdir(),'db-logs-')),logger=configureLogger({root,service:'api'});
 let failCommit=false;
 const pool=createPool({DATABASE_URL:'postgresql://test:test@example.invalid/test'}),client={query:async(sql:string,_values?:unknown[])=>{
  if(sql==='COMMIT'&&failCommit)throw Object.assign(new Error('private commit result uncertain'),{code:'08006'});
  if(sql.includes('slow_probe')){await Bun.sleep(1050);return{rows:[],rowCount:1};}
  if(sql.startsWith('SELECT'))throw Object.assign(new Error('private database message'),{code:'23505'});
  return{rows:[],rowCount:1};
 }};
 try{
  pool.emit('error',Object.assign(new Error('private pool error'),{code:'08006'}));pool.emit('acquire',client as any);
  await withLogContext({workflow_id:'workflow-a',attempt_id:'attempt-a'},async()=>{
   await client.query('BEGIN');await client.query('COMMIT');
   failCommit=true;await expect(client.query('COMMIT')).rejects.toThrow('private commit result uncertain');failCommit=false;
   await expect(client.query('SELECT * FROM ai_distill.private_rows WHERE token=$1',['private sql value'])).rejects.toThrow('private database message');
   await client.query('SELECT * FROM ai_distill.slow_probe');
  });
  await logger.flush();const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({event:'transaction.started',transaction_name:'begin',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'transaction.committed',transaction_name:'commit',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'transaction.outcome_unknown',state:'unknown',transaction_name:'commit',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.query.failed',query_name:'select:ai_distill.private_rows',error_code:'23505',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.query.slow',query_name:'select:ai_distill.slow_probe',duration_ms:expect.any(Number),workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.pool.error',error_code:'08006'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.connection.recovered'}));
  expect(JSON.stringify(records)).not.toContain('private database message');expect(JSON.stringify(records)).not.toContain('private commit result uncertain');expect(JSON.stringify(records)).not.toContain('private sql value');
 }finally{await logger.close();await pool.end();await rm(root,{recursive:true,force:true});}
});

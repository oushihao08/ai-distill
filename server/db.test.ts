/** 验证连接/TLS配置、日志脱敏和后台状态事务超时；使用SQL替身及随机端口PG协议夹具，不连接业务数据库。 */
import {readActiveWorkflowTasks} from './monitoring/worker-monitor';
import{test,expect}from'bun:test';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createPool,readStatusRows}from'./db';
import{Pool}from'pg';
import{createServer,type Socket}from'node:net';
import{configureLogger,withLogContext}from'./logging';
test('database URL is required',()=>{expect(()=>createPool({})).toThrow('DATABASE_URL');});
test('database configuration verifies TLS and retains channel binding',async()=>{
 const pool=createPool({DATABASE_URL:'postgresql://test:test@example.invalid/test?sslmode=require&channel_binding=require'});
 try{expect(pool.options.ssl).toEqual({rejectUnauthorized:true});expect(pool.options.enableChannelBinding).toBe(true);expect(pool.options.max).toBe(4);expect(pool.options.idleTimeoutMillis).toBe(10000);expect(pool.options.connectionString).not.toContain('sslmode');expect(pool.options.connectionString).not.toContain('channel_binding');}finally{await pool.end();}
});

test('status reads preserve rows, bound every transaction message and discard failed connections',async()=>{
 const rows=[{id:'task-a',status:'running'}],failure=new Error('synthetic read failure');
 for(const phase of ['success','BEGIN','SET','SELECT','COMMIT','ROLLBACK']){
  const queries:{text:string;query_timeout:number;values?:unknown[]}[]=[],released:unknown[]=[];
  const pool={connect:async()=>({query:async(query:any)=>{
   expect(typeof query).toBe('object');queries.push(query);
   expect(query.query_timeout).toBeGreaterThan(2000);expect(query.query_timeout).toBeLessThanOrEqual(5000);
   if(phase==='ROLLBACK'&&(query.text.startsWith('SELECT')||query.text==='ROLLBACK'))throw failure;
   if(phase!=='success'&&query.text.startsWith(phase))throw failure;
   return{rows:query.text.startsWith('SELECT')?rows:[]};
  },release:(error?:Error)=>released.push(error)})} as unknown as Pool;
  if(phase==='success'){
   expect(await readStatusRows(pool,'SELECT id,status FROM example WHERE id=$1',['task-a'])).toEqual(rows);
   expect(released).toEqual([undefined]);expect(queries.find(q=>q.text.startsWith('SELECT'))?.values).toEqual(['task-a']);
  }else{
   await expect(readStatusRows(pool,'SELECT id,status FROM example')).rejects.toBe(failure);
   expect(released).toEqual([failure]);
  }
 }
});

test('status reads stop real pg protocol stalls and evict the connection at each transaction phase',async()=>{
 const frame=(type:string,body:Buffer)=>{const length=Buffer.alloc(4);length.writeInt32BE(body.length+4);return Buffer.concat([Buffer.from(type),length,body]);};
 for(const phase of ['BEGIN','SET','SELECT','COMMIT','MONITOR']){
  const sockets=new Set<Socket>();let stalled=false,stallEnabled=true;
  const server=createServer(socket=>{
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{/* The fixture expects the timed-out client to destroy its socket. */});
   let startup=true,pending=Buffer.alloc(0);
   socket.on('data',chunk=>{
    pending=Buffer.concat([pending,typeof chunk==='string'?Buffer.from(chunk):chunk]);
    while(pending.length>=(startup?4:5)){
     const length=pending.readInt32BE(startup?0:1),total=length+(startup?0:1);if(pending.length<total)return;
     const packet=pending.subarray(0,total);pending=pending.subarray(total);
     if(startup){startup=false;socket.write(Buffer.concat([frame('R',Buffer.alloc(4)),frame('Z',Buffer.from('I'))]));continue;}
     if(phase==='MONITOR'&&packet[0]!==81){
      if(stallEnabled){stalled=true;continue;}
      const type=String.fromCharCode(packet[0]!);
      if(type==='P')socket.write(frame('1',Buffer.alloc(0)));
      else if(type==='B')socket.write(frame('2',Buffer.alloc(0)));
      else if(type==='D')socket.write(frame('n',Buffer.alloc(0)));
      else if(type==='E')socket.write(frame('C',Buffer.from('SELECT 0\0')));
      else if(type==='S')socket.write(frame('Z',Buffer.from('I')));
      continue;
     }
     if(packet[0]!==81)continue;
     const sql=packet.subarray(5,-1).toString();
     if(stallEnabled&&sql.startsWith(phase==='MONITOR'?'SELECT':phase)){stalled=true;continue;}
     const command=sql.startsWith('SELECT')?'SELECT 0':sql.split(' ')[0]!;
     socket.write(Buffer.concat([frame('C',Buffer.from(command+'\0')),frame('Z',Buffer.from(command==='COMMIT'?'I':'T'))]));
    }
   });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture port unavailable');
  const pool=new Pool({host:'127.0.0.1',port:address.port,user:'fixture',database:'fixture',ssl:false,max:1,connectionTimeoutMillis:1000});
  const started=performance.now();
  try{
   await expect(phase==='MONITOR'?readActiveWorkflowTasks(pool):readStatusRows(pool,'SELECT id,status FROM example')).rejects.toThrow('Query read timeout');
   expect(stalled).toBe(true);expect(performance.now()-started).toBeLessThan(phase==='MONITOR'?6500:4500);
   expect(pool.totalCount).toBe(0);expect(pool.waitingCount).toBe(0);
   stallEnabled=false;
   expect(await (phase==='MONITOR'?readActiveWorkflowTasks(pool):readStatusRows(pool,'SELECT id,status FROM example'))).toEqual([]);
   expect(pool.totalCount).toBe(1);
  }finally{await pool.end();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
},30000);
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
   await client.query('SELECT (SELECT count(*) FROM ai_distill.private_rows) FROM ai_distill.slow_probe');
  });
  await logger.flush();const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).not.toContainEqual(expect.objectContaining({event:'transaction.started',transaction_name:'begin',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).not.toContainEqual(expect.objectContaining({event:'transaction.committed',transaction_name:'commit',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'transaction.outcome_unknown',state:'unknown',transaction_name:'commit',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.query.failed',query_name:'select:ai_distill.private_rows',error_code:'23505',workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.query.slow',level:'warn',query_name:'select:ai_distill.slow_probe',duration_ms:expect.any(Number),workflow_id:'workflow-a',attempt_id:'attempt-a'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.pool.error',error_code:'08006'}));
  expect(records).toContainEqual(expect.objectContaining({event:'db.connection.recovered',pool_total:expect.any(Number),pool_idle:expect.any(Number),pool_waiting:expect.any(Number),new_connection:false}));
  expect(records.filter(record=>record.level==='warn').every(record=>record.event==='db.query.slow')).toBe(true);expect(JSON.stringify(records)).not.toContain('private database message');expect(JSON.stringify(records)).not.toContain('private commit result uncertain');expect(JSON.stringify(records)).not.toContain('private sql value');expect(records.find(record=>record.event==='db.query.slow')).not.toHaveProperty('sql');expect(records.find(record=>record.event==='db.query.slow')).not.toHaveProperty('values');
 }finally{await logger.close();await pool.end();await rm(root,{recursive:true,force:true});}
});

test('slow diagnostics distinguish SQL shapes and connection holds without recording SQL',async()=>{
 const root=await mkdtemp(join(tmpdir(),'db-hold-')),logger=configureLogger({root,service:'api'});
 const pool=createPool({DATABASE_URL:'postgresql://fixture:fixture@example.invalid/fixture'}),client={query:async(_sql:string)=>{await Bun.sleep(1050);return{rows:[]};}};
 try{
  await withLogContext({route:'/api/projects/:id',method:'GET'},async()=>{
   pool.emit('acquire',client as any);await client.query('SELECT private_value FROM secret_fixture');pool.emit('release',undefined,client as any);
  });
  await logger.flush();const files=await readdir(join(root,'logs',new Date().toISOString().slice(0,10)));const rows=(await Promise.all(files.filter(f=>f.endsWith('.jsonl')).map(f=>readFile(join(root,'logs',new Date().toISOString().slice(0,10),f),'utf8')))).join('').trim().split('\n').map(l=>JSON.parse(l));
  expect(rows).toContainEqual(expect.objectContaining({event:'db.connection.held',route:'/api/projects/:id',duration_ms:expect.any(Number),query_count:1,db_elapsed_ms:expect.any(Number),non_db_elapsed_ms:expect.any(Number),max_query_ms:expect.any(Number)}));
  const query=rows.find(r=>r.event==='db.query.slow');expect(query.query_id).toMatch(/^[a-f0-9]{16}$/);expect(query.route).toBe('/api/projects/:id');expect(JSON.stringify(rows)).not.toContain('private_value');
 }finally{await logger.close();await pool.end();await rm(root,{recursive:true,force:true});}
});

/**
 * 职责：数据库连接工厂：创建启用 TLS 证书验证的 PostgreSQL 连接池，避免输出连接凭证。
 * 关键方法与用途：`createPool()` 创建 PostgreSQL 连接池并启用证书校验与安全错误处理。
 * 使用场景：由 API、worker 和迁移入口分别创建本进程连接池。
 */
import { Pool } from 'pg';
import {classifyLogError,logEvent} from './logging';
function queryName(value:unknown){
 const sql=typeof value==='string'?value:value&&typeof value==='object'&&'text'in value&&typeof value.text==='string'?value.text:'';
 const verb=sql.trim().match(/^(select|insert|update|delete|with|begin|commit|rollback|savepoint|release)\b/i)?.[1]?.toLowerCase()??'unknown';
 const topLevel=topLevelSql(sql);
 const table=(verb==='select'||verb==='with'
  ?topLevel.match(/\bselect\b[\s\S]*?\bfrom\s+("?[a-z][a-z0-9_]*"?(?:\."?[a-z][a-z0-9_]*"?)?)/i)?.[1]
  :sql.match(/\b(?:from|into|update|join)\s+("?[a-z][a-z0-9_]*"?(?:\."?[a-z][a-z0-9_]*"?)?)/i)?.[1]
 )?.replaceAll('"','').toLowerCase();
 return `${verb}${table?`:${table}`:''}`.slice(0,120);
}
/** SQL日志标签只取顶层SELECT的来源表，忽略括号子查询、字符串和注释，避免误标。 */
function topLevelSql(sql:string){
 let output='',depth=0,single=false,double=false,lineComment=false,blockComment=0,dollarTag:string|undefined;
 for(let index=0;index<sql.length;index++){
  const char=sql[index]!,next=sql[index+1];
  if(lineComment){output+=' ';if(char==='\n')lineComment=false;continue;}
  if(blockComment){output+=' ';if(char==='/'&&next==='*'){blockComment++;output+=' ';index++;}else if(char==='*'&&next==='/'){blockComment--;output+=' ';index++;}continue;}
  if(dollarTag){if(sql.startsWith(dollarTag,index)){output+=' '.repeat(dollarTag.length);index+=dollarTag.length-1;dollarTag=undefined;}else output+=' ';continue;}
  if(single){output+=' ';if(char==="'"&&next==="'"){output+=' ';index++;}else if(char==="'")single=false;continue;}
  if(double){output+=depth===0?char:' ';if(char==='"'&&next==='"'){output+=depth===0?'"':' ';index++;}else if(char==='"')double=false;continue;}
  if(char==='-'&&next==='-'){lineComment=true;output+='  ';index++;continue;}
  if(char==='/'&&next==='*'){blockComment=1;output+='  ';index++;continue;}
  if(char==="'"){single=true;output+=' ';continue;}
  if(char==='"'){double=true;output+=depth===0?char:' ';continue;}
  if(char==='$'){
   const tag=sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
   if(tag){dollarTag=tag;output+=' '.repeat(tag.length);index+=tag.length-1;continue;}
  }
  if(char==='('){depth++;output+=' ';continue;}
  if(char===')'){depth=Math.max(0,depth-1);output+=' ';continue;}
  output+=depth===0?char:' ';
 }
 return output;
}
function safeDbCode(error:unknown){const code=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;return typeof code==='string'&&/^[A-Z0-9]{5}$/.test(code)?code:undefined;}
function transactionEvent(name:string){const op=name.split(':',1)[0];return op==='begin'?'transaction.started':op==='commit'?'transaction.committed':op==='rollback'?'transaction.rolled_back':undefined;}
export function createPool(env = process.env) {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('缺少 DATABASE_URL，请配置本地 .env');
  const url = new URL(raw);
  // Explicit TLS verification; avoid sslmode=require replacing the verified SSL options.
  const requireBinding = url.searchParams.get('channel_binding') === 'require';
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'channel_binding']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, enableChannelBinding: requireBinding, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  const clients=new WeakSet<object>();let connectionUnavailable=false;
  const installClient=(client:any)=>{
    if(!client||typeof client!=='object'||clients.has(client))return;clients.add(client);
    const original=client.query.bind(client);
    client.query=(...args:any[])=>{
      const name=queryName(args[0]),started=performance.now(),callbackIndex=args.findIndex(arg=>typeof arg==='function');
      const finish=(error?:unknown)=>{
        const duration_ms=Math.round(performance.now()-started);
        if(error){const code=safeDbCode(error);logEvent('db.query.failed',{level:'error',query_name:name,duration_ms,...classifyLogError(error),...(code?{error_code:code}:{})});}
        else if(duration_ms>=1000)logEvent('db.query.slow',{level:'warn',query_name:name,duration_ms});
        const event=transactionEvent(name);
        if(event){const outcomeUnknown=Boolean(error&&(event==='transaction.committed'||event==='transaction.rolled_back'));logEvent(outcomeUnknown?'transaction.outcome_unknown':error?'transaction.failed':event,{level:error?'error':event==='transaction.rolled_back'?'warn':'info',transaction_name:name,duration_ms,...(outcomeUnknown?{state:'unknown'}:{}),...(error?classifyLogError(error):{})});}
      };
      if(callbackIndex>=0){const callback=args[callbackIndex];args[callbackIndex]=(...values:any[])=>{finish(values[0]);callback(...values);};return original(...args);}
      try{const result=original(...args);if(result&&typeof result.then==='function')return result.then((value:any)=>{finish();return value;},(error:unknown)=>{finish(error);throw error;});finish();return result;}
      catch(error){finish(error);throw error;}
    };
  };
  const originalConnect=(pool as any).connect.bind(pool);
  (pool as any).connect=(...args:any[])=>{
    const started=performance.now(),callbackIndex=args.findIndex(arg=>typeof arg==='function');
    const acquired=(error:unknown,client?:any,release?:unknown)=>{
      const duration_ms=Math.round(performance.now()-started);
      if(error){connectionUnavailable=true;const code=safeDbCode(error);logEvent('db.connection.failed',{level:'error',duration_ms,...classifyLogError(error),...(code?{error_code:code}:{})});}
      else{installClient(client);if(connectionUnavailable){logEvent('db.connection.recovered',{level:'info',duration_ms});connectionUnavailable=false;}if(duration_ms>=250)logEvent('db.connection.waited',{level:'warn',duration_ms});}
    };
    if(callbackIndex>=0){const callback=args[callbackIndex];args[callbackIndex]=(...values:any[])=>{acquired(values[0],values[1],values[2]);callback(...values);};return originalConnect(...args);}
    try{return originalConnect(...args).then((client:any)=>{acquired(undefined,client);return client;},(error:unknown)=>{acquired(error);throw error;});}
    catch(error){acquired(error);throw error;}
  };
  pool.on('acquire',(client:any)=>{installClient(client);if(connectionUnavailable){logEvent('db.connection.recovered',{level:'info'});connectionUnavailable=false;}});
  pool.on('error',(error:unknown)=>{connectionUnavailable=true;const code=safeDbCode(error);logEvent('db.pool.error',{level:'error',...classifyLogError(error),...(code?{error_code:code}:{})});console.error('数据库连接异常，请检查连接配置或网络；连接信息未输出。');});
  return pool;
}

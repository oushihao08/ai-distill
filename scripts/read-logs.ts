/** 读取本机结构化日志时间线；只扫描 logger 管理的 JSONL，不访问业务产物或 Codex 私有事件。
 * 执行入口与用途：`bun scripts/read-logs.ts`；按命令行过滤参数读取 logger 管理的 JSONL，净化字段后输出有限日志条目；不访问业务产物。
 */
import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {sanitizeLogRecord} from '../server/logging';

const values=new Map<string,string>();
for(let index=2;index<process.argv.length;index++){
 const key=process.argv[index];
 if(!key?.startsWith('--'))throw new Error('参数必须使用 --name value 格式');
 const value=process.argv[++index];
 if(!value||value.startsWith('--')||values.has(key))throw new Error(`参数缺失或重复：${key}`);
 values.set(key,value);
}
const allowed=new Set(['--request-id','--operation-id','--project-id','--workflow-id','--attempt-id','--skill-attempt-id','--call-id','--service','--component','--operation','--level','--from','--to']);
for(const key of values.keys())if(!allowed.has(key))throw new Error(`不支持的查询参数：${key}`);
for(const key of ['--request-id','--operation-id','--project-id','--workflow-id','--attempt-id','--skill-attempt-id','--call-id','--service','--component','--operation']){
 const value=values.get(key);if(value&&!/^[A-Za-z0-9._:/-]{1,160}$/.test(value))throw new Error(`${key} 格式不合法`);
}
const level=values.get('--level');if(level&&!['debug','info','warn','error'].includes(level))throw new Error('--level 必须是 debug、info、warn 或 error');
const parseDate=(key:string)=>{const value=values.get(key);if(!value)return undefined;const parsed=Date.parse(value);if(!Number.isFinite(parsed))throw new Error(`${key} 必须是可解析的时间`);return parsed;};
const from=parseDate('--from'),to=parseDate('--to');if(from!==undefined&&to!==undefined&&from>to)throw new Error('--from 不能晚于 --to');
const root=join(process.env.STORAGE_DIR??'.storage','logs');
const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const filePattern=/^[a-z0-9-]+-[a-f0-9-]{36}-\d{3}\.jsonl$/;
let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(error){if(error&&typeof error==='object'&&'code'in error&&(error as {code?:unknown}).code==='ENOENT'){console.error(JSON.stringify({matched:0,files_scanned:0,bytes_scanned:0,malformed_lines:0,incomplete_tail_lines:0,truncated:false}));process.exit(0);}throw error;}
const days=entries.filter(entry=>entry.isDirectory()&&dayPattern.test(entry.name)).map(entry=>entry.name).sort().reverse();
const files:string[]=[];for(const day of days){const entries=await readdir(join(root,day),{withFileTypes:true});for(const entry of entries.filter(entry=>entry.isFile()&&filePattern.test(entry.name)).sort((a,b)=>b.name.localeCompare(a.name))){files.push(join(root,day,entry.name));if(files.length>=50)break;}if(files.length>=50)break;}
let scanned=0,malformed=0,incompleteTailLines=0,shown=0;const matches:any[]=[];
for(const path of files){if(shown>=500||scanned>=20*1024*1024)break;const info=await stat(path);if(info.size>20*1024*1024-scanned)continue;const text=await readFile(path,'utf8');scanned+=info.size;
 const lines=text.split('\n');if(text.length>0&&!text.endsWith('\n'))incompleteTailLines++;
 for(const line of lines){
  if(!line)continue;let parsed:any;try{parsed=JSON.parse(line);}catch{malformed++;continue;}const record=sanitizeLogRecord(parsed);if(!record){malformed++;continue;}
  if(typeof record?.occurred_at!=='string'||!Number.isFinite(Date.parse(record.occurred_at)))continue;
  const at=Date.parse(record.occurred_at);if(from!==undefined&&at<from||to!==undefined&&at>to)continue;
  if(level&&record.level!==level)continue;
  let matched=true;for(const [argument,field] of [['--request-id','request_id'],['--operation-id','operation_id'],['--project-id','project_id'],['--workflow-id','workflow_id'],['--attempt-id','attempt_id'],['--skill-attempt-id','skill_attempt_id'],['--call-id','call_id'],['--service','service'],['--component','component'],['--operation','operation']] as const){const value=values.get(argument);if(value&&record[field]!==value)matched=false;}
  if(matched){matches.push(record);shown++;if(shown>=500)break;}
 }
}
matches.sort((a,b)=>String(a.occurred_at).localeCompare(String(b.occurred_at))||Number(a.seq)-Number(b.seq));
for(const record of matches)console.log(JSON.stringify(record));
console.error(JSON.stringify({matched:matches.length,files_scanned:files.length,bytes_scanned:scanned,malformed_lines:malformed,incomplete_tail_lines:incompleteTailLines,truncated:matches.length>=500||scanned>=20*1024*1024}));

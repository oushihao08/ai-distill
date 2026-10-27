/** 工具包的进程客户端：服务端调用同一个CLI的NDJSON协议；正文走stdin，附件经私有临时文件传递。 */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FeishuError,type FeishuClient} from './client';
import type {Operation} from './commands';
export interface FeishuProcessClient extends FeishuClient {close():Promise<void>}
/** 每次交付复用一个子进程/一个token/一个90秒预算；结束或失败均须close，不自动重试写入。 */
export async function createCliClient(options:{env?:NodeJS.ProcessEnv;timeoutMs?:number}={}):Promise<FeishuProcessClient>{
 const cli=fileURLToPath(new URL('./cli.ts',import.meta.url));
 const child=spawn(process.execPath,[cli,'--rpc'],{stdio:['pipe','pipe','pipe'],shell:false,env:options.env??process.env});
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();let sequence=0,closed=false,failure:FeishuError|undefined;
 const directories=new Set<string>();
 const fail=(code:string)=>{failure??=new FeishuError(code);for(const entry of pending.values())entry.reject(failure);pending.clear();};
 child.stderr.resume(); // 子进程原始诊断可能含业务数据，不透传普通日志。
 child.on('error',()=>fail('feishu_cli_unavailable'));
 child.stdin.on('error',()=>fail('feishu_cli_write_failed'));
 const exit=new Promise<void>(resolve=>child.once('close',()=>{if(!closed)fail('feishu_cli_exited');resolve();}));
 const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
 lines.on('line',line=>{
  try{const response=JSON.parse(line),entry=pending.get(response.id);if(!entry)return;pending.delete(response.id);
   if(response.ok===true)entry.resolve(response.data);else entry.reject(new FeishuError(typeof response.error?.code==='string'?response.error.code:'feishu_cli_failed'));
  }catch{fail('feishu_cli_response_invalid');child.kill('SIGTERM');}
 });
 const deadline=setTimeout(()=>{fail('feishu_timeout');child.kill('SIGTERM');},options.timeoutMs??95_000);deadline.unref();
 function request(operation:Operation):Promise<any>{
  if(closed||failure)return Promise.reject(failure??new FeishuError('feishu_cli_closed'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{
   pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,operation})+'\n',error=>{if(error)fail('feishu_cli_write_failed');});
  });
 }
 async function close(){
  if(closed)return;closed=true;clearTimeout(deadline);fail('feishu_cli_closed');child.stdin.end();
  const stop=setTimeout(()=>child.kill('SIGTERM'),1000);stop.unref();
  try{await exit;}finally{clearTimeout(stop);lines.close();for(const dir of directories)await rm(dir,{recursive:true,force:true});}
 }
 async function call(path:string,method='GET',body?:unknown){
  if(!(body instanceof FormData))return request({kind:'call',path,method,body});
  // 现有交付只有bitable附件上传；不把二进制编码成巨大的JSON或写进命令参数。
  if(path!=='/drive/v1/medias/upload_all'||method!=='POST'||body.get('parent_type')!=='bitable_file')throw new FeishuError('feishu_multipart_unsupported');
  const file=body.get('file');if(!(file instanceof Blob))throw new FeishuError('feishu_upload_not_file');
  const dir=await mkdtemp(join(tmpdir(),'feishu-upload-'));directories.add(dir);const filename=join(dir,'attachment');
  try{
   await writeFile(filename,new Uint8Array(await file.arrayBuffer()),{mode:0o600});
   return await request({kind:'upload',file:filename,name:String(body.get('file_name')??'file'),parent:String(body.get('parent_node')??'')});
  }finally{await rm(dir,{recursive:true,force:true});directories.delete(dir);}
 }
 async function download(fileToken:string){
  const dir=await mkdtemp(join(tmpdir(),'feishu-download-'));directories.add(dir);const output=join(dir,'attachment');
  try{await request({kind:'download',fileToken,output});return new Uint8Array(await readFile(output));}
  finally{await rm(dir,{recursive:true,force:true});directories.delete(dir);}
 }
 const client:FeishuProcessClient={call,list:path=>request({kind:'list',path}),download,close};
 // 在返回客户端前验证应用凭证，保持原feishuClient的认证失败语义。
 try{await request({kind:'status'});return client;}catch(error){await close();throw error;}
}

/** 通用工具/真实CLI子进程的回环HTTP验收，不访问飞书或真实凭证；覆盖CRUD/分页/错误/上传与会话清理。 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,writeFile,mkdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppClient} from './client';
import {createCliClient} from './process-client';
import {parseCommand} from './commands';
import {buildProjectSnapshot,syncProjectRegistry,type ProjectRegistry} from './project-registry';
const cli=new URL('./cli.ts',import.meta.url).pathname;
function fixture(){
 const calls:{path:string;method:string;body:any}[]=[];let auth=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  try{
   const url=new URL(request.url),path=url.pathname;
   if(path.endsWith('/auth/v3/tenant_access_token/internal')){auth++;return Response.json({code:0,tenant_access_token:'fixture-token'});}
   const form=request.headers.get('content-type')?.includes('multipart/form-data')?await request.formData():null;
   const body=form?{size:form.get('size'),filename:form.get('file_name'),contents:await(form.get('file')as Blob).text()}:request.method==='GET'?null:await request.json();
   calls.push({path:url.pathname+url.search,method:request.method,body});
   if(path.endsWith('/download'))return new Response('downloaded',{headers:{'Content-Type':'application/octet-stream'}});
   if(path.endsWith('/upload_all'))return Response.json({code:0,data:{file_token:'media-token'}});
   if(url.searchParams.has('page_size'))return Response.json({code:0,data:{items:[{page:url.searchParams.get('page_token')??'first'}],has_more:!url.searchParams.has('page_token'),page_token:'second'}});
   if(path.endsWith('/error'))return Response.json({code:99991679,msg:'private response must not escape'},{status:403});
   return Response.json({code:0,data:{record:{record_id:'rec-test',fields:body?.fields},table_id:'tbl-test'}});
  }catch{return Response.json({code:400},{status:400});}
 }});
 const env={...process.env,FEISHU_APP_ID:'fixture-app',FEISHU_APP_SECRET:'fixture-secret',FEISHU_API_BASE_URL:`http://127.0.0.1:${server.port}/open-apis`};
 return{server,calls,env,auth:()=>auth};
}
test('原生JSON字段与显式资源ID映射，缺少ID/正文拒绝；批操作不作用于全表',()=>{
 const fields={fields:{名称:'题目一'}};
 expect(parseCommand(['record','create','--base','base','--table','tbl'],fields)).toMatchObject({path:'/bitable/v1/apps/base/tables/tbl/records',method:'POST',body:fields});
 expect(parseCommand(['field','delete','--base','base','--table','tbl','--id','fld'])).toMatchObject({path:'/bitable/v1/apps/base/tables/tbl/fields/fld',method:'DELETE'});
 expect(parseCommand(['view','update','--base','base','--table','tbl','--id','vew'],{}).method).toBe('PATCH');
 expect(parseCommand(['table','update','--base','base','--id','tbl'],{}).method).toBe('PATCH');
 expect(parseCommand(['record','batch-update','--base','base','--table','tbl'],{records:[]})).toMatchObject({path:'/bitable/v1/apps/base/tables/tbl/records/batch_update'});
 expect(()=>parseCommand(['field','delete','--base','base','--table','tbl'])).toThrow();
 expect(()=>parseCommand(['table','create','--base','base'])).toThrow();
});
test('真实CLI会话只认证一次，分页/写入/上传兼容旧客户端，失败不重试不泄露正文',async()=>{
 const f=fixture();let api:Awaited<ReturnType<typeof createCliClient>>|undefined;
 try{
  api=await createCliClient({env:f.env});
  expect(await api.list('/bitable/v1/apps/base/tables')).toHaveLength(2);
  await api.call('/bitable/v1/apps/base/tables/tbl/records','POST',{fields:{名称:'隔离题目'}});
  const form=new FormData();form.set('parent_type','bitable_file');form.set('parent_node','base');form.set('file_name','附件.docx');form.set('file',new Blob(['fixture bytes']));
  expect(await api.call('/drive/v1/medias/upload_all','POST',form)).toEqual({file_token:'media-token'});
  expect(new TextDecoder().decode(await api.download('media-token'))).toBe('downloaded');
  await expect(api.call('/error','POST',{})).rejects.toThrow('feishu_api_99991679');
  expect(f.calls.filter(c=>c.path==='/open-apis/error')).toHaveLength(1);
  expect(f.calls.find(c=>c.path.endsWith('/upload_all'))?.body).toEqual({size:'13',filename:'附件.docx',contents:'fixture bytes'});
  expect(f.auth()).toBe(1);
  await api.close();await expect(api.call('/anything')).rejects.toThrow('feishu_cli_closed');
 }finally{await api?.close();f.server.stop(true);}
});
test('CLI一次命令、下载与dry-run都使用相同操作，dry-run无认证',async()=>{
 const f=fixture(),dir=await mkdtemp(join(tmpdir(),'feishu-cli-test-'));
 const run=async(args:string[],input='')=>{
  const child=Bun.spawn([process.execPath,cli,...args],{env:f.env,stdin:new Blob([input]),stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{stdout,stderr,code};
 };
 try{
  const dry=await run(['table','create','--base','base','--dry-run'],JSON.stringify({table:{name:'测试'}}));expect(dry.code).toBe(0);expect(JSON.parse(dry.stdout).data.dispatched).toBe(false);expect(f.auth()).toBe(0);
  const created=await run(['record','create','--base','base','--table','tbl'],JSON.stringify({fields:{名称:'测试'}}));expect(created.code).toBe(0);expect(JSON.parse(created.stdout).data.record.record_id).toBe('rec-test');
  const output=join(dir,'download.bin');const downloaded=await run(['file','download','--id','media-token','--output',output]);expect(downloaded.code).toBe(0);expect(await readFile(output,'utf8')).toBe('downloaded');
  const bad=await run(['api','POST','/error'],'{}');expect(bad.code).toBe(1);expect(bad.stderr).not.toContain('private');expect(bad.stderr).not.toContain('fixture-secret');
 }finally{f.server.stop(true);await rm(dir,{recursive:true,force:true});}
});
test('凭证不发送到任意主机，raw API不允许认证路径与路径逃逸',async()=>{
 await expect(createAppClient({appId:'x',appSecret:'y',root:'https://example.com/open-apis'})).rejects.toThrow('feishu_origin_invalid');
 const f=fixture();
 try{
  const api=await createAppClient({appId:'x',appSecret:'y',root:f.env.FEISHU_API_BASE_URL});
  for(const path of ['//evil','/../auth/v3/token','/auth/v3/token','/%2e%2e/auth','/%61uth/v3/token'])await expect(api.call(path)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
 }finally{f.server.stop(true);}
});
test('官方透传不静默选身份；缺少官方可执行文件明确失败',async()=>{
 const run=async(args:string[])=>{
  const child=Bun.spawn([process.execPath,cli,...args],{env:{...process.env,LARK_CLI_BIN:'/nonexistent/lark-cli-fixture'},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const [code,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);return{code,error};
 };
 expect((await run(['official','--','base','+base-get'])).error).toContain('feishu_official_identity_required');
 expect((await run(['official','--','base','+base-get','--as','user'])).error).toContain('feishu_official_cli_unavailable');
});
const registryConfig:ProjectRegistry={schema_version:1,key:'fixture',name:'项目夹具',roster:{base_token:'roster-base',name:'名单',primary_table_id:'roster',tables:[{table_id:'roster',name:'名单'}],fields:{name:'姓名',expert_id:'ID',account_mobile:'手机',expert_source:'来源',notes:'备注'}},question_targets:[{key:'questions',name:'题目',role:'mock_submission',base_token:'question-base',table_id:'questions',fields:{question_id:'题目ID',sync_id:'同步ID',expert_id:'uid',account_user:'账号',expert_source:'来源'}}]};
test('项目私有快照以字符串专家ID关联一人多题，不把手机号当人员ID或把EGV改成九盈',()=>{
 const rosters=[{base_token:'roster-base',table_id:'roster',name:'名单',fields:[],records:[{record_id:'person',fields:{姓名:'测试人',ID:'7689102253537611535',手机:'13800000000',来源:'EGV'}}]}];
 const targets=[{base_token:'question-base',table_id:'questions',name:'题目',fields:[{field_id:'source',field_name:'来源',type:3,property:{options:[{name:'九盈'}]}}],records:[{record_id:'q1',fields:{题目ID:'one',uid:'7689102253537611535',账号:[{id:'ou_fixture',name:'测试人'}]}},{record_id:'q2',fields:{题目ID:'two',uid:'7689102253537611535',账号:[{id:'ou_fixture',name:'测试人'}]}}]}];
 const result=buildProjectSnapshot(registryConfig,rosters,targets,'fixture-time');
 expect(result.people[0]).toMatchObject({expert_id:'7689102253537611535',account_mobile:'13800000000',expert_source:'EGV',observed_question_count:2,open_ids_from_existing_assignments:['ou_fixture']});
 expect(result.existing_assignments).toHaveLength(2);expect(result.issues).toContainEqual({code:'expert_source_option_not_present',resource:'questions',values:['EGV']});
});
test('未知open_id、重复专家身份冲突和不安全数字ID保留为问题，不生成填报值',()=>{
 const table={base_token:'roster-base',table_id:'roster',name:'名单',fields:[],records:[{record_id:'a',fields:{姓名:'一',ID:'id',手机:'13800000000'}},{record_id:'b',fields:{姓名:'二',ID:'id',手机:'13900000000'}},{record_id:'c',fields:{姓名:'三',ID:7689102253537611535}}]};
 const result=buildProjectSnapshot(registryConfig,[table],[],'fixture');
 expect(result.people[0].identity_status).toBe('conflicting_roster_records');expect(result.people[0].feishu_user_resolution).toBe('mobile_lookup_required');
 expect(result.people[1].expert_id).toBeNull();expect(result.issues.map(issue=>issue.code)).toContain('missing_expert_id');
});
test('资料同步只读固定清单，筛除题面正文，私有文件0600且失败不覆盖旧快照',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-registry-')),folder=join(root,'fixture'),calls:string[]=[];
 try{
  await mkdir(folder);await writeFile(join(folder,'config.json'),JSON.stringify(registryConfig));
  const api={list:async(path:string)=>{
   calls.push(path);if(path.includes('/fields'))return[];
   return path.includes('/roster/')?[{record_id:'p',fields:{姓名:'测试',ID:'1',手机:'13800000000',来源:'EGV',不需要的字段:'丢弃'}}]:[{record_id:'q',fields:{题目ID:'q',uid:'1',题面:'不应保存的正文'}}];
  }};
  const summary=await syncProjectRegistry('fixture',api,root);expect(summary.remote_writes).toBe(0);expect(summary.person_count).toBe(1);
  const path=join(folder,'private/snapshot.json'),snapshot=await readFile(path,'utf8');expect(snapshot).not.toContain('不应保存的正文');expect(snapshot).not.toContain('丢弃');expect(JSON.stringify(summary)).not.toContain('13800000000');
  expect((await stat(path)).mode&0o777).toBe(0o600);expect(calls.filter(path=>path.includes('/records')).every(path=>path.includes('field_names=')&&path.includes('user_id_type=open_id'))).toBe(true);
  await expect(syncProjectRegistry('fixture',{list:async()=>{throw new Error('fixture failure');}},root)).rejects.toThrow('fixture failure');expect(await readFile(path,'utf8')).toBe(snapshot);
  await expect(syncProjectRegistry('../elsewhere',api,root)).rejects.toThrow('feishu_project_key_invalid');
 }finally{await rm(root,{recursive:true,force:true});}
});

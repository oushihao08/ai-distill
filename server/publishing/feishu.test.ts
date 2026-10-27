/** 验证同步编排的旧记录回读、补ID、重复、版本变化与网络失败；所有数据库、DOCX、飞书均用替身，无真实写入。 */
import {expect,test,mock} from 'bun:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {feishuTextFields} from './feishu-verification';
// mock.module为进程级替身；隔离子进程，避免污染同次运行的材料/路由测试。
if(process.env.AI_DISTILL_FEISHU_TEST_ISOLATED!=='1'){
 test('飞书同步八种分支在隔离进程中通过',()=>{
  const result=spawnSync(process.execPath,['test',import.meta.path],{env:{...process.env,AI_DISTILL_FEISHU_TEST_ISOLATED:'1'},encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr);expect(result.status).toBe(0);
 });
}else{
const id='11111111-1111-4111-8111-111111111111',base='base1234567890',table='tbl123456789',bytes=Buffer.from('verified docx');
const filename=`材料-${createHash('sha256').update(bytes).digest('hex').slice(0,16)}.docx`;
let state:any;
mock.module('../materials/redacted-docx-export',()=>({exportCurrentMaterialDocx:async(...args:any[])=>{state.exportOptions=args[5];return{artifacts:[{artifact_id:'docx'}]};},readCurrentMaterialDocx:async()=>({bytes,filename:'脱敏材料.docx'})}));
mock.module('./feishu-targets',()=>({readFeishuDeliveryConfig:async()=>({default_target:{base_token:base,table_id:table}}),validateFeishuTarget:(x:any)=>x}));
mock.module('../logging',()=>({logEvent:()=>{}}));
mock.module('./feishu-api',()=>({SyncError:class extends Error{constructor(public code:string){super(code);}},ensureFeishuSchema:async()=>{},createFeishuTable:async()=>({table_id:table}),removeEmptyFeishuRows:async()=>{},feishuClient:async()=>({close:async()=>{state.closed=true;},list:async(path:string)=>path.endsWith('/records')?state.rows:[],call:async(path:string,method='GET',body?:any)=>{
 state.calls.push({path,method,body});if(state.networkError)throw new Error('network');
 if(method==='PUT'){Object.assign(state.fields,body.fields);return{};}
 if(path.includes('upload_all'))return{file_token:'token'};
 if(method==='POST'){state.fields={...body.fields,'输入附件':[{file_token:'token',name:filename}]};return{record:{record_id:'record'}};}
 if(state.changeOnRead)state.snapshot.question={...state.snapshot.question,question_version:'new'};
 return{record:{fields:state.fields}};
}})}));
const {syncArchivedWorkflowToFeishu}=await import('./feishu');
function setup(existing=true){
 const question={question_version:'q1',rubric_version:'r1',task_name:'任务',task_type:'服务',question:'正文',rubric:['考点'],answer_approach:'思路',reference_answer:'答案'};
 state={snapshot:{question,acceptance:{decision:'accepted'},archive:{question_version:'q1',rubric_version:'r1',source_digest:'digest'},archive_attempt_id:'archive',authoring_input:{materials:[{id:'a',sha256:'h'}]}},fields:{...feishuTextFields(id,question),'输入附件':[{file_token:'token',name:filename}]},rows:existing?[{record_id:'record',fields:{'系统同步ID':id}}]:[],calls:[],receipts:[]};
 const db={release:()=>{},query:async(sql:string,args:any[])=>{
  if(sql.startsWith('SELECT q.result'))return{rows:[structuredClone(state.snapshot)]};
  if(sql.includes('WITH saved AS')){state.receipts.push(JSON.parse(args[1]));return{rows:[],rowCount:1};}
  if(sql.includes('pg_try_'))return{rows:[{locked:true}]};return{rows:[],rowCount:1};
 }};
 return{connect:async()=>db,query:async(sql:string,args:any[])=>sql.startsWith('SELECT w.project_id')?{rows:[{project_id:'project',phase_name:'第六期'}]}:db.query(sql,args)} as any;
}
test('新记录写可见题目ID，六字段回读通过才成功',async()=>{const pool=setup(false),r=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('succeeded');expect((r as any).verification.status).toBe('passed');expect(state.fields['题目ID']).toBe(id);expect(state.exportOptions.expectedAuthoringInput).toEqual(state.snapshot.authoring_input);expect(state.closed).toBe(true);});
test('已有记录补空题目ID后重新核对，不重复创建',async()=>{const pool=setup();delete state.fields['题目ID'];const r=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('succeeded');expect(state.calls.filter((c:any)=>c.method==='POST')).toHaveLength(0);expect(state.calls.some((c:any)=>c.method==='PUT')).toBe(true);});
test('已有记录正文截断返回具体差异，绝不覆写',async()=>{const pool=setup();state.fields.prompt='';const r:any=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('failed');expect(r.verification.status).toBe('failed');expect(r.verification.differences[0].field).toBe('prompt');expect(state.fields.prompt).toBe('');expect(state.calls.some((c:any)=>c.method==='POST')).toBe(false);});
test('不同的人工题目ID不被覆盖',async()=>{const pool=setup();state.rows[0].fields['题目ID']='manual';state.fields['题目ID']='manual';const r:any=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('failed');expect(r.verification.fields).toContain('题目ID');expect(state.calls.some((c:any)=>c.method==='PUT')).toBe(false);});
test('重复记录失败而非任选一条',async()=>{const pool=setup();state.rows.push(state.rows[0]);const r:any=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.reason_code).toBe('feishu_duplicate_question_records');expect(r.verification.status).toBe('failed');});
test('网络读取失败是未完成，不是内容差异',async()=>{const pool=setup();state.networkError=true;const r:any=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('failed');expect(r.verification.status).toBe('incomplete');expect(state.receipts.at(-1).verification.status).toBe('incomplete');});
test('回读时题目版本变化拒绝成功',async()=>{const pool=setup();state.changeOnRead=true;const r:any=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('failed');expect(r.reason_code).toBe('feishu_source_changed');});
test('飞书附件缺失不能算核对通过',async()=>{const pool=setup();state.fields['输入附件']=[];const r:any=await syncArchivedWorkflowToFeishu(pool,id,'storage','assets');expect(r.status).toBe('failed');expect(r.verification.fields).toContain('输入附件');});

}

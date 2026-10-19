/** 验证旧项目内材料包从成功脱敏版本独立建题、来源校验和索引重映射；使用内存 Pool 与临时文件，不访问真实数据库或重复调用脱敏。 */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {createQuestionFromMaterialPackage,listMaterialPackageVersions} from './material-package-questions';
import {redactionInputDigest} from './materials/redaction-jobs';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const packageId='11111111-1111-4111-8111-111111111111';
const materialId='22222222-2222-4222-8222-222222222222';
const extractedId='33333333-3333-4333-8333-333333333333';
const attemptId='44444444-4444-4444-8444-444444444444';

test('one successful material version creates two independent question snapshots without redaction work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-material-package-'));
 try{
  const raw='Original private fixture';
  await writeFile(join(root,'source.txt'),raw);
  const extracted=JSON.stringify({source_sha256:hash(raw),pages:[{page:1,text:raw}]});
  const refs=[{material_id:materialId,source_sha256:hash(raw),artifact_id:extractedId,artifact_sha256:hash(extracted),redaction_mode:'declared_redacted' as const}];
  const markdown='【附件 1】\n\nRedacted fixture\n\n【附件 1 结束】';
  const index=JSON.stringify({format:'redacted-index-v2',redacted_sha256:hash(markdown),pages:[{material_id:materialId,page:1}],materials:[{material_id:materialId,markdown:'Redacted fixture'}]});
  const queries:{sql:string;values?:unknown[]}[]=[];
  const client={query:async(sql:string,values?:unknown[])=>{
   queries.push({sql,values});
   if(sql.startsWith('SELECT w.id,w.project_id'))return{rows:[{id:packageId,project_id:packageId,material_mode:'material_packages',source_manifest:[]}],rowCount:1};
   if(sql.startsWith('SELECT id,input,result,finished_at'))return{rows:[{id:attemptId,input:{materials:refs,digest:redactionInputDigest(refs)},result:{redacted_sha256:hash(markdown)}}],rowCount:1};
   if(sql.startsWith('SELECT kind,content,sha256'))return{rows:[{kind:'redacted_markdown',content:markdown,sha256:hash(markdown)},{kind:'redacted_index',content:index,sha256:hash(index)}],rowCount:2};
   if(sql.startsWith('SELECT id,original_name,storage_path'))return{rows:[{id:materialId,original_name:'source.docx',storage_path:'source.txt',sha256:hash(raw),size_bytes:Buffer.byteLength(raw),content_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',redaction_mode:'declared_redacted'}],rowCount:1};
   if(sql.startsWith('SELECT id,material_id,content,sha256'))return{rows:[{id:extractedId,material_id:materialId,content:extracted,sha256:hash(extracted)}],rowCount:1};
   return{rows:[],rowCount:1};
  },release:()=>{}};
  const pool={connect:async()=>client,query:async(sql:string)=>sql.startsWith('SELECT id FROM ai_distill.workflows')?{rows:[{id:packageId}]}:{rows:[{id:attemptId,redacted_sha256:hash(markdown)}]}} as unknown as Pool;
  expect(await listMaterialPackageVersions(pool,packageId)).toHaveLength(1);
  const first=await createQuestionFromMaterialPackage(pool,root,packageId,{title:'题目一',redaction_attempt_id:attemptId,target_level:'L2'});
  const second=await createQuestionFromMaterialPackage(pool,root,packageId,{title:'题目二',redaction_attempt_id:attemptId,target_level:'L4'});
  expect(first.id).not.toBe(second.id);
  expect(first.source_redaction_sha256).toBe(hash(markdown));
  const clones=queries.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.materials'));
  expect(clones).toHaveLength(2);
  expect(clones[0]?.values?.[0]).not.toBe(clones[1]?.values?.[0]);
  expect(clones.map(call=>call.values?.[7])).toEqual(['declared_redacted','declared_redacted']);
  for(const question of [first,second]){
   const indexFile=queries.find(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts')&&call.values?.[1]===question.id&&call.values?.[3]==='redacted_index');
   const parsed=JSON.parse(String(indexFile?.values?.[7]));
   expect(parsed.materials[0].material_id).not.toBe(materialId);
   expect(parsed.pages[0].material_id).toBe(parsed.materials[0].material_id);
   const source=queries.find(call=>call.sql.startsWith('INSERT INTO ai_distill.materials')&&call.values?.[1]===question.id);
   expect(await readFile(join(root,String(source?.values?.[3])),'utf8')).toBe(raw);
  }
  expect(queries.some(call=>/INSERT INTO ai_distill.step_attempts/.test(call.sql)&&call.values?.[2]===9&&call.values?.[4]==='waiting')).toBe(false);
  expect(queries.filter(call=>call.sql==='COMMIT')).toHaveLength(2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('missing successful redaction version aborts creation without material writes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-material-package-'));
 const calls:string[]=[];
 const client={query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT w.id,w.project_id'))return{rows:[{id:packageId,project_id:packageId,material_mode:'material_packages'}]};return{rows:[]};},release:()=>{}};
 try{
  await expect(createQuestionFromMaterialPackage({connect:async()=>client} as unknown as Pool,root,packageId,{title:'无效',redaction_attempt_id:attemptId})).rejects.toThrow('所选脱敏版本未成功完成');
  expect(calls).toContain('ROLLBACK');
  expect(calls.some(sql=>sql.startsWith('INSERT INTO ai_distill.workflows'))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

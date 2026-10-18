/**
 * 职责：验证统一题目材料读取对 legacy 与 library_v1 的来源边界。
 * 主要检查：新来源由题目快照记录提供；缺失快照时不得退回旧 ordinal 9。
 */
import {expect,test} from 'bun:test';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../shared/workflow-config';
import {readQuestionMaterials} from './question-materials';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const workflowId='11111111-1111-4111-8111-111111111111';
const markdown='案件脱敏文本';
const markdownSha=digest(markdown);
const index=JSON.stringify({format:'redacted-index-v2',redacted_sha256:markdownSha,materials:[]});
const indexSha=digest(index);
const manifest={version:2,origin:{kind:'library_v1',package_id:'p1',package_name:'标准材料',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64)},files:[],redacted_markdown:{artifact_id:'markdown-1',sha256:markdownSha},redacted_index:{artifact_id:'index-1',sha256:indexSha}};

function mockDb(respond:(sql:string)=>unknown){
 const statements:string[]=[];
 const query=async(sql:string)=>{statements.push(sql);return respond(sql)??{rows:[],rowCount:0};};
 return{db:{query} as unknown as PoolClient,statements};
}

test('reads library question snapshot without consulting legacy redaction steps',async()=>{
 const {db,statements}=mockDb(sql=>{
  if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[{snapshot_manifest:manifest,snapshot_digest:digest(canonicalJson(manifest)),package_id:'p1',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64),markdown_artifact_id:'markdown-1',index_artifact_id:'index-1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.artifacts')&&sql.includes('ANY'))return{rows:[
   {id:'markdown-1',kind:'redacted_markdown',attempt_id:null,sha256:markdownSha,content:markdown},
   {id:'index-1',kind:'redacted_index',attempt_id:null,sha256:indexSha,content:index},
  ],rowCount:2};
  return undefined;
 });
 const result=await readQuestionMaterials(db,workflowId);
 expect(result.origin).toEqual({kind:'library_v1',package_id:'p1',revision_id:'r1',redaction_id:'d1',snapshot_digest:digest(canonicalJson(manifest))});
 expect(result.attachments).toEqual([{id:'markdown-1',sha256:markdownSha,content:markdown,source_names:[],attempt_id:null}]);
 expect(statements.some(sql=>sql.includes('ordinal=9'))).toBe(false);
});

test('rejects a library question without a source snapshot instead of falling back to ordinal 9',async()=>{
 const {db,statements}=mockDb(sql=>{
  if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[],rowCount:0};
  return undefined;
 });
 await expect(readQuestionMaterials(db,workflowId)).rejects.toThrow('来源快照');
 expect(statements.some(sql=>sql.includes('ordinal=9'))).toBe(false);
});

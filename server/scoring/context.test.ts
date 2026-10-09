import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readScoreContext} from './context';
import {inputDigest} from '../answer-models/input';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
test('scoring context uses the exact project rule snapshot pinned by authoring',async()=>{
 const root=await mkdtemp(join(tmpdir(),'score-context-'));const snapshot=join(root,'snapshot');
 try{
  await mkdir(join(snapshot,'skill'),{recursive:true});const text='本期评分须按项目资料';await writeFile(join(snapshot,'skill','SKILL.md'),text);
  const files=[{path:'skill/SKILL.md',sha256:hash(text),size_bytes:Buffer.byteLength(text)}];
  const answerInput={question_version:'q1',input_revision:1,question:'题目',materials:[{name:'附件1',text:'材料'}],attachments:[{id:'attachment',sha256:hash('材料')}],question_attempt_id:'author',input_digest:''};
  answerInput.input_digest=inputDigest({question_version:answerInput.question_version,input_revision:answerInput.input_revision,question:answerInput.question,materials:answerInput.materials,attachments:answerInput.attachments});
  const authorResult={...answerInput,attachment_ids:['attachment'],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'rubric-v1',rubric:[{id:'fact',criterion:'依据材料',max_score:1}]};
  const answerResult={text:'答案',input_digest:answerInput.input_digest,answer_sha256:hash('答案')};
  const db={query:async(sql:string)=>{
   if(sql.startsWith('SELECT w.input_revision'))return{rows:[{input_revision:1,rule_version_id:'rules-v1'}]};
   if(sql.startsWith('SELECT a.input,a.result'))return{rows:[{input:answerInput,result:answerResult}]};
   if(sql.startsWith('SELECT a.id,a.input,a.result'))return{rows:[{id:'author',input:{rule_version_id:'rules-v1',rule_source_digest:hash('rules'),rule_snapshot_path:snapshot,rule_files:files},result:authorResult}]};
   throw new Error(`unexpected query: ${sql}`);
  }} as any;
  const context=await readScoreContext(db,'workflow','answer');
  expect(context.project_rules).toEqual({version_id:'rules-v1',source_digest:hash('rules'),snapshot_path:snapshot,files});
 }finally{await rm(root,{recursive:true,force:true});}
});

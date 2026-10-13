/** 未达标题包导出：exportFailedQuestions 只经现有 API 读取当前绑定的题目、作答和评分，写入 assets 固定目录。 */
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {ApiClient, CliError} from './client';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const root=resolve(import.meta.dir,'../assets/未达标题目');
const safeName=(value:string)=>value.replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,80)||'题目';
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

export async function exportFailedQuestions(api:ApiClient,projectId:string,selectedIds?:string[],signal?:AbortSignal,mode:'failed'|'review'='failed') {
  const project=await api.json(`/api/projects/${projectId}`,'GET',undefined,signal);
  if(!Array.isArray(project?.workflows))throw new CliError('项目题目列表无效',{kind:'invalid_response'});
  const known=new Set<string>(project.workflows.map((item:any)=>item.id));
  const ids=selectedIds??project.workflows.map((item:any)=>item.id);
  if(ids.some(id=>!uuid.test(id)||!known.has(id)))throw new CliError('所选题目不属于该项目');
  const results:any[]=[];
  for(const workflowId of ids) {
    try {results.push(await exportOne(api,projectId,workflowId,signal,mode));}
    catch(error) {
      if(signal?.aborted)throw error;
      results.push({workflow_id:workflowId,status:'error',reason:error instanceof CliError?error.message:'导出失败'});
    }
  }
  return {outcome:results.some(item=>item.status==='error')?'partial':'complete',project_id:projectId,results};
}

async function exportOne(api:ApiClient,projectId:string,workflowId:string,signal?:AbortSignal,mode:'failed'|'review'='failed') {
  const data=await api.json(`/api/workflows/${workflowId}`,'GET',undefined,signal);
  if(data?.workflow?.project_id!==projectId)throw new CliError('题目项目关联不一致',{kind:'invalid_response'});
  const step=(ordinal:number)=>data.steps?.find((item:any)=>item.ordinal===ordinal);
  const question=step(4)?.result, scoring=step(6)?.result, decision=step(7)?.result;
  if(mode==='failed'&&decision?.decision!=='repair')return {workflow_id:workflowId,status:'skipped',reason:'当前不是未达标判定'};
  if(mode==='review'&&!['repair','accepted'].includes(decision?.decision))throw new CliError('当前没有可复核的有效评分判定',{kind:'invalid_response'});
  if(!question?.question_version||!question?.rubric_version||!Array.isArray(scoring?.models))throw new CliError('当前题包或评分关联缺失',{kind:'invalid_response'});
  const decisionAttempt=[...(data.attempts??[])].reverse().find((item:any)=>item.ordinal===7&&item.status==='succeeded');
  const authorAttempt=[...(data.attempts??[])].reverse().find((item:any)=>item.ordinal===4&&item.status==='succeeded');
  if(!uuid.test(decisionAttempt?.id??'')||!uuid.test(authorAttempt?.id??''))throw new CliError('当前判定或出题记录缺失',{kind:'invalid_response'});
  const author=await api.json(`/api/attempts/${authorAttempt.id}?view=full`,'GET',undefined,signal);
  if(author?.result?.question_version!==question.question_version||author?.result?.rubric_version!==question.rubric_version)throw new CliError('出题记录与当前题包版本不一致',{kind:'invalid_response'});
  const artifact=(kind:string,attemptId:string)=>{
    const found=data.artifacts?.find((item:any)=>item.kind===kind&&item.attempt_id===attemptId&&item.question_version===question.question_version);
    if(!uuid.test(found?.id??''))throw new CliError(`${kind} 当前产物缺失`,{kind:'invalid_response'});
    return found.id as string;
  };
  const files:{name:string;bytes:Uint8Array}[]=[];
  files.push({name:'出题.txt',bytes:await api.download(`/api/artifacts/${artifact('authored_question',authorAttempt.id)}/download`,signal)});
  const models:any[]=[];
  for(const model of scoring.models) {
    const modelDecision=decision.model_scores?.[model.model_id];
    if(!uuid.test(model.model_id??'')||!uuid.test(model.answer_attempt_id??'')||!uuid.test(model.score_attempt_id??'')
      ||model.score_status!=='succeeded'||model.valid!==true||!modelDecision||modelDecision.score!==model.score)throw new CliError('模型评分与当前判定关联不一致',{kind:'invalid_response'});
    const score=await api.json(`/api/attempts/${model.score_attempt_id}?view=full`,'GET',undefined,signal);
    const binding=score?.result?.binding;
    if(score.status!=='succeeded'||score.result?.validation?.valid!==true||binding?.answer_attempt_id!==model.answer_attempt_id
      ||binding?.question_version!==question.question_version||binding?.rubric_version!==question.rubric_version
      ||binding?.answer_sha256!==model.binding?.answer_sha256||typeof score.result?.raw_text!=='string')throw new CliError('评分记录绑定无效',{kind:'invalid_response'});
    const answer=await api.download(`/api/artifacts/${artifact('model_answer',model.answer_attempt_id)}/download`,signal);
    if(sha256(answer)!==binding.answer_sha256)throw new CliError('作答产物与评分绑定哈希不一致',{kind:'invalid_response'});
    const scoreJson=await api.download(`/api/artifacts/${artifact('score_report',model.score_attempt_id)}/download`,signal);
    const folder=`模型-${model.model_id}`;
    files.push({name:`${folder}/作答.txt`,bytes:answer});
    files.push({name:`${folder}/评分.txt`,bytes:new TextEncoder().encode(score.result.raw_text)});
    files.push({name:`${folder}/评分.json`,bytes:scoreJson});
    models.push({model_id:model.model_id,model_name:model.name,answer_attempt_id:model.answer_attempt_id,score_attempt_id:model.score_attempt_id,score:model.score,max_score:model.max_score,percentage:modelDecision.percentage,threshold:modelDecision.threshold,status:modelDecision.status});
  }
  if(!models.length)throw new CliError('当前判定没有可导出的模型评分',{kind:'invalid_response'});
  const questionKey=safeName(data.workflow.source_key||question.question_id||workflowId);
  const target=join(root,projectId,`${questionKey}-${workflowId}`,decisionAttempt.id);
  const manifest={schema_version:1,project_id:projectId,workflow_id:workflowId,question_id:question.question_id,
    decision:decision.decision,...(mode==='review'?{export_purpose:'指定题目作答质量复核'}:{}),decision_attempt_id:decisionAttempt.id,author_attempt_id:authorAttempt.id,
    question_version:question.question_version,rubric_version:question.rubric_version,models,
    files:files.map(file=>({path:file.name,sha256:sha256(file.bytes),size_bytes:file.bytes.length}))};
  try {
    const existing=JSON.parse(await readFile(join(target,'清单.json'),'utf8'));
    if(JSON.stringify(existing)!==JSON.stringify(manifest))throw new CliError('同一判定已有不同清单，不覆盖',{kind:'file_error'});
    for(const file of files)if(sha256(await readFile(join(target,file.name)))!==sha256(file.bytes))throw new CliError('已导出文件与清单不一致，不覆盖',{kind:'file_error'});
    return {workflow_id:workflowId,status:'already_exported',path:target,models:models.map(({model_id,score,max_score,percentage,threshold,status})=>({model_id,score,max_score,percentage,threshold,status}))};
  } catch(error) {
    if(error instanceof CliError)throw error;
    if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw new CliError('无法核对已有导出目录',{kind:'file_error'});
  }
  const parent=resolve(target,'..');
  await mkdir(parent,{recursive:true,mode:0o700});
  const temp=join(parent,`.tmp-${randomUUID()}`);
  try {
    await mkdir(temp,{mode:0o700});
    for(const file of files) {
      const path=join(temp,file.name);
      if(file.name.includes('/'))await mkdir(resolve(path,'..'),{recursive:true,mode:0o700});
      await writeFile(path,file.bytes,{flag:'wx',mode:0o600});
    }
    await writeFile(join(temp,'清单.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    await rename(temp,target);
  } catch(error) {
    await rm(temp,{recursive:true,force:true});
    if((error as NodeJS.ErrnoException)?.code==='EEXIST'||(error as NodeJS.ErrnoException)?.code==='ENOTEMPTY')throw new CliError('同一判定已导出；不会覆盖已有文件',{kind:'file_error'});
    throw new CliError('导出文件写入失败',{kind:'file_error'});
  }
  return {workflow_id:workflowId,status:'exported',path:target,models:models.map(({model_id,score,max_score,percentage,threshold,status})=>({model_id,score,max_score,percentage,threshold,status}))};
}

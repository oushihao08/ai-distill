/** 迁移前后行为对照的合成输入采集器；只用注入作者，不调用模型/数据库/网络。由flow.test.ts及基线生成命令使用。 */
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAuthoring,renderPrivateQuestionPackage} from '../authoring/executor';
import {buildAnswerInput,buildAnswerMessage} from '../answer-models/input';
import {scoreExecutionInstructions} from '../scoring/executor';
import {decideAcceptance} from '../decisions/acceptance';
export function sampleDraft(work=false):any {
 const value:any={task_name:'合成核算',task_type:'合成分析',header:{industry_l1:'法律',industry_l2:'法律服务',task_form:'single_round',occupation_l1:'专业人员',occupation_l2:'律师'},question:'仅依据附件核算100元。',attachment_ids:['a'],rubric:[{id:'r',criterion:'核清金额',max_score:1}],answer_approach:'对照附件',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
 if(work)Object.assign(value,{content_contract:'work_legal_v1',task_metadata:{instruction:{background:'合成背景',requests:['给出意见'],baseline_date:null,hard_constraints:[]}},input_files:[{attachment_id:'a',name:'附件1',description:'合成材料'}],deliverables:[{id:'d',path:'意见.docx',format:'docx',description:'核算意见',required:true}],reference_outputs:[{deliverable_id:'d',content:'完整合成意见',sheets:[]}],research_records:[],task_requirements:{input_mode:'text',output_mode:'file',tools:[]},content_status:{status:'complete',issues:[]},rubric:[{id:'r',metadata:{statement:'核清金额',type:'binary',priority:'Important',score:7,points:null,trigger_count:null}}]});
 if(work){delete value.question;delete value.reference_answer;}
 return value;
}
export async function captureFlowBaseline(){
 const records:any={};
 for(const name of ['普通项目','豆包高经济价值','Work法律全场景','Work新契约']){
  const root=await mkdtemp(join(tmpdir(),'lifecycle-baseline-'));
  try{
   const work=name==='Work新契约',project_name=name==='Work新契约'?'Work法律全场景 - 一期':name==='Work法律全场景'?'Work法律全场景 - 旧期':name;
   let request:any,contract:any;
   const result=await runAuthoring({root,workspace_path:root,project_name,question:'合成任务',materials:[{id:'a',sha256:'a'.repeat(64),text:'金额100元',source_names:['材料.pdf']}],project_context:{source_digest:'b'.repeat(64),files:[{path:'skill/SKILL.md',text:'合成规则'}]},model:'fixture',reasoning_effort:'medium',...(name.includes('Work')?{scoring_policy:{contract:'model_report_v1' as const,rules_text:'按给定判据评分',reference_answer:'none' as const}}:{}),...(work?{content_contract:'work_legal_v1' as const}:{}),execute:async call=>{
    contract=JSON.parse(await readFile(join(call.directory,'input/delivery.json'),'utf8'));
    request={prompt:call.prompt,schema:call.schema};
    return {result:call.validate(sampleDraft(work)),session_id:'fixture',usage:null,duration_ms:1} as any;
   }});
   const input=buildAnswerInput({...result.draft,question_version:result.question_version},[{id:'a',kind:'redacted_markdown',sha256:'a'.repeat(64),text:'金额100元'}]);
   const normalize=(v:any)=>JSON.parse(JSON.stringify(v).replaceAll(root,'<ROOT>').replaceAll(process.execPath,'<RUNTIME>').replace(/authoring-[0-9a-f-]{36}/g,'authoring-<ATTEMPT>'));
   records[name]=normalize({request,contract,result,private_package:renderPrivateQuestionPackage({question:'合成任务',materials:[{source_names:['材料.pdf']}]},result.draft),answer_input:input,answer_message:buildAnswerMessage(input),score_instructions:scoreExecutionInstructions('codex',name.includes('Work')?'model_report_v1':undefined,work?'literal_v1':undefined)});
  }finally{await rm(root,{recursive:true,force:true});}
 }
 // 达标输入由原有acceptance回归覆盖；这里固定保留可用的纯决策输出。
 records.acceptance=decideAcceptance({} as any);
 return records;
}

/** 验证评分报告的证据引用、逐项覆盖、零分理由与合计重算。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {validateScore} from './validate';
import {extractTextScore,extractModelReport} from './validate';
const binding={question_version:'v1',input_digest:'a'.repeat(64),rubric_version:'r1',rubric_digest:'c'.repeat(64),answer_attempt_id:'answer',answer_sha256:'b'.repeat(64)};
const context={binding,question:'问题',materials:[{name:'附件1',text:'金额100'}],answer:'实际答案：金额100。未支付。',rubric:[{id:'one',max_score:1,criterion:'指出金额'},{id:'two',max_score:1,criterion:'指出日期'}],answer_approach:'依据答案逐项核对',reference_answer:'金额100，日期未出现',project_rules:{version_id:'rules',source_digest:'d'.repeat(64),snapshot_path:'rules',files:[{path:'skill/SKILL.md',sha256:'e'.repeat(64),size_bytes:1}]}};
const report={binding,assessment_valid:true,items:[{id:'one',score:1,reason:'金额完整',evidence:[{source:'answer',quote:'金额100'}]},{id:'two',score:0,reason:'没有日期',missing:true,evidence:[]}],total:1,max_score:2,disputes:[]};
const modelRubric=[{id:'positive',criterion:'正向要求',rule:'命中加10分'},{id:'negative',criterion:'错误',rule:'命中扣7分'},{id:'veto',criterion:'否决',rule:'触发时单独记录，不计分'}];
const modelReport={contract:'model_report_v1',items:modelRubric.map((r,i)=>({id:r.id,judgment:'模型判断',score_delta:[10,-7,null][i],reason:'模型说明'})),summary:{raw_score:-9,full_score:100,evaluation_percent:0,veto_triggered:true}};
const envelope=(value:unknown)=>`完整评分原文\n<model_report>\n${JSON.stringify(value)}\n</model_report>`;
test('模型评分接收负分和否决，原样收集总分而不按分项重算',()=>{
 const result=extractModelReport(envelope(modelReport),modelRubric);
 expect(result).toMatchObject({valid:true,report:modelReport,evaluation_percent:0,issues:[]});
});
test('模型未给比较指标时报告仍可保存，指标保持 null',()=>{
 expect(extractModelReport(envelope({...modelReport,summary:{...modelReport.summary,evaluation_percent:null}}),modelRubric)).toMatchObject({valid:true,evaluation_percent:null});
});
test('模型报告拒绝缺失重复结果区、缺项、未知编号和越界指标',()=>{
 for(const text of ['正文无结果区',envelope(modelReport)+envelope(modelReport),envelope({...modelReport,items:modelReport.items.slice(1)}),envelope({...modelReport,items:[...modelReport.items,{...modelReport.items[0],id:'other'}]}),envelope({...modelReport,summary:{...modelReport.summary,evaluation_percent:101}}),envelope({...modelReport,summary:{raw_score:0}}),'<model_report>{"contract":"model_report_v1"']){
  expect(extractModelReport(text,modelRubric)).toMatchObject({valid:false,evaluation_percent:null});
 }
});
test('validates complete evidence-backed report and recomputes total',()=>{expect(validateScore(report,context)).toMatchObject({valid:true,total:1,max_score:2,issues:[]});});
test.each(['question_version','input_digest','rubric_version','rubric_digest','answer_attempt_id','answer_sha256'])('rejects mismatched %s',key=>{expect(validateScore({...report,binding:{...binding,[key]:'changed'}},context).valid).toBe(false);});
test('rejects fabricated quote and missing positive evidence',()=>{expect(validateScore({...report,items:[{...report.items[0],evidence:[{source:'answer',quote:'不存在的原文'}]},report.items[1]]},context).valid).toBe(false);expect(validateScore({...report,items:[{...report.items[0],evidence:[]},report.items[1]]},context).valid).toBe(false);});
test.each([{assessment_valid:false},{assessment_valid:undefined},{items:[report.items[0]]},{items:[report.items[0],report.items[0]]},{total:2},{max_score:20},{disputes:['rubric与材料冲突']},{items:[{...report.items[0],score:2},report.items[1]]},{items:[{...report.items[0],score:NaN},report.items[1]]}])('rejects incomplete, disputed or inconsistent score',change=>{expect(validateScore({...report,...change},context).valid).toBe(false);});
test('zero score requires a reason plus evidence or explicit missing finding',()=>{expect(validateScore({...report,items:[report.items[0],{...report.items[1],missing:false}]},context).valid).toBe(false);expect(validateScore({...report,items:[report.items[0],{...report.items[1],reason:''}]},context).valid).toBe(false);});
test('quote from materials cannot substitute answer evidence for positive score',()=>{expect(validateScore({...report,items:[{...report.items[0],evidence:[{source:'material',material_index:0,quote:'金额100'}]},report.items[1]]},context).valid).toBe(false);});
test.each([null,{}, {binding,items:'bad'}, {binding,items:[],disputes:'bad'}])('malformed report returns invalid without throwing',value=>{expect(validateScore(value,context).valid).toBe(false);});
test('positive score cannot also claim the required answer was missing',()=>{expect(validateScore({...report,items:[{...report.items[0],missing:true},report.items[1]]},context).valid).toBe(false);});

test('text scoring requires one binary score row for every unit-weight rubric item',()=>{
 const text='one：1 / 1分。证据完整。\ntwo：0 / 1分。未找到。\n最终总分：1 / 2 分';
 expect(extractTextScore(text,context.rubric)).toMatchObject({valid:true,total:1,max_score:2,issues:[]});
});

test('text scoring rejects partial points even when the final total is extractable',()=>{
 const text='one：0.5 / 1分。部分满足。\ntwo：0 / 1分。未找到。\n最终总分：0.5 / 2 分';
 expect(extractTextScore(text,context.rubric)).toMatchObject({valid:false,total:null,max_score:2});
 expect(extractTextScore(text,context.rubric).issues.join(' ')).toContain('只能为0或1');
});

test('text scoring rejects a final total when a unit-weight rubric item is missing',()=>{
 const text='one：1 / 1分。证据完整。\n最终总分：1 / 2 分';
 expect(extractTextScore(text,context.rubric)).toMatchObject({valid:false,total:null,max_score:2});
 expect(extractTextScore(text,context.rubric).issues.join(' ')).toContain('条目评分缺失');
});

test('text scoring validates exact IDs and weighted rows for every rubric',()=>{
 const rubric=[{id:'1',max_score:2,criterion:'两分项'},{id:'10',max_score:1,criterion:'单位分项'}];
 const valid='1：2 / 2分。满足。\n10：0 / 1分。未找到。\n最终总分：2 / 3 分';
 expect(extractTextScore(valid,rubric)).toMatchObject({valid:true,total:2,max_score:3,issues:[]});
 const mismatched='R1：2 / 2分。满足。\nR10：0 / 1分。未找到。\n最终总分：2 / 3 分';
 expect(extractTextScore(mismatched,rubric).valid).toBe(false);
 expect(extractTextScore(mismatched,rubric).issues.join(' ')).toContain('ID不属于本题rubric');
});


test('Markdown headings are presentation, not rubric ID prefixes',()=>{
 const rubric=[{id:'R01',max_score:1,criterion:'第一项'},{id:'R02',max_score:1,criterion:'第二项'}];
 const text='### R01：1/1\n证据与理由。\n### **R02：0/1**\n未找到。\n## 最终总分：1 / 2 分';
 expect(extractTextScore(text,rubric)).toMatchObject({valid:true,total:1,max_score:2,issues:[]});
 expect(extractTextScore(text.replace('R02','R03'),rubric).valid).toBe(false);
 expect(extractTextScore(text+'\nR01：1/1',rubric).valid).toBe(false);
});

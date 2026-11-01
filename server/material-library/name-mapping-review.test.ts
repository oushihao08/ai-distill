/** 验证主体候选完整分流、姓氏保护与指定模型调用留痕；不调用真实Agent、数据库或材料接口。 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewNameMappings,validateNameMappingReview,type NameMappingPackage} from './name-mapping-review';

const ids={package:'11111111-1111-4111-8111-111111111111',redaction:'22222222-2222-4222-8222-222222222222',workflow:'33333333-3333-4333-8333-333333333333',file:'44444444-4444-4444-8444-444444444444'};
const candidates=[['杨政','林志远'],['重庆天宇科技有限公司','重庆远辰科技有限公司'],['申请人','当事人']].map(([original,before])=>({original,before,count:1,question_hits:0,samples:[{file_id:ids.file,original_name:'材料.pdf',page:1,path:'/0/text',context:'证据'}]}));
const packages:NameMappingPackage[]=[{package_id:ids.package,redaction_id:ids.redaction,workflow_id:ids.workflow,candidates}];
const valid={packages:[{package_id:ids.package,redaction_id:ids.redaction,mappings:[{original:'杨政',before:'林志远',after:'杨正',kind:'person' as const,reason:'姓氏及读音符合'}],unresolved:[{original:'重庆天宇科技有限公司',before:'重庆远辰科技有限公司',reason:'字号边界待核'}],ignored:[{original:'申请人',before:'当事人',reason:'普通角色词'}]}]};

test('每个候选恰好分流一次并保留人名姓氏',()=>{
 expect(validateNameMappingReview(valid,packages)).toEqual(valid);
 expect(()=>validateNameMappingReview({...valid,packages:[{...valid.packages[0],ignored:[]}]},packages)).toThrow('未全部分流');
 expect(()=>validateNameMappingReview({...valid,packages:[{...valid.packages[0],mappings:[{...valid.packages[0].mappings[0],after:'林正'}]}]},packages)).toThrow('改变了姓氏');
 expect(()=>validateNameMappingReview({...valid,packages:[{...valid.packages[0],mappings:[{...valid.packages[0].mappings[0],after:'杨政'}]}]},packages)).toThrow('仍暴露原名');
});

test('单位映射保留行政区划、行业和组织形式',()=>{
 const source:NameMappingPackage[]=[{package_id:ids.package,redaction_id:ids.redaction,workflow_id:ids.workflow,candidates:[candidates[1]]}];
 const result=(after:string)=>({packages:[{package_id:ids.package,redaction_id:ids.redaction,mappings:[{original:'重庆天宇科技有限公司',before:'重庆远辰科技有限公司',after,kind:'organization' as const,reason:'仅改字号'}],unresolved:[],ignored:[]}]});
 expect(validateNameMappingReview(result('重庆添余科技有限公司'),source).packages[0].mappings[0].after).toBe('重庆添余科技有限公司');
 for(const invalid of ['上海添余科技有限公司','重庆添余物流有限公司','重庆添余科技集团'])expect(()=>validateNameMappingReview(result(invalid),source)).toThrow('行政区划、行业或组织形式');
});

test('复核调用冻结指定模型并保存私有请求与结果',async()=>{
 const root=await mkdtemp(join(tmpdir(),'name-review-'));
 try{
  let task:any;
  const result=await reviewNameMappings(root,{model:'gpt-5.6-sol',reasoning_effort:'medium',packages},async input=>{task=input;return{result:input.validate(valid),session_id:'session',usage:{total_tokens:10},diagnostic_path:'private',duration_ms:12,provider:'codex',model:input.model,requested_model:input.model,returned_model:null} as any;});
  expect(task).toMatchObject({task_type:'material_name_mapping_review',model:'gpt-5.6-sol',reasoning_effort:'medium'});expect(result.packages[0].mappings[0].after).toBe('杨正');
  const request=JSON.parse(await readFile(join(root,'name-revision-reviews',result.call_id,'request.private.json'),'utf8'));expect(request.packages[0].candidates).toHaveLength(3);
  const receipt=JSON.parse(await readFile(join(root,'name-revision-reviews',result.call_id,'result.private.json'),'utf8'));expect(receipt.requested_model).toBe('gpt-5.6-sol');
 }finally{await rm(root,{recursive:true,force:true});}
});

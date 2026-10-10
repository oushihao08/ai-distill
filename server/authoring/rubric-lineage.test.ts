/** 验证多轮 rubric 返修保留成功题面基线，并拒绝循环或伪造血缘。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {findRubricBaseline} from './jobs';
const requirements={input_mode:'text' as const,output_mode:'text' as const,tools:[]};
const draft={task_name:'金额核算',task_type:'合同计算',header:{industry_l1:'待确认',industry_l2:'待确认',task_form:'single_round' as const,occupation_l1:'待确认',occupation_l2:'待确认'},question:'金额？',attachment_ids:['attachment'],answer_requirements:requirements,answer_approach:'核对合同金额',reference_answer:'100元',rubric:[{id:'amount',criterion:'100元',max_score:1}]};
const failed=(id:string,parent:string)=>({id,status:'failed',input:{revision:{mode:'rubric',source_attempt_id:parent}}});
test('several rubric failures retain the exact successful question baseline',async()=>{
 const baseline={id:'baseline',status:'succeeded',result:{task_name:draft.task_name,task_type:draft.task_type,header:draft.header,question:draft.question,attachment_ids:draft.attachment_ids,answer_approach:draft.answer_approach,answer_requirements:{tools:[],output_mode:'text',input_mode:'text'}}};
 const rows:any={middle:failed('middle','baseline'),baseline};const pool={query:async(_sql:string,values:any[])=>({rows:rows[values[0]]?[rows[values[0]]]:[]})} as any;
 expect(await findRubricBaseline(pool,'workflow',failed('latest','middle'),draft)).toEqual(baseline);
 expect(await findRubricBaseline(pool,'workflow',failed('latest','middle'),{...draft,question:'已修改题面'})).toBeUndefined();
 expect(await findRubricBaseline(pool,'workflow',failed('latest','missing'),draft)).toBeUndefined();
});
test('cyclic failed lineage cannot select or invent a successful baseline',async()=>{
 const node=failed('cycle','cycle'),pool={query:async()=>({rows:[node]})} as any;
 await expect(findRubricBaseline(pool,'workflow',node,draft)).rejects.toThrow('cyclic');
});

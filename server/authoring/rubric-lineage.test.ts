import {test,expect} from 'bun:test';
import {findRubricBaseline} from './jobs';
const requirements={input_mode:'text' as const,output_mode:'text' as const,tools:[]};
const draft={question:'金额？',attachment_ids:['attachment'],answer_requirements:requirements,reference_answer:'100元',rubric:[{id:'amount',criterion:'100元',max_score:1}]};
const failed=(id:string,parent:string)=>({id,status:'failed',input:{revision:{mode:'rubric',source_attempt_id:parent}}});
test('several rubric failures retain the exact successful question baseline',async()=>{
 const baseline={id:'baseline',status:'succeeded',result:{question:draft.question,attachment_ids:draft.attachment_ids,answer_requirements:{tools:[],output_mode:'text',input_mode:'text'}}};
 const rows:any={middle:failed('middle','baseline'),baseline};const pool={query:async(_sql:string,values:any[])=>({rows:rows[values[0]]?[rows[values[0]]]:[]})} as any;
 expect(await findRubricBaseline(pool,'workflow',1,failed('latest','middle'),draft)).toEqual(baseline);
 expect(await findRubricBaseline(pool,'workflow',1,failed('latest','middle'),{...draft,question:'已修改题面'})).toBeUndefined();
 expect(await findRubricBaseline(pool,'workflow',1,failed('latest','missing'),draft)).toBeUndefined();
});
test('cyclic failed lineage cannot select or invent a successful baseline',async()=>{
 const node=failed('cycle','cycle'),pool={query:async()=>({rows:[node]})} as any;
 await expect(findRubricBaseline(pool,'workflow',1,node,draft)).rejects.toThrow('cyclic');
});

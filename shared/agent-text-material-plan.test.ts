/** 验证新ID文本契约的字段归属、原ID复用、空行坐标和长度变化；使用合成结构，不调用模型或数据库。 */
import {test,expect} from 'bun:test';
import {agentMaterialSource,compileAgentTextMaterialPlan,type PreparationFile,type AgentTextMaterialPlan} from './agent-material-plan';
import {documentBlocksToText,type DocumentBlock} from './document-structure';
const identity={revision_id:'r',extraction_job_id:'e',template_id:'aliases',template_digest:'digest'};
function files(blocks:DocumentBlock[]):PreparationFile[]{return[{file_id:'file',text_sha256:'hash',pages:[{page:1,text:documentBlocksToText(blocks),structure:blocks}]}];}
function planFor(input:PreparationFile[]):AgentTextMaterialPlan{
 const source=agentMaterialSource(input);
 return{texts:[...source.fields].map(([id,f])=>({id,text:f.text})),documents:[{id:'d',title:'材料',ranges:[{first_block_id:source.blocks[0]!.id,last_block_id:source.blocks.at(-1)!.id}],duplicate_of:null}],unresolved:[]};
}
function failure(run:()=>unknown,reason_code:string){let error:unknown;try{run();}catch(reason){error=reason;}expect(error).toMatchObject({reason_code});}

test('duplicate original block IDs cannot redirect one text replacement into its neighbor',()=>{
 const input=files([{id:'same',kind:'paragraph',text:'张三'},{id:'same',kind:'paragraph',text:'李四'}]),before=JSON.stringify(input),plan=planFor(input);
 expect(plan.texts.map(t=>t.text)).toEqual(['张三','李四']);expect(new Set(plan.texts.map(t=>t.id)).size).toBe(2);
 plan.texts[0]!.text='张叁';const out=compileAgentTextMaterialPlan(plan,input,identity);
 expect(out.prepared.pages[0]!.text).toBe('张叁\n李四');expect(out.prepared.pages[0]!.structure.map(b=>b.id)).toEqual(['same','same']);expect(JSON.stringify(input)).toBe(before);
});
test('missing original IDs use distinct frozen positions and do not replace another field',()=>{
 const input=files([{kind:'paragraph',text:'甲'},{kind:'paragraph',text:'乙'}] as any),plan=planFor(input);
 plan.texts[1]!.text='乙化名';expect(compileAgentTextMaterialPlan(plan,input,identity).prepared.pages[0]!.text).toBe('甲\n乙化名');
});
test('valid original IDs survive text changes and insertion of a different source block',()=>{
 const a=files([{id:'original',kind:'paragraph',text:'张三'}]),b=files([{id:'added',kind:'paragraph',text:'前文'},{id:'original',kind:'paragraph',text:'张叁'}]);
 expect(planFor(a).texts[0]!.id).toBe('f1p1/original#text');expect(planFor(b).texts[1]!.id).toBe(planFor(a).texts[0]!.id);
});
test('file and page scope isolate identical original IDs and identical text',()=>{
 const input=files([{id:'same',kind:'paragraph',text:'张三'}]);input[0]!.pages.push({...input[0]!.pages[0]!,page:2});input.push({...input[0]!,file_id:'second',pages:[input[0]!.pages[0]!]});
 const plan=planFor(input);expect(new Set(plan.texts.map(t=>t.id)).size).toBe(3);plan.texts[2]!.text='张叁';
 const out=compileAgentTextMaterialPlan(plan,input,identity);expect(out.prepared.pages.map(p=>p.text)).toEqual(['张三','张三','张叁']);
});
test('escaped original IDs cannot collide with a field separator or missing-ID fallback',()=>{
 const input=files([{id:'@2',kind:'paragraph',text:'甲'},{kind:'paragraph',text:'乙'},{id:'a#text/rows',kind:'paragraph',text:'丙'}] as any),plan=planFor(input);
 expect(new Set(plan.texts.map(t=>t.id)).size).toBe(3);plan.texts.reverse();expect(compileAgentTextMaterialPlan(plan,input,identity).prepared.pages[0]!.text).toBe('甲\n乙\n丙');
});
test('table caption, blank rows, merged cells and list items keep exact field ownership',()=>{
 const input=files([{id:'table',kind:'table',caption:'表题',rows:[{cells:[]},{cells:[]},{cells:[{text:'张三',rowSpan:2},{text:'100元',columnSpan:2}]},{cells:[{text:'2026年1月1日'}]}],footnotes:['脚注']},{id:'list',kind:'list',items:['张三','正文']}]),plan=planFor(input),before=JSON.stringify(input);
 for(const t of plan.texts)if(t.text==='张三')t.text='张叁';
 const out=compileAgentTextMaterialPlan(plan,input,identity),table=out.prepared.pages[0]!.structure[0] as Extract<DocumentBlock,{kind:'table'}>;
 expect(table.rows[2]!.cells).toEqual([{text:'张叁',rowSpan:2},{text:'100元',columnSpan:2}]);expect(table.rows.slice(0,2)).toEqual([{cells:[]},{cells:[]}]);expect(table.footnotes).toEqual(['脚注']);expect(out.prepared.pages[0]!.structure[1]).toMatchObject({items:['张叁','正文']});expect(JSON.stringify(input)).toBe(before);
});
test('length changes and pure insertion remap separate documents without losing amount or date',()=>{
 const input=files([{id:'a',kind:'paragraph',text:'张三'},{id:'b',kind:'paragraph',text:'金额100元，日期2026年1月1日，😀'}]),plan=planFor(input),source=agentMaterialSource(input);
 plan.texts[0]!.text='张三丰';plan.texts[1]!.text=plan.texts[1]!.text.replace('😀','😁');plan.documents=source.blocks.map((b,i)=>({id:`d${i}`,title:`材料${i}`,ranges:[{first_block_id:b.id,last_block_id:b.id}],duplicate_of:null}));
 const out=compileAgentTextMaterialPlan(plan,input,identity);expect(out.prepared.documents.map(d=>d.text.trimEnd())).toEqual(['张三丰','金额100元，日期2026年1月1日，😁']);
 expect(out.plan.documents[0]!.segments[0]!.end).toBe(out.plan.documents[1]!.segments[0]!.start);
});
test('missing, duplicate and unknown returned IDs fail before publication',()=>{
 const input=files([{id:'a',kind:'paragraph',text:'甲'}]);const p=planFor(input);
 failure(()=>compileAgentTextMaterialPlan({...p,texts:[]},input,identity),'agent_text_coverage_missing');
 failure(()=>compileAgentTextMaterialPlan({...p,texts:[...p.texts,...p.texts]},input,identity),'agent_text_id_invalid');
 failure(()=>compileAgentTextMaterialPlan({...p,texts:[{id:'unknown',text:'甲'}]},input,identity),'agent_text_id_invalid');
});
test('legacy or mixed output cannot bypass the new ID/text contract',()=>{
 const input=files([{id:'a',kind:'paragraph',text:'甲'}]),p=planFor(input);
 failure(()=>compileAgentTextMaterialPlan({...p,entities:[],edits:[]},input,identity),'agent_text_shape_invalid');
 failure(()=>compileAgentTextMaterialPlan({...p,texts:[{id:'f1p1b1f1',text:'乙'}]},input,identity),'agent_text_id_invalid');
});
test('empty source fields stay empty and repeated file/page identities fail safely',()=>{
 const input=files([{id:'a',kind:'paragraph',text:''},{id:'b',kind:'paragraph',text:'金额100元'}]),p=planFor(input);p.texts[0]!.text='新增内容';
 failure(()=>compileAgentTextMaterialPlan(p,input,identity),'agent_text_empty_source_changed');
 failure(()=>agentMaterialSource([input[0]!,input[0]!]),'agent_source_identity_invalid');
 failure(()=>agentMaterialSource([{...input[0]!,pages:[input[0]!.pages[0]!,input[0]!.pages[0]!]}]),'agent_source_identity_invalid');
});

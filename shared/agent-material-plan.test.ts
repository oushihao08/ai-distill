/** 验证Agent材料计划的主体映射、程序定位、分册覆盖和规则保真；仅使用合成材料。 */
import {test,expect} from 'bun:test';
import {ALIAS_REDACTION_PROMPT} from './redaction-templates';
import {agentMaterialSource,compileAgentMaterialPlan,type AgentMaterialPlan,type PreparationFile} from './agent-material-plan';
import {createHash} from 'node:crypto';

test('default Agent policy uses fixed natural pseudonyms, preserves courts and stops within ten minutes',()=>{
 expect(ALIAS_REDACTION_PROMPT).toContain('自然的虚构姓名');
 expect(ALIAS_REDACTION_PROMPT).toContain('法院名称保留');
 expect(ALIAS_REDACTION_PROMPT).toContain('10分钟');
 expect(ALIAS_REDACTION_PROMPT).not.toContain('人名使用人员甲');
 expect(ALIAS_REDACTION_PROMPT).toContain('组合文书');
 expect(ALIAS_REDACTION_PROMPT).toContain('不确定是否同一主体');
 expect(ALIAS_REDACTION_PROMPT).toContain('仅敏感片段尚未安全处理或正文无法完整覆盖');
});

const identity={revision_id:'11111111-1111-4111-8111-111111111111',extraction_job_id:'22222222-2222-4222-8222-222222222222',template_id:'aliases',template_digest:'a'.repeat(64)};
function fixture(){
 const text='欧世豪向人民法院申请，金额10000元，2023年1月1日。\n电话13812345678，住址北京市东城区星河小区8号。';
 const files:PreparationFile[]=[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:createHash('sha256').update(text).digest('hex'),pages:[{page:1,text,structure:[{id:'a',kind:'paragraph',text:text.split('\n')[0]!},{id:'b',kind:'paragraph',text:text.split('\n')[1]!}]}]}];
 const plan:AgentMaterialPlan={entities:[{id:'p1',kind:'person',alias:'林远舟',variants:[{text:'欧世豪',targets:[]}]}],edits:[{target_id:'f1p1b2f1',source_text:'13812345678',occurrence:1,kind:'phone',keep_prefix:''},{target_id:'f1p1b2f1',source_text:'北京市东城区星河小区8号',occurrence:1,kind:'address',keep_prefix:'北京市东城区'}],documents:[{id:'d1',title:'申请书',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b2'}],duplicate_of:null}],unresolved:[]};
 return {files,plan};
}
test('compiles exact coordinates while preserving court, business values and administrative address boundary',()=>{
 const {files,plan}=fixture(),before=JSON.stringify(files),out=compileAgentMaterialPlan(plan,files,identity);
 expect(out.prepared.documents[0]!.text).toContain('林远舟向人民法院');
 expect(out.prepared.documents[0]!.text).toContain('10000元，2023年1月1日');
 expect(out.prepared.documents[0]!.text).toContain('138******78');
 expect(out.prepared.documents[0]!.text).toContain('北京市东城区******');
 expect(JSON.stringify(files)).toBe(before);
 expect(out.plan.edits.every(e=>files[0]!.pages[0]!.text.slice(e.start,e.end)===e.source_text)).toBe(true);
});
test('changing alias length remaps document boundaries without asking model for edited offsets',()=>{
 const {files,plan}=fixture();plan.documents=[{id:'d1',title:'申请书',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null},{id:'d2',title:'联系信息',ranges:[{first_block_id:'f1p1b2',last_block_id:'f1p1b2'}],duplicate_of:null}];
 plan.entities[0]!.alias='林远';
 const out=compileAgentMaterialPlan(plan,files,identity);
 expect(out.prepared.documents).toHaveLength(2);expect(out.plan.documents[0]!.segments[0]!.end).toBe(out.plan.documents[1]!.segments[0]!.start);
});
test('rejects overlapping identities, uncovered blocks and aliases colliding with original names',()=>{
 const {files,plan}=fixture();plan.entities.push({id:'p2',kind:'person',alias:'周行舟',variants:[{text:'世豪',targets:[]}]});
 expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();plan.entities.pop();
 plan.documents[0]!.ranges[0]!.last_block_id='f1p1b1';expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();
 plan.documents[0]!.ranges[0]!.last_block_id='f1p1b2';plan.entities[0]!.alias='欧世豪';expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();
});
test('unresolved privacy blocks publication; uncertain noise can remain without blocking',()=>{
 const {files,plan}=fixture();plan.unresolved=[{target_id:'f1p1b1f1',kind:'noise',blocking:false,reason:'无法确认，不删除'}];
 expect(()=>compileAgentMaterialPlan(plan,files,identity)).not.toThrow();plan.unresolved[0]!.blocking=true;expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();
});
test('zero occurrence applies the same confirmed edit to every literal occurrence in one field',()=>{
 const {files,plan}=fixture();const page=files[0]!.pages[0]!;
 (page.structure[1] as any).text+=' 再联系13812345678';page.text=page.structure.map((block:any)=>block.text).join('\n');
 plan.edits[0]!.occurrence=0;
 expect(compileAgentMaterialPlan(plan,files,identity).prepared.documents[0]!.text.match(/138\*+78/g)).toHaveLength(2);
 plan.edits[0]!.source_text='不存在的片段';expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();
});
test('identity and boundary uncertainty must identify real source fields instead of hiding an entire pack',()=>{
 const {files,plan}=fixture();
 for(const kind of ['identity','boundary'] as const){plan.unresolved=[{target_id:'all',kind,blocking:false,reason:'未逐项确认'}];expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();}
 plan.unresolved=[{target_id:'f1p1b1f1',kind:'identity',blocking:false,reason:'敏感名称已化名，未合并不确定身份'}];expect(()=>compileAgentMaterialPlan(plan,files,identity)).not.toThrow();
});
test('declared duplicate links are preserved without dropping source and unknown links fail',()=>{
 const {files,plan}=fixture();plan.documents=[{id:'d1',title:'材料一',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null},{id:'d2',title:'材料二',ranges:[{first_block_id:'f1p1b2',last_block_id:'f1p1b2'}],duplicate_of:'d1'}];
 const out=compileAgentMaterialPlan(plan,files,identity);expect(out.plan.documents[1]!.duplicate_of).toBe('d1');expect(out.prepared.documents).toHaveLength(2);
 plan.documents[1]!.duplicate_of='missing';expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();
});
test('structure blocks preserve table shape and merged cells',()=>{
 const {plan}=fixture();const structure:any[]=[{id:'table',kind:'table',rows:[{cells:[{text:'欧世豪',rowSpan:2},{text:'10000元'}]},{cells:[{text:'2023年1月1日'}]}]}];const text=structure[0].rows.map((r:any)=>r.cells.map((c:any)=>c.text).join('\t')).join('\n');
 const files:PreparationFile[]=[{file_id:'file',text_sha256:'hash',pages:[{page:1,text,structure}]}];plan.edits=[];plan.documents[0]!.ranges=[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}];
 const out=compileAgentMaterialPlan(plan,files,identity);expect((out.prepared.documents[0]!.document.pages[0]!.blocks[0] as any).rows[0].cells[0]).toEqual({text:'林远舟',rowSpan:2});expect(agentMaterialSource(files).source[0]!.pages[0]!.blocks[0]!.fields).toHaveLength(3);
});


test('compiler records confirmed scanner cleanup as exact edits without dropping business values or source blocks',()=>{
 const source=Array.from({length:3},(_,i)=>({page:i+1,structure:[{id:'a',kind:'paragraph' as const,text:'欧世豪支付8836元，日期2025-03-26。'},{id:'b',kind:'paragraph' as const,text:`8836\\_2025-03-26 15:27:5${i}`},{id:'c',kind:'paragraph' as const,text:String(i+1).padStart(3,'0')},{id:'d',kind:'paragraph' as const,text:'1'}]}));
 const files:PreparationFile[]=[{file_id:'file',text_sha256:'hash',pages:source.map(p=>({...p,text:p.structure.map(b=>b.text).join('\n')}))}];
 const plan:AgentMaterialPlan={entities:[{id:'person',kind:'person',alias:'林远舟',variants:[{text:'欧世豪',targets:[]}]}],edits:[],documents:[{id:'d1',title:'材料',duplicate_of:null,ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p3b4'}]}],unresolved:[]};
 const compiled=compileAgentMaterialPlan(plan,files,identity),text=compiled.prepared.documents[0]!.text;
 expect(text).not.toContain('15:27:');expect(text.match(/林远舟支付8836元，日期2025-03-26/g)).toHaveLength(3);
 expect(compiled.prepared.pages).toHaveLength(3);expect(compiled.plan.edits.some(e=>e.source_text.includes('15:27:'))).toBe(true);
});

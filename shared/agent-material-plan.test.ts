/** 验证Agent材料计划的主体映射、程序定位、分册覆盖和规则保真；仅使用合成材料。 */
import {test,expect} from 'bun:test';
import {ALIAS_REDACTION_PROMPT} from './redaction-templates';
import {agentMaterialSource,compileAgentMaterialPlan,type AgentMaterialPlan,type PreparationFile} from './agent-material-plan';
import {createHash} from 'node:crypto';

test('default Agent policy keeps business facts and natural aliases without an execution-file checklist',()=>{
 expect(ALIAS_REDACTION_PROMPT).toContain('日常的虚构名称');
 expect(ALIAS_REDACTION_PROMPT).toContain('法院、银行、邮政的名称保留');
 expect(ALIAS_REDACTION_PROMPT).not.toContain('人名使用人员甲');
 expect(ALIAS_REDACTION_PROMPT).toContain('组合文书');
 expect(ALIAS_REDACTION_PROMPT).toContain('不确定是否同一主体');
 expect(ALIAS_REDACTION_PROMPT).toContain('未安全处理的敏感片段或缺失正文');
 expect(ALIAS_REDACTION_PROMPT).not.toContain('婚姻状况遮盖');
 expect(ALIAS_REDACTION_PROMPT).not.toContain('subject-map.json');
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
test('rejects masking amount digits without their unit, including partial numeric edits',()=>{
 for(const source_text of ['10000','000']){
  const {files,plan}=fixture();plan.edits.push({target_id:'f1p1b1f1',source_text,occurrence:1,kind:'identifier',keep_prefix:''});
  let error:unknown;try{compileAgentMaterialPlan(plan,files,identity);}catch(cause){error=cause;}
  expect(error).toMatchObject({reason_code:'agent_business_value_edit'});
 }
 const {files,plan}=fixture();plan.edits.push({target_id:'f1p1b2f1',source_text:'13812345678',occurrence:1,kind:'identifier',keep_prefix:''});
 plan.edits.shift();expect(()=>compileAgentMaterialPlan(plan,files,identity)).not.toThrow();
});
test('post-Agent cleanup preserves mapped identifiers and compiles exact cleanup coordinates',()=>{
 const {files,plan}=fixture(),page=files[0]!.pages[0]!;
 page.structure.push({id:'code',kind:'paragraph',text:'12345678'},{id:'noise',kind:'paragraph',text:'[NO TEXT]\n221\n-22-\n4751 2025-04-25 15:24:08'});
 page.text=page.structure.map((block:any)=>block.text).join('\n');files[0]!.text_sha256=createHash('sha256').update(page.text).digest('hex');
 plan.edits.push({target_id:'f1p1b3f1',source_text:'12345678',occurrence:1,kind:'identifier',keep_prefix:''});plan.documents[0]!.ranges[0]!.last_block_id='f1p1b4';
 const out=compileAgentMaterialPlan(plan,files,identity),text=out.prepared.documents[0]!.text;
 expect(text).toContain('12****78');expect(text).toContain('10000元，2023年1月1日');expect(text).not.toMatch(/NO TEXT|15:24:08/);expect(text).toContain('221\n-22-');
 for(const edit of out.plan.edits)expect(page.text.slice(edit.start,edit.end)).toBe(edit.source_text);
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

// 合成回归：相邻单元格的业务编号和时间不能被拼成一个跨字段扫描水印。
test('scanner cleanup respects table fields while retaining independent values and full coverage',()=>{
 const structure:any[]=[{id:'table',kind:'table',rows:[{cells:[{text:'706'},{text:'2020.8.21 15:07'},{text:'4751_2025-04-25 15:24:08 [NO TEXT]'},{text:'10000元'}]}]}];
 const text=structure[0].rows[0].cells.map((c:any)=>c.text).join('\t');
 const files:PreparationFile[]=[{file_id:'file',text_sha256:'hash',pages:[{page:1,text,structure}]}];
 const plan:AgentMaterialPlan={entities:[],edits:[],documents:[{id:'doc',title:'材料',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]};
 const before=JSON.stringify(files),out=compileAgentMaterialPlan(plan,files,identity);
 const table=out.prepared.pages[0]!.structure[0] as any;
 expect(table.rows[0].cells.map((c:any)=>c.text)).toEqual(['706','2020.8.21 15:07',' ','10000元']);
 expect(out.plan.edits.every(e=>!e.source_text.includes('\t'))).toBe(true);
 expect(out.prepared.documents[0]!.text).toBe('706\t2020.8.21 15:07\t \t10000元');
 expect(JSON.stringify(files)).toBe(before);
});

test('compiled redaction rejects unmasked party names, identity numbers and labeled phone numbers',()=>{
 const text='原告：张三，身份证号：500100199001012345，联系电话：13812345678。';
 const files:PreparationFile[]=[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:createHash('sha256').update(text).digest('hex'),pages:[{page:1,text,structure:[{id:'a',kind:'paragraph',text}]}]}];
 const plan:AgentMaterialPlan={entities:[],edits:[],documents:[{id:'d',title:'委托材料',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]};
 let error:any;try{compileAgentMaterialPlan(plan,files,identity);}catch(cause){error=cause;}
 expect(error).toMatchObject({reason_code:'agent_sensitive_value_remaining'});
 expect(error.validation_details.findings.map((item:any)=>item.kind)).toEqual(expect.arrayContaining(['party_name','identifier','phone']));
 expect(JSON.stringify(error.validation_details)).not.toContain('张三');
 expect(JSON.stringify(error.validation_details)).not.toContain('500100199001012345');
 expect(JSON.stringify(error.validation_details)).not.toContain('13812345678');
});

test('compiled redaction rejects a planned identity left outside scoped target fields',()=>{
 const first='原告：欧世豪，';const second='联系人：欧世豪，电话13812345678。';const text=`${first}\n${second}`;
 const files:PreparationFile[]=[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:createHash('sha256').update(text).digest('hex'),pages:[{page:1,text,structure:[{id:'a',kind:'paragraph',text:first},{id:'b',kind:'paragraph',text:second}]}]}];
 const plan:AgentMaterialPlan={entities:[{id:'p',kind:'person',alias:'林远舟',variants:[{text:'欧世豪',targets:['f1p1b1f1']}]}],edits:[],documents:[{id:'d',title:'委托材料',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b2'}],duplicate_of:null}],unresolved:[]};
 let error:any;try{compileAgentMaterialPlan(plan,files,identity);}catch(cause){error=cause;}
 expect(error).toMatchObject({reason_code:'agent_sensitive_value_remaining'});
 expect(error.validation_details.findings).toContainEqual(expect.objectContaining({kind:'planned_entity',target_id:'f1p1b2f1'}));
});

test('hearing replies and generic postal routing remain intact while real identities and addresses stay blocked',()=>{
 const compile=(text:string)=>{
  const files:PreparationFile[]=[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:createHash('sha256').update(text).digest('hex'),pages:[{page:1,text,structure:[{id:'a',kind:'paragraph',text}]}]}];
  const plan:AgentMaterialPlan={entities:[],edits:[],documents:[{id:'d',title:'笔录',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]};
  return compileAgentMaterialPlan(plan,files,identity);
 };
 for(const text of ['审：听清楚否？是否上诉？\n原告：清楚，上诉以书面意见为准。','原告是否清楚诉讼权利？是否申请回避？\n原告：清楚，不申请。','回执反馈地址:邮政局速递局法院专递业务档案室收']){
  expect(compile(text).prepared.documents[0]!.text).toBe(text);
 }
 for(const text of ['原告：清楚，男，汉族。','审：是否申请回避？\n原告：清楚，男，汉族。','原告：张三，男，汉族。','回执反馈地址:邮政局速递局东街10号档案室']){
  let error:any;try{compile(text);}catch(cause){error=cause;}
  expect(error).toMatchObject({reason_code:'agent_sensitive_value_remaining'});
 }
});

test('a postal timestamp following a masked phone is preserved and does not become another phone finding',()=>{
 const text='投递轨迹：联系电话:13812345678)2023-08-09 15:31:59未妥投。';
 const files:PreparationFile[]=[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:createHash('sha256').update(text).digest('hex'),pages:[{page:1,text,structure:[{id:'a',kind:'paragraph',text}]}]}];
 const plan:AgentMaterialPlan={entities:[],edits:[{target_id:'f1p1b1f1',source_text:'13812345678',occurrence:0,kind:'phone',keep_prefix:''}],documents:[{id:'d',title:'投递记录',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]};
 const out=compileAgentMaterialPlan(plan,files,identity);
 expect(out.prepared.documents[0]!.text).toContain('138******78)2023-08-09 15:31:59');
 plan.edits=[];
 let error:any;try{compileAgentMaterialPlan(plan,files,identity);}catch(cause){error=cause;}
 expect(error).toMatchObject({reason_code:'agent_sensitive_value_remaining'});
 expect(error.validation_details.findings).toContainEqual({kind:'phone',target_id:'f1p1b1f1',page:1});
});

test('publication blocks intact labeled access codes, organization identifiers and parenthetical contact phones',()=>{
 const text='查询密码:123456。统一社会信用代码:91500107512345678Q。受试人：张三（13812345678）。款项123456元。';
 const files:PreparationFile[]=[{file_id:'33333333-3333-4333-8333-333333333333',text_sha256:createHash('sha256').update(text).digest('hex'),pages:[{page:1,text,structure:[{id:'a',kind:'paragraph',text}]}]}];
 const plan:AgentMaterialPlan={entities:[],edits:[],documents:[{id:'d',title:'材料',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]};
 let error:any;try{compileAgentMaterialPlan(plan,files,identity);}catch(cause){error=cause;}
 expect(error).toMatchObject({reason_code:'agent_sensitive_value_remaining'});
 expect(error.validation_details.findings.map((x:any)=>x.kind)).toEqual(expect.arrayContaining(['identifier','phone']));
 plan.edits=[{target_id:'f1p1b1f1',source_text:'123456',occurrence:1,kind:'credential',keep_prefix:''},{target_id:'f1p1b1f1',source_text:'91500107512345678Q',occurrence:1,kind:'identifier',keep_prefix:''},{target_id:'f1p1b1f1',source_text:'13812345678',occurrence:1,kind:'phone',keep_prefix:''}];
 // 与密码恰好相同的业务金额不应被残留检查误判为未脱敏密码。
 expect(()=>compileAgentMaterialPlan(plan,files,identity)).not.toThrow();
});

test('credentials are fully hidden while bank accounts use partial masking and business facts stay intact',()=>{
 const text='法院：北京市东城区人民法院；银行：中国建设银行；邮政：中国邮政。账号123456789012；查询密码AB123456；出生1990年1月1日，结婚登记2020年2月2日，已婚。金额10000元，期限12个月，利率5%。';
 const files:PreparationFile[]=[{file_id:'file',text_sha256:'h',pages:[{page:1,text,structure:[{id:'b',kind:'paragraph',text}]}]}];
 const plan:AgentMaterialPlan={entities:[],edits:[{target_id:'f1p1b1f1',source_text:'123456789012',kind:'identifier',occurrence:0,keep_prefix:''},{target_id:'f1p1b1f1',source_text:'AB123456',kind:'credential',occurrence:0,keep_prefix:''}],documents:[{id:'d',title:'业务记录',duplicate_of:null,ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}]}],unresolved:[]};
 expect(compileAgentMaterialPlan(plan,files,identity).prepared.documents[0]!.text).toBe(text.replace('123456789012','12********12').replace('AB123456','**'));
 plan.edits=[{target_id:'f1p1b1f1',source_text:'10000',kind:'credential',occurrence:0,keep_prefix:''}];
 expect(()=>compileAgentMaterialPlan(plan,files,identity)).toThrow();
});

test('an address without a confirmed administrative prefix can be fully masked without deleting neighboring words',()=>{
 const text='备注地址：星河小区8栋。';
 const files:PreparationFile[]=[{file_id:'file',text_sha256:'h',pages:[{page:1,text,structure:[{id:'b',kind:'paragraph',text}]}]}];
 const plan:AgentMaterialPlan={entities:[],edits:[{target_id:'f1p1b1f1',source_text:'星河小区8栋',kind:'address',occurrence:0,keep_prefix:''}],documents:[{id:'d',title:'联系记录',duplicate_of:null,ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}]}],unresolved:[]};
 expect(compileAgentMaterialPlan(plan,files,identity).prepared.documents[0]!.text).toBe('备注地址：******。');
});

test('a complete cross-page contract and another same-page document preserve tables and shared identities',()=>{
 const pages:any[]=[{page:1,structure:[{id:'h',kind:'heading',text:'合同'},{id:'p',kind:'paragraph',text:'赵安与青杉科技有限公司（简称青杉公司）签订合同。'}]},{page:2,structure:[{id:'t',kind:'table',rows:[{cells:[{text:'赵安',rowSpan:2},{text:'10000元'}]},{cells:[{text:'青杉公司'}]}]},{id:'r',kind:'paragraph',text:'另附收据：赵安收款10000元。'}]}];
 for(const page of pages)page.text=page.structure.map((b:any)=>b.kind==='table'?b.rows.map((r:any)=>r.cells.map((c:any)=>c.text).join('\t')).join('\n'):b.text).join('\n');
 const files:PreparationFile[]=[{file_id:'file',text_sha256:'h',pages}];
 const plan:AgentMaterialPlan={entities:[{id:'p',kind:'person',alias:'周文远',variants:[{text:'赵安',targets:[]}]},{id:'c',kind:'organization',alias:'青禾科技有限公司',variants:[{text:'青杉科技有限公司',targets:[]},{text:'青杉公司',targets:[]}]}],edits:[],documents:[{id:'contract',title:'合同',duplicate_of:null,ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p2b1'}]},{id:'receipt',title:'收据',duplicate_of:null,ranges:[{first_block_id:'f1p2b2',last_block_id:'f1p2b2'}]}],unresolved:[]};
 const out=compileAgentMaterialPlan(plan,files,identity);
 expect(out.prepared.documents).toHaveLength(2);expect(out.prepared.documents[0]!.document.pages).toHaveLength(2);
 expect(out.prepared.documents[0]!.text).not.toContain('青杉');expect(out.prepared.documents[1]!.text).toBe('另附收据：周文远收款10000元。');
 expect((out.prepared.documents[0]!.document.pages[1]!.blocks[0] as any).rows[0].cells[0]).toEqual({text:'周文远',rowSpan:2});
});

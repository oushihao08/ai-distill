/** 验证五件套投影、冻结检索表述与ZIP中文路径编码；不调用模型或数据库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as generator from './generate-five-piece';
import {renderWorkInstruction} from '../../../../server/authoring/work-contract';
// 最小图像PDF，无文字层；验证真实Poppler与导出路径，不依赖用户案件文件。
function imagePdfFixture(){
 const contents='q 200 0 0 200 0 0 cm /Im0 Do Q';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,'<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream'];
 let text='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(text.length);text+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const xref=text.length;text+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(text);
}

test('旧题基准日兼容真实反馈措辞，约束支持标题和编号，不从开庭日期推测',()=>{
 for(const text of ['准备基准日为2021年3月16日，拟于2021年3月17日开庭','以2021年3月16日为本次判断基准日','在2021年3月16日这一业务基准日','基准日期：2021-03-16'])expect(generator.legacyInstruction(text).baselineDate).toBe('2021-03-16');
 expect(generator.legacyInstruction('拟于2021年3月17日开庭').baselineDate).toBe('');
 expect(generator.legacyInstruction('基准日2021年2月29日').baselineDate).toBe('');
 expect(generator.legacyInstruction('基准日2021年3月16日，基准日2021年3月17日').baselineDate).toBe('');
 expect(generator.legacyInstruction('## 硬性约束\n1. 仅使用已形成材料\n2. 不补造事实\n\n## 成果要求\n提交正文').hardConstraints).toEqual(['仅使用已形成材料','不补造事实']);
});

test('Work新结构从公开题面到五件套分字段同源，原始Rubric与历史目录保留',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-structured-'));
 try{
  const instruction={background:'甲委托律师核对附件材料。',requests:['给出本案证据审查意见'],baseline_date:'2021-03-16',hard_constraints:['不将未来材料作为当时已知事实']};
  const deliverables=[{id:'D1',path:'意见.docx',format:'docx',description:'律师证据审查意见',required:true}];
  const input:any={title:'合成证据审查',workflow_id:'fixture',source_digest:'a'.repeat(64),delivery_digest:'b'.repeat(64),question_version:'q1',rubric_version:'r1',question:{content_contract:'work_legal_v1',task_name:'证据审查',task_type:'F2 审查审核',question:renderWorkInstruction(instruction,deliverables),task_metadata:{instruction,scenario:'LS02 证据审查',target_level:'L2',capabilities:['证据评估'],professional_knowledge:['证据规则'],vl_dependency:false,source_note:'合成来源',generation_note:'内部生成记录',tools:[],level_basis:{documents:[{id:'d1',attachment_id:'a',locator:'第1页',description:'证据'}],necessary_steps:['审查证据'],estimated_hours:1,explanation:'合成工作量，仅测试投影'}},content_status:{status:'complete',issues:[]},deliverables,reference_outputs:[{deliverable_id:'D1',content:'证据审查意见\n\n经核对，当前材料存在需核验的证明范围。',sheets:[]}],input_files:[{attachment_id:'a',name:'附件1',description:'材料'}],research_records:[{id:'s1',query:'证据规则',source_url:null,source_title:'未取得',version:'待核',findings:'未采用',verification_status:'unverified',supports:[]}],rubric:Array.from({length:30},(_,i)=>({id:`R2-P${i+1}`,metadata:{statement:'合成独立条件',score:3,dimension:'2-交付物内容质量/Q1事实与证据梳理准确性',evaluated_files:['意见.docx'],trigger_count:null}}))},attachments:[{name:'附件1',text:'合成证据正文',material_mode:'redacted'}]};
  const original=JSON.stringify(input),result=await generator.generateSiriserConfirmation(root,input,{expertName:'测试',date:'20261025'});
  const projected=JSON.parse(await readFile(join(result.directory,'instruction.json'),'utf8'));
  expect(projected.background).toBe(instruction.background);expect(projected.requests).toEqual(instruction.requests);expect(projected.baselineDate).toBe(instruction.baseline_date);expect(projected.hardConstraints).toEqual(instruction.hard_constraints);
  expect(projected.deliverableReqs).toContain('意见.docx');expect(projected.background).not.toContain('合成独立条件');
  expect(JSON.parse(await readFile(join(result.directory,'rubric.json'),'utf8')).items).toEqual(input.question.rubric.map((r:any)=>({id:r.id,...r.metadata})));
  const metadata=JSON.parse(await readFile(join(result.directory,'metadata.json'),'utf8'));expect(metadata.hasScan).toBe(false);expect(metadata.scanFiles).toEqual([]);expect(metadata.taskDesc).not.toContain('内部生成记录');expect(metadata.dataSource).toContain('内部生成记录');
  const state=JSON.parse(await readFile(join(root,'Siriser五件套.json'),'utf8'));expect(state.quality_warnings.length).toBeGreaterThan(0);expect(state.confirmation_renderer).toBe('siriser-confirmation-office-v9');expect(JSON.stringify(input)).toBe(original);
  const reused=await generator.generateSiriserConfirmation(root,input,{expertName:'测试',date:'20261025'});expect(reused.reused).toBe(true);expect(reused.sha256).toBe(result.sha256);
  // 选用原文仍生成所选分册DOCX；不要求也不使用可能包含隐藏文书的整包原件。
  const selected=structuredClone(input);selected.source_digest='e'.repeat(64);
  selected.attachments=[{name:'附件1',text:'# 合同:../\n\n合成证据正文',material_mode:'original',selected_materials:true,prepared_documents:[{id:'doc',title:'合同:../',text:'合成证据正文',document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'p',kind:'paragraph',text:'合成证据正文'}]}]}}],original_files:[{name:'HIDDEN_完整卷宗.pdf',sha256:'unused',content_base64:'invalid-and-must-not-be-used'}]}];
  const selectedResult=await generator.generateSiriserConfirmation(root,selected,{expertName:'测试',date:'20261025'});
  const physical=await readdir(join(selectedResult.directory,'input_files'));expect(physical.length).toBe(1);expect(physical[0]).toEndWith('.docx');expect(physical.join()).not.toContain('HIDDEN');
  const xml=Bun.spawn(['unzip','-p',join(selectedResult.directory,'input_files',physical[0]!), 'word/document.xml'],{stdout:'pipe',stderr:'pipe'});
  const content=await new Response(xml.stdout).text();expect(await xml.exited).toBe(0);expect(content).toContain('合成证据正文');expect(content).not.toContain('HIDDEN');

 }finally{await rm(root,{recursive:true,force:true});}
});

test('新旧Work交付均在写目录前拒绝不足30项，不能复用旧缓存绕过',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-admission-'));
 try{
  const input:any={question:{content_contract:'work_legal_v1',content_status:{status:'complete',issues:[]},question:'提交意见.docx',rubric:[{id:'R1',criterion:'判据',metadata:{evaluated_files:['意见.docx']}}],deliverables:[{id:'D1',path:'意见.docx',format:'docx',description:'意见',required:true}],reference_outputs:[{deliverable_id:'D1',content:'正文',sheets:[]}]},attachments:[{name:'附件',text:'材料'}],simulation:{deliverable_markdown:'业务正文',harbor_files:[{path:'意见.docx',markdown:'正文',sheets:[]}],research_entries:[{}]},source_digest:'a'.repeat(64),delivery_digest:'b'.repeat(64)};
  for(const generate of [generator.generateSiriserConfirmation,generator.generateSiriserFivePiece])await expect(generate(root,input)).rejects.toThrow('至少30项');
  expect(await import('node:fs/promises').then(fs=>fs.readdir(root))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('TSV成果保留作者冻结的制表符和正文，不转换为Markdown表格',async()=>{
 const markdown='案件\t金额\n甲案\t100\n';
 const bytes=await generator.deliverableBytes({path:'核对表.tsv',markdown,sheets:[]});
 expect(bytes.toString('utf8')).toBe(markdown);
});

test('业务成果生成真实Office包，保留正文、表头和单元格',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-office-'));
 try{
  const cases=[
   {path:'意见.docx',markdown:'审查意见\n\n已经核对。\n申请执行人甲\n被执行人乙\n\n|项目|金额|\n|---|---|\n|本金|100|',sheets:[],member:'word/document.xml',expected:['审查意见','已经核对','本金','100','<w:tbl','w:pStyle w:val="Title"']},
   {path:'核算.xlsx',markdown:'逐笔核算\n来源：https://example.test/law',sheets:[{name:'核算',columns:['项目','金额'],rows:[['本金',100]]}],member:'xl/worksheets/sheet1.xml',expected:['项目','金额','本金','100']},
  ];
  for(const c of cases){
   const file=join(root,c.path);await writeFile(file,await generator.deliverableBytes(c));
   const child=Bun.spawn(['unzip','-p',file,c.member],{stdout:'pipe',stderr:'pipe'});
   const [xml,exit]=await Promise.all([new Response(child.stdout).text(),child.exited]);expect(exit).toBe(0);
   for(const word of c.expected)expect(xml).toContain(word);
   if(c.path.endsWith('.docx')){
    expect(xml).toMatch(/申请执行人甲[\s\S]*<\/w:p>[\s\S]*<w:p[\s\S]*被执行人乙/);
    const styles=Bun.spawn(['unzip','-p',file,'word/styles.xml'],{stdout:'pipe',stderr:'pipe'});
    const styleXml=await new Response(styles.stdout).text();expect(await styles.exited).toBe(0);
    expect(styleXml).toContain('宋体');expect(styleXml).toContain('黑体');
    expect(styleXml).toContain('w:color w:val="000000"');
   }else{
    const notes=Bun.spawn(['unzip','-p',file,'xl/worksheets/sheet2.xml'],{stdout:'pipe',stderr:'pipe'});
    const body=await new Response(notes.stdout).text();expect(await notes.exited).toBe(0);
    expect(body).toContain('逐笔核算');expect(body).toContain('https://example.test/law');
   }
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('旧Work复制成果时拒绝伪装成DOCX的文本，不更新当前状态',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-fake-office-'));
 try{
  const golden=join(root,'source');await mkdir(golden);await writeFile(join(golden,'意见.docx'),'只是改名的文本');
  const input:any={title:'合成校验',workflow_id:'fixture',source_digest:'a'.repeat(64),delivery_digest:'b'.repeat(64),question:{rubric:Array.from({length:30},(_,i)=>({id:`R${i}`,criterion:'测试判据',metadata:{evaluated_files:['意见.docx']}}))},attachments:[{name:'卷宗',text:'本次材料'}],simulation:{generated_at:'2026-10-21',deliverable_markdown:'已经完成核对',harbor_files:[{path:'意见.docx',markdown:'已经完成核对',sheets:[]}],research_entries:[{id:'S1',query:'规则',title:'规则',url:'',finding:'未取得',version_or_date:'未核验',used_in:'意见'}],unresolved:[]}};
  await expect(generator.generateSiriserFivePiece(root,input,golden)).rejects.toThrow('有效Office成果');
  expect(await import('node:fs/promises').then(fs=>fs.readdir(join(root,'Siriser五件套')))).toEqual([]);
  expect(await import('node:fs/promises').then(fs=>fs.readdir(join(root,'交付状态')))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('题目信息包含专业元数据及等级依据',()=>{
 const input:any={title:'测试题',workflow_id:'fixture',question_version:'q',rubric_version:'r',question:{task_name:'证据审查',task_type:'F2',header:{},task_metadata:{scenario:'LS02',role_perspective:'原告律师',domain_l2:null,capabilities:['证据评估'],professional_knowledge:['书证证明力'],level_basis:{estimated_hours:1.5,explanation:'逐份核验',documents:[]},target_level:'L2',source_note:'本次卷宗',tools:['文档编辑'],vl_dependency:false,generation_note:'AI模拟'}},simulation:{deliverable_type:'F2',deliverable_title:'意见'}};
 expect((generator as any).taskInfoMarkdown).toBeFunction();const text=(generator as any).taskInfoMarkdown(input);expect(text).toContain('书证证明力');expect(text).toContain('1.5');expect(text).toContain('LS02');expect(text).toContain('未提供正式二级标签');
});

test('作者冻结记录明确不等于归档实际联网事件',()=>{
 expect((generator as any).traceMarkdown).toBeFunction();const text=(generator as any).traceMarkdown({model:'author_snapshot',research_entries:[{id:'S1',query:'证据规则',title:'正文',url:'https://example.test/law',finding:'规则',version_or_date:'2020',used_in:'D1'}],actual_search_queries:[],actually_opened_urls:[]} as any);
 expect(text).toContain('作者冻结');expect(text).not.toContain('仅列与实际 Codex 网页搜索／打开事件匹配');
});

test('未采用检索保留失败原因，不生成空正文链接',()=>{
 const text=generator.traceMarkdown({model:'author_snapshot',research_entries:[{id:'S2',query:'可比案例',title:'未取得可采用正文',url:'',finding:'未核验：未采用',version_or_date:'本次基准日',used_in:'未采用'}],actual_search_queries:[],actually_opened_urls:[]} as any);
 expect(text).toContain('未取得正文URL');expect(text).toContain('未核验');expect(text).not.toContain(']()');
});

test('原文模式将输入 PDF 原字节写入 input_files，并校验摘要',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-original-input-'));
 try{
  const bytes=Buffer.from('%PDF-1.7\nsource bytes\n%%EOF\n'),sha256=createHash('sha256').update(bytes).digest('hex');
  const files=[{name:'卷宗.pdf',sha256,content_base64:bytes.toString('base64')}];
  await mkdir(join(root,'input_files'));
  expect((generator as any).writeOriginalInputFiles).toBeFunction();
  const result=await (generator as any).writeOriginalInputFiles(join(root,'input_files'),files);
  expect(result).toEqual([{name:'卷宗.pdf',sha256,bytes:bytes.length}]);
  expect(await readFile(join(root,'input_files','卷宗.pdf'))).toEqual(bytes);
  await expect((generator as any).writeOriginalInputFiles(join(root,'bad'),[{...files[0],sha256:'0'.repeat(64)}])).rejects.toThrow('摘要校验失败');
 }finally{await rm(root,{recursive:true,force:true});}
});

test.each([true,false])('Work原文确认稿保留原字节与扫描检测（可读扫描PDF=%s）',async readable=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-original-zip-'));
 try{
  const bytes=readable?imagePdfFixture():Buffer.from('%PDF-1.7\noriginal fixture\n%%EOF\n'),sha256=createHash('sha256').update(bytes).digest('hex');
  const digest='a'.repeat(64),item={id:'R1-P01',criterion:'事实核对',rule:'逐项核验来源',metadata:{statement:'核验材料事实',score:3,type:'binary',evaluated_files:['意见.docx']}};
  const input:any={title:'原文输入测试',workflow_id:'22222222-2222-4222-8222-222222222222',source_digest:digest,delivery_digest:'b'.repeat(64),question_version:'q1',rubric_version:'r1',question:{content_contract:'work_legal_v1',task_name:'事实核对',task_type:'F1 法律意见',question:'请核验卷宗中的事实并提出意见.docx。',content_status:{status:'complete',issues:[]},rubric:Array.from({length:30},(_,i)=>({...item,id:`R2-P${i+1}`})),task_metadata:{scenario:'LS02 证据审查',domain_l2:'诉讼证据',capabilities:['事实核验'],vl_dependency:true,professional_knowledge:['证据规则'],tools:['文书编辑'],target_level:'L2',source_note:'冻结材料',generation_note:'本地合成测试',level_basis:{estimated_hours:1,explanation:'核对两份材料',documents:[{id:'D1',attachment_id:'attachment',locator:'首页',description:'原始文书'}]}},input_files:[{attachment_id:'attachment',name:'卷宗',description:'原始卷宗'}],deliverables:[{id:'opinion',path:'意见.docx',format:'docx',description:'法律意见',required:true}],reference_outputs:[{deliverable_id:'opinion',content:'# 法律意见\n\n核对完成。',sheets:[]}],research_records:[{id:'S1',query:'证据规则',source_url:'https://example.test/rule',source_title:'规则正文',version:'测试版本',findings:'测试检索记录',verification_status:'verified',supports:['opinion']} ]},attachments:[{name:'材料-001.md',text:'冻结提取正文',material_mode:'original',original_files:[{name:'原卷.pdf',sha256,content_base64:bytes.toString('base64')}]}]};
  const result=await generator.generateSiriserConfirmation(root,input,{expertName:'测试',date:'20261021'});
  const packageName=result.filename.replace(/\.zip$/,'');
  const child=Bun.spawn(['unzip','-p',result.zip_path,`${packageName}/input_files/原卷.pdf`],{stdout:'pipe',stderr:'pipe'});
  const [output,exit]=await Promise.all([new Response(child.stdout).arrayBuffer(),child.exited]);
  expect(exit).toBe(0);expect(Buffer.from(output)).toEqual(bytes);
  const state=JSON.parse(await readFile(join(result.directory,'..','法律-LS02-20261021-测试.state.json'),'utf8'));
  expect(state.input_format).toBe('pdf');expect(state.physical_input_files).toBe(1);
  const metadata=JSON.parse(await readFile(join(result.directory,'metadata.json'),'utf8'));
  if(readable){expect(metadata.hasScan).toBe(true);expect(metadata.scanFiles).toEqual(['原卷.pdf']);expect(state.scan_checks[0].status).toBe('scanned');}
  else{expect(metadata).not.toHaveProperty('hasScan');expect(state.scan_checks[0].status).toBe('unknown');expect(state.quality_warnings.some((v:string)=>v.includes('扫描属性未知'))).toBe(true);}
  const currentState=await readFile(join(root,'Siriser五件套.json'),'utf8'),zipBefore=await readFile(result.zip_path);
  input.question.rubric.pop();
  await expect(generator.generateSiriserConfirmation(root,input,{expertName:'测试',date:'20261021'})).rejects.toThrow('至少30项');
  expect(await readFile(join(root,'Siriser五件套.json'),'utf8')).toBe(currentState);
  expect(await readFile(result.zip_path)).toEqual(zipBefore);
  input.question.rubric.push({...item,id:'R2-P30'});
  const reused=await generator.generateSiriserConfirmation(root,input,{expertName:'测试',date:'20261021'});expect(reused.reused).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('结构化正文内的附件及页码文字不被误当作外层定位标记',()=>{
 const docs:any=[{format:'redacted-structure-v1',pages:[{page:1,blocks:[{kind:'paragraph',text:'卷内引用【附件 4】与【原附件第 999 页】，均为正文。'}]},{page:2,blocks:[{kind:'paragraph',text:'第二页有效正文。'}]}]}];
 const text='【附件 1】\n\n【原附件第 1 页】\n卷内引用【附件 4】与【原附件第 999 页】，均为正文。\n\n【原附件第 2 页】\n第二页有效正文。\n\n【附件 1 结束】';
 const full:any=generator.confirmationDocument(text,[{start:0,end:text.length}],docs);
 expect(full.pages.map((p:any)=>p.page)).toEqual([1,2]);
 expect(full.pages[0].blocks).toHaveLength(1);
 expect(full.pages[0].blocks[0].text).toContain('999');
 const start=text.indexOf('【原附件第 2 页】');
 const second:any=generator.confirmationDocument(text,[{start,end:text.length}],docs);
 expect(second.pages.map((p:any)=>p.page)).toEqual([2]);
 expect(()=>generator.confirmationDocument(text+'篡改',[{start:0,end:text.length}],docs)).toThrow('冻结正文不一致');
});

test('Siriser确认包ZIP显式标记UTF-8中文路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-utf8-'));
 try{
  const packageName='法律-LS02-测试',relativeName=`${packageName}/input_files/材料.docx`,zipPath=join(root,'package.zip');
  await mkdir(join(root,packageName,'input_files'),{recursive:true});
  await writeFile(join(root,relativeName),'fixture');
  const child=Bun.spawn(['zip','-qr',zipPath,packageName],{cwd:root,stdout:'ignore',stderr:'pipe'});
  const [,exit]=await Promise.all([new Response(child.stderr).text(),child.exited]);
  expect(exit).toBe(0);
  const bytes=await readFile(zipPath),normalized=(generator as any).markZipFilenamesUtf8(bytes) as Buffer;
  let end=-1;
  for(let offset=normalized.length-22;offset>=Math.max(0,normalized.length-65557);offset--)if(normalized.readUInt32LE(offset)===0x06054b50&&offset+22+normalized.readUInt16LE(offset+20)===normalized.length){end=offset;break;}
  expect(end).toBeGreaterThanOrEqual(0);
  const count=normalized.readUInt16LE(end+10);let offset=normalized.readUInt32LE(end+16);const names:string[]=[];
  for(let index=0;index<count;index++){
   expect(normalized.readUInt32LE(offset)).toBe(0x02014b50);
   expect(normalized.readUInt16LE(offset+8)&0x0800).toBe(0x0800);
   const nameLength=normalized.readUInt16LE(offset+28),extraLength=normalized.readUInt16LE(offset+30),commentLength=normalized.readUInt16LE(offset+32);
   names.push(new TextDecoder('utf-8',{fatal:true}).decode(normalized.subarray(offset+46,offset+46+nameLength)));
   offset+=46+nameLength+extraLength+commentLength;
  }
  expect(names).toContain(relativeName);
 }finally{await rm(root,{recursive:true,force:true});}
});

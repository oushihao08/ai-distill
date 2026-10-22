/** 验证五件套投影、冻结检索表述与ZIP中文路径编码；不调用模型或数据库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as generator from './generate-five-piece';

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

test('Work原文确认稿ZIP实际包含未改写PDF，状态记录来源格式为PDF',async()=>{
 const root=await mkdtemp(join(tmpdir(),'siriser-original-zip-'));
 try{
  const bytes=Buffer.from('%PDF-1.7\noriginal fixture\n%%EOF\n'),sha256=createHash('sha256').update(bytes).digest('hex');
  const digest='a'.repeat(64),item={id:'R1-P01',criterion:'事实核对',rule:'逐项核验来源',metadata:{statement:'核验材料事实',score:3,type:'binary',evaluated_files:['意见.docx']}};
  const input:any={title:'原文输入测试',workflow_id:'22222222-2222-4222-8222-222222222222',source_digest:digest,delivery_digest:'b'.repeat(64),question_version:'q1',rubric_version:'r1',question:{content_contract:'work_legal_v1',task_name:'事实核对',task_type:'F1 法律意见',question:'请核验卷宗中的事实并提出意见.docx。',content_status:{status:'complete',issues:[]},rubric:Array.from({length:30},(_,i)=>({...item,id:`R2-P${i+1}`})),task_metadata:{scenario:'LS02 证据审查',domain_l2:'诉讼证据',capabilities:['事实核验'],vl_dependency:true,professional_knowledge:['证据规则'],tools:['文书编辑'],target_level:'L2',source_note:'冻结材料',generation_note:'本地合成测试',level_basis:{estimated_hours:1,explanation:'核对两份材料',documents:[{id:'D1',attachment_id:'attachment',locator:'首页',description:'原始文书'}]}},input_files:[{attachment_id:'attachment',name:'卷宗',description:'原始卷宗'}],deliverables:[{id:'opinion',path:'意见.docx',format:'docx',description:'法律意见',required:true}],reference_outputs:[{deliverable_id:'opinion',content:'# 法律意见\n\n核对完成。',sheets:[]}],research_records:[{id:'S1',query:'证据规则',source_url:'https://example.test/rule',source_title:'规则正文',version:'测试版本',findings:'测试检索记录',verification_status:'verified',supports:['opinion']} ]},attachments:[{name:'材料-001.md',text:'冻结提取正文',material_mode:'original',original_files:[{name:'原卷.pdf',sha256,content_base64:bytes.toString('base64')}]}]};
  const result=await generator.generateSiriserConfirmation(root,input,{expertName:'测试',date:'20261021'});
  const packageName=result.filename.replace(/\.zip$/,'');
  const child=Bun.spawn(['unzip','-p',result.zip_path,`${packageName}/input_files/原卷.pdf`],{stdout:'pipe',stderr:'pipe'});
  const [output,exit]=await Promise.all([new Response(child.stdout).arrayBuffer(),child.exited]);
  expect(exit).toBe(0);expect(Buffer.from(output)).toEqual(bytes);
  const state=JSON.parse(await readFile(join(result.directory,'..','法律-LS02-20261021-测试.state.json'),'utf8'));
  expect(state.input_format).toBe('pdf');expect(state.physical_input_files).toBe(1);
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

/**
 * 职责：验证脱敏 Markdown 到 DOCX 的转换边界与附件页码呈现。
 * 主要验证：OOXML ZIP 可解析，系统标记被隐藏，正文转义、按需源页分页与默认连续排版及常见 Markdown 表格均保留。
 * 验证边界：直接检查生成的 OOXML ZIP 字节，不启动 Word/Office；修改 `redacted-docx.ts` 时可定向回归。
 */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inflateRawSync} from 'node:zlib';
import {buildRedactedDocx} from './redacted-docx';
import {buildCurrentMaterialImageDocx} from './redacted-docx-export';
import {canonicalJson} from '../../shared/workflow-config';
import type {DocumentBlock} from './pdf';

function docxParts(bytes:Uint8Array){
 const buffer=Buffer.from(bytes),parts=new Map<string,string>();let offset=0;
 while(offset+30<buffer.length&&buffer.readUInt32LE(offset)===0x04034b50){
  const method=buffer.readUInt16LE(offset+8),compressedSize=buffer.readUInt32LE(offset+18),nameSize=buffer.readUInt16LE(offset+26),extraSize=buffer.readUInt16LE(offset+28),name=buffer.toString('utf8',offset+30,offset+30+nameSize),start=offset+30+nameSize+extraSize,compressed=buffer.subarray(start,start+compressedSize);
  parts.set(name,(method===8?inflateRawSync(compressed):compressed).toString('utf8'));offset=start+compressedSize;
 }
 return parts;
}

test('DOCX uses only supplied redacted text and preserves attachment/page structure and tables',async()=>{
 const source='【附件 1】\n\n【原附件第 1 页】\n# 执行申请\n\n申请人支付 43****33 元 & <已脱敏>，需 **重点核对**。\n\n| 项目 | 金额 |\n| --- | --- |\n| 本金 | 100 元 |\n\n【原附件第 3 页】\n第二页后内容\n\n【附件 1 结束】';
 const parts=docxParts(await buildRedactedDocx(source));
 const xml=parts.get('word/document.xml');
 expect(parts.has('[Content_Types].xml')).toBe(true);
 expect(parts.has('_rels/.rels')).toBe(true);expect(parts.has('word/styles.xml')).toBe(true);
 expect(xml).not.toContain('【附件 1】');expect(xml).not.toContain('【原附件第 1 页】');expect(xml).not.toContain('【原附件第 3 页】');expect(xml).not.toContain('【附件 1 结束】');
 expect(xml).toContain('43****33 元 &amp; &lt;已脱敏&gt;');expect(xml).not.toContain('**重点核对**');expect(xml).toContain('<w:b');expect(xml).toContain('<w:tbl>');expect(xml).not.toContain('<w:pageBreakBefore');
 expect(xml).not.toContain('原始OCR');
});

test('DOCX rejects an empty redacted source',async()=>{
 await expect(buildRedactedDocx(' \n ')).rejects.toThrow('脱敏文本为空');
});

test('structured DOCX keeps exact text in headings, lists, tables and footnotes without image content',async()=>{
 const document={format:'redacted-structure-v1',pages:[
  {page:1,blocks:[
   {id:'h1',kind:'heading',level:1,text:' 标题 & <脱敏> '},
   {id:'l1',kind:'list',items:['第一项  ','第二项']},
   {id:'t1',kind:'table',caption:'付款表',rows:[{cells:[{text:'日期'},{text:'金额'}]},{cells:[{text:'2025-01-02'},{text:'甲某 100 元'}]}],footnotes:['脚注内容']},
  ] as DocumentBlock[]},
  {page:3,blocks:[{id:'p2',kind:'paragraph',text:'重复文本\n重复文本  '}] as DocumentBlock[]},
 ]};
 const parts=docxParts(await buildRedactedDocx(document as any)),xml=parts.get('word/document.xml')!;
 expect(xml).toContain(' 标题 &amp; &lt;脱敏&gt; ');
 expect(xml).toContain('第一项  ');expect(xml).toContain('第二项');
 expect(xml).toContain('付款表');expect(xml).toContain('2025-01-02');expect(xml).toContain('甲某 100 元');expect(xml).toContain('脚注内容');
 expect(xml.match(/重复文本/g)).toHaveLength(2);expect(xml).toContain('<w:tbl>');expect(xml).not.toContain('<w:pageBreakBefore');
 const renderedText=[...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match=>match[1]!.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"));
 expect(renderedText).toEqual([' 标题 & <脱敏> ','第一项  ','第二项','付款表','日期','金额','2025-01-02','甲某 100 元','脚注内容','重复文本\n重复文本  ']);
 expect(parts.get('word/_rels/document.xml.rels')??'').not.toContain('/media/');
});


test('source pagination is explicit and skips blank source pages while flow keeps every real paragraph',async()=>{
 const structure:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'a',kind:'paragraph',text:'完整正文甲'}]},{page:2,blocks:[{id:'b',kind:'paragraph',text:'   '}]},{page:3,blocks:[{id:'c',kind:'paragraph',text:'完整正文乙'}]}]};
 const flow=docxParts(await buildRedactedDocx(structure)).get('word/document.xml')!;
 expect(flow).not.toContain('<w:pageBreakBefore');expect(flow.match(/<w:p>/g)).toHaveLength(2);expect(flow).toContain('完整正文甲');expect(flow).toContain('完整正文乙');
 const source=docxParts(await buildRedactedDocx(structure,{pagination:'source'})).get('word/document.xml')!;
 expect(source.match(/<w:pageBreakBefore/g)).toHaveLength(1);
 await expect(buildRedactedDocx({format:'redacted-structure-v1',pages:[{page:1,blocks:[]}]})).rejects.toThrow('脱敏文本为空');
});


test('control characters in extracted text never produce invalid OOXML',async()=>{
 const {buildDocx}=await import('../document-generation/docx');
 const doc:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'p',kind:'paragraph',text:'正文\x0c换页\x01控制'}]}]};
 const xml=docxParts(await buildDocx(doc)).get('word/document.xml')!;
 expect(xml).toContain('正文换页控制');
 expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml)).toBe(false);
});

test('table cells use compact paragraph spacing without changing amounts or dates',async()=>{
 const doc:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'t',kind:'table',rows:[{cells:[{text:'本金10000元'},{text:'2025-03-26'}]}]}]}]};
 const xml=docxParts(await buildRedactedDocx(doc)).get('word/document.xml')!;
 expect(xml).toContain('本金10000元');expect(xml).toContain('2025-03-26');expect(xml).toContain('w:after="0"');expect(xml).toContain('w:line="240"');
});

test('material cleanup removes unknown HTML before DOCX generation, preserving body and masked values',async()=>{
 const {parseMineruDocxJson}=await import('./pdf-extraction/mineru-cli');
 const {cleanScanNoisePages}=await import('../../shared/scan-noise');
 const source=[{type:'html',html:'<p><哈哈>本金10000元</哈哈><br>日期2026-10-27</p>'},{type:'text',text:'<哈哈></哈哈>；依据<中华人民共和国民法典>'},{type:'text',text:String.raw`622848\\*\\*8919`},{type:'table',table_body:'<table><tr><td>&lt;哈哈&gt;附件&lt;/哈哈&gt;</td><td>10000元</td></tr></table>'}];
 const original=JSON.stringify(source),pages=parseMineruDocxJson(source),cleaned=cleanScanNoisePages(pages.map(page=>({file_id:'synthetic',page:page.page,blocks:page.structure!})));
 const xml=docxParts(await buildRedactedDocx({format:'redacted-structure-v1',pages:cleaned.pages.map(page=>({page:page.page,blocks:page.blocks}))})).get('word/document.xml')!;
 expect(xml).toContain('本金10000元\n日期2026-10-27');
 expect(xml).toContain('；依据《中华人民共和国民法典》');
 expect(xml).toContain('622848**8919');expect(xml).toContain('附件');expect(xml).not.toContain('哈哈');
 expect(xml).not.toContain('\\*');expect(xml).not.toContain('&lt;p&gt;');expect(xml).not.toContain('&lt;br&gt;');expect(xml).toContain('<w:tbl>');
 expect(JSON.stringify(source)).toBe(original);
});

test('图文DOCX只嵌入显式选择的页图，纯文本输出不带图片',async()=>{
 const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
 const source={format:'redacted-structure-v1' as const,pages:[{page:1,blocks:[{id:'b1',kind:'paragraph' as const,text:'检查结论'}]}]};
 const plain=docxParts(await buildRedactedDocx(source));
 const illustrated=docxParts(await buildRedactedDocx(source,{imagesByPage:new Map([[1,[{data,type:'png' as const,width:1,height:1}]]])}));
 expect([...plain.keys()].some(key=>key.startsWith('word/media/'))).toBe(false);
 expect([...illustrated.keys()].some(key=>key.startsWith('word/media/'))).toBe(true);
 expect(illustrated.get('word/document.xml')).toContain('w:drawing');
});

test('图文导出绑定冻结来源与逐图决定，来源摘要不一致时拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-image-docx-'));
 const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
 const imageSha=digest(png),relativePath=join('material-library','blobs',imageSha.slice(0,2),imageSha);
 const originalName='检查单.pdf',materialId='material-1',fileId='file-1',workflowId='workflow-image-fixture';
 const block={id:'b1',kind:'paragraph',text:'检查结论'};
 const page={page:1,text:'检查结论',structure:[block]},secondPage={page:2,text:'复查建议\nCS 扫描全能王®',structure:[{id:'b2',kind:'paragraph',text:'复查建议'},{id:'b3',kind:'paragraph',text:'CS 扫描全能王®'}]};
 const index=JSON.stringify({format:'source-index-v1',materials:[{material_id:materialId,markdown:'检查结论\n\n复查建议\nCS 扫描全能王®',document:{version:1,pages:[page,secondPage]}}]});
 const markdown=`# ${originalName}\n\n检查结论\n\n复查建议\nCS 扫描全能王®`;
 const result={format:'material-preparation-v2',package_summary:'检查单',documents:[{id:fileId,title:originalName,block_ids:['u1p1b1'],summary:'检查结论',document_type:'检查单',tags:[],notes:'',visibility:'visible',hidden_texts:[{source_text:'CS 扫描全能王®',reason:'广告'}]}],combinations:[],warnings:[],image_decisions:[{file_id:fileId,image_id:`p1-i0-${imageSha.slice(0,12)}`,page:1,sha256:imageSha,keep:true,reason:'诊断图像'}]};
 const manifest:any={version:2,origin:{kind:'library_v1',material_mode:'original',material_processing_mode:'original',package_id:'package-1',revision_id:'revision-1',redaction_id:null,source_digest:'source-digest'},material_scope:{preparation_id:'preparation-1',result},files:[{library_file_id:fileId,material_id:materialId,original_name:originalName}],material_markdown:{artifact_id:'markdown-artifact',sha256:digest(markdown),kind:'source_markdown'},material_index:{artifact_id:'index-artifact',sha256:digest(index),kind:'source_index'}};
 const sourceRow={project_id:'project-1',package_id:'package-1',revision_id:'revision-1',redaction_id:null,material_mode:'original',source_digest:'source-digest',snapshot_manifest:manifest,snapshot_digest:digest(canonicalJson(manifest)),markdown_artifact_id:'markdown-artifact',index_artifact_id:'index-artifact'};
 const artifacts=[{id:'markdown-artifact',kind:'source_markdown',attempt_id:null,sha256:digest(markdown),content:markdown,size_bytes:Buffer.byteLength(markdown)},{id:'index-artifact',kind:'source_index',attempt_id:null,sha256:digest(index),content:index,size_bytes:Buffer.byteLength(index)}];
 let preparationDigest='source-digest',candidateRole:'figure'|'page_scan'|undefined='figure';
 const db={query:async(sql:string,params:unknown[])=>{
  if(sql.includes('SELECT w.id AS workflow_id'))return{rows:[{workflow_id:workflowId,project_id:'project-1',title:'图像题',source_key:null,workflow_kind:'question',material_backend:'library_v1',has_library_snapshot:true,project_name:'医疗',parent_name:'医疗',phase_name:'一期'}]};
  if(sql.includes('SELECT p.material_backend'))return{rows:[{material_backend:'library_v1',has_library_snapshot:true}]};
  if(sql.includes('SELECT project_id,package_id,revision_id'))return{rows:[sourceRow]};
  if(sql.includes('SELECT id,kind,attempt_id,sha256,storage_path,size_bytes'))return{rows:artifacts.map(({content,...item})=>item)};
  if(sql.includes('SELECT id,content FROM ai_distill.artifacts'))return{rows:artifacts.map(({id,content})=>({id,content}))};
  if(sql.includes('SELECT snapshot_manifest,redaction_id'))return{rows:[{snapshot_manifest:manifest,redaction_id:null}]};
  if(sql.includes("kind='source_index'"))return{rows:[artifacts[1]]};
  if(sql.includes('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials'))return{rows:[{id:materialId,original_name:originalName,storage_path:'source.pdf',sha256:'a'.repeat(64),size_bytes:1}]};
  if(sql.includes('SELECT snapshot_manifest FROM ai_distill.question_library_sources'))return{rows:[{snapshot_manifest:manifest}]};
  if(sql.includes('SELECT revision_id,source_digest,project_id,extraction_job_id,result FROM ai_distill.library_preparations'))return{rows:[{revision_id:'revision-1',source_digest:preparationDigest,project_id:'project-1',extraction_job_id:'extract-1',result}]};
  if(sql.includes('SELECT extraction_job_id,source_digest FROM ai_distill.library_preparations'))return{rows:[{extraction_job_id:'extract-1',source_digest:preparationDigest}]};
  if(sql.includes('SELECT b.text_content FROM ai_distill.library_documents'))return{rows:[{text_content:JSON.stringify({image_candidates:[{id:result.image_decisions[0]!.image_id,page:1,sha256:imageSha,blob_id:'image-blob',...(candidateRole?{role:candidateRole}:{})}]})}]};
  if(sql.includes('SELECT sha256,storage_path,content_type FROM ai_distill.library_blobs'))return{rows:[{sha256:imageSha,storage_path:relativePath,content_type:'image/png'}]};
  throw new Error(`未预期查询: ${sql.slice(0,100)} ${JSON.stringify(params)}`);
 }};
 try{
  await mkdir(join(root,'material-library','blobs',imageSha.slice(0,2)),{recursive:true});await writeFile(join(root,relativePath),png);
  const output=await buildCurrentMaterialImageDocx(db as any,workflowId,root);
  expect(output.image_count).toBe(1);
  expect(docxParts(output.bytes).get('word/document.xml')).not.toContain('w:pageBreakBefore');
  expect(docxParts(output.bytes).get('word/document.xml')).not.toContain('扫描全能王');
  expect((await buildCurrentMaterialImageDocx(db as any,workflowId,root,'preview-1')).image_count).toBe(1);
  expect([...docxParts(output.bytes).keys()].filter(name=>name.startsWith('word/media/')&&name!=='word/media/')).toHaveLength(1);
  candidateRole=undefined;
  const legacy=await buildCurrentMaterialImageDocx(db as any,workflowId,root);
  expect(legacy.image_count).toBe(0);
  expect([...docxParts(legacy.bytes).keys()].filter(name=>name.startsWith('word/media/')&&name!=='word/media/')).toHaveLength(0);
  candidateRole='page_scan';
  expect((await buildCurrentMaterialImageDocx(db as any,workflowId,root)).image_count).toBe(0);
  preparationDigest='different-source';
  await expect(buildCurrentMaterialImageDocx(db as any,workflowId,root)).rejects.toThrow('图片整理来源与题目不一致');
 }finally{await rm(root,{recursive:true,force:true});}
});

/** 验证材料清单预处理只接受正式原件清单，保留合法短文本并阻断恢复清单洗白；不调用PDF/OFD外部工具。 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareLibraryFiles} from './prepare-library-files';

test('合法短TXT生成可追溯清单，不因字符少被拦截',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-prepare-text-'));
 try{
  const source=join(root,'短说明.txt'),manifest=join(root,'manifest.json'),out=join(root,'out');
  await writeFile(source,'确认');await writeFile(manifest,JSON.stringify({files:[{path:'短说明.txt',redaction_mode:'model'}]}));
  const result=await prepareLibraryFiles(manifest,out);
  expect(result).toMatchObject({source_files:1,upload_files:1,requires_visual_review:false});
  expect(JSON.parse(await readFile(result.manifest_path,'utf8'))).toEqual({files:[{path:'files/短说明.txt',redaction_mode:'model'}]});
  const provenance=JSON.parse(await readFile(result.provenance_path,'utf8'));
  expect(provenance).toMatchObject({version:1,complete:true,files:[{source_path:source,source_size_bytes:6,outputs:[{path:'files/短说明.txt',size_bytes:6}]}]});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('恢复清单及去掉顶层标记后的恢复字段都不能被预处理洗成正式清单',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-prepare-recovery-'));
 try{
  const source=join(root,'恢复.txt'),manifest=join(root,'manifest.json');await writeFile(source,'扫描全能王 创建');
  await writeFile(manifest,JSON.stringify({version:1,recovery:'pdf-to-text',files:[{path:'恢复.txt',source_pdf:'原件.pdf',characters:8}]}));
  await expect(prepareLibraryFiles(manifest,join(root,'out-a'))).rejects.toThrow('临时恢复清单');
  await writeFile(manifest,JSON.stringify({files:[{path:'恢复.txt',source_pdf:'原件.pdf',characters:8}]}));
  await expect(prepareLibraryFiles(manifest,join(root,'out-b'))).rejects.toThrow('不支持的来源或恢复字段');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('PNG原件字节不变进入清单并记录单页provenance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-prepare-image-'));
 try{
  const source=join(root,'扫描.png'),manifest=join(root,'manifest.json'),out=join(root,'out'),bytes=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
  await writeFile(source,bytes);await writeFile(manifest,JSON.stringify({files:[{path:'扫描.png'}]}));
  const result=await prepareLibraryFiles(manifest,out),copied=new Uint8Array(await readFile(join(out,'files','扫描.png'))),provenance=JSON.parse(await readFile(result.provenance_path,'utf8'));
  expect(copied).toEqual(bytes);expect(provenance.files[0]).toMatchObject({source_path:source,outputs:[{path:'files/扫描.png',page_count:1}]});expect(provenance.files[0]).not.toHaveProperty('converter');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DOC经隔离LibreOffice转PDF保留原件并记录转换provenance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-prepare-doc-'));
 try{
  const source=join(root,'合同.doc'),manifest=join(root,'manifest.json'),out=join(root,'out'),content='{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}\\f0\\fs24 \\u21512?\\u21516? Synthetic contract}';
  await writeFile(source,content);await writeFile(manifest,JSON.stringify({files:[{path:'合同.doc'}]}));
  const result=await prepareLibraryFiles(manifest,out),provenance=JSON.parse(await readFile(result.provenance_path,'utf8'));
  expect(await readFile(source,'utf8')).toBe(content);expect(provenance.files[0]).toMatchObject({source_path:source,converter:'LibreOffice',visual_review:'required',outputs:[{path:'files/合同.pdf',page_count:1}]});
  expect(provenance.files[0].converter_version).toContain('LibreOffice');expect(await Bun.file(result.manifest_path).exists()).toBe(true);
  expect((await Bun.$`pdffonts ${join(out,'files','合同.pdf')}`.text())).not.toMatch(/NotoSansLisu|LastResort/i);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('WPS转换失败只写failed.json而不发布manifest',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-prepare-wps-fail-'));
 try{
  const manifest=join(root,'manifest.json'),out=join(root,'out');await mkdir(join(root,'broken.wps'));await writeFile(manifest,JSON.stringify({files:[{path:'broken.wps'}]}));
  await expect(prepareLibraryFiles(manifest,out)).rejects.toThrow();
  expect(await Bun.file(join(out,'failed.json')).exists()).toBe(true);expect(await Bun.file(join(out,'manifest.json')).exists()).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

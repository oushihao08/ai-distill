/** 验证材料清单预处理只接受正式原件清单，保留合法短文本并阻断恢复清单洗白；不调用PDF/OFD外部工具。 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
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

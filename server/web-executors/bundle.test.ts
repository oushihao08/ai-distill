/** 验证网页上传打包：数量足够时逐个上传，超限时按原序合并且不丢内容；二进制与上限边界。不启动浏览器。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bundleForUpload,collectDirectoryFiles,renderUploadManifest,WEB_UPLOAD_MAX_FILES} from './bundle';

const text=(path:string,content:string)=>({path,content});

test('files within the limit are uploaded one by one with flat unique names',()=>{
  const result=bundleForUpload([text('input/a.txt','甲'),text('input/b/c.txt','乙')],5);
  expect(result.files.map(f=>f.name)).toEqual(['input__a.txt','input__b__c.txt']);
  expect(result.files.map(f=>f.content)).toEqual(['甲','乙']);
  expect(result.manifest).toEqual([{path:'input/a.txt',bytes:3,file:'input__a.txt'},{path:'input/b/c.txt',bytes:3,file:'input__b__c.txt'}]);
});
test('over the limit merges in original order, keeps every byte and marks file boundaries',()=>{
  const entries=Array.from({length:12},(_,i)=>text(`input/f${i}.txt`,`正文${i}`.repeat(20)));
  const result=bundleForUpload(entries,3);
  expect(result.files.length).toBeLessThanOrEqual(3);
  const joined=result.files.map(f=>String(f.content)).join('\n');
  for(const entry of entries){
    expect(joined).toContain(`<<<<< FILE: ${entry.path} | bytes=${Buffer.byteLength(entry.content)} >>>>>\n${entry.content}\n<<<<< END FILE: ${entry.path} >>>>>`);
  }
  // 原顺序：manifest 中文件出现的容器编号单调不减
  const order=result.manifest.map(item=>item.file);
  expect([...order].sort()).toEqual(order);
  expect(result.manifest.map(item=>item.path)).toEqual(entries.map(e=>e.path));
});
test('a single oversized file is never split and still fits',()=>{
  const result=bundleForUpload([text('input/big.txt','x'.repeat(10_000)),text('input/s1.txt','a'),text('input/s2.txt','b')],2);
  expect(result.files.length).toBeLessThanOrEqual(2);
  expect(result.files.some(f=>String(f.content).includes('x'.repeat(10_000)))).toBe(true);
});
test('binary files are uploaded unchanged and reserve upload slots',()=>{
  const binary=new Uint8Array([0xff,0xfe,0x00,0x80]);
  const result=bundleForUpload([{path:'input/logo.bin',content:binary},text('input/a.txt','甲'),text('input/b.txt','乙'),text('input/c.txt','丙')],2);
  expect(result.files.length).toBe(2);
  expect(result.files[0]).toEqual({name:'input__logo.bin',content:binary});
  expect(String(result.files[1]!.content)).toContain('input/a.txt');
  expect(()=>bundleForUpload([{path:'x.bin',content:binary},text('a.txt','甲')],1)).toThrow();
});
test('invalid limits and duplicate paths are rejected',()=>{
  expect(()=>bundleForUpload([text('a','1')],0)).toThrow();
  expect(()=>bundleForUpload([text('a','1'),text('a','2')],3)).toThrow('路径重复');
});
test('manifest text lists every original path with its upload file',()=>{
  const result=bundleForUpload([text('input/a.txt','甲')],3);
  expect(renderUploadManifest(result.manifest)).toContain('- input/a.txt → input__a.txt');
});
test('upload limits for known providers are positive integers',()=>{
  for(const limit of Object.values(WEB_UPLOAD_MAX_FILES))expect(Number.isInteger(limit)&&limit>=1).toBe(true);
});
test('collectDirectoryFiles walks sorted, honours exclusions and keeps raw bytes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'web-bundle-'));
  try{
    await mkdir(join(dir,'input','sub'),{recursive:true});await mkdir(join(dir,'output'),{recursive:true});
    await writeFile(join(dir,'input','b.txt'),'乙');await writeFile(join(dir,'input','a.txt'),'甲');
    await writeFile(join(dir,'input','sub','c.txt'),'丙');await writeFile(join(dir,'output','x.json'),'{}');
    const files=await collectDirectoryFiles(dir,path=>path==='output/');
    expect(files.map(f=>f.path)).toEqual(['input/a.txt','input/b.txt','input/sub/c.txt']);
    expect(Buffer.from(files[0]!.content as Uint8Array).toString('utf8')).toBe('甲');
  }finally{await rm(dir,{recursive:true,force:true});}
});

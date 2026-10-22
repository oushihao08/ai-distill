/**
 * 文件职责：验证全局材料库原件安装、复用、权限与不可变文本对象校验。
 * 主要边界：文件仅写临时目录；数据库文本使用替身，核对复用正文、MIME及UTF8字节数，不写业务库。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installLibraryBlob,normalizeLibraryFilename,insertLibraryTextBlob} from './storage';

test('文本对象按摘要与MIME复用，损坏正文或UTF8字节数不能冒充成功',async()=>{
 const text='测试正文',type='text/markdown; charset=utf-8';let existing:any,values:any[]=[];
 const db={query:async(sql:string,args:any[])=>{
  values=args;
  return sql.startsWith('INSERT')?{rows:existing?[]:[{id:'new-text'}]}:{rows:[existing]};
 }} as any;
 const fresh=await insertLibraryTextBlob(db,text,type);
 expect(fresh).toMatchObject({id:'new-text',size_bytes:Buffer.byteLength(text)});
 expect(values.slice(2,5)).toEqual([Buffer.byteLength(text),type,text]);
 existing={id:'same-text',text_content:text,size_bytes:String(Buffer.byteLength(text))};
 expect(await insertLibraryTextBlob(db,text,type)).toEqual({...fresh,id:'same-text'});
 for(const damaged of [{...existing,text_content:'已损坏'},{...existing,size_bytes:1}]){
  existing=damaged;await expect(insertLibraryTextBlob(db,text,type)).rejects.toThrow('摘要或大小冲突');
 }
});

test('installs content-addressed blobs once and verifies reused bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-library-'));
 try{
  const bytes=new TextEncoder().encode('shared material');
  const first=await installLibraryBlob(root,bytes,'text/plain','local');
  const second=await installLibraryBlob(root,bytes,'text/plain','local');
  expect(first.sha256).toBe(second.sha256);
  expect(first.storage_path).toBe(second.storage_path);
  expect(await readFile(join(root,first.storage_path))).toEqual(Buffer.from(bytes));
  expect((await stat(join(root,first.storage_path))).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('normalizes a filename without permitting traversal or control characters',()=>{
 expect(normalizeLibraryFilename('证据\\附件1.pdf')).toBe('证据/附件1.pdf');
 expect(()=>normalizeLibraryFilename('../outside.pdf')).toThrow();
 expect(()=>normalizeLibraryFilename('a/../../outside.pdf')).toThrow();
 expect(()=>normalizeLibraryFilename('a/\u0000b.pdf')).toThrow();
});

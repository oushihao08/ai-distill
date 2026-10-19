/**
 * 文件职责：验证全局材料库内容寻址文件的安装、复用和字节权限。
 * 主要边界：所有文件仅写入临时目录，验证摘要一致性与新建文件权限。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installLibraryBlob,normalizeLibraryFilename} from './storage';

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

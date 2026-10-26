/**
 * 文件职责：验证全局材料库原件安装、复用、权限与不可变文本对象校验。
 * 主要边界：文件仅写临时目录；数据库文本使用替身，核对复用正文、MIME及UTF8字节数，不写业务库。
 */
import {test,expect,spyOn} from 'bun:test';
import * as fs from 'node:fs/promises';
import {mkdtemp,readFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanupRolledBackLibraryBlobs,lockLibraryBlobWrites,installLibraryBlob,normalizeLibraryFilename,insertLibraryTextBlob} from './storage';

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
  expect(first.installed_new).toBe(true);expect(second.installed_new).toBe(false);
  expect(await readFile(join(root,first.storage_path))).toEqual(Buffer.from(bytes));
  expect((await stat(join(root,first.storage_path))).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('temporary cleanup failure preserves validated installation receipts and rollback recovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blob-temp-cleanup-'));
 const cleanup=spyOn(fs,'rm').mockRejectedValue(new Error('fixture cleanup denied'));
 try{
  const bytes=Buffer.from('validated original');
  const first=await installLibraryBlob(root,bytes,'text/plain','local');
  const reused=await installLibraryBlob(root,bytes,'text/plain','local');
  expect(first.installed_new).toBe(true);expect(reused.installed_new).toBe(false);
  expect(await readFile(join(root,first.storage_path))).toEqual(bytes);
  expect(cleanup).toHaveBeenCalledTimes(2);
  cleanup.mockRestore();
  expect(await cleanupRolledBackLibraryBlobs({query:async()=>({rows:[]})} as any,root,[first])).toEqual({removed:1,retained:0,deferred:0});
  expect(await Bun.file(join(root,first.storage_path)).exists()).toBe(false);
 }finally{cleanup.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('temporary cleanup failure cannot hide an installation failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blob-install-failure-')),failure=new Error('fixture link failed');
 const publish=spyOn(fs,'link').mockRejectedValue(failure),cleanup=spyOn(fs,'rm').mockRejectedValue(new Error('fixture cleanup denied'));
 try{
  await expect(installLibraryBlob(root,Buffer.from('original'),'text/plain','local')).rejects.toBe(failure);
  expect(cleanup).toHaveBeenCalledTimes(1);
 }finally{publish.mockRestore();cleanup.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('blob locks are sorted and deduplicated across a batch',async()=>{
 const keys:unknown[]=[];
 await lockLibraryBlobWrites({query:async(_sql:string,values:unknown[])=>{keys.push(values[0]);}} as any,['b'.repeat(64),'a'.repeat(64),'b'.repeat(64)]);
 expect(keys).toEqual(['library-blob:'+'a'.repeat(64),'library-blob:'+'b'.repeat(64)]);
});

test('rollback cleanup only unlinks newly installed files after locking and confirming no database registration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blob-rollback-'));const calls:string[]=[];
 try{
  const orphan=await installLibraryBlob(root,Buffer.from('orphan'),'text/plain','local');
  const shared=await installLibraryBlob(root,Buffer.from('shared'),'text/plain','local');
  const reused=await installLibraryBlob(root,Buffer.from('reused'),'text/plain','local');reused.installed_new=false;
  const db={query:async(sql:string,values:unknown[]=[])=>{calls.push(sql);return{rows:sql.startsWith('SELECT id FROM')&&values[0]===shared.sha256?[{id:'committed-blob'}]:[]};}} as any;
  expect(await cleanupRolledBackLibraryBlobs(db,root,[orphan,shared,reused])).toEqual({removed:1,retained:1,deferred:0});
  expect(await Bun.file(join(root,orphan.storage_path)).exists()).toBe(false);
  expect(await Bun.file(join(root,shared.storage_path)).exists()).toBe(true);expect(await Bun.file(join(root,reused.storage_path)).exists()).toBe(true);
  expect(calls.indexOf(calls.find(sql=>sql.includes('pg_advisory_xact_lock'))!)).toBeLessThan(calls.indexOf(calls.find(sql=>sql.startsWith('SELECT id FROM'))!));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('failed reference lookup retains originals and cannot hide the original upload failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blob-offline-'));
 try{
  const blob=await installLibraryBlob(root,Buffer.from('retain'),'text/plain','local');
  const db={query:async(sql:string)=>{if(sql.startsWith('SELECT id FROM'))throw new Error('DB unavailable');return{rows:[]};}} as any;
  expect(await cleanupRolledBackLibraryBlobs(db,root,[blob])).toEqual({removed:0,retained:0,deferred:1});
  expect(await Bun.file(join(root,blob.storage_path)).text()).toBe('retain');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a writer registering a blob before cleanup obtains the lock causes cleanup to retain it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blob-lock-wait-'));let release!:()=>void,locked!:()=>void,registered=false;
 const lockStarted=new Promise<void>(resolve=>{locked=resolve;}),lockReleased=new Promise<void>(resolve=>{release=resolve;});
 try{
  const blob=await installLibraryBlob(root,Buffer.from('concurrent'),'text/plain','local');
  const db={query:async(sql:string)=>{
   if(sql.includes('pg_advisory_xact_lock')){locked();await lockReleased;}
   return{rows:sql.startsWith('SELECT id FROM')&&registered?[{id:'other-writer'}]:[]};
  }} as any;
  const pending=cleanupRolledBackLibraryBlobs(db,root,[blob]);await lockStarted;registered=true;release();
  expect(await pending).toEqual({removed:0,retained:1,deferred:0});expect(await Bun.file(join(root,blob.storage_path)).exists()).toBe(true);
 }finally{release?.();await rm(root,{recursive:true,force:true});}
});

test('rollback cleanup refuses a replaced symlink and keeps its target',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blob-link-'));
 try{
  const blob=await installLibraryBlob(root,Buffer.from('private'),'text/plain','local'),target=join(root,'other.txt');
  await Bun.write(target,'keep target');await rm(join(root,blob.storage_path));await symlink(target,join(root,blob.storage_path));
  expect((await cleanupRolledBackLibraryBlobs({query:async()=>({rows:[]})} as any,root,[blob])).deferred).toBe(1);
  expect(await Bun.file(target).text()).toBe('keep target');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('normalizes a filename without permitting traversal or control characters',()=>{
 expect(normalizeLibraryFilename('证据\\附件1.pdf')).toBe('证据/附件1.pdf');
 expect(()=>normalizeLibraryFilename('../outside.pdf')).toThrow();
 expect(()=>normalizeLibraryFilename('a/../../outside.pdf')).toThrow();
 expect(()=>normalizeLibraryFilename('a/\u0000b.pdf')).toThrow();
});

/** 验证本地解压的取消/输出上限和Poppler命令取消；仅运行临时FIFO/ZIP与自有子进程，不连接MinerU或业务服务。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runUnzip} from './mineru-api';
import {command} from '../pdf';
import {withTaskSignal} from '../../task-signal';

test('unzip blocked on a FIFO is cancelled and reaped',async()=>{
 const root=await mkdtemp(join(tmpdir(),'unzip-stop-')),path=join(root,'input.zip'),controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  expect(await Bun.spawn(['mkfifo',path],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  const pending=runUnzip(['-Z1',path],1024,controller.signal);
  timer=setTimeout(()=>controller.abort(new Error('cancelled-test')),30);
  await expect(pending).rejects.toThrow('cancelled-test');
 }finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
},3000);

test('unzip bounds output while reading, not after complete buffering',async()=>{
 const root=await mkdtemp(join(tmpdir(),'unzip-limit-')),path=join(root,'input.zip'),source=join(root,'text.txt');
 try{
  await writeFile(source,'x'.repeat(1024*1024));
  expect(await Bun.spawn(['zip','-qj',path,source],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  await expect(runUnzip(['-p',path,'text.txt'],128)).rejects.toThrow('输出限制');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ambient task cancellation terminates a command and pre-cancelled unzip never starts',async()=>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const pending=withTaskSignal(controller.signal,()=>command([process.execPath,'-e','setInterval(()=>{},1000)']));
  timer=setTimeout(()=>controller.abort(new Error('stop')),30);
  await expect(pending).rejects.toThrow();
  await expect(runUnzip(['does-not-exist'],1024,controller.signal)).rejects.toThrow('stop');
 }finally{clearTimeout(timer);}
},3000);

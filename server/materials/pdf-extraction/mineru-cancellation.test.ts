/** 验证ZIP下载/解压的取消与大小边界、Poppler命令取消；仅用合成响应流、临时FIFO/ZIP与自有子进程，不连接MinerU或业务服务。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readMineruResultZip,runUnzip} from './mineru-api';
import {command} from '../pdf';
import {withTaskSignal} from '../../task-signal';

test('ZIP download preserves chunks at the limit and rejects empty results',async()=>{
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.enqueue(new Uint8Array([3,4]));controller.close();}});
 expect(await readMineruResultZip(new Response(body),new AbortController().signal,4)).toEqual(new Uint8Array([1,2,3,4]));
 await expect(readMineruResultZip(new Response(''),new AbortController().signal,4)).rejects.toThrow('大小无效');
 await expect(readMineruResultZip(new Response(null),new AbortController().signal,4)).rejects.toThrow('大小无效');
});

test('ZIP download stops and cancels the response as soon as its byte limit is exceeded',async()=>{
 let pulls=0,cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}},{highWaterMark:0});
 await expect(readMineruResultZip(new Response(body),new AbortController().signal,4)).rejects.toThrow('大小无效');
 expect(pulls).toBe(2);expect(cancelled).toBe(true);
});

test('ZIP download cancellation wakes a pending stream read',async()=>{
 const controller=new AbortController();let cancelled=false,started!:()=>void;
 const reading=new Promise<void>(resolve=>{started=resolve;});
 const body=new ReadableStream<Uint8Array>({pull(){started();},cancel(){cancelled=true;}},{highWaterMark:0});
 const pending=readMineruResultZip(new Response(body),controller.signal,4);
 await reading;controller.abort(new Error('download stopped'));
 await expect(pending).rejects.toThrow('download stopped');expect(cancelled).toBe(true);
});

test('ZIP download propagates response errors and refuses a pre-cancelled task',async()=>{
 const broken=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('broken response'));}});
 await expect(readMineruResultZip(new Response(broken),new AbortController().signal,4)).rejects.toThrow('broken response');
 const controller=new AbortController();controller.abort(new Error('already stopped'));
 await expect(readMineruResultZip(new Response('data'),controller.signal,4)).rejects.toThrow('already stopped');
});

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

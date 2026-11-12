/**
 * 职责：本机 Chrome 专用实例的启动、复用、状态查询、关闭与人工登录窗口；档案、端口与锁都位于 `<STORAGE_DIR>/web-agent/`。
 * 公开入口：`webAgentPaths()`、`ensureBrowser()`、`webBrowserStatus()`、`webCloseBrowser()`、`webLogin()`、`probeDebugPort()`。
 * 调用方：`transport.ts`（打开会话）、`index.ts`（对外状态/登录/关闭）；多个 worker 进程共享同一浏览器：端口写入 `browser.json`，启动竞态由 `browser.lock`（`wx` 原子创建）串行化。
 * 运行影响：会启动一个后台 Chrome（macOS 用 `open -g -j -n -a` 并加 `--no-startup-window`，实测启动与后台 createTarget 均不抢前台；headless 或指定 chromePath 时直接 spawn），占用一个随机本机调试端口（仅 127.0.0.1），档案落盘于 `profile/`。
 * 绝不使用用户日常 Chrome 档案；`webCloseBrowser()` 只通过本档案端口的 `Browser.close` 关闭，不按进程名杀进程。
 */
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CdpClient} from './cdp';
import {storageDirectory} from '../paths';
import {WebAgentError,type WebProvider} from './types';

export interface WebAgentPaths{dir:string;profile:string;infoFile:string;lockFile:string;activePortFile:string}
export interface BrowserInfo{port:number;started_at:string;profile:string;chrome_path?:string;headless?:boolean}
export interface LaunchOptions{root?:string;chromePath?:string;headless?:boolean}

const MAC_APP='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOGIN_URLS:Record<WebProvider,string>={deepseek:'https://chat.deepseek.com/',gemini:'https://gemini.google.com/app'};

export function webAgentPaths(root?:string):WebAgentPaths{
 const dir=join(root??storageDirectory(),'web-agent');
 const profile=join(dir,'profile');
 return {dir,profile,infoFile:join(dir,'browser.json'),lockFile:join(dir,'browser.lock'),activePortFile:join(profile,'DevToolsActivePort')};
}

function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}

/** 探测调试端口：返回浏览器级 WebSocket 地址；不可达返回 null。 */
export async function probeDebugPort(port:number,timeout_ms=1500):Promise<{wsUrl:string;version:string}|null>{
 try{
  const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(timeout_ms)});
  if(!response.ok)return null;
  const body=await response.json() as {webSocketDebuggerUrl?:string;Browser?:string};
  if(!body.webSocketDebuggerUrl)return null;
  return {wsUrl:body.webSocketDebuggerUrl,version:String(body.Browser??'')};
 }catch{return null;}
}

async function readInfo(paths:WebAgentPaths):Promise<BrowserInfo|null>{
 try{
  const info=JSON.parse(await readFile(paths.infoFile,'utf8')) as BrowserInfo;
  return Number.isInteger(info.port)&&info.port>0?info:null;
 }catch{return null;}
}

async function writeInfoAtomic(paths:WebAgentPaths,info:BrowserInfo){
 const temp=`${paths.infoFile}.${process.pid}.tmp`;
 await writeFile(temp,JSON.stringify(info),{mode:0o600});
 await rename(temp,paths.infoFile);
}

function resolveChrome(options:LaunchOptions):{bin?:string;macApp:boolean}{
 if(options.chromePath){
  if(!existsSync(options.chromePath))throw new WebAgentError('web_browser_unavailable','指定的 Chrome 路径不存在');
  return {bin:options.chromePath,macApp:false};
 }
 if(process.platform==='darwin'&&!options.headless){
  if(!existsSync(MAC_APP))throw new WebAgentError('web_browser_unavailable','未找到 Google Chrome');
  return {macApp:true};
 }
 const candidates=process.platform==='darwin'?[MAC_APP]:['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'];
 const bin=candidates.find(existsSync);
 if(!bin)throw new WebAgentError('web_browser_unavailable','未找到 Chrome');
 return {bin,macApp:false};
}

function launchArgs(paths:WebAgentPaths,headless:boolean|undefined,extra:string[]){
 return [
  `--user-data-dir=${paths.profile}`,
  ...extra,
  '--no-first-run','--no-default-browser-check',
  '--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling',
  ...(headless?['--headless=new','--disable-gpu']:[]),
 ];
}

async function spawnDetached(cmd:string[]){
 const proc=Bun.spawn(cmd,{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
 proc.unref();
}

async function acquireLock(paths:WebAgentPaths,deadline:number):Promise<(()=>Promise<void>)|null>{
 while(Date.now()<deadline){
  try{
   await writeFile(paths.lockFile,`${process.pid}\n${Date.now()}`,{flag:'wx',mode:0o600});
   return async()=>{await rm(paths.lockFile,{force:true});};
  }catch{
   try{
    const age=Date.now()-(await stat(paths.lockFile)).mtimeMs;
    if(age>90_000){await rm(paths.lockFile,{force:true});continue;}
   }catch{/* 锁已被释放，重试创建 */}
   return null;
  }
 }
 return null;
}

/**
 * 确保专用浏览器可连：已有且可连则复用；否则在文件锁内启动并等待 `DevToolsActivePort`。
 * 其他进程正在启动时等待其 `browser.json` 变为可连（最长 45 秒）。
 */
export async function ensureBrowser(options:LaunchOptions={}):Promise<{port:number;wsUrl:string;launched:boolean}>{
 const paths=webAgentPaths(options.root);
 await mkdir(paths.profile,{recursive:true,mode:0o700});
 const reuse=async()=>{
  const info=await readInfo(paths);
  if(!info)return null;
  const probe=await probeDebugPort(info.port);
  return probe?{port:info.port,wsUrl:probe.wsUrl,launched:false}:null;
 };
 const existing=await reuse();
 if(existing)return existing;
 const deadline=Date.now()+45_000;
 while(Date.now()<deadline){
  const release=await acquireLock(paths,Date.now()+500);
  if(!release){
   await sleep(400);
   const waited=await reuse();
   if(waited)return waited;
   continue;
  }
  try{
   const again=await reuse();
   if(again)return again;
   return await launch(paths,options,deadline);
  }finally{await release();}
 }
 throw new WebAgentError('web_browser_unavailable','等待专用浏览器启动超时');
}

async function launch(paths:WebAgentPaths,options:LaunchOptions,deadline:number){
 const chrome=resolveChrome(options);
 await rm(paths.activePortFile,{force:true});
 await rm(paths.infoFile,{force:true});
 const args=launchArgs(paths,options.headless,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-startup-window']);
 try{
  if(chrome.macApp)await spawnDetached(['open','-g','-j','-n','-a','Google Chrome','--args',...args]);
  else await spawnDetached([chrome.bin!,...args]);
 }catch{throw new WebAgentError('web_browser_unavailable','启动 Chrome 失败');}
 while(Date.now()<deadline){
  await sleep(300);
  let port=0;
  try{port=Number((await readFile(paths.activePortFile,'utf8')).split('\n')[0]);}catch{continue;}
  if(!Number.isInteger(port)||port<=0)continue;
  const probe=await probeDebugPort(port,1000);
  if(!probe)continue;
  await writeInfoAtomic(paths,{port,started_at:new Date().toISOString(),profile:paths.profile,chrome_path:options.chromePath,headless:options.headless});
  return {port,wsUrl:probe.wsUrl,launched:true};
 }
 throw new WebAgentError('web_browser_unavailable','Chrome 调试端口未就绪');
}

export async function webBrowserStatus(root?:string):Promise<{running:boolean;port?:number;profile:string}>{
 const paths=webAgentPaths(root);
 const info=await readInfo(paths);
 if(info&&await probeDebugPort(info.port,1000))return {running:true,port:info.port,profile:paths.profile};
 return {running:false,profile:paths.profile};
}

/** 通过本档案调试端口执行 `Browser.close`，等待端口关闭后移除 browser.json。 */
export async function webCloseBrowser(root?:string):Promise<void>{
 const paths=webAgentPaths(root);
 const info=await readInfo(paths);
 if(!info)return;
 const probe=await probeDebugPort(info.port,1000);
 if(probe){
  try{
   const client=await CdpClient.connect(probe.wsUrl,{timeout_ms:5000});
   try{await client.send('Browser.close',{},{timeout_ms:5000});}catch{/* Browser.close 常在响应前断开连接 */}
   client.close();
  }catch{/* 无法连接则按已关闭处理 */}
  for(let i=0;i<50&&await probeDebugPort(info.port,500);i++)await sleep(200);
 }
 await rm(paths.infoFile,{force:true});
}

/**
 * 启动不带远程调试端口的同档案 Chrome 前台窗口供人工登录；用户退出该 Chrome（macOS 需 Cmd+Q）后返回。
 * 专用浏览器正在运行时拒绝（同一档案不能同时被两个实例使用），请先 `webCloseBrowser()`。
 */
export async function webLogin(provider:WebProvider,root?:string,options:{chromePath?:string}={}):Promise<void>{
 const paths=webAgentPaths(root);
 if((await webBrowserStatus(root)).running)throw new WebAgentError('web_browser_unavailable','专用浏览器正在运行，请先关闭后再登录');
 await mkdir(paths.profile,{recursive:true,mode:0o700});
 await rm(paths.activePortFile,{force:true});
 const chrome=resolveChrome({chromePath:options.chromePath});
 const args=launchArgs(paths,false,[LOGIN_URLS[provider]]);
 const cmd=chrome.macApp?['open','-n','-W','-a','Google Chrome','--args',...args]:[chrome.bin!,...args];
 const proc=Bun.spawn(cmd,{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
 await proc.exited;
}

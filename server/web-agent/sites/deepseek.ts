/**
 * 职责：DeepSeek 网页（https://chat.deepseek.com/）的站点适配——全部为页面内 JS 表达式字符串。
 * 公开入口：`deepseekAdapter`；由 `session.ts` 通过 CDP 执行，同一表达式可用 `bsk evaluate` 复核。
 * 事实依据：2026-11-12 用 bsk 对已登录 Chrome 只读/低影响核验（详见 README「已核验事实」）；DeepSeek 使用哈希类名，故优先用 `ds-*` 稳定类、ARIA 与结构判定。
 * 注意：页面处于 hidden（后台）时 DeepSeek 虚拟列表不渲染消息，`session.ts` 在读取前会保证页面可见状态。
 */
import {DOM_MARKDOWN_FN} from './dom-markdown';
import {jsArg,type WebSiteAdapter} from './types';

const SEND_BUTTON="document.querySelector('[role=button].ds-button--primary.ds-button--circle')";
const TOGGLE=(kind:'thinking'|'search')=>kind==='thinking'?'/^(deepthink|深度思考)/i':'/^(search|联网搜索|智能搜索)/i';
const writeComposer=(arg:string)=>String.raw`((text)=>{
 var el=document.querySelector('textarea');if(!el)return -1;
 var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
 set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));
 return el.value.replace(/\s+/g,'').length;
})(${arg})`;

export const deepseekAdapter:WebSiteAdapter={
 provider:'deepseek',
 label:'DeepSeek',
 startUrl:'https://chat.deepseek.com/',
 conversationUrl:/^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[0-9a-f-]{36}/,
 max_files:50,                    // 站点提示：Upload docs or images (Max 50, 100MB each)
 max_file_bytes:100*1024*1024,
 supports:{thinking:true,search_toggle:true,model:false},
 upload:{mode:'input',selector:'input[type=file]'},
 pageState:String.raw`(()=>{
  var ta=document.querySelector('textarea');
  var p=location.pathname;
  return {url:location.href,composer:!!ta,
   login:/\/sign_in|\/login|\/sign_up/.test(p)||!!document.querySelector('input[type=password]'),
   challenge:!!document.querySelector('iframe[src*="captcha"],iframe[src*="turnstile"],iframe[src*="challenges.cloudflare.com"],.cf-turnstile,#cf-challenge-running,[id*="captcha"],[class*="captcha"]'),
   text:ta?'':(document.body?(document.body.innerText||document.body.textContent||''):'').slice(0,1500),visibility:document.visibilityState};
 })()`,
 notice:String.raw`(()=>{
  var s=[].slice.call(document.querySelectorAll('.ds-toast-container,.ds-toast,[role=alert],[role=dialog],.ds-modal'));
  return s.map(function(e){return (e.innerText||e.textContent||'').trim().slice(0,300);}).filter(Boolean).join(' | ').slice(0,900);
 })()`,
 options:String.raw`(()=>{
  var tg=[].slice.call(document.querySelectorAll('.ds-toggle-button'));
  function f(re){return tg.filter(function(b){return re.test((b.innerText||b.textContent||'').trim());})[0]||null;}
  var dt=f(${TOGGLE('thinking')}),se=f(${TOGGLE('search')});
  return {thinking:dt?dt.getAttribute('aria-pressed')==='true':null,search:se?se.getAttribute('aria-pressed')==='true':null};
 })()`,
 setOption:(kind,on)=>String.raw`((on)=>{
  var tg=[].slice.call(document.querySelectorAll('.ds-toggle-button'));
  var el=tg.filter(function(b){return ${TOGGLE(kind)}.test((b.innerText||b.textContent||'').trim());})[0];
  if(!el)return false;
  if((el.getAttribute('aria-pressed')==='true')!==on)el.click();
  return true;
 })(${jsArg(on)})`,
 composerFocus:String.raw`(()=>{var t=document.querySelector('textarea');if(!t)return false;t.focus();t.select();return true;})()`,
 composerLength:String.raw`(()=>{var t=document.querySelector('textarea');return t?t.value.replace(/\s+/g,'').length:-1;})()`,
 composerFallback:text=>writeComposer(jsArg(text)),
 composerFromExpr:expr=>writeComposer(expr),
 attachments:String.raw`(()=>{
  var ta=document.querySelector('textarea');if(!ta)return [];
  var root=ta;for(var i=0;i<12&&root&&!root.querySelector('input[type=file]');i++)root=root.parentElement;
  if(!root)return [];
  var READY=/^(?:[A-Za-z0-9+#._-]{1,10}\s+)?\d+(?:\.\d+)?\s?(?:B|KB|MB|GB)$/i,PROG=/^(uploading|parsing|reading|上传中|解析中|读取中)|(\.\.\.|…)$/i;
  var out=[];
  [].slice.call(root.querySelectorAll('div')).forEach(function(d){
   if(d.children.length!==2||d.contains(ta)||d.closest('.ds-toggle-button,[role=button]'))return;
   var meta=d.children[1];if(meta.children.length!==0)return;
   var st=(meta.innerText||meta.textContent||'').trim(),name=(d.children[0].innerText||d.children[0].textContent||'').trim();
   if(!st||!name)return;
   out.push({name:name,text:st,state:READY.test(st)?'ready':(PROG.test(st)?'uploading':'failed')});
  });
  return out;
 })()`,
 sendReady:String.raw`(()=>{var b=${SEND_BUTTON};return !!b&&!b.classList.contains('ds-button--disabled')&&b.getAttribute('aria-disabled')!=='true';})()`,
 send:String.raw`(()=>{var b=${SEND_BUTTON};if(!b||b.classList.contains('ds-button--disabled'))return false;b.click();return true;})()`,
 sendPoint:String.raw`(()=>{var b=${SEND_BUTTON};if(!b)return null;var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
 chatState:String.raw`(()=>{
  var items=[].slice.call(document.querySelectorAll('[data-virtual-list-item-key]'));
  function key(it){return it?(it.getAttribute('data-virtual-list-item-key')||''):'';}
  function isUser(it){return !!it.querySelector('.ds-collapsible-text')||key(it).charAt(0)==='-';}
  var users=items.filter(isUser),asst=items.filter(function(it){return !isUser(it)&&!!it.querySelector('.ds-message');});
  var last=asst[asst.length-1]||null;
  var main=last?[].slice.call(last.querySelectorAll('.ds-assistant-message-main-content')):[];
  var txt=main.map(function(e){return e.textContent||'';}).join('\n');
  var tb=last?[].slice.call(last.querySelectorAll('[role=button]')).filter(function(b){return !b.closest('.ds-message');}).length:0;
  var btn=${SEND_BUTTON},btnOn=!!btn&&!btn.classList.contains('ds-button--disabled');
  var ta=document.querySelector('textarea'),empty=!ta||ta.value.length===0;
  var lastItem=items[items.length-1],waiting=!!lastItem&&isUser(lastItem);
  var stop=btnOn&&empty;
  return {users:users.length,assistants:asst.length,last_user_key:key(users[users.length-1]),last_assistant_key:key(last),
   reply_len:txt.length,reply_sig:txt.length+':'+txt.slice(-48),
   generating:stop||waiting||(!!last&&tb<3),complete:tb>=3&&!stop,visibility:document.visibilityState};
 })()`,
 lastReply:String.raw`(()=>{
  ${DOM_MARKDOWN_FN}
  var items=[].slice.call(document.querySelectorAll('[data-virtual-list-item-key]')).filter(function(it){
   return !it.querySelector('.ds-collapsible-text')&&(it.getAttribute('data-virtual-list-item-key')||'').charAt(0)!=='-'&&!!it.querySelector('.ds-message');
  });
  var last=items[items.length-1];if(!last)return '';
  return [].slice.call(last.querySelectorAll('.ds-assistant-message-main-content')).map(__waMarkdown).filter(Boolean).join('\n\n');
 })()`,
 stop:String.raw`(()=>{
  var b=${SEND_BUTTON},ta=document.querySelector('textarea');
  if(!b||b.classList.contains('ds-button--disabled')||(ta&&ta.value.length>0))return false;
  b.click();return true;
 })()`,
};

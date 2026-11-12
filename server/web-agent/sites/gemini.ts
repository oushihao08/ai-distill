/**
 * 职责：Gemini 网页（https://gemini.google.com/app）的站点适配——全部为页面内 JS 表达式字符串。
 * 公开入口：`geminiAdapter`；由 `session.ts` 通过 CDP 执行，同一表达式可用 `bsk evaluate` 复核。
 * 事实依据：2026-11-12 用 bsk 对已登录 Chrome 只读/低影响核验（详见 README「已核验事实」）；界面为 Angular 组件，优先用自定义标签、`data-test-id` 与 ARIA 文案。
 * 注意：Gemini 没有联网搜索开关（搜索由模型自动决定），`thinking` 选项对 Gemini 无布尔开关，仅 `model_label` 通过模型选择器生效。
 * 文件上传由「Upload and tools」菜单触发文件选择器，需要可信点击 + `Page.fileChooserOpened`，不存在常驻 file input。
 */
import {DOM_MARKDOWN_FN} from './dom-markdown';
import {jsArg,type WebSiteAdapter} from './types';

const EDITOR="document.querySelector('rich-textarea .ql-editor,.ql-editor[contenteditable=true],[contenteditable=true][role=textbox]')";
const SEND_BUTTON="document.querySelector('button[aria-label=\"Send message\"]')";
const writeComposer=(arg:string)=>String.raw`((text)=>{
 var ed=${EDITOR};if(!ed)return -1;
 while(ed.firstChild)ed.removeChild(ed.firstChild);
 text.split('\n').forEach(function(line){var p=document.createElement('p');if(line)p.textContent=line;else p.appendChild(document.createElement('br'));ed.appendChild(p);});
 ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));
 return (ed.innerText||ed.textContent||'').replace(/\s+/g,'').length;
})(${arg})`;

export const geminiAdapter:WebSiteAdapter={
 provider:'gemini',
 label:'Gemini',
 startUrl:'https://gemini.google.com/app',
 conversationUrl:/^https:\/\/gemini\.google\.com\/(u\/\d+\/)?app\/[0-9a-f]{8,}/,
 max_files:10,                    // Google 官方说明：每条提示最多 10 个文件；未在本机实测
 max_file_bytes:100*1024*1024,    // 官方说明单文件 100MB（视频另计）；未实测
 supports:{thinking:false,search_toggle:false,model:true},
 upload:{
  mode:'chooser',
  prepare:String.raw`(()=>{
   if(document.querySelector('[data-test-id="local-images-files-uploader-button"]'))return true;
   var b=document.querySelector('button[aria-label="Upload and tools"]');
   if(!b)return false;b.click();return true;
  })()`,
  target:String.raw`(()=>{
   var b=document.querySelector('[data-test-id="local-images-files-uploader-button"]');
   if(!b)return null;b.scrollIntoView({block:'center'});
   var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
  })()`,
 },
 pageState:String.raw`(()=>{
  var ed=${EDITOR};
  var signedIn=!!document.querySelector('a[href*="accounts.google.com/SignOutOptions"]');
  var signIn=!!document.querySelector('a[href*="accounts.google.com/ServiceLogin"],a[href*="accounts.google.com/signin"],a[href*="/ServiceLogin"]');
  return {url:location.href,composer:!!ed,
   login:location.hostname==='accounts.google.com'||(!signedIn&&signIn),
   challenge:/\/sorry\//.test(location.pathname)||!!document.querySelector('iframe[src*="recaptcha"],form[action*="/sorry/"]'),
   text:ed?'':(document.body?(document.body.innerText||document.body.textContent||''):'').slice(0,1500),visibility:document.visibilityState};
 })()`,
 notice:String.raw`(()=>{
  var s=[].slice.call(document.querySelectorAll('snack-bar-container,.mat-mdc-snack-bar-label,[role=alert],[role=alertdialog],mat-dialog-container,.error-message,error-message'));
  return s.map(function(e){return (e.innerText||e.textContent||'').trim().slice(0,300);}).filter(Boolean).join(' | ').slice(0,900);
 })()`,
 options:String.raw`(()=>({thinking:null,search:null}))()`,
 setOption:()=>String.raw`(()=>false)()`,
 modelOpen:String.raw`(()=>{var b=document.querySelector('button[data-test-id="bard-mode-menu-button"]');if(!b)return false;if(b.getAttribute('aria-expanded')!=='true')b.click();return true;})()`,
 modelChoose:label=>String.raw`((want)=>{
  var items=[].slice.call(document.querySelectorAll('gem-menu-item[role=menuitemradio][data-test-id^="bard-mode-option"]'));
  var labels=items.map(function(i){return (i.innerText||i.textContent||'').trim().replace(/\s*\n\s*/g,' / ');});
  var hit=items.filter(function(i){return (i.innerText||i.textContent||'').toLowerCase().indexOf(want.toLowerCase())>=0;})[0];
  if(!hit)return {ok:false,labels:labels,checked:null};
  if(hit.getAttribute('aria-checked')!=='true')hit.click();
  return {ok:true,labels:labels,checked:(hit.innerText||hit.textContent||'').trim()};
 })(${jsArg(label)})`,
 modelClose:String.raw`(()=>{var b=document.querySelector('button[data-test-id="bard-mode-menu-button"]');if(b&&b.getAttribute('aria-expanded')==='true')b.click();return true;})()`,
 composerFocus:String.raw`(()=>{
  var ed=${EDITOR};if(!ed)return false;
  ed.focus();var r=document.createRange();r.selectNodeContents(ed);var s=getSelection();s.removeAllRanges();s.addRange(r);return true;
 })()`,
 composerLength:String.raw`(()=>{var ed=${EDITOR};return ed?(ed.innerText||ed.textContent||'').replace(/\s+/g,'').length:-1;})()`,
 composerFallback:text=>writeComposer(jsArg(text)),
 composerFromExpr:expr=>writeComposer(expr),
 attachments:String.raw`(()=>[].slice.call(document.querySelectorAll('uploader-file-preview')).map(function(p){
  var close=p.querySelector('button[aria-label^="close "]');
  var name=close?(close.getAttribute('aria-label')||'').replace(/^close\s+/,''):(p.innerText||p.textContent||'').trim().split('\n').pop();
  var g=p.querySelector('gem-attachment');
  var failed=!!g&&/gem-attachment-loading-error/.test(g.className);
  var loading=!!p.querySelector('.gem-attachment-content.loading,[class*="gem-attachment-loading"]:not([class*="error"])')||(!failed&&!name);
  return {name:name||'',state:failed?'failed':(loading?'uploading':'ready'),text:(p.innerText||p.textContent||'').trim().replace(/\n/g,'/').slice(0,80)};
 }))()`,
 sendReady:String.raw`(()=>{var b=${SEND_BUTTON};return !!b&&b.getAttribute('aria-disabled')!=='true'&&!b.disabled;})()`,
 send:String.raw`(()=>{var b=${SEND_BUTTON};if(!b||b.getAttribute('aria-disabled')==='true'||b.disabled)return false;b.click();return true;})()`,
 sendPoint:String.raw`(()=>{var b=${SEND_BUTTON};if(!b)return null;var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
 chatState:String.raw`(()=>{
  var cs=[].slice.call(document.querySelectorAll('.conversation-container'));
  var mr=[].slice.call(document.querySelectorAll('model-response')),uq=[].slice.call(document.querySelectorAll('user-query'));
  var last=mr[mr.length-1]||null,lastCont=cs[cs.length-1]||null;
  var txt=last?[].slice.call(last.querySelectorAll('message-content')).map(function(e){return e.textContent||'';}).join('\n'):'';
  var stop=!!document.querySelector('button[aria-label="Stop response"]');
  var done=!!last&&!!last.querySelector('.response-footer.complete');
  return {users:uq.length,assistants:mr.length,last_user_key:cs.length?(cs[cs.length-1].id||''):'',last_assistant_key:lastCont?(lastCont.id||''):'',
   reply_len:txt.length,reply_sig:txt.length+':'+txt.slice(-48),
   generating:stop||(!!last&&!done),complete:done&&!stop,visibility:document.visibilityState};
 })()`,
 lastReply:String.raw`(()=>{
  ${DOM_MARKDOWN_FN}
  var mr=[].slice.call(document.querySelectorAll('model-response')),last=mr[mr.length-1];
  if(!last)return '';
  return [].slice.call(last.querySelectorAll('message-content')).map(__waMarkdown).filter(Boolean).join('\n\n');
 })()`,
 stop:String.raw`(()=>{var b=document.querySelector('button[aria-label="Stop response"]');if(!b)return false;b.click();return true;})()`,
};

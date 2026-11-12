/**
 * 职责：web agent 的公共契约：站点标识、会话/传输接口、安全错误及 reason_code。
 * 公开入口：类型与 `WebAgentError`；由 `index.ts` 再导出，供 worker 执行器、站点适配及测试使用。
 * 错误信息只含固定说明，不携带提示词、回复正文、文件内容或登录凭证。
 */
export type WebProvider='deepseek'|'gemini';
/** `fake` 仅用于自动化测试，指向调用方注入的本地假聊天页。 */
export type WebProviderId=WebProvider|'fake';
export interface WebChatFile{name:string;content:Uint8Array|string}
export interface WebChatTurn{prompt:string;files?:WebChatFile[]}
export interface WebChatReply{text:string;conversation_url:string;elapsed_ms:number}
export interface WebChatSession{
 ask(turn:WebChatTurn,opts:{timeout_ms:number;signal?:AbortSignal}):Promise<WebChatReply>;
 url():string;
 close():Promise<void>;
}
export interface WebChatOpenOptions{signal?:AbortSignal;thinking?:boolean;model_label?:string}
export interface WebChatTransport{open(provider:WebProviderId,opts?:WebChatOpenOptions):Promise<WebChatSession>}
export type WebAgentBackend='auto'|'bsk'|'cdp';
export interface WebChatTransportOptions{
 /** 存储根（默认 `storageDirectory()`）；档案与 browser.json 位于 `<root>/web-agent/`。 */
 root?:string;
 chromePath?:string;
 /** 直接启动 Chrome 二进制并使用 headless；默认 macOS 用 `open -g -n -a` 后台启动有界面窗口。 */
 headless?:boolean;
 /** `fake` 站点的页面地址（由测试的 Bun.serve 提供）。 */
 fake_url?:string;
 /** 浏览器后端：默认 `auto`（优先已连接的 BrowserSkill 实例，否则退回独立 CDP 档案）。 */
 backend?:WebAgentBackend;
 bskBin?:string;
 bskBrowser?:string;
}

export const WEB_AGENT_REASON_CODES=[
 'web_login_required','web_challenge_required','web_rate_limited','web_busy','web_timeout',
 'web_ui_changed','web_browser_unavailable','web_reply_incomplete','web_upload_rejected','web_cancelled',
] as const;
export type WebAgentReasonCode=typeof WEB_AGENT_REASON_CODES[number];

const REASON_TEXT:Record<WebAgentReasonCode,string>={
 web_login_required:'网页聊天需要登录，请先在专用档案中登录',
 web_challenge_required:'网页出现验证码或风控验证，需要人工处理',
 web_rate_limited:'网页提示达到使用限额或请求过于频繁',
 web_busy:'网页提示服务繁忙',
 web_timeout:'网页聊天等待超时',
 web_ui_changed:'网页结构与适配不一致',
 web_browser_unavailable:'专用浏览器不可用',
 web_reply_incomplete:'网页回复未完整结束',
 web_upload_rejected:'网页拒绝或无法接收上传文件',
 web_cancelled:'网页聊天已取消',
};

export class WebAgentError extends Error{
 readonly reason_code:WebAgentReasonCode;
 constructor(reason_code:WebAgentReasonCode,detail?:string){
  super(detail?`${REASON_TEXT[reason_code]}：${detail}`:REASON_TEXT[reason_code]);
  this.name='WebAgentError';
  this.reason_code=reason_code;
 }
}
export function isWebAgentError(error:unknown):error is WebAgentError{return error instanceof WebAgentError;}

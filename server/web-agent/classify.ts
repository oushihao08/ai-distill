/**
 * 职责：把页面状态/提示文本分类为登录、验证码、限额、服务繁忙等 web agent 原因；纯函数，不访问浏览器。
 * 公开入口：`classifyNotice(text)`、`classifyPage(snapshot)`、`providerHealth(kind)`；供 `session.ts` 运行期判定与 `webDoctor` 使用。
 * 文案模式来自两站点常见提示（中英文），其中限额/繁忙/验证码文案属于推断，真实触发的页面形态未经实测，见 README 的「未验证项」。
 * 本模块只判定、不尝试绕过：命中后由调用方抛 `WebAgentError` 并停止本次会话。
 */
import type {WebAgentReasonCode} from './types';

export const NOTICE_CHALLENGE=/(captcha|recaptcha|turnstile|verify (that )?you('| a)?re (a )?human|are you (a )?robot|unusual traffic|checking your browser|just a moment|人机验证|安全验证|请完成验证|验证您是真人|异常流量|滑动验证|行为验证)/i;
export const NOTICE_RATE_LIMITED=/(too many requests|rate[ -]?limit|usage limit|reached (your|the|today'?s)[^.\n]{0,30}limit|limit (has been )?reached|exceeded[^.\n]{0,30}(quota|limit)|quota|请求过于频繁|发送消息过于频繁|消息发送过于频繁|操作过于频繁|已达到[^。\n]{0,20}(上限|限额|限制)|(使用|对话)次数[^。\n]{0,10}(用完|上限)|额度[^。\n]{0,10}(用完|不足|已用)|明天再来|come back (tomorrow|later))/i;
export const NOTICE_BUSY=/(server (is )?busy|servers? (are )?busy|service (is )?(busy|unavailable|temporarily)|system (is )?busy|try again later|try again in a (few|moment)|something went wrong|temporarily unavailable|服务器繁忙|服务繁忙|系统繁忙|服务暂时不可用|请稍后再试|稍后重试|出了点问题|出错了)/i;
const CHALLENGE=NOTICE_CHALLENGE,RATE_LIMITED=NOTICE_RATE_LIMITED,BUSY=NOTICE_BUSY;

/** 运行期提示（toast/弹窗/短回复）分类；命中顺序：验证码 → 限额 → 繁忙。 */
export function classifyNotice(text:string):Exclude<WebAgentReasonCode,'web_timeout'|'web_ui_changed'|'web_browser_unavailable'|'web_reply_incomplete'|'web_upload_rejected'|'web_cancelled'|'web_login_required'>|null{
 const value=text.trim();
 if(!value)return null;
 if(CHALLENGE.test(value))return 'web_challenge_required';
 if(RATE_LIMITED.test(value))return 'web_rate_limited';
 if(BUSY.test(value))return 'web_busy';
 return null;
}

export interface PageSnapshot{
 url:string;
 /** 站点表达式判定：存在聊天输入框。 */
 composer:boolean;
 /** 站点表达式判定：明确的登录入口/登录页特征（如密码框、登录路径、登录跳转）。 */
 login:boolean;
 /** 站点表达式判定：明确的验证码/风控挑战元素。 */
 challenge?:boolean;
 /** 页面正文片段，仅在没有输入框时用于兜底分类。 */
 text?:string;
}
export type PageKind='ready'|'login'|'challenge'|'loading';

/** 页面分类：有输入框且无登录特征为 ready；挑战优先于登录；无输入框时才用正文兜底。 */
export function classifyPage(snapshot:PageSnapshot):PageKind{
 if(snapshot.challenge)return 'challenge';
 if(/google\.com\/sorry\//.test(snapshot.url))return 'challenge';
 if(snapshot.login)return 'login';
 if(snapshot.composer)return 'ready';
 const text=snapshot.text??'';
 if(text&&CHALLENGE.test(text))return 'challenge';
 if(/accounts\.google\.com|\/sign_in|\/login/.test(snapshot.url))return 'login';
 return 'loading';
}

export function providerHealth(kind:PageKind|'error'):'logged_in'|'login_required'|'challenge'|'unknown'{
 if(kind==='ready')return 'logged_in';
 if(kind==='login')return 'login_required';
 if(kind==='challenge')return 'challenge';
 return 'unknown';
}

/** 仅用于短回复：站点把服务端错误当作助手消息显示时的判定（如“服务器繁忙，请稍后再试”）。 */
export function classifyShortReply(text:string):ReturnType<typeof classifyNotice>{
 const value=text.trim();
 if(!value||value.length>160||/[\n`]/.test(value))return null;
 return classifyNotice(value);
}

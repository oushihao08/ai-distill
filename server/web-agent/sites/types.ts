/**
 * 职责：站点适配器契约——每个站点把选择器与 DOM 判定写成「页面内 JS 表达式字符串」，由 `session.ts` 经 CDP `Runtime.evaluate` 执行，也可原样用 `bsk evaluate` 复核。
 * 公开入口：`WebSiteAdapter` 接口与 `jsArg()`（把参数安全嵌入表达式）；实现位于 `deepseek.ts`、`gemini.ts`、`fake.ts`。
 * 约束：表达式必须是自包含 IIFE，返回可 JSON 序列化的值；只读 DOM 或执行站点内正常的 UI 点击，不读 cookie/存储，不触碰验证码/登录控件。
 */
import type {WebProviderId} from '../types';

export interface AttachmentInfo{name:string;state:'uploading'|'ready'|'failed';text?:string}
export interface ChatStateInfo{
 /** 用户/助手消息数与最后条目键：虚拟列表可能卸载旧条目，故同时比较键。 */
 users:number;assistants:number;last_user_key:string;last_assistant_key:string;
 reply_len:number;reply_sig:string;
 /** 站点是否仍在生成（停止按钮、等待助手等多信号之一）。 */
 generating:boolean;
 /** 站点明确的“本条回复已完成”信号（DeepSeek 操作栏、Gemini footer.complete）。 */
 complete:boolean;
 visibility?:string;
}
export interface PageStateInfo{url:string;composer:boolean;login:boolean;challenge?:boolean;text?:string;visibility?:string}
export interface OptionStateInfo{thinking:boolean|null;search:boolean|null}

export type UploadMode=
 /** 页面常驻 `input[type=file]`：直接 `DOM.setFileInputFiles`。 */
 |{mode:'input';selector:string}
 /** 文件选择器由菜单项触发：拦截 `Page.fileChooserOpened` 后设置文件；`prepare` 打开菜单，`target` 返回待点击元素中心坐标。 */
 |{mode:'chooser';prepare:string;target:string};

export interface WebSiteAdapter{
 provider:WebProviderId;
 label:string;
 startUrl:string;
 /** 对话 URL 形态；首次发送后 `location.href` 应匹配。 */
 conversationUrl:RegExp;
 max_files:number;
 max_file_bytes:number;
 /** 站点支持的选项：不支持的选项被忽略（见 README），不会静默改变站点默认。 */
 supports:{thinking:boolean;search_toggle:boolean;model:boolean};
 upload:UploadMode;
 pageState:string;       // → PageStateInfo
 notice:string;          // → string：toast/弹窗/横幅文本（不含助手回复）
 options:string;         // → OptionStateInfo
 setOption:(kind:'thinking'|'search',on:boolean)=>string; // → boolean（是否找到并处理）
 /** 模型选择（可选）：打开选择器、选择匹配 label 的项、关闭；`modelChoose` → {ok,labels,checked}。 */
 modelOpen?:string;
 modelChoose?:(label:string)=>string;
 modelClose?:string;
 composerFocus:string;   // → boolean：聚焦并全选输入框内容（后续 insertText 会替换选区）
 composerLength:string;  // → number：输入框非空白字符数，-1 表示不存在
 composerFallback:(text:string)=>string; // → number：JS 写入输入框并触发 input，返回非空白字符数
 composerFromExpr?:(expr:string)=>string; // → number：从页面内表达式读取文本并写入输入框（大提示词分块暂存后使用）
 attachments:string;     // → AttachmentInfo[]
 sendReady:string;       // → boolean
 send:string;            // → boolean：点击发送
 chatState:string;       // → ChatStateInfo
 lastReply:string;       // → string：最后一条助手回复（markdown 纯文本）
 stop:string;            // → boolean：点击停止生成
 /** 返回元素中心 `{x,y}` 以便 CDP 触发可信点击；缺省时不使用。 */
 sendPoint?:string;
}

/** 把 JS 值安全嵌入表达式（JSON 序列化，转义行分隔符）。 */
export function jsArg(value:unknown):string{
 return JSON.stringify(value).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}

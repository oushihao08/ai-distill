/**
 * 职责：网页执行器单元测试的脚本化传输替身：按顺序返回预设回复，并记录每次打开、提问和关闭。
 * 使用场景：chat-loop.test.ts、redaction.test.ts、preparation.test.ts、authoring.test.ts；不用于生产。
 * 边界：不启动浏览器、不访问网络，因此不证明真实站点可用。
 */
import type {WebChatReply,WebChatSession,WebChatTransport,WebChatTurn} from '../web-agent';
import type {WebProvider} from '../web-agent';

export type ScriptedReply=string|((turn:WebChatTurn,index:number)=>string|Promise<string>);
export interface FakeTransport{transport:WebChatTransport;opened:{provider:WebProvider;options:unknown}[];turns:WebChatTurn[];closed:()=>number}

export function fakeTransport(replies:ScriptedReply[]):FakeTransport{
  const opened:FakeTransport['opened']=[],turns:WebChatTurn[]=[];let closed=0,next=0;
  const transport:WebChatTransport={
    async open(provider,options){
      opened.push({provider,options});
      const session:WebChatSession={
        async ask(turn){
          turns.push(turn);
          const index=next++,script=replies[index];
          if(script===undefined)throw new Error('脚本化传输没有更多回复');
          const text=typeof script==='function'?await script(turn,index):script;
          const reply:WebChatReply={text,conversation_url:'https://example.test/chat/fake',elapsed_ms:1};
          return reply;
        },
        url:()=>'https://example.test/chat/fake',
        async close(){closed++;},
      };
      return session;
    },
  };
  return{transport,opened,turns,closed:()=>closed};
}
export const fenced=(value:unknown)=>`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

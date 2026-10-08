import type {Pool} from 'pg';
const processes=new Map<number,'codex'|'materials'>();
let database:Pool|undefined;
export function configureRuntimeMonitor(pool:Pool){database=pool;}
export function registerProcess(pid:number,kind:'codex'|'materials'){
 processes.set(pid,kind);return ()=>{processes.delete(pid);};
}
export function registeredProcesses(){return [...processes.keys()];}
export function classifyExecutorFailure(text:string):'authentication'|'quota'|null{
 if(/(?:insufficient[_ ]quota|quota[_ ]exceeded|usage limit|credit balance|insufficient credits|额度|余额不足)/i.test(text))return 'quota';
 if(/(?:unauthorized|invalid[_ ]api[_ ]key|authentication|not logged in|需要有效的ChatGPT套餐登录)/i.test(text))return 'authentication';
 return null;
}
export async function blockExecutor(executor:string,reason:'authentication'|'quota'){
 if(!database)return;
 try{await database.query('INSERT INTO ai_distill.executor_blocks(executor,reason) VALUES($1,$2) ON CONFLICT(executor) DO UPDATE SET reason=$2,updated_at=now()',[executor,reason]);}
 catch{console.error('执行器阻断状态保存失败，请核对数据库后暂停任务');}
}

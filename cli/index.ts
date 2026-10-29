/** Bun CLI 入口：解析调用结果、输出稳定 JSON 信封及退出码；由 bun run ai-distill 或直接运行本文件调用。 */
import {CliError} from './client';
import {runCommand} from './commands';
import {runRemoteMaterialCommand} from './remote-materials';
import {runRemoteAnswerCommand} from './remote-answers';

if(import.meta.main) {
  const controller=new AbortController();
  const interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try {
    const args=process.argv.slice(2);
    const result=args[0]==='remote'&&args[1]==='answer'?await runRemoteAnswerCommand(args,controller.signal):args[0]==='remote'?await runRemoteMaterialCommand(args,controller.signal):await runCommand(args,undefined,controller.signal);
    const cliResult=result as {help?:string;data?:unknown;outcome?:string};
    if(cliResult.help&&!process.argv.includes('--json'))process.stdout.write(cliResult.help);
    else {
      const apiPassthrough=args[0]==='library'&&args[1]==='job'&&args[2]==='start';
      const output=apiPassthrough?cliResult.data:result;
      process.stdout.write(`${JSON.stringify(output,null,2)}\n`);
    }
    process.exitCode=controller.signal.aborted?130:cliResult.outcome==='partial'?2:cliResult.outcome==='waiting'?3:0;
  } catch(error) {
    const detail=error instanceof CliError?{message:error.message,...error.detail}:{kind:'internal_error',message:'命令执行失败'};
    process.stderr.write(`${JSON.stringify({outcome:'error',error:detail})}\n`);
    process.exitCode=controller.signal.aborted?130:1;
  } finally {
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  }
}

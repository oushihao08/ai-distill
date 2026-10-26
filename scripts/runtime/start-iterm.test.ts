/** 验证过期服务拒绝替换的Shell分支；仅执行提取分支，使用假PID，不运行启动脚本、不发送信号。 */
import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
test('stale service exits before any stop or launch command',async()=>{
 const text=await readFile(new URL('./start-iterm.sh',import.meta.url),'utf8');
 const block=text.slice(text.indexOf('if (( ${#STALE_SERVICE_PIDS[@]} > 0 )); then'),text.indexOf('\nfi',text.indexOf('if (( ${#STALE_SERVICE_PIDS[@]} > 0 )); then'))+3);
 expect(block).not.toContain('kill');expect(block).not.toContain('curl');
 const process=Bun.spawn(['bash','-c',`STALE_SERVICE_PIDS=(12345)\n${block}\nprintf unsafe-reached`],{stdout:'pipe',stderr:'pipe'});
 const stdout=await new Response(process.stdout).text(),stderr=await new Response(process.stderr).text();
 expect(await process.exited).toBe(1);expect(stdout).toBe('');expect(stderr).toContain('不自动停止或重启');
});

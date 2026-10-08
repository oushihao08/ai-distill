import {test,expect} from 'bun:test';
import {registerProcess,registeredProcesses,classifyExecutorFailure} from './runtime';
test('process lifecycle removes exited PID and categorizes only evidenced blocks',()=>{
 const unregister=registerProcess(98765,'codex');expect(registeredProcesses()).toContain(98765);unregister();expect(registeredProcesses()).not.toContain(98765);
 expect(classifyExecutorFailure('insufficient_quota')).toBe('quota');
 expect(classifyExecutorFailure('Unauthorized')).toBe('authentication');
 expect(classifyExecutorFailure('request timeout')).toBeNull();
});

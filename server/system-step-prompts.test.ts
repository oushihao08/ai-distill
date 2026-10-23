/** 验证出题专用默认的读取、输入校验和单次原子保存；不连接业务数据库或调用模型。 */
import {test,expect} from 'bun:test';
import {DEFAULT_AUTHORING_SETTINGS,readSystemAuthoringDefaults,validateAuthoringDefaults,saveSystemStepPrompts} from './system-step-prompts';
import {SYSTEM_STEP_PROMPTS} from '../shared/step-prompts';
test('出题默认独立于全局Agent并校验显式覆盖',async()=>{
 expect(await readSystemAuthoringDefaults({query:async()=>({rows:[]})} as any)).toEqual(DEFAULT_AUTHORING_SETTINGS);
 expect(await readSystemAuthoringDefaults({query:async()=>({rows:[{authoring_defaults:{model:'custom-model',reasoning_effort:'high'}}]})} as any)).toEqual({model:'custom-model',reasoning_effort:'high'});
 for(const bad of [null,[],{model:'x',reasoning_effort:'bad effort'},{model:'x',reasoning_effort:'low',api_key:'secret'}])expect(()=>validateAuthoringDefaults(bad)).toThrow();
});
test('提示词和出题默认原子保存；旧客户端不覆盖出题默认',async()=>{
 const calls:Array<{sql:string;params:any[]}>=[];const db={query:async(sql:string,params:any[])=>{calls.push({sql,params});return{rows:[]};}} as any;
 await saveSystemStepPrompts(db,SYSTEM_STEP_PROMPTS,DEFAULT_AUTHORING_SETTINGS);
 expect(calls).toHaveLength(1);expect(calls[0]!.sql).toContain('authoring_defaults=EXCLUDED.authoring_defaults');expect(JSON.parse(calls[0]!.params[1])).toEqual(DEFAULT_AUTHORING_SETTINGS);
 calls.length=0;await saveSystemStepPrompts(db,SYSTEM_STEP_PROMPTS);expect(calls[0]!.sql).not.toContain('authoring_defaults');
});

import {test,expect} from 'bun:test';
import {readRevisionSettings} from './revision-binding';
test('revision settings reject changed rules, including selection after a chain starts without rules',async()=>{
 for(const [frozen,current] of [['rule-a','rule-b'],[null,'rule-a']]){
  const db={query:async()=>({rows:[{config_snapshot:{rule_version_id:frozen,configs:{}},current_rule_version_id:current}]})} as any;
  await expect(readRevisionSettings(db,'workflow',1,'round')).rejects.toThrow('规则版本已变化');
 }
});
test('unchanged frozen rules and legacy snapshots remain readable',async()=>{
 for(const snapshot of [{rule_version_id:'rule-a',configs:{}},{configs:{}}]){
  const db={query:async()=>({rows:[{config_snapshot:snapshot,current_rule_version_id:'rule-a'}]})} as any;
  expect(await readRevisionSettings(db,'workflow',1,'round')).toEqual(snapshot);
 }
});

/** 验证各材料后端和工作流类型适用的稳定步骤集合，不重编号持久化 ordinal。 */
import {expect,test} from 'bun:test';
import {getWorkflowStepDefinitions} from './step-registry';

test('legacy question retains the current visible step identities',()=>{
  expect(getWorkflowStepDefinitions('legacy').map(step=>step.ordinal)).toEqual([1,9,4,5,6,7,8]);
});

test('library_v1 questions expose only authoring through publishing',()=>{
  expect(getWorkflowStepDefinitions('library_v1').map(step=>step.ordinal)).toEqual([4,5,6,7,8]);
});

test('legacy material packages retain intake and redaction steps',()=>{
  expect(getWorkflowStepDefinitions('legacy','material_package').map(step=>step.ordinal)).toEqual([1,9]);
});

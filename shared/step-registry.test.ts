/** 验证各材料后端和工作流类型适用的稳定步骤集合，不重编号持久化 ordinal。 */
import {expect,test} from 'bun:test';
import {getWorkflowStepDefinitions,SEALED_STEP_ORDINALS,isStepSealed,isEvaluationPipelineSealed} from './step-registry';

test('legacy question exposes active steps with evaluation stages sealed',()=>{
  expect(getWorkflowStepDefinitions('legacy').map(step=>step.ordinal)).toEqual([1,9,4,8]);
});

test('library_v1 questions expose authoring directly to publishing while evaluation is sealed',()=>{
  expect(getWorkflowStepDefinitions('library_v1').map(step=>step.ordinal)).toEqual([4,8]);
  expect(SEALED_STEP_ORDINALS).toEqual([5,6,7]);
  expect(isEvaluationPipelineSealed()).toBe(true);
  for(const ordinal of [5,6,7])expect(isStepSealed(ordinal)).toBe(true);
  expect(isStepSealed(4)).toBe(false);expect(isStepSealed(8)).toBe(false);
});

test('legacy material packages retain intake and redaction steps',()=>{
  expect(getWorkflowStepDefinitions('legacy','material_package').map(step=>step.ordinal)).toEqual([1,9]);
});

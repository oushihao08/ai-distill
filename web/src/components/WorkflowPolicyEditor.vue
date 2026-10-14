<!-- 职责：编辑单一步骤的流程 JSON，结构校验后通知父表单；不修改模型配置或解释业务评分规则。props 为初始配置与步骤，change/invalid 供 StepSettings 保存与禁用提交。 -->
<script setup lang="ts">
import {validateWorkflowConfig,type WorkflowConfig} from '@shared/workflow-config';
const props=defineProps<{initial?:WorkflowConfig;ordinal:number;disabled?:boolean}>();
const emit=defineEmits<{change:[value:WorkflowConfig|undefined];invalid:[value:boolean]}>();
const enabled=shallowRef(!!props.initial);
const source=shallowRef(JSON.stringify(props.initial??{contract:'legacy',rules_text:'',reference_answer:'none',hooks:{before:[],after:[]}},null,2));
const error=shallowRef('');
function validate(){
 try{
  error.value='';
  if(!enabled.value){emit('change',undefined);emit('invalid',false);return;}
  const config=validateWorkflowConfig(JSON.parse(source.value));
  if(props.ordinal!==6&&(config?.contract!=='legacy'||config.rules_text||config.reference_answer!=='none'))throw new Error('计分规则及参考答案政策请在独立评分步骤统一设置；本步只设置钩子');
  emit('change',config);emit('invalid',false);
 }catch(cause){error.value=cause instanceof Error?cause.message:'流程配置格式无效';emit('invalid',true);}
}
watch([enabled,source],validate,{immediate:true});
</script>
<template><Column :gap="8">
 <v-switch v-model="enabled" label="启用项目流程扩展" :disabled="disabled" hide-details />
 <p class="text-xs text-muted">未启用时沿用原流程。before/after 留空即空钩子；脚本相对项目 skill 的上级目录，默认同步。配置只影响新派发任务。</p>
 <p v-if="ordinal===6" class="text-xs text-muted">contract 可选 legacy 或 model_report_v1；rules_text 写完整加分、扣分、否决及指标规则，专业判断由评分模型完成。reference_answer 默认 none；calibration 会向评分模型提供同版标答作校准。</p>
 <details v-if="enabled"><summary class="text-sm cursor-pointer">钩子配置示例</summary><pre class="text-xs whitespace-pre-wrap">{{ JSON.stringify({id:'collect',script:'hooks/collect.ts',files:['hooks/collect.ts'],mode:'sync',params:{},timeout_ms:60000,idempotent:true},null,2) }}</pre></details>
 <v-textarea v-if="enabled" v-model="source" label="流程配置 JSON" rows="12" :disabled="disabled" :error-messages="error" />
</Column></template>

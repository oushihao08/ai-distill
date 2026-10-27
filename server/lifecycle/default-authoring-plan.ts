/** 默认出题计划的纯工厂；steps默认策略与项目覆盖共用，不调用模型或修改传入配置。 */
import type {AuthoringOptions} from '../authoring/executor';
import type {AuthoringPlan} from './step-types';

export function defaultAuthoringPlan(options:AuthoringOptions,base:Record<string,any>):AuthoringPlan {
 return {
  schema:base,
  validation_options:{requireHarborMetadata:false,contentContract:options.content_contract},
  delivery_fields:{},
  scoring_instruction:'依规则生成每条criterion和完整rule，保留加分、扣分和独立否决的实际含义。metadata保存必要业务信息；不得把扣分或否决改造成正向满分。',
  contract_prefix:'',
  runner_instruction:'answer_requirements 只记录当前被测作答器的事实能力，固定为 text/text/tools=[]；不要把作者工具填进此字段。',
  task_instruction:'题目须依据给定附件和题面可用信息作答，不要求被测模型调用外部工具、检索互联网或生成文件。',
  prompt_suffix:'',
 };
}

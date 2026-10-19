/**
 * 文件职责：提供系统级步骤提示词默认正文；新建项目复制这些默认值，项目级步骤设置可独立覆盖。
 * 作答模型接收冻结的作答步骤提示词、题面及允许附件；不读取出题 Skill、rubric 或标答。
 */
import {DEFAULT_REDACTION_PROMPT} from './step-registry';
export const DEFAULT_STEP_PROMPTS:Record<4|6,string>={
 4:'查看指定 skill，依据本次附件出题。',
 6:'依据本题题面、rubric 和附件，对匿名完整答案逐项评分。附件用于核对题目事实及 rubric 的依据；是否得分只看待评答案实际写出的内容，不能用附件中存在但答案未写出的事实代替答案证据。以 rubric 的既定条件和满分为判分依据，不改变评分条件，不预设得分高低。不得使用作答思路或标准答案。每项列出考点、得分/满分、判断理由，以及待评答案原文证据；证据须逐字引用，未找到时明确写“未找到”。判断理由说明证据如何满足或未满足该考点的既定条件。最后说明仍有争议的考点，并在末尾单独一行按“最终总分：X / Y 分”列出本次实际逐项评分合计；假设、建议或补充修改后的分数不得作为最终总分。',
};

/** 四类系统提示词；项目创建时复制到对应项目步骤配置，后续系统修改不回写已有项目。 */
export const SYSTEM_STEP_PROMPTS:Record<4|5|6|9,string>={
 4:'编写本题完整题目包，交付前自检并修订发现的问题。完整阅读指定 skill，再阅读本次附件。被测作答模型仅支持 text 输入、text 输出且不执行任何工具；题目必须适配这一能力。answer_requirements 必须固定为 {"input_mode":"text","output_mode":"text","tools":[]}。出题作者可使用自己的阅读、检索和计算工具，但不得把作者工具写成被测模型所需工具。',
 5:'仅依据用户消息中的题面和附件独立作答。最终答案直接写在回复正文中，只返回纯文本；不得生成、上传或附加 DOCX、PDF 等文件，也不得声称已生成文件。',
 6:DEFAULT_STEP_PROMPTS[6],
 9:DEFAULT_REDACTION_PROMPT,
};

const LEGACY_DEFAULT_SCORE_PROMPT='依据本题题面、rubric、作答思路和标准答案，对匿名完整答案逐项评分，并引用答案原文证据。';
const PREVIOUS_DEFAULT_SCORE_PROMPT='依据本题题面、rubric、作答思路和标准答案，对匿名完整答案逐项评分。每项列出考点、得分/满分、判断理由，以及答案原文证据；证据须逐字引用，未找到时明确写“未找到”。判断理由说明证据如何满足或未满足该考点，不增加 rubric 以外的扣分标准。最后说明仍有争议的考点，并在末尾单独一行按“最终总分：X / Y 分”列出本次实际逐项评分合计；假设、建议或补充修改后的分数不得作为最终总分。';
const REFERENCE_AWARE_DEFAULT_SCORE_PROMPT='依据本题题面、rubric、附件、作答思路和标准答案，对匿名完整答案逐项评分。以 rubric 的既定条件和满分为判分依据，不改变评分条件，不预设得分高低。作答思路和标准答案用于核对，不作为待评答案的证据。每项列出考点、得分/满分、判断理由，以及答案原文证据；证据须逐字引用，未找到时明确写“未找到”。判断理由说明证据如何满足或未满足该考点的既定条件。最后说明仍有争议的考点，并在末尾单独一行按“最终总分：X / Y 分”列出本次实际逐项评分合计；假设、建议或补充修改后的分数不得作为最终总分。';

/** 仅将旧版内置默认正文映射到新版默认；自定义评分提示词仍原样使用。 */
export function resolveScoreStepPrompt(prompt?:string){
 return !prompt||prompt===LEGACY_DEFAULT_SCORE_PROMPT||prompt===PREVIOUS_DEFAULT_SCORE_PROMPT||prompt===REFERENCE_AWARE_DEFAULT_SCORE_PROMPT?DEFAULT_STEP_PROMPTS[6]:prompt;
}

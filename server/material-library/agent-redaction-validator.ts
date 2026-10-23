/** 职责：打包到Agent私有工作区的只读本地验收入口。由宿主指定Bun或Node运行validate-plan.mjs；只校验本次固定输入/结果，输出安全错误码，不写库、不修改材料、不调用模型。 */
import {readFile} from 'node:fs/promises';
import {compileAgentMaterialPlan} from '../../shared/agent-material-plan';

try{
 const context=JSON.parse(await readFile('validation-source.json','utf8'));
 const plan=JSON.parse(await readFile('output/material-plan.json','utf8'));
 const result=compileAgentMaterialPlan(plan,context.files,context.identity);
 console.log(JSON.stringify({valid:true,pages:result.prepared.pages.length,documents:result.prepared.documents.length}));
}catch(error){
 console.log(JSON.stringify({valid:false,reason_code:(error as any)?.reason_code??(error instanceof SyntaxError?'invalid_json':'agent_plan_file_invalid'),...((error as any)?.validation_details?{validation_details:(error as any).validation_details}:{})}));
 process.exitCode=2;
}

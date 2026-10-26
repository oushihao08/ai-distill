/**
 * 职责：打包到Agent私有工作区的只读本地校验工具validate-plan.mjs，由宿主提供Bun或Node执行命令。
 * 读取validation-source.json和output/material-plan.json，复用compileAgentMaterialPlan，包含共用扫描清理加固。
 * Agent可在同一会话内依据valid:false和定位信息修正计划；本工具只返回安全校验结果，不写库、不修改材料、不调用模型。
 * valid:true表示计划通过当前程序的定位、结构、覆盖和残留检查，不表示Agent语义判断或原件OCR已人工验收。
 * Agent结束后宿主会重读计划并再次调用同一编译器，最后才走事务发布；工具通过或聊天声明成功都不是发布回执。
 */
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

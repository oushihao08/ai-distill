/**
 * 职责：对JSON Schema子集（type/enum/properties/required/additionalProperties/items/minItems/maxItems/minLength/minimum/maximum）做结构校验，供网页执行器把“不符合交付schema”的回复反馈给网页修正。
 * 主要入口：`assertMatchesSchema()`；调用方为 authoring.ts、preparation.ts。
 * 边界：只验证结构，不做内容准入；Agent路径由结构化输出保证同样的schema，本函数让网页路径获得等价的结构保证。
 */
export interface SchemaIssue{path:string;problem:string}
type Schema=Record<string,any>;
const typeOf=(value:unknown)=>value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
function check(value:unknown,schema:Schema|undefined,path:string,issues:SchemaIssue[]){
  if(!schema||issues.length>=20)return;
  const actual=typeOf(value);
  if(schema.type){
    const allowed=(Array.isArray(schema.type)?schema.type:[schema.type]) as string[];
    const ok=allowed.some(type=>type===actual||(type==='number'&&actual==='integer'));
    if(!ok){issues.push({path,problem:`类型应为${allowed.join('|')}，实际为${actual}`});return;}
  }
  if(schema.enum&&!schema.enum.some((item:unknown)=>JSON.stringify(item)===JSON.stringify(value))){issues.push({path,problem:'取值不在允许范围内'});return;}
  if(typeof value==='string'){if(schema.minLength!==undefined&&value.length<schema.minLength)issues.push({path,problem:`长度不足${schema.minLength}`});}
  if(typeof value==='number'){
    if(schema.minimum!==undefined&&value<schema.minimum)issues.push({path,problem:`不得小于${schema.minimum}`});
    if(schema.maximum!==undefined&&value>schema.maximum)issues.push({path,problem:`不得大于${schema.maximum}`});
  }
  if(Array.isArray(value)){
    if(schema.minItems!==undefined&&value.length<schema.minItems)issues.push({path,problem:`至少${schema.minItems}项`});
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)issues.push({path,problem:`至多${schema.maxItems}项`});
    value.forEach((item,index)=>check(item,schema.items,`${path}[${index}]`,issues));
  }
  if(actual==='object'){
    const record=value as Record<string,unknown>,properties=(schema.properties??{}) as Record<string,Schema>;
    for(const key of (schema.required??[]) as string[])if(!Object.hasOwn(record,key))issues.push({path:path?`${path}.${key}`:key,problem:'缺少必填字段'});
    for(const [key,item] of Object.entries(record)){
      if(Object.hasOwn(properties,key))check(item,properties[key],path?`${path}.${key}`:key,issues);
      else if(schema.additionalProperties===false)issues.push({path:path?`${path}.${key}`:key,problem:'不允许的额外字段'});
      else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')check(item,schema.additionalProperties,path?`${path}.${key}`:key,issues);
    }
  }
}
export function validateAgainstSchema(value:unknown,schema:Schema|undefined):SchemaIssue[]{const issues:SchemaIssue[]=[];check(value,schema,'',issues);return issues;}
/** 不符合时抛出带 reason_code=schema_invalid 与具体字段问题的错误，供对话回路反馈。 */
export function assertMatchesSchema(value:unknown,schema:Schema|undefined){
  const issues=validateAgainstSchema(value,schema);
  if(issues.length)throw Object.assign(new Error('回复JSON不符合交付schema'),{reason_code:'schema_invalid',validation_details:issues});
}

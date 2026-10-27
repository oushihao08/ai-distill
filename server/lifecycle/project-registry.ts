/** 项目实现注册与同步分派。各步骤以同一个 execute(projectKey,input) 入口选择一个实现；通用业务仍由步骤管理。 */
export type ProjectImplementation<Input, Output> = (input: Input) => Output | Promise<Output>;
export class ProjectImplementations<Input, Output> {
 private readonly implementations = new Map<string, ProjectImplementation<Input, Output>>();
 constructor(private readonly fallback: ProjectImplementation<Input, Output>) {}
 register(projectKey: string, implementation: ProjectImplementation<Input, Output>): () => void {
  if (!projectKey.trim()) throw new Error('项目 key 不能为空');
  if (this.implementations.has(projectKey)) throw new Error(`项目实现重复注册：${projectKey}`);
  this.implementations.set(projectKey, implementation);
  return () => { if (this.implementations.get(projectKey) === implementation) this.implementations.delete(projectKey); };
 }
 /** 精确匹配，只执行一个实现；失败原样向步骤传播，不作为可忽略通知吞掉。 */
 async execute(projectKey: string | null | undefined, input: Input): Promise<Output> {
  const implementation = (projectKey ? this.implementations.get(projectKey) : undefined) ?? this.fallback;
  try { return await implementation(input); } catch (error) { throw error; }
 }
}

/** 同步数据策略：用于schema/纯转换/就绪判断等同步调用方；异步外部副作用使用上方注册器。 */
export class SyncProjectImplementations<Input, Output> {
 private readonly implementations = new Map<string, (input:Input)=>Output>();
 constructor(private readonly fallback:(input:Input)=>Output){}
 register(projectKey:string,implementation:(input:Input)=>Output):()=>void {
  if(!projectKey.trim())throw new Error('项目 key 不能为空');
  if(this.implementations.has(projectKey))throw new Error(`项目实现重复注册：${projectKey}`);
  this.implementations.set(projectKey,implementation);
  return()=>{if(this.implementations.get(projectKey)===implementation)this.implementations.delete(projectKey);};
 }
 execute(projectKey:string|null|undefined,input:Input):Output {
  return ((projectKey?this.implementations.get(projectKey):undefined)??this.fallback)(input);
 }
}

/** 项目自行登记历史身份匹配规则；公共流程不认识项目名称、路径或内容契约。 */
export class ProjectKeyRegistry<Identity> {
 private readonly matchers=new Map<string,(identity:Identity)=>boolean>();
 register(key:string,matches:(identity:Identity)=>boolean){
  if(this.matchers.has(key))throw new Error(`项目身份重复注册：${key}`);
  this.matchers.set(key,matches);
  return()=>{if(this.matchers.get(key)===matches)this.matchers.delete(key);};
 }
 resolve(identity:Identity):string|null {
  for(const [key,matches] of this.matchers)if(matches(identity))return key;
  return null;
 }
}

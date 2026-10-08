import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {validateDraft,type Draft} from './validate';
export async function readPrivateDraft(root:string,workflowId:string,attemptId:string,materials:{id:string;text:string}[]):Promise<Draft>{
 const base=await realpath(resolve(root));
 const privateRoot=await realpath(join(base,workflowId,attemptId,'private'));
 if(privateRoot!==join(base,workflowId,attemptId,'private')||!privateRoot.startsWith(base+'/'))throw new Error('unsafe revision workspace');
 async function load(path:string,legacy=false){
  const actual=await realpath(path);
  if(!actual.startsWith(privateRoot+'/'))throw new Error('unsafe revision draft');
  const info=await stat(actual);if(!info.isFile()||info.size>30*1024*1024)throw new Error('invalid private draft');
  const value=JSON.parse(await readFile(actual,'utf8'));
  return validateDraft(legacy?value.draft:value,materials);
 }
 try{return await load(join(privateRoot,'draft.json'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const directories=(await readdir(privateRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('authoring-'));
 if(directories.length!==1)throw new Error('missing or ambiguous private draft');
 // Older attempts kept their complete draft in the independent review input.
 // Read it in place; never reconstruct a reference answer from public output.
 return await load(join(privateRoot,directories[0]!.name,'review','input','input.json'),true);
}

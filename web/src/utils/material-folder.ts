/** 职责：统一材料文件夹导入的文件类型、数量与同名校验。
 * 入口：readMaterialFolderSelection() 供新建材料包弹窗和导入新文件集合使用；readDirectRawFolderSelection() 供期次原件包免提取/免脱敏直接建题出题使用；只整理File引用，不读取或改写材料内容。
 */
export function readMaterialFolderSelection(incoming:File[]){
 const files=incoming.filter(file=>/\.(pdf|docx|txt|md|png|jpe?g)$/i.test(file.name));
 if(!files.length)throw new Error('文件夹内没有 PDF、DOCX、TXT、MD、PNG、JPG 或 JPEG 材料。');
 if(files.length>100)throw new Error('一个材料包最多导入100份材料。');
 if(new Set(files.map(file=>file.name)).size!==files.length)throw new Error('文件夹中存在同名材料，请先为同名文件改名再导入。');
 return{files,name:files[0]!.webkitRelativePath.split('/')[0]||'材料包',ignoredCount:incoming.length-files.length};
}

const DIRECT_RAW_PATTERN=/\.(pdf|docx|xlsx|csv|tsv|txt|md|json|jsonl|xml|ya?ml|fasta|fa|gb|pdb|mmcif|cif|sdf|nwk|step|stp|iges|igs|py|sql|r|sh|parquet|png|jpe?g)$/i;

export function readDirectRawFolderSelection(incoming:File[]){
 const visible=incoming.filter(file=>{
  const rel=(file.webkitRelativePath||file.name).replaceAll('\\','/');
  return !rel.split('/').some(seg=>seg==='__MACOSX'||seg.startsWith('.')||seg.startsWith('~$'));
 });
 const files=visible.filter(file=>DIRECT_RAW_PATTERN.test(file.name));
 if(!files.length)throw new Error('所选目录中没有支持的原件文件（支持 XLSX、CSV、TSV、PDF、DOCX、TXT、MD、JSON、Parquet、FASTA、PDB、STEP 等）。');
 if(files.length>100)throw new Error('单个原件包最多包含 100 份文件。');
 if(new Set(files.map(file=>file.name)).size!==files.length)throw new Error('所选文件存在重名，请确保每份原件文件名唯一。');
 const relParts=(files[0]!.webkitRelativePath||'').replaceAll('\\','/').split('/').filter(Boolean);
 const rawFolder=relParts.length>1?relParts[0]!:'';
 const suggestedTitle=rawFolder&&!/^(input|inputs|data|materials|raw)$/i.test(rawFolder)?rawFolder:'';
 return{files,folderName:rawFolder||'原件材料包',suggestedTitle,ignoredCount:incoming.length-files.length};
}

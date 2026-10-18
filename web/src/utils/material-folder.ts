/** 职责：统一材料文件夹导入的文件类型、数量与同名校验。
 * 入口：readMaterialFolderSelection() 供新建材料包弹窗和导入新文件集合使用；只整理File引用，不读取或改写材料内容。
 */
export function readMaterialFolderSelection(incoming:File[]){
 const files=incoming.filter(file=>/\.(pdf|docx|txt|md)$/i.test(file.name));
 if(!files.length)throw new Error('文件夹内没有 PDF、DOCX、TXT 或 MD 材料。');
 if(files.length>100)throw new Error('一个材料包最多导入100份材料。');
 if(new Set(files.map(file=>file.name)).size!==files.length)throw new Error('文件夹中存在同名材料，请先为同名文件改名再导入。');
 return{files,name:files[0]!.webkitRelativePath.split('/')[0]||'材料包',ignoredCount:incoming.length-files.length};
}

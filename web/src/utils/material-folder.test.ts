/** 职责：验证浏览器目录文件清单的PDF/DOCX筛选、目录命名和冲突校验；不模拟原生选择器交互。 */
import {test,expect} from 'bun:test';
import {readMaterialFolderSelection} from './material-folder';
function file(name:string,path:string){const value=new File(['合成材料'],name);Object.defineProperty(value,'webkitRelativePath',{value:path});return value;}
test('imports documents and images together and uses the selected root folder name',()=>{
 const pdf=file('案卷.pdf','合成案件/案卷.pdf'),docx=file('合同.docx','合成案件/补充/合同.docx'),png=file('image.png','合成案件/image.png'),jpeg=file('photo.JPEG','合成案件/photo.JPEG');
 const selected=readMaterialFolderSelection([pdf,docx,png,jpeg,file('sheet.xlsx','合成案件/sheet.xlsx')]);
 expect(selected).toEqual({name:'合成案件',files:[pdf,docx,png,jpeg],ignoredCount:1});
});
test('rejects empty or duplicate-basename material folders',()=>{
 expect(()=>readMaterialFolderSelection([])).toThrow('没有');
 expect(()=>readMaterialFolderSelection([file('同名.pdf','案卷/a/同名.pdf'),file('同名.pdf','案卷/b/同名.pdf')])).toThrow('同名');
});

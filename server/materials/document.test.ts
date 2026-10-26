/** 验证 PDF 缺少 MinerU provider 时拒绝执行，以及 TXT 原文空白投影；只使用临时文件，不请求 MinerU/智谱。 */
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractLocalDocument,ProjectDocumentExtractor} from './document';
import {createHash} from 'node:crypto';
import {command} from './pdf';

/** 最小三页合成PDF，仅供本地Poppler拆页验证，不含用户材料。 */
function blankPdf(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',...Array(3).fill('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>')];
 let result='%PDF-1.4\n';const offsets=[0];
 for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${object}\nendobj\n`;}
 const start=Buffer.byteLength(result);result+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('');
 return result+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

test('page recheck sends only a private PDF subset and maps results back to original page numbers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'document-subset-')),path=join(root,'source.pdf'),source=blankPdf();let subsetPath='',calls=0;
 try{
  await writeFile(path,source);
  const provider={id:'mineru-api' as const,async extract(subset:string){
   calls++;subsetPath=subset;expect(subset).not.toBe(path);expect(await command(['pdfinfo',subset])).toMatch(/Pages:\s+2/);
   const bytes=await Bun.file(subset).arrayBuffer();
   return{provider:'mineru-api' as const,sha256:createHash('sha256').update(Buffer.from(bytes)).digest('hex'),pages:[{page:1,text:'原第三页',method:'ocr' as const},{page:2,text:'原第一页',method:'ocr' as const}]};
  }};
  const result=await new ProjectDocumentExtractor(provider).extractPages(path,[3,1]);
  expect(result.sha256).toBe(createHash('sha256').update(source).digest('hex'));expect(result.pages.map(p=>p.page)).toEqual([3,1]);expect(calls).toBe(1);
  expect(await Bun.file(path).text()).toBe(source);expect(await Bun.file(subsetPath).exists()).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('page recheck rejects invalid, out-of-range and cancelled requests without calling the provider',async()=>{
 const root=await mkdtemp(join(tmpdir(),'document-subset-stop-')),path=join(root,'source.pdf');let calls=0;
 const extractor=new ProjectDocumentExtractor({id:'mineru-api',async extract(){calls++;throw new Error('must not call provider');}});
 try{
  await writeFile(path,blankPdf());
  for(const pages of [[],[0],[1,1],[99]])await expect(extractor.extractPages(path,pages)).rejects.toThrow();
  const controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(extractor.extractPages(path,[1],controller.signal)).rejects.toThrow('stopped');expect(calls).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('PDF extraction requires an explicit provider instead of falling back to GLM OCR',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-provider-'));
 try{
  const path=join(root,'source.pdf');await writeFile(path,'%PDF-1.4');
  const extractor=new ProjectDocumentExtractor();
  await expect(extractor.extract(path)).rejects.toThrow('MinerU PDF解析器未配置');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('local text documents expose a structure whose projection retains source whitespace exactly',()=>{
 const source=' 标题\n\n第二段  ';
 const result=extractLocalDocument(new TextEncoder().encode(source),'txt');
 expect(result.pages[0]?.structure).toEqual([{id:'p1-b1',kind:'paragraph',text:source}]);
});

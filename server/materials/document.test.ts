/** 验证 PDF 缺少 MinerU provider 时拒绝执行，以及 TXT 原文空白投影；只使用临时文件，不请求 MinerU/智谱。 */
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractLocalDocument,ProjectDocumentExtractor} from './document';

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

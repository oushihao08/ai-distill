/** 验证 XLSX 写入、非法维度拒绝、文本安全、长单元格拆分和成果工作表。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {writeXlsx} from './xlsx';
import {buildResultWorkbook} from './results';
test('writes a real workbook with safe inline text, split long cells and unique sheet names',async()=>{
 const root=await mkdtemp(join(tmpdir(),'xlsx-test-'));const path=join(root,'result.xlsx');
 try{
  const long='长文本'.repeat(11_000);const bytes=await writeXlsx(path,[{name:'结果/题目',columns:['id','题面','答案','费用'],rows:[{id:'w1',题面:'=1+1',答案:long,费用:'未知'}]},{name:'结果/题目',columns:['id','状态'],rows:[{id:'w2',状态:'合格'}]}]);
  expect(bytes[0]).toBe(0x50);expect((await readFile(path)).length).toBeGreaterThan(100);
  const script="import json,openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1],data_only=False); s=w.worksheets[0]; print(json.dumps({'sheets':w.sheetnames,'headers':[c.value for c in s[1]],'formula':s['B2'].data_type,'value':s['B2'].value,'fee':s['E2'].value},ensure_ascii=False))";
  const result=spawnSync('python3',['-c',script,path],{encoding:'utf8'});expect(result.status).toBe(0);const read=JSON.parse(result.stdout);
  expect(read.sheets).toEqual(['结果 题目','结果 题目 (2)']);expect(read.headers).toEqual(['id','题面','答案','答案（续2）','费用']);expect(read.formula).toBe('s');expect(read.value).toBe('=1+1');expect(read.fee).toBe('未知');
  const longRead=spawnSync('python3',['-c',"import openpyxl,sys; s=openpyxl.load_workbook(sys.argv[1],read_only=True).worksheets[0]; print(len(s['C2'].value+s['D2'].value))",path],{encoding:'utf8'});expect(longRead.status).toBe(0);expect(Number(longRead.stdout.trim())).toBe(long.length);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rejects empty workbook and invalid dimensions',()=>{expect(()=>writeXlsx('',[] as any)).toThrow();});
test('builds deliverable sheets from project results grouped by batch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'result-xlsx-'));const path=join(root,'deliverable.xlsx');
 try{
  const bytes=buildResultWorkbook([{project_id:'p1',project_name:'项目甲',batch:'第一批',workflow_id:'w1',title:'题目',question:'题面',question_version:'q2',rubric_version:'r1',quality:'passed',accepted:true,quarantined:false,answers:[{model:'qwen-plus',status:'succeeded',answer:'答案',score_status:'succeeded',score_valid:true,total:8,max_score:10,items:[{id:'r1',score:8,max_score:10,reason:'证据充分'}]}],revisions:[],api_costs:[{model:'qwen-plus',amount:null,currency:null,unknown_reason:'price_missing'}]}]);
  await Bun.write(path,bytes);const out=spawnSync('python3',['-c',"import json,openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1],read_only=True); print(json.dumps({'sheets':w.sheetnames,'title':w['成果汇总']['F2'].value,'answer':w['答案评分-第一批']['G2'].value,'reason':w['返修费用-第一批']['M2'].value},ensure_ascii=False))",path],{encoding:'utf8'});
  expect(out.status).toBe(0);expect(JSON.parse(out.stdout)).toEqual({sheets:['成果汇总','答案评分-第一批','返修费用-第一批'],title:'题面',answer:'答案',reason:'price_missing'});
 }finally{await rm(root,{recursive:true,force:true});}
});

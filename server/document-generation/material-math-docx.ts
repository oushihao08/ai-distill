/**
 * 职责：将材料 OCR 中可确认的圈号与简单 LaTeX 公式转换为 Word 内容。
 * 入口：materialMathRuns() 供材料 DOCX 渲染调用；无法安全解析时原样保留。
 */
import {Math as WordMath,MathRun,MathSuperScript,TextRun,type MathComponent} from 'docx';

const circled=(digit:string)=>String.fromCodePoint(0x2460+Number(digit)-1);

export function materialMathRuns(value:string):(TextRun|WordMath)[]{
 const normalized=value.replace(/\$\{\s*\}/g,'').replace(/\$\s*(?:\\textcircled|\x09extcircled)\{([1-9])\}\s*\$/g,(_,digit:string)=>circled(digit));
 const result:(TextRun|WordMath)[]=[];let cursor=0;
 for(const match of normalized.matchAll(/\$\s*([^$\n]+?)\s*\$/g)){
  const start=match.index??0,parsed=parseMath(match[1]!);
  if(start>cursor)result.push(new TextRun(normalized.slice(cursor,start)));
  result.push(parsed?new WordMath({children:parsed}):new TextRun(readableFormula(match[1]!)));
  cursor=start+match[0].length;
 }
 if(cursor<normalized.length||!result.length)result.push(new TextRun(normalized.slice(cursor)));
 return result;
}

/** 解析失败时只转换含义确定的记号；不明指数显式标记，避免把错误公式伪装成正确公式。 */
function readableFormula(source:string):string{
 return source.replace(/\\{1,2}(?:mathrm|mathbf|mathit|text|operatorname)\{([^{}]*)\}/g,'$1')
  .replace(/\\{1,2}prime\b/g,'′').replace(/\\{1,2}Sigma\b/g,'Σ')
  .replace(/\^\{′\}/g,'′')
  .replace(/\^\{\*\}|\^\{\}/g,'〔指数待核对〕')
  .replace(/^\{\}\s*$/,'').trim();
}

function parseMath(source:string):MathComponent[]|null{
 const parts:MathComponent[]=[];let plain='';
 const flush=()=>{if(plain){parts.push(new MathRun(plain));plain='';}};
 for(let i=0;i<source.length;){
  const rest=source.slice(i);
  const roman=/^\\{1,2}mathrm\{([^{}]+)\}/.exec(rest);
  if(roman){flush();parts.push(new MathRun({text:roman[1]!,style:'plain'}));i+=roman[0].length;continue;}
  const prime=/^\\{1,2}prime\b/.exec(rest);
  if(prime){plain+='′';i+=prime[0].length;continue;}
  const sigma=/^\\{1,2}Sigma\b/.exec(rest);
  if(sigma){plain+='Σ';i+=sigma[0].length;continue;}
  const exponent=/^\^\{([^{}]+)\}/.exec(rest);
  if(exponent){
   if(!/^(?:[A-Za-z0-9]+|\\{1,2}prime)$/.test(exponent[1]!))return null;
   let base:MathComponent;
   if(plain){const character=plain.at(-1)!;plain=plain.slice(0,-1);flush();base=new MathRun(character);}
   else{const prior=parts.pop();if(!(prior instanceof MathRun))return null;base=prior;}
   const superScript=parseMath(exponent[1]!);if(!superScript)return null;
   parts.push(new MathSuperScript({children:[base],superScript}));i+=exponent[0].length;continue;
  }
  if(rest[0]==='\\'||rest[0]==='{'||rest[0]==='}'||rest[0]==='^')return null;
  plain+=rest[0];i++;
 }
 flush();return parts.length?parts:null;
}

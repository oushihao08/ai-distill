/**
 * 职责：只核对评分报告声明的候选引文是否逐字存在于候选答案，不判断语义或分数。
 * 入口：candidateQuoteIssues()供返回后校验；buildCandidateQuoteFiles()供Work评分会话自行核验、纠正。
 * 调用方：validate.ts、executor.ts；不改写输入、报告或数据库。
 */
export function candidateQuoteIssues(items:unknown[],answer:string):string[]{
 const issues:string[]=[];
 for(const value of items.slice(0,501)){
  const item=value as {id?:unknown;answer_quotes?:unknown}|null;
  const quotes=item?.answer_quotes,id=typeof item?.id==='string'?item.id:'未知条目';
  if(!Array.isArray(quotes)||quotes.some(quote=>typeof quote!=='string'||!quote.trim()))issues.push(`${id}：answer_quotes须为非空原句组成的数组，无可引用内容时用空数组`);
  else if(quotes.some(quote=>!answer.includes(quote)))issues.push(`${id}：声明的引文不在候选答案原文，请回读待评答案.txt并自行纠正判断`);
 }
 return issues;
}

const checker=String.raw`# 只核对声明的候选引文；不判断满足判据与否，不改分，不写入任何文件。
import json, sys
from pathlib import Path

try:
    with Path(__file__).with_name('待评答案.txt').open(encoding='utf-8', newline='') as source:
        answer = source.read()
    report = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    items = report['items']
    if not isinstance(items, list) or len(items) > 500:
        raise ValueError('items须为最多500项的数组')
    issues = []
    for item in items:
        quotes = item.get('answer_quotes') if isinstance(item, dict) else None
        item_id = item.get('id', '未知条目') if isinstance(item, dict) else '未知条目'
        if not isinstance(quotes, list) or any(not isinstance(q, str) or not q.strip() for q in quotes):
            issues.append(str(item_id) + '：answer_quotes格式无效，无可引用内容时用空数组')
        elif any(q not in answer for q in quotes):
            issues.append(str(item_id) + '：声明的引文不在候选答案原文；回读待评答案并自行纠正判断')
    print(json.dumps({'valid': not issues, 'issues': issues, 'scope': '仅声明引文的字面来源；不证明判断、缺失断言或分数正确'}, ensure_ascii=False))
    sys.exit(1 if issues else 0)
except (KeyError, IndexError, TypeError, ValueError, OSError) as error:
    print('无法核验候选引文：' + str(error), file=sys.stderr)
    sys.exit(1)
`;

export function buildCandidateQuoteFiles(){return [{name:'核验候选引文.py',text:checker}];}

export const CANDIDATE_QUOTE_INSTRUCTIONS=[
 '候选引文协议literal_v1：每项JSON增加answer_quotes字符串数组。对候选文字作肯定、否定或错误认定时，摘录相关原句；所有声称来自候选的逐字引文都放入本数组，reason引用它们并说明判断。题面、附件、Rubric、校准标答的文字不能冒充候选引文。',
 '引文逐字复制，保留原标点与空格，不拼接、不用省略号改写。未找到可引用内容时填[]，在reason说明实际回查范围及缺失判断；不得为填数组编造证据。空数组不证明该内容不存在，引文存在也不证明该项满足。',
 '有文件工具时，把最终报告JSON保存为文件，执行python3 核验候选引文.py <JSON路径>。若有错引，回读待评答案.txt后自行更正相关判断、理由和成绩，并重核汇总；不得仅删除错引而保留未经核实的结论。此工具只给来源检查结果，不给分。无文件工具的API模式逐字回查本次提供的候选全文，不声称执行工具。',
 '提交前确认评审正文、reason、answer_quotes和汇总相互一致；程序返回后再次核验，错引报告保留原文但不产生有效比较指标。',
].join('\n');

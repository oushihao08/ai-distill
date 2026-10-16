/**
 * 职责：为评分 Agent 提供同版 Rubric 权重及本地算术工具，避免手抄权重和汇总错误。
 * 入口：buildScoreArithmeticFiles() 由评分文件构造器调用；不判业务条目，不回写报告或数据库。
 */
import type {ScoreContext} from './validate';

const calculator=String.raw`# 本次评分的只读复算工具；不判断考点，不修改输入或业务成绩。
import json, sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('分值必须是有限数字')
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError('分值必须是有限数字')
    return result

try:
    weights = json.loads(Path(__file__).with_name('计分条目.json').read_text(encoding='utf-8'))
    report = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    items = report['items']
    expected = {item['id']: item for item in weights}
    actual = {item['id']: item for item in items}
    if len(expected) != len(weights) or len(actual) != len(items) or set(actual) != set(expected):
        raise ValueError('条目缺失、重复或存在未知ID')
    full = Decimal(0)
    net = Decimal(0)
    for item in weights:
        delta = actual[item['id']]['score_delta']
        if item.get('priority') == 'Veto':
            if delta is not None:
                raise ValueError('独立否决不得计入分数')
            continue
        weight = number(item.get('score'))
        if weight > 0:
            full += weight
        net += number(delta)
    if full <= 0:
        raise ValueError('没有可确定的正项满分；不能猜测比较口径')
    percentage = max(Decimal(0), min(Decimal(100), net / full * 100))
    print(json.dumps({'raw_score': float(net), 'full_score': float(full),
                      'net_percentage': float(percentage.quantize(Decimal('0.00000001')))}, ensure_ascii=False))
except (KeyError, IndexError, TypeError, ValueError, OSError, InvalidOperation) as error:
    print('无法复算：' + str(error), file=sys.stderr)
    sys.exit(1)
`;

export function buildScoreArithmeticFiles(rubric:ScoreContext['rubric']){
 const weights=rubric.map(item=>({id:item.id,...('metadata' in item&&item.metadata?{score:item.metadata.score,priority:item.metadata.priority}:{})}));
 return [{name:'计分条目.json',text:JSON.stringify(weights)},{name:'复算评分.py',text:calculator}];
}

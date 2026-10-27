/**
 * 职责：为评分 Agent 提供同版 Rubric 权重及本地算术工具，避免手抄权重和汇总错误。
 * 入口：buildScoreArithmeticFiles()提供权重JSON及复算脚本；评分文件构造器只向Codex提供脚本，API保留权重数据。不判业务条目，不回写报告或数据库。
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

/** Legacy报告交卷前自检：只返回问题和合计，不改文件或替Agent决定冲突条目。 */
export const LEGACY_PREFLIGHT_INSTRUCTIONS='提交前将完整最终评分正文保存为评分草稿.txt，执行 python3 核验文本评分.py 评分草稿.txt。工具检查ID唯一性、分值和总分一致性，不判断业务得分；有问题时回读对应判据和答案，在本次会话修正草稿并重新检查。重复ID不得靠任选一条或删除得分来凑总分。仅在valid=true后逐字提交该草稿；检查后修改正文必须重查。工具不替代逐项理由和答案证据，不改变Rubric、门槛或专业判断；无法修复时如实保留问题，不声称检查通过。';

const legacyChecker=String.raw`# 核验完整legacy评分草稿；只读输入，不改业务分数。
import json, re, sys
from decimal import Decimal
from pathlib import Path

def check(text, rubric):
    expected = {item['id']: Decimal(str(item['max_score'])) for item in rubric}
    full = sum(expected.values(), Decimal(0))
    found, totals, issues = set(), set(), []
    total = Decimal(0)
    labels = {'最终总分', '最终得分', '总分', '合计得分', '得分'}
    number = r'(\d+(?:\.\d+)?)'
    for raw in text.split('\n'):
        line = re.sub(r'^#{1,6}\s+', '', raw.replace('**', '').strip())
        summary = re.fullmatch(r'(?:最终总分|最终得分|总分|合计得分|得分)\s*[:：]?\s*'+number+r'\s*(?:[／/]\s*'+number+r'\s*分?|分\s*[（(]?满分\s*'+number+r'\s*分?[）)]?)\s*', line)
        if summary and not re.search('假设|如果|若|补充后|修订后|改进后|例如|可能达到', line):
            if Decimal(summary[2] or summary[3]) == full:
                totals.add(Decimal(summary[1]))
        identifier = next((key for key in sorted(expected, key=len, reverse=True) if line.startswith(key+'：') or line.startswith(key+':')), None)
        if identifier is not None:
            match = re.match(re.escape(identifier)+r'\s*[：:]\s*(?:得分\s*)?'+number+r'\s*[／/]\s*'+number+r'(?:\s*分)?(?:\s|[，。；;|]|$)', line)
            if match is None or identifier in found:
                issues.append(identifier+'：条目评分格式缺失或重复')
                continue
            found.add(identifier)
            score, maximum = Decimal(match[1]), Decimal(match[2])
            if expected[identifier] == 1 and score not in (0, 1):
                issues.append(identifier+'：每项满分1分且得分只能为0或1')
                continue
            if maximum != expected[identifier] or not 0 <= score <= maximum:
                issues.append(identifier+'：得分或满分与本题rubric不符')
                continue
            total += score
        else:
            unknown = re.match(r'^(.{1,160}?)\s*[：:]\s*(?:得分\s*)?'+number+r'\s*[／/]\s*'+number+r'(?:\s*分)?(?:\s|[，。；;|]|$)', line)
            if unknown and unknown[1].strip() not in labels and unknown[1].strip() not in expected:
                issues.append('评分条目ID不属于本题rubric：'+unknown[1].strip())
    if len(found) != len(expected):
        issues.append('rubric条目评分缺失或重复')
    value = next(iter(totals)) if len(totals) == 1 else None
    if value is None or not 0 <= value <= full:
        issues.append('评分原文存在多个不同总分' if len(totals) > 1 else '未能从评分原文明确提取合法总分')
    elif abs(value-total) > Decimal('0.00000001'):
        issues.append('最终总分与逐项评分合计不一致')
    return {'valid': not issues, 'issues': issues, 'item_total': float(total), 'max_score': float(full)}

try:
    rubric = json.loads(Path(__file__).with_name('文本计分条目.json').read_text(encoding='utf-8'))
    result = check(Path(sys.argv[1]).read_text(encoding='utf-8'), rubric)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result['valid'] else 1)
except (KeyError, IndexError, TypeError, ValueError, OSError) as error:
    print('无法核验：'+str(error), file=sys.stderr)
    sys.exit(1)
`;

export function buildLegacyScorePreflightFiles(rubric:ScoreContext['rubric']){
 return [{name:'文本计分条目.json',text:JSON.stringify(rubric.map(item=>({id:item.id,max_score:'max_score' in item?item.max_score:null})))},{name:'核验文本评分.py',text:legacyChecker}];
}

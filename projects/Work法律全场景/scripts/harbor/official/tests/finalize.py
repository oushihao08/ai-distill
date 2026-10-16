#!/usr/bin/env python3
"""平台固定模板，请勿改动。

从 Reward Kit 的逐条判定明细汇总主分（按签名权重池化全题 criterion），
并显式区分"评分不可用"与"确实得零分"。
"""
import argparse
import sys
import json
import math
import pathlib
import re


def load_json(path):
    """读取 JSON；不可读或解析失败返回 None。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_scores(path):
    data = load_json(path)
    return data if isinstance(data, dict) else None


def finite(value):
    """转成有限浮点数；不可转、NaN、±inf 一律返回 None。

    Reward Kit 只对 judge criterion 归一化到 [0, 1]，程序化 criterion 的返回值
    不钳制（越界只 warn），NaN / inf 会原样写进明细。这类值若直接参与运算会算出
    一个 0 分，看起来像"确实得零分"，必须当成评分异常上报。
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def iter_criteria(details):
    """遍历明细里的全部 criterion。

    details[<维度>] 在该维度只有一个 Reward 时是 dict；judge TOML 与 .py 混用、
    或放了多份 judge TOML 时是 list。两种形状都要处理。
    """
    if not isinstance(details, dict):
        return
    for entry in details.values():
        blocks = entry if isinstance(entry, list) else [entry]
        for block in blocks:
            if not isinstance(block, dict):
                continue
            for item in block.get("criteria") or []:
                if isinstance(item, dict):
                    yield item


def pooled_score(details):
    """全题池化的签名加权分，返回 (分数, 参与条数, 异常条数)。

    正向项：+weight 进分子、weight 进分母。
    negate 项：-weight 进分子、不进分母。明细里的 value 是翻转后的值
              （违规存在 = 0），违规程度需还原为 1 - value。
    异常条目一律不计入、改由 verifier_error 上报，包括：带 error（判官超时会把
    每条都记成 value = 0.0 并保留 negate，若计入会凭空扣分）、weight 非正数、
    value 非有限值、negate 非布尔值。
    无正向条目时分母为 0，主分无定义，返回 (None, ...)。
    """
    numerator = 0.0
    denominator = 0.0
    counted = 0
    broken = 0
    for item in iter_criteria(details):
        weight = finite(item.get("weight"))
        value = finite(item.get("value"))
        negate = item.get("negate")
        if (item.get("error") or weight is None or weight <= 0.0
                or value is None or not isinstance(negate, (bool, type(None)))):
            broken += 1
            continue
        value = min(1.0, max(0.0, value))   # 程序化 criterion 越界返回值的兜底
        if negate:
            numerator -= weight * (1.0 - value)
        else:
            numerator += weight * value
            denominator += weight
        counted += 1
    if denominator <= 0.0:
        return None, counted, broken
    return min(1.0, max(0.0, numerator / denominator)), counted, broken


def count_errors(node):
    """递归统计明细里的 error 字段。judge 超时 / 限额会被记成 0.0 加 error。"""
    total = 0
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "error" and value:
                total += 1
            else:
                total += count_errors(value)
    elif isinstance(node, list):
        for item in node:
            total += count_errors(item)
    return total


def detail_errors(reward_path):
    """扫描 reward.json 同目录下的 *details*.json。"""
    total = 0
    for path in sorted(reward_path.parent.glob("*details*.json")):
        data = load_json(path)
        if data is None:
            total += 1
        else:
            total += count_errors(data)
    return total


def detail_error_messages(reward_path):
    """收集明细里全部 error 字符串。

    Reward Kit 只在**判官超时**这一种情况下写 error 字段（judges.py 的
    ``f"judge timed out after {timeout}s"``），其余失败都是未捕获异常，
    错误信息只在 stderr 的 traceback 里。
    """
    msgs = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "error" and value:
                    msgs.append(str(value))
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    for path in sorted(reward_path.parent.glob("*details*.json")):
        walk(load_json(path))
    return msgs


def read_stderr_tail(reward_path, limit=2000):
    """读 test.sh 落盘的 rewardkit stderr 末尾（Python traceback 的末行信息量最大）。"""
    try:
        text = (reward_path.parent / "stderr.txt").read_text(
            encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""
    return text[-limit:]


# Python traceback 的**最后一条异常行**才是真正的错误信息（前面全是栈帧）。
# rewardkit 用 ExceptionGroup 包裹异常，每行带 "  | " 前缀，一并剥掉。
_ERROR_LINE_RE = re.compile(
    r"^[\s|+]*((?:\w+\.)*\w*(?:Error|Exception|Timeout)\b.*)$", re.MULTILINE)


def last_error_line(text):
    """从 traceback 里取最后一条异常行；取不到返回空串。"""
    matches = _ERROR_LINE_RE.findall(text or "")
    return matches[-1].strip() if matches else ""


# Reward Kit 抛出的异常类型 → AP 错误码。左侧字符串取自 rewardkit 0.1.7 源码里
# 逐字写死的异常消息，不是猜测；未命中的一律按 scorer_error 兜底并透传原文。
_EXIT_CODE_RULES = (
    ("timed out after", "judge:timeout"),                    # judges.py 超时（error 字段/warning）
    ("Could not parse JSON from judge response", "judge:parse_error"),
    ("expected dict with 'score' and 'reasoning'", "judge:parse_error"),
    ("exited with code", "judge:scorer_error"),              # agent CLI 非零退出
    ("RateLimitError", "judge:api_error:rate_limit"),        # litellm 异常类名
    ("ContentPolicyViolationError", "judge:api_error:content_filter"),
    ("AuthenticationError", "judge:api_error:auth"),
    ("litellm", "judge:api_error"),
)


def classify_exit(args, result):
    """归类为 AP 错误码，并把 Reward Kit 的原始错误文本原样透传进 exit_reason。

    分类只做三件确定的事：命中源码里写死的异常消息 → 对应码；rewardkit 非零退出
    → scorer_error；跑通了却没有任何有效条目 → invalid_output。其余 unknown。
    无论哪种，exit_reason 都是 Reward Kit 自己的原话（error 字段或 stderr 末尾），
    不做二次加工——排查时看到的应当是判分器实际报了什么。
    """
    detail_msgs = detail_error_messages(pathlib.Path(args.graded))
    stderr_tail = read_stderr_tail(pathlib.Path(args.graded))
    haystack = " | ".join(detail_msgs) + "\n" + stderr_tail
    reason = (detail_msgs[0] if detail_msgs else
              last_error_line(stderr_tail) or stderr_tail[-1000:]) or (
        "verifier marked unavailable without any error output")
    for needle, code in _EXIT_CODE_RULES:
        if needle.lower() in haystack.lower():
            return code, reason
    if args.graded_rc != 0:
        return "judge:scorer_error", reason
    if not result.get("criteria_counted"):
        return "judge:invalid_output", reason
    return "judge:unknown", reason


def compute(args):
    """汇总评分结果，返回要写进 reward.json 的字典。"""
    graded_path = pathlib.Path(args.graded)

    graded = load_scores(graded_path)
    graded_details = load_json(graded_path.with_name("reward-details.json"))

    dims = {}
    for key, value in (graded or {}).items():
        if key == "soft_score":
            continue
        number = finite(value)
        if number is not None:
            dims[key] = number

    # 主分：按签名权重池化全题 criterion（负向项真扣分，空产物下限为 0）。
    pooled, counted, broken = pooled_score(graded_details)
    score = 0.0 if pooled is None else round(pooled, 6)

    # Reward Kit 自己的 [0,1] 归一化聚合值，仅留作审计参照，不作主分。
    soft = finite((graded or {}).get("soft_score"))
    if soft is not None:
        soft = round(soft, 6)

    graded_ok = (args.graded_rc == 0 and bool(dims) and pooled is not None
                 and counted > 0 and broken == 0)

    result = dict(dims)
    result["graded_score"] = score
    result["criteria_counted"] = float(counted)
    if soft is not None:
        result["soft_score"] = soft
    # 评分不可用时主分一律记 0：宁可保守低估，也不要因为把异常条目排除在分母之外
    # 而把剩下的条目重新归一化成一个虚高的分数。真实分数留在 graded_score 里。
    unavailable = not graded_ok
    result["reward"] = 0.0 if unavailable else score
    # 平台读取：1 = 本次评分不可信（判官限额/超时/评分器异常），须重评而非记零分。
    result["verifier_error"] = 1.0 if unavailable else 0.0
    return result


def main() -> int:
    # 被 rewardkit discover() import 时不得有副作用：它会把 tests/ 下所有 *.py
    # 都 import 一遍。若 argparse 留在模块级，import 即 SystemExit 杀死评分进程。
    parser = argparse.ArgumentParser()
    parser.add_argument("--graded", required=True)
    parser.add_argument("--graded-rc", type=int, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    try:
        result = compute(args)
    except Exception:
        # 未预期的异常也必须落地一份结果：缺了 reward.json，平台读到的是"这道题没跑过"，
        # 与"跑出 0 分"无法区分。一律记 verifier_error = 1 交平台重评。
        result = {"graded_score": 0.0, "criteria_counted": 0.0,
                  "reward": 0.0, "verifier_error": 1.0}

    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- AP 标准化输出 ----
    # reward.txt：单一数值（覆盖 test.sh 开头的 fail-closed 占位）。
    out_path.with_name("reward.txt").write_text(
        f"{result.get('reward', 0.0)}\n", encoding="utf-8")
    # reward_exit_message.json：仅评分不可用时存在；成功则删除 fail-closed 占位。
    exit_path = out_path.with_name("reward_exit_message.json")
    if result.get("verifier_error"):
        try:
            code, reason = classify_exit(args, result)
        except Exception:
            code, reason = "judge:unknown", "classification itself failed"
        exit_path.write_text(json.dumps({
            "exit_code": code,
            "exit_reason": reason,
            "extra_fields": {
                "criteria_counted": result.get("criteria_counted", 0.0),
                "graded_score": result.get("graded_score", 0.0),
                "rewardkit_rc": args.graded_rc,
            },
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        exit_path.unlink(missing_ok=True)
    # reward-details.json：逐条明细随主分一并落到 out 同目录（rewardkit 写在
    # --output 旁的 graded/ 子目录）。审计便利件，不参与 fail-closed 契约：
    # 缺失或拷贝失败不影响主分与错误码归类，静默跳过。
    graded_details = pathlib.Path(args.graded).with_name("reward-details.json")
    if graded_details.is_file():
        try:
            out_path.with_name("reward-details.json").write_text(
                graded_details.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            pass
    # 退出码恒 0：评分不可用由 reward.json 的 verifier_error 承载，
    # 非零退出会被平台当成 finalize 自身崩溃、丢掉已写好的结果。
    return 0


if __name__ == "__main__":
    sys.exit(main())
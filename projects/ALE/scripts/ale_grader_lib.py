#!/usr/bin/env python3
"""
职责：ALE 标准公共判分底座库（随每题自动打入私有 tests/ale_grader_lib.py，Agent 执行期绝对不可见）。
主要公开入口：
  - ExcelEvaluator：支持 LibreOffice（若存在）与纯 Python OOXML + 惰性 AST 公式求值双引擎，
    完整支持跨表引用、$A$1、A1:B50 区间、整列裁剪、共享公式 t="shared"、全套数学/统计/逻辑/查找/日期函数
    （含 WEEKDAY/EDATE/EOMONTH/DATEDIF/WORKDAY/SUMIFS/XLOOKUP/_xlfn.* 等）、百分比 %、^ 幂运算、合法零公式 =0，
    以及安全的内存/进程微扰动联动断言 probe() 与不锁行号的主键检索 find_row_metric()。
  - DocxExtractor：纯标准库解析 .docx 段落全文与任意多列表格，按行首主键提取首个数值列（天然兼容模型自加第 3+ 列备注/来源/单位），
    枚举结论归一化空白与标点提取（拒绝 ^ 截断误杀）。
  - GradeReporter / SubCheck / verify_frozen_inputs：统一输出符合《ALE 数据交付技术规范》第 7 节的 grade.json，
    支持组内连续比例计分、关键门控分层判定、只读输入 SHA-256 校验与 Canary 检查。
调用方：各题 tests/grade.py 直接 `from ale_grader_lib import ExcelEvaluator, DocxExtractor, GradeReporter, SubCheck, verify_frozen_inputs`。
"""
from __future__ import annotations

import argparse
import calendar
import copy
import datetime as _dt
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_UP, ROUND_UP
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

EXCEL_EPOCH = _dt.date(1899, 12, 30)
EXCEL_ERRORS = frozenset({"#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#CYCLE!", "#SYNTAX!"})


class ExcelError(Exception):
    def __init__(self, code: str = "#VALUE!", detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code if code.startswith("#") else f"#{code}"
        self.detail = detail


def is_excel_error(val: Any) -> bool:
    return isinstance(val, str) and (val in EXCEL_ERRORS or val.startswith("#ERR") or val.startswith("#FUNC:"))


# ---------------------------------------------------------------------------
# 坐标与引用工具
# ---------------------------------------------------------------------------

_CELL_RE = re.compile(r"^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$")
_COL_ONLY_RE = re.compile(r"^(\$?)([A-Za-z]{1,3})$")


def col_to_index(col_str: str) -> int:
    idx = 0
    for ch in col_str.upper():
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx


def index_to_col(idx: int) -> str:
    if idx < 1:
        raise ValueError(f"Invalid column index: {idx}")
    chars: list[str] = []
    n = idx
    while n > 0:
        n, rem = divmod(n - 1, 26)
        chars.append(chr(ord("A") + rem))
    return "".join(reversed(chars))


def split_cell_coord(coord: str) -> tuple[int, int, bool, bool]:
    m = _CELL_RE.match(coord.strip())
    if not m:
        raise ValueError(f"Invalid cell coordinate: {coord!r}")
    abs_col, col_s, abs_row, row_s = m.groups()
    return col_to_index(col_s), int(row_s), bool(abs_col), bool(abs_row)


def normalize_coord(coord: str) -> str:
    c, r, _, _ = split_cell_coord(coord)
    return f"{index_to_col(c)}{r}"


_REF_SHIFT_RE = re.compile(
    r"""(?P<str>"(?:""|[^"])*")|(?P<sheet>(?:'(?:''|[^'])+'|[A-Za-z0-9_\u4e00-\u9fff.]+)!)?(?P<c1>\$?[A-Za-z]{1,3})(?P<r1>\$?\d+)(?::(?P<c2>\$?[A-Za-z]{1,3})(?P<r2>\$?\d+))?(?![A-Za-z0-9_(])"""
)


def shift_formula_references(formula: str, d_col: int, d_row: int) -> str:
    if d_col == 0 and d_row == 0:
        return formula

    def _shift_single(col_part: str, row_part: str) -> str:
        abs_c = col_part.startswith("$")
        raw_c = col_part[1:] if abs_c else col_part
        abs_r = row_part.startswith("$")
        raw_r = int(row_part[1:] if abs_r else row_part)
        new_c = col_to_index(raw_c) if abs_c else max(1, col_to_index(raw_c) + d_col)
        new_r = raw_r if abs_r else max(1, raw_r + d_row)
        return f"{'$' if abs_c else ''}{index_to_col(new_c)}{'$' if abs_r else ''}{new_r}"

    def _repl(m: re.Match[str]) -> str:
        if m.group("str") is not None:
            return m.group("str")
        prefix = m.group("sheet") or ""
        left = _shift_single(m.group("c1"), m.group("r1"))
        if m.group("c2") and m.group("r2"):
            right = _shift_single(m.group("c2"), m.group("r2"))
            return f"{prefix}{left}:{right}"
        return f"{prefix}{left}"

    return _REF_SHIFT_RE.sub(_repl, formula)


# ---------------------------------------------------------------------------
# 日期与数值转换原语（兼容 Excel 1900 序列号与中文/ISO 日期字符串）
# ---------------------------------------------------------------------------

_ISO_DATE_RE = re.compile(
    r"^\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?\s*$"
)


def date_to_excel_serial(d: _dt.date) -> int:
    if isinstance(d, _dt.datetime):
        d = d.date()
    serial = (d - EXCEL_EPOCH).days
    if d < _dt.date(1900, 3, 1):
        serial -= 1
    return serial


def excel_serial_to_date(serial: float | int) -> _dt.date:
    s = int(math.floor(float(serial) + 1e-9))
    if s == 60:
        return _dt.date(1900, 2, 28)
    if s < 60:
        return _dt.date(1899, 12, 31) + _dt.timedelta(days=s)
    return EXCEL_EPOCH + _dt.timedelta(days=s)


def try_parse_date_text(text: str) -> _dt.date | None:
    m = _ISO_DATE_RE.match(text)
    if not m:
        return None
    y, mo, da = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return _dt.date(y, mo, da)
    except ValueError:
        return None


def coerce_to_date(val: Any) -> _dt.date:
    if is_excel_error(val):
        raise ExcelError(str(val))
    if isinstance(val, _dt.datetime):
        return val.date()
    if isinstance(val, _dt.date):
        return val
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        if not math.isfinite(val) or val < 1:
            raise ExcelError("#NUM!", f"Invalid date serial: {val}")
        return excel_serial_to_date(val)
    if isinstance(val, str):
        dt = try_parse_date_text(val)
        if dt is not None:
            return dt
        try:
            num = float(val.replace(",", "").strip())
            return excel_serial_to_date(num)
        except ValueError:
            pass
    raise ExcelError("#VALUE!", f"Cannot convert {val!r} to date")


def coerce_to_serial(val: Any) -> float:
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    return float(date_to_excel_serial(coerce_to_date(val)))


def coerce_to_number(val: Any, blank_as_zero: bool = True) -> float:
    if is_excel_error(val):
        raise ExcelError(str(val))
    if val is None or val == "":
        if blank_as_zero:
            return 0.0
        raise ExcelError("#VALUE!", "Blank cannot coerce to number")
    if isinstance(val, bool):
        return 1.0 if val else 0.0
    if isinstance(val, (int, float)):
        if not math.isfinite(val):
            raise ExcelError("#NUM!")
        return float(val)
    if isinstance(val, (_dt.date, _dt.datetime)):
        return float(date_to_excel_serial(val))
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return 0.0 if blank_as_zero else (_ for _ in ()).throw(ExcelError("#VALUE!"))
        dt = try_parse_date_text(s)
        if dt is not None:
            return float(date_to_excel_serial(dt))
        cleaned = s.replace(",", "").replace("¥", "").replace("￥", "")
        if cleaned.endswith("%"):
            try:
                return float(cleaned[:-1]) / 100.0
            except ValueError:
                pass
        try:
            return float(cleaned)
        except ValueError as exc:
            raise ExcelError("#VALUE!", f"Cannot parse number: {val!r}") from exc
    raise ExcelError("#VALUE!", f"Unsupported type: {type(val)}")


def coerce_to_bool(val: Any) -> bool:
    if is_excel_error(val):
        raise ExcelError(str(val))
    if isinstance(val, bool):
        return val
    if val is None or val == "":
        return False
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        up = val.strip().upper()
        if up == "TRUE":
            return True
        if up == "FALSE":
            return False
    raise ExcelError("#VALUE!", f"Cannot convert {val!r} to bool")


def excel_round(val: float, digits: int = 0, mode: str = "half_up") -> float:
    if not math.isfinite(val):
        raise ExcelError("#NUM!")
    d_digits = int(math.trunc(digits))
    try:
        dec = Decimal(str(val))
        quant = Decimal(10) ** (-d_digits)
        rounding = {"half_up": ROUND_HALF_UP, "up": ROUND_UP, "down": ROUND_DOWN}[mode]
        res = float(dec.quantize(quant, rounding=rounding))
        return 0.0 if res == 0.0 else res
    except (InvalidOperation, OverflowError) as exc:
        raise ExcelError("#NUM!") from exc


# ---------------------------------------------------------------------------
# Excel 公式词法分析与递归下降语法树（支持惰性求值）
# ---------------------------------------------------------------------------

@dataclass
class Token:
    kind: str  # NUM, STR, BOOL, ERR, REF, IDENT, OP, LPAREN, RPAREN, LBRACE, RBRACE, COMMA, SEMI, EOF
    value: str


_ERROR_LITERALS = ("#GETTING_DATA", "#DIV/0!", "#VALUE!", "#NAME?", "#NULL!", "#REF!", "#NUM!", "#N/A")


def tokenize_excel_formula(expr: str) -> list[Token]:
    s = expr.strip()
    if s.startswith("="):
        s = s[1:].lstrip()
    tokens: list[Token] = []
    i = 0
    n = len(s)

    while i < n:
        ch = s[i]
        if ch in " \t\r\n":
            i += 1
            continue
        if ch == '"':
            j = i + 1
            buf: list[str] = []
            while j < n:
                if s[j] == '"':
                    if j + 1 < n and s[j + 1] == '"':
                        buf.append('"')
                        j += 2
                        continue
                    j += 1
                    break
                buf.append(s[j])
                j += 1
            tokens.append(Token("STR", "".join(buf)))
            i = j
            continue
        if ch == "#":
            matched_err = None
            up_tail = s[i:].upper()
            for lit in _ERROR_LITERALS:
                if up_tail.startswith(lit):
                    matched_err = lit
                    break
            if matched_err:
                tokens.append(Token("ERR", matched_err))
                i += len(matched_err)
                continue
        if ch == "'":
            # 单引号包裹的工作表引用：'Sheet Name'!$A$1:$B$10
            j = i + 1
            sheet_buf: list[str] = []
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'":
                        sheet_buf.append("'")
                        j += 2
                        continue
                    j += 1
                    break
                sheet_buf.append(s[j])
                j += 1
            if j < n and s[j] == "!":
                j += 1
                ref_start = j
                while j < n and (s[j].isalnum() or s[j] in "$:"):
                    j += 1
                coord_part = s[ref_start:j]
                tokens.append(Token("REF", f"'{''.join(sheet_buf)}'!{coord_part}"))
                i = j
                continue
            raise ExcelError("#SYNTAX!", f"Malformed quoted sheet reference near: {s[i:i+25]!r}")
        if ch.isdigit() or (ch == "." and i + 1 < n and s[i + 1].isdigit()):
            j = i
            while j < n and (s[j].isdigit() or s[j] == "."):
                j += 1
            if j < n and s[j] in "eE":
                k = j + 1
                if k < n and s[k] in "+-":
                    k += 1
                if k < n and s[k].isdigit():
                    j = k + 1
                    while j < n and s[j].isdigit():
                        j += 1
            # 处理未加单引号但以数字开头的工作表名，如 2020分段!A1
            if j < n and (s[j] == "!" or (not s[i:j].replace(".", "").isdigit())):
                pass
            elif j < n and (s[j].isalpha() or ord(s[j]) > 127 or s[j] in "_-"):
                # 可能是无引号表名如 1_本金表!B2 或 2020前!B2
                k = j
                while k < n and (s[k].isalnum() or ord(s[k]) > 127 or s[k] in "_-."):
                    k += 1
                if k < n and s[k] == "!":
                    sheet_name = s[i:k]
                    k += 1
                    r_start = k
                    while k < n and (s[k].isalnum() or s[k] in "$:"):
                        k += 1
                    tokens.append(Token("REF", f"'{sheet_name}'!{s[r_start:k]}"))
                    i = k
                    continue
            tokens.append(Token("NUM", s[i:j]))
            i = j
            continue
        if s[i : i + 2] in ("<>", "<=", ">="):
            tokens.append(Token("OP", s[i : i + 2]))
            i += 2
            continue
        if ch in "+-*/^&=<>%":
            tokens.append(Token("OP", ch))
            i += 1
            continue
        if ch == "(":
            tokens.append(Token("LPAREN", ch))
            i += 1
            continue
        if ch == ")":
            tokens.append(Token("RPAREN", ch))
            i += 1
            continue
        if ch == "{":
            tokens.append(Token("LBRACE", ch))
            i += 1
            continue
        if ch == "}":
            tokens.append(Token("RBRACE", ch))
            i += 1
            continue
        if ch == ",":
            tokens.append(Token("COMMA", ch))
            i += 1
            continue
        if ch == ";":
            tokens.append(Token("SEMI", ch))
            i += 1
            continue
        # 标识符、函数名、布尔值、无引号跨表引用或单元格/区间引用
        if ch.isalpha() or ch in "$_" or ord(ch) > 127:
            j = i
            while j < n and (s[j].isalnum() or s[j] in "$_." or ord(s[j]) > 127):
                j += 1
            if j < n and s[j] == "!":
                sheet_name = s[i:j]
                j += 1
                r_start = j
                while j < n and (s[j].isalnum() or s[j] in "$:"):
                    j += 1
                tokens.append(Token("REF", f"'{sheet_name}'!{s[r_start:j]}"))
                i = j
                continue
            if j < n and s[j] == ":":
                j += 1
                while j < n and (s[j].isalnum() or s[j] == "$"):
                    j += 1
                tokens.append(Token("REF", s[i:j]))
                i = j
                continue
            word = s[i:j]
            # 紧跟 '(' 则为函数调用
            k = j
            while k < n and s[k] in " \t":
                k += 1
            if k < n and s[k] == "(":
                tokens.append(Token("IDENT", word))
            elif word.upper() in ("TRUE", "FALSE"):
                tokens.append(Token("BOOL", word.upper()))
            elif _CELL_RE.match(word):
                tokens.append(Token("REF", word))
            else:
                tokens.append(Token("IDENT", word))
            i = j
            continue
        raise ExcelError("#SYNTAX!", f"Unexpected character {ch!r} in formula {expr!r}")

    tokens.append(Token("EOF", ""))
    return tokens


# AST 节点类型（轻量元组表示，极速且易调试）
@dataclass
class RangeValue:
    sheet: str
    c1: int
    r1: int
    c2: int
    r2: int
    values: list[list[Any]]  # 2D [row][col]

    def flat(self) -> list[Any]:
        return [cell for row in self.values for cell in row]


class FormulaParser:
    def __init__(self, tokens: list[Token]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token:
        return self.tokens[self.pos]

    def consume(self, expected_kind: str | None = None) -> Token:
        tok = self.tokens[self.pos]
        if expected_kind and tok.kind != expected_kind:
            raise ExcelError("#SYNTAX!", f"Expected {expected_kind}, got {tok}")
        self.pos += 1
        return tok

    def parse(self) -> tuple[Any, ...]:
        node = self.parse_comparison()
        if self.peek().kind != "EOF":
            raise ExcelError("#SYNTAX!", f"Trailing token: {self.peek()}")
        return node

    def parse_comparison(self) -> tuple[Any, ...]:
        node = self.parse_concat()
        while self.peek().kind == "OP" and self.peek().value in ("=", "<>", "<", "<=", ">", ">="):
            op = self.consume().value
            right = self.parse_concat()
            node = ("binop", op, node, right)
        return node

    def parse_concat(self) -> tuple[Any, ...]:
        node = self.parse_additive()
        while self.peek().kind == "OP" and self.peek().value == "&":
            op = self.consume().value
            right = self.parse_additive()
            node = ("binop", op, node, right)
        return node

    def parse_additive(self) -> tuple[Any, ...]:
        node = self.parse_multiplicative()
        while self.peek().kind == "OP" and self.peek().value in ("+", "-"):
            op = self.consume().value
            right = self.parse_multiplicative()
            node = ("binop", op, node, right)
        return node

    def parse_multiplicative(self) -> tuple[Any, ...]:
        node = self.parse_power()
        while self.peek().kind == "OP" and self.peek().value in ("*", "/"):
            op = self.consume().value
            right = self.parse_power()
            node = ("binop", op, node, right)
        return node

    def parse_power(self) -> tuple[Any, ...]:
        node = self.parse_unary()
        while self.peek().kind == "OP" and self.peek().value == "^":
            self.consume()
            right = self.parse_unary()
            node = ("binop", "^", node, right)
        return node

    def parse_unary(self) -> tuple[Any, ...]:
        if self.peek().kind == "OP" and self.peek().value in ("+", "-"):
            op = self.consume().value
            operand = self.parse_unary()
            return ("unary", op, operand)
        return self.parse_postfix()

    def parse_postfix(self) -> tuple[Any, ...]:
        node = self.parse_primary()
        while self.peek().kind == "OP" and self.peek().value == "%":
            self.consume()
            node = ("percent", node)
        return node

    def parse_primary(self) -> tuple[Any, ...]:
        tok = self.peek()
        if tok.kind == "NUM":
            self.consume()
            return ("lit", float(tok.value))
        if tok.kind == "STR":
            self.consume()
            return ("lit", tok.value)
        if tok.kind == "BOOL":
            self.consume()
            return ("lit", tok.value == "TRUE")
        if tok.kind == "ERR":
            self.consume()
            return ("err", tok.value)
        if tok.kind == "REF":
            self.consume()
            return ("ref", tok.value)
        if tok.kind == "LPAREN":
            self.consume("LPAREN")
            inner = self.parse_comparison()
            self.consume("RPAREN")
            return inner
        if tok.kind == "LBRACE":
            self.consume("LBRACE")
            rows: list[list[tuple[Any, ...]]] = [[]]
            if self.peek().kind != "RBRACE":
                rows[-1].append(self.parse_comparison())
                while self.peek().kind in ("COMMA", "SEMI"):
                    sep = self.consume().kind
                    if sep == "SEMI":
                        rows.append([])
                    rows[-1].append(self.parse_comparison())
            self.consume("RBRACE")
            return ("array", rows)
        if tok.kind == "IDENT":
            name = self.consume().value
            if self.peek().kind == "LPAREN":
                self.consume("LPAREN")
                args: list[tuple[Any, ...]] = []
                if self.peek().kind != "RPAREN":
                    if self.peek().kind == "COMMA":
                        args.append(("lit", None))
                    else:
                        args.append(self.parse_comparison())
                    while self.peek().kind == "COMMA":
                        self.consume("COMMA")
                        if self.peek().kind in ("COMMA", "RPAREN"):
                            args.append(("lit", None))
                        else:
                            args.append(self.parse_comparison())
                self.consume("RPAREN")
                return ("call", name, args)
            return ("name", name)
        raise ExcelError("#SYNTAX!", f"Unexpected token in primary: {tok}")


# ---------------------------------------------------------------------------
# 工作表与工作簿模型 + 纯 Python / LibreOffice 双引擎求值器
# ---------------------------------------------------------------------------

@dataclass
class CellData:
    coord: str
    value: Any = None
    formula: str | None = None
    data_type: str = "n"  # n, s, b, e, d, inlineStr, str


@dataclass
class SheetModel:
    name: str
    cells: dict[str, CellData] = field(default_factory=dict)
    max_row: int = 1
    max_col: int = 1


_NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_NS_REL_ATTR = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def _norm_label(text: Any) -> str:
    s = str(text or "").strip()
    s = re.sub(r"^[（(]?[一二三四五六七八九十\d]+[)）、.．\s]+", "", s)
    s = re.sub(r"[\s:：—\-–_]+", "", s)
    return s.lower()


def _strip_unit_paren(label: str) -> str:
    return re.sub(r"[（(][^）)]*(?:元|万元|%|％|天|日|年|人民币|RMB|口径|单位)[^）)]*[）)]", "", label)


def _match_criteria(cell_val: Any, criteria: Any) -> bool:
    if is_excel_error(cell_val):
        return False
    if isinstance(criteria, (int, float)) and not isinstance(criteria, bool):
        try:
            return abs(coerce_to_number(cell_val, blank_as_zero=False) - float(criteria)) <= 1e-9
        except ExcelError:
            return False
    if isinstance(criteria, bool):
        return isinstance(cell_val, bool) and cell_val == criteria
    crit_s = str(criteria if criteria is not None else "")
    m = re.match(r"^(<>|<=|>=|=|<|>)(.*)$", crit_s.strip())
    op = "="
    rhs_raw = crit_s
    if m:
        op, rhs_raw = m.group(1), m.group(2).strip()
    if rhs_raw == "":
        is_empty = cell_val is None or cell_val == ""
        return (not is_empty) if op == "<>" else (is_empty if op == "=" else False)
    # 尝试按数值或日期序列号比较
    rhs_num: float | None = None
    try:
        rhs_num = coerce_to_number(rhs_raw, blank_as_zero=False)
    except ExcelError:
        rhs_num = None

    if rhs_num is not None:
        try:
            lhs_num = coerce_to_number(cell_val, blank_as_zero=False)
            if op == "=":
                return abs(lhs_num - rhs_num) <= 1e-9
            if op == "<>":
                return abs(lhs_num - rhs_num) > 1e-9
            if op == "<":
                return lhs_num < rhs_num - 1e-12
            if op == "<=":
                return lhs_num <= rhs_num + 1e-12
            if op == ">":
                return lhs_num > rhs_num + 1e-12
            if op == ">=":
                return lhs_num >= rhs_num - 1e-12
        except ExcelError:
            return op == "<>"

    lhs_s = str(cell_val if cell_val is not None else "").strip()
    if op in ("=", "<>") and ("*" in rhs_raw or "?" in rhs_raw):
        pat = "^" + re.escape(rhs_raw).replace(r"\*", ".*").replace(r"\?", ".") + "$"
        matched = bool(re.match(pat, lhs_s, flags=re.IGNORECASE))
        return matched if op == "=" else not matched
    lhs_low, rhs_low = lhs_s.lower(), rhs_raw.strip().lower()
    if op == "=":
        return lhs_low == rhs_low
    if op == "<>":
        return lhs_low != rhs_low
    if op == "<":
        return lhs_low < rhs_low
    if op == "<=":
        return lhs_low <= rhs_low
    if op == ">":
        return lhs_low > rhs_low
    if op == ">=":
        return lhs_low >= rhs_low
    return False


class ExcelEvaluator:
    """支持纯 Python OOXML+AST 与可选 LibreOffice 无头重算的双引擎 Excel 核验器。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        if not self.path.is_file():
            raise FileNotFoundError(f"XLSX file not found: {self.path}")
        self.sheets: dict[str, SheetModel] = {}
        self.sheet_order: list[str] = []
        self.defined_names: dict[str, tuple[str | None, str]] = {}
        self._ast_cache: dict[str, tuple[Any, ...]] = {}
        self._eval_cache: dict[tuple[str, str], Any] = {}
        self._evaluating: set[tuple[str, str]] = set()
        self._date_xf_indices: set[int] = set()
        self._load_ooxml()

    def _load_ooxml(self) -> None:
        with zipfile.ZipFile(self.path, "r") as zf:
            names = set(zf.namelist())
            if "xl/workbook.xml" not in names:
                raise ValueError(f"Invalid XLSX (missing xl/workbook.xml): {self.path}")

            # 1. sharedStrings.xml
            shared_strings: list[str] = []
            if "xl/sharedStrings.xml" in names:
                ss_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in ss_root.findall(f"{_NS_MAIN}si"):
                    parts = [t.text or "" for t in si.iter(f"{_NS_MAIN}t")]
                    shared_strings.append("".join(parts))

            # 2. styles.xml（识别内建及自定义日期格式 xf 索引）
            if "xl/styles.xml" in names:
                try:
                    st_root = ET.fromstring(zf.read("xl/styles.xml"))
                    custom_date_fmts: set[int] = set()
                    for nf in st_root.iter(f"{_NS_MAIN}numFmt"):
                        fmt_id = int(nf.attrib.get("numFmtId", "0"))
                        code = nf.attrib.get("formatCode", "").lower()
                        cleaned_code = re.sub(r'"[^"]*"|\[[^\]]*\]', "", code)
                        if any(tok in cleaned_code for tok in ("yy", "mm", "dd", "年", "月", "日")) and "#" not in cleaned_code and "0.0" not in cleaned_code:
                            custom_date_fmts.add(fmt_id)
                    builtin_dates = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))
                    cell_xfs = st_root.find(f"{_NS_MAIN}cellXfs")
                    if cell_xfs is not None:
                        for idx, xf in enumerate(cell_xfs.findall(f"{_NS_MAIN}xf")):
                            nf_id = int(xf.attrib.get("numFmtId", "0"))
                            if nf_id in builtin_dates or nf_id in custom_date_fmts:
                                self._date_xf_indices.add(idx)
                except Exception:
                    pass

            # 3. workbook.xml & _rels
            rels_map: dict[str, str] = {}
            if "xl/_rels/workbook.xml.rels" in names:
                rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
                for rel in rels_root:
                    rid = rel.attrib.get("Id", "")
                    target = rel.attrib.get("Target", "").lstrip("/")
                    if not target.startswith("xl/"):
                        target = f"xl/{target}"
                    rels_map[rid] = target

            wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
            sheets_el = wb_root.find(f"{_NS_MAIN}sheets")
            sheet_entries: list[tuple[str, str]] = []
            if sheets_el is not None:
                for idx, sh in enumerate(sheets_el.findall(f"{_NS_MAIN}sheet")):
                    sh_name = sh.attrib.get("name", f"Sheet{idx + 1}")
                    rid = sh.attrib.get(_NS_REL_ATTR, "")
                    target = rels_map.get(rid, f"xl/worksheets/sheet{idx + 1}.xml")
                    sheet_entries.append((sh_name, target))

            defined_el = wb_root.find(f"{_NS_MAIN}definedNames")
            if defined_el is not None:
                for dn in defined_el.findall(f"{_NS_MAIN}definedName"):
                    dn_name = dn.attrib.get("name", "").strip()
                    if not dn_name or dn_name.startswith("_xlnm."):
                        continue
                    local_id = dn.attrib.get("localSheetId")
                    scope_sheet = sheet_entries[int(local_id)][0] if (local_id is not None and local_id.isdigit() and int(local_id) < len(sheet_entries)) else None
                    if dn.text and dn.text.strip():
                        self.defined_names[dn_name.upper()] = (scope_sheet, dn.text.strip())

            # 4. 各工作表解析（含共享公式展开）
            for sh_name, target in sheet_entries:
                self.sheet_order.append(sh_name)
                model = SheetModel(name=sh_name)
                if target not in names:
                    self.sheets[sh_name] = model
                    continue
                ws_root = ET.fromstring(zf.read(target))
                shared_masters: dict[str, tuple[int, int, str]] = {}
                pending_shared_slaves: list[tuple[CellData, str, int, int]] = []

                for row_idx, row_el in enumerate(ws_root.iter(f"{_NS_MAIN}row"), start=1):
                    r_num = int(row_el.attrib.get("r", str(row_idx)))
                    for col_idx, c_el in enumerate(row_el.findall(f"{_NS_MAIN}c"), start=1):
                        raw_ref = c_el.attrib.get("r")
                        if raw_ref:
                            c_num, r_num, _, _ = split_cell_coord(raw_ref)
                            coord = f"{index_to_col(c_num)}{r_num}"
                        else:
                            c_num = col_idx
                            coord = f"{index_to_col(c_num)}{r_num}"
                        model.max_row = max(model.max_row, r_num)
                        model.max_col = max(model.max_col, c_num)

                        c_type = c_el.attrib.get("t", "n")
                        f_el = c_el.find(f"{_NS_MAIN}f")
                        v_el = c_el.find(f"{_NS_MAIN}v")
                        is_el = c_el.find(f"{_NS_MAIN}is")

                        val: Any = None
                        if c_type == "s" and v_el is not None and v_el.text is not None:
                            s_idx = int(v_el.text.strip())
                            val = shared_strings[s_idx] if 0 <= s_idx < len(shared_strings) else ""
                        elif c_type == "inlineStr" and is_el is not None:
                            val = "".join(t.text or "" for t in is_el.iter(f"{_NS_MAIN}t"))
                        elif c_type == "b" and v_el is not None and v_el.text is not None:
                            val = v_el.text.strip() in ("1", "true", "TRUE")
                        elif c_type in ("str", "e") and v_el is not None:
                            val = v_el.text or ""
                        elif c_type == "d" and v_el is not None and v_el.text:
                            dt = try_parse_date_text(v_el.text[:10])
                            val = float(date_to_excel_serial(dt)) if dt else v_el.text
                        elif v_el is not None and v_el.text is not None and v_el.text.strip() != "":
                            raw_v = v_el.text.strip()
                            try:
                                num_v = float(raw_v)
                                val = int(num_v) if num_v.is_integer() and "." not in raw_v and "e" not in raw_v.lower() else num_v
                            except ValueError:
                                val = raw_v

                        formula_str: str | None = None
                        if f_el is not None:
                            f_type = f_el.attrib.get("t", "")
                            si = f_el.attrib.get("si", "")
                            f_text = (f_el.text or "").strip()
                            if f_type == "shared" and si != "":
                                if f_text:
                                    shared_masters[si] = (c_num, r_num, f_text)
                                    formula_str = f_text
                                else:
                                    cell_obj = CellData(coord=coord, value=val, formula=None, data_type=c_type)
                                    model.cells[coord] = cell_obj
                                    pending_shared_slaves.append((cell_obj, si, c_num, r_num))
                                    continue
                            elif f_text:
                                formula_str = f_text

                        model.cells[coord] = CellData(coord=coord, value=val, formula=formula_str, data_type=c_type)

                for slave_cell, si, c_num, r_num in pending_shared_slaves:
                    master = shared_masters.get(si)
                    if master is not None:
                        mc, mr, mf = master
                        slave_cell.formula = shift_formula_references(mf, c_num - mc, r_num - mr)

                self.sheets[sh_name] = model

    def resolve_sheet_name(self, name: str | None) -> str:
        if not name:
            if not self.sheet_order:
                raise ExcelError("#REF!", "Workbook has no sheets")
            return self.sheet_order[0]
        cleaned = name.strip()
        if cleaned.startswith("'") and cleaned.endswith("'"):
            cleaned = cleaned[1:-1].replace("''", "'")
        if cleaned in self.sheets:
            return cleaned
        low = cleaned.lower()
        for k in self.sheet_order:
            if k.lower() == low:
                return k
        raise ExcelError("#REF!", f"Unknown sheet: {name!r}")

    def get_cell_data(self, sheet: str | None, coord: str) -> CellData | None:
        sh = self.resolve_sheet_name(sheet)
        return self.sheets[sh].cells.get(normalize_coord(coord))

    def get_formula(self, sheet: str | None, coord: str) -> str | None:
        cd = self.get_cell_data(sheet, coord)
        if cd and cd.formula is not None:
            return cd.formula if cd.formula.startswith("=") else f"={cd.formula}"
        return None

    def has_formula(self, sheet: str | None, coord: str) -> bool:
        return self.get_formula(sheet, coord) is not None

    def get_cached_value(self, sheet: str | None, coord: str) -> Any:
        cd = self.get_cell_data(sheet, coord)
        return cd.value if cd else None

    def formula_references_cells(self, sheet: str | None, coord: str) -> bool:
        """检查单元格公式是否引用了至少一个单元格或定义了合法零值表达式（拦截 =90000+0 伪公式）。"""
        f = self.get_formula(sheet, coord)
        if not f:
            return False
        toks = tokenize_excel_formula(f)
        if any(t.kind == "REF" for t in toks):
            return True
        if any(t.kind == "IDENT" and t.value.upper() in self.defined_names for t in toks):
            return True
        return False

    def is_live_formula(self, sheet: str | None, coord: str, allow_zero_literal: bool = True) -> bool:
        """
        判断单元格是否为真实活公式：
        - 引用了上游单元格/命名区域的公式 -> True；
        - 当重算结果恰为 0 且 allow_zero_literal=True 时，允许 `=0` 等显式零值公式 -> True；
        - 非零纯常量表达式（如 `=90000+0`、`=IF(1=1,90000,0)`）-> False（拦截 M02 伪公式作弊）。
        """
        f = self.get_formula(sheet, coord)
        if not f:
            return False
        if self.formula_references_cells(sheet, coord):
            return True
        if allow_zero_literal:
            val = self.evaluate_cell(sheet, coord)
            if isinstance(val, (int, float)) and not isinstance(val, bool) and abs(float(val)) <= 1e-9:
                return True
        return False

    def evaluate_cell(self, sheet: str | None, coord: str) -> Any:
        sh = self.resolve_sheet_name(sheet)
        norm_c = normalize_coord(coord)
        key = (sh, norm_c)
        if key in self._eval_cache:
            return self._eval_cache[key]
        if key in self._evaluating:
            return "#CYCLE!"

        cd = self.sheets[sh].cells.get(norm_c)
        if cd is None:
            return None
        if cd.formula is None:
            self._eval_cache[key] = cd.value
            return cd.value

        self._evaluating.add(key)
        try:
            ast_root = self._ast_cache.get(cd.formula)
            if ast_root is None:
                tokens = tokenize_excel_formula(cd.formula)
                ast_root = FormulaParser(tokens).parse()
                self._ast_cache[cd.formula] = ast_root
            res = self._eval_node(ast_root, sh, norm_c)
            if isinstance(res, RangeValue):
                flat = res.flat()
                res = flat[0] if flat else None
        except ExcelError as err:
            res = err.code
        except ZeroDivisionError:
            res = "#DIV/0!"
        except Exception:
            res = "#VALUE!"
        finally:
            self._evaluating.discard(key)

        self._eval_cache[key] = res
        return res

    def evaluate_all(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for sh in self.sheet_order:
            sh_res: dict[str, Any] = {}
            for coord in self.sheets[sh].cells:
                sh_res[coord] = self.evaluate_cell(sh, coord)
            out[sh] = sh_res
        return out

    def _parse_ref_spec(self, ref_text: str, current_sheet: str) -> RangeValue:
        target_sheet = current_sheet
        coord_part = ref_text.strip()
        if "!" in coord_part:
            sh_raw, coord_part = coord_part.rsplit("!", 1)
            target_sheet = self.resolve_sheet_name(sh_raw)
        sh_model = self.sheets[target_sheet]

        if ":" in coord_part:
            left_s, right_s = coord_part.split(":", 1)
            m_col1, m_col2 = _COL_ONLY_RE.match(left_s.strip()), _COL_ONLY_RE.match(right_s.strip())
            if m_col1 and m_col2:
                c1 = col_to_index(m_col1.group(2))
                c2 = col_to_index(m_col2.group(2))
                r1, r2 = 1, max(1, sh_model.max_row)
            else:
                c1, r1, _, _ = split_cell_coord(left_s)
                c2, r2, _, _ = split_cell_coord(right_s)
                r2 = min(r2, max(r1, sh_model.max_row + 50))
        else:
            c1, r1, _, _ = split_cell_coord(coord_part)
            c2, r2 = c1, r1

        c_min, c_max = min(c1, c2), max(c1, c2)
        r_min, r_max = min(r1, r2), max(r1, r2)
        vals: list[list[Any]] = []
        for r in range(r_min, r_max + 1):
            row_vals: list[Any] = []
            for c in range(c_min, c_max + 1):
                row_vals.append(self.evaluate_cell(target_sheet, f"{index_to_col(c)}{r}"))
            vals.append(row_vals)
        return RangeValue(sheet=target_sheet, c1=c_min, r1=r_min, c2=c_max, r2=r_max, values=vals)

    def _scalar(self, val: Any) -> Any:
        if isinstance(val, RangeValue):
            flat = val.flat()
            val = flat[0] if flat else None
        if is_excel_error(val):
            raise ExcelError(str(val))
        return val

    def _eval_node(self, node: tuple[Any, ...], current_sheet: str, current_coord: str, env: dict[str, Any] | None = None) -> Any:
        kind = node[0]
        if kind == "lit":
            return node[1]
        if kind == "err":
            raise ExcelError(node[1])
        if kind == "ref":
            rv = self._parse_ref_spec(node[1], current_sheet)
            if rv.c1 == rv.c2 and rv.r1 == rv.r2:
                return rv.values[0][0]
            return rv
        if kind == "name":
            nm = str(node[1]).upper()
            if env and nm in env:
                return env[nm]
            if nm in self.defined_names:
                scope_sh, target_expr = self.defined_names[nm]
                ast_dn = FormulaParser(tokenize_excel_formula(target_expr)).parse()
                return self._eval_node(ast_dn, scope_sh or current_sheet, current_coord, env)
            raise ExcelError("#NAME?", f"Unknown name: {node[1]}")
        if kind == "array":
            rows_ast = node[1]
            mat = [[self._eval_node(cell_ast, current_sheet, current_coord, env) for cell_ast in r] for r in rows_ast]
            return RangeValue(sheet=current_sheet, c1=1, r1=1, c2=len(mat[0]) if mat else 1, r2=len(mat), values=mat)
        if kind == "percent":
            v = coerce_to_number(self._scalar(self._eval_node(node[1], current_sheet, current_coord, env)))
            return v / 100.0
        if kind == "unary":
            op = node[1]
            v = coerce_to_number(self._scalar(self._eval_node(node[2], current_sheet, current_coord, env)))
            return -v if op == "-" else v
        if kind == "binop":
            op, left_n, right_n = node[1], node[2], node[3]
            lv = self._scalar(self._eval_node(left_n, current_sheet, current_coord, env))
            rv = self._scalar(self._eval_node(right_n, current_sheet, current_coord, env))
            if op == "&":
                ls = "" if lv is None else (str(int(lv)) if isinstance(lv, float) and lv.is_integer() else str(lv))
                rs = "" if rv is None else (str(int(rv)) if isinstance(rv, float) and rv.is_integer() else str(rv))
                return ls + rs
            if op in ("+", "-", "*", "/", "^"):
                ln = coerce_to_number(lv)
                rn = coerce_to_number(rv)
                if op == "+":
                    return ln + rn
                if op == "-":
                    return ln - rn
                if op == "*":
                    return ln * rn
                if op == "/":
                    if abs(rn) <= 1e-15:
                        raise ExcelError("#DIV/0!")
                    return ln / rn
                if op == "^":
                    return float(ln**rn)
            if op in ("=", "<>", "<", "<=", ">", ">="):
                return self._compare_values(lv, rv, op)
        if kind == "call":
            raw_fn = str(node[1]).upper()
            for prefix in ("_XLFN._XLWS.", "_XLFN.", "_XLWS."):
                if raw_fn.startswith(prefix):
                    raw_fn = raw_fn[len(prefix) :]
            args_ast: list[tuple[Any, ...]] = node[2]
            return self._eval_call(raw_fn, args_ast, current_sheet, current_coord, env)
        raise ExcelError("#SYNTAX!", f"Unknown AST node: {kind}")

    def _compare_values(self, lv: Any, rv: Any, op: str) -> bool:
        # 处理日期字符串与序列号混合比较（如 "2020-08-20" >= DATE(2020,8,20)）
        if isinstance(lv, str) and isinstance(rv, (int, float)) and not isinstance(rv, bool):
            dt = try_parse_date_text(lv)
            if dt is not None:
                lv = float(date_to_excel_serial(dt))
        elif isinstance(rv, str) and isinstance(lv, (int, float)) and not isinstance(lv, bool):
            dt = try_parse_date_text(rv)
            if dt is not None:
                rv = float(date_to_excel_serial(dt))

        l_norm = 0.0 if lv is None and isinstance(rv, (int, float)) else ("" if lv is None and isinstance(rv, str) else lv)
        r_norm = 0.0 if rv is None and isinstance(lv, (int, float)) else ("" if rv is None and isinstance(lv, str) else rv)

        if isinstance(l_norm, (int, float)) and not isinstance(l_norm, bool) and isinstance(r_norm, (int, float)) and not isinstance(r_norm, bool):
            diff = float(l_norm) - float(r_norm)
            if op == "=":
                return abs(diff) <= 1e-9
            if op == "<>":
                return abs(diff) > 1e-9
            if op == "<":
                return diff < -1e-12
            if op == "<=":
                return diff <= 1e-12
            if op == ">":
                return diff > 1e-12
            if op == ">=":
                return diff >= -1e-12

        if isinstance(l_norm, str) and isinstance(r_norm, str):
            a, b = l_norm.lower(), r_norm.lower()
            return {"=": a == b, "<>": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]

        eq = l_norm == r_norm
        if op == "=":
            return eq
        if op == "<>":
            return not eq
        # Excel 跨类型排序：数值 < 文本 < 布尔
        def _rank(x: Any) -> tuple[int, Any]:
            if x is None:
                return (0, 0)
            if isinstance(x, bool):
                return (3, int(x))
            if isinstance(x, (int, float)):
                return (1, float(x))
            return (2, str(x).lower())

        ra, rb = _rank(l_norm), _rank(r_norm)
        return {"<": ra < rb, "<=": ra <= rb, ">": ra > rb, ">=": ra >= rb}[op]

    def _iter_numbers_from_arg(self, val: Any, is_range: bool) -> list[float]:
        if isinstance(val, RangeValue):
            nums: list[float] = []
            for item in val.flat():
                if is_excel_error(item):
                    raise ExcelError(str(item))
                if isinstance(item, (int, float)) and not isinstance(item, bool):
                    nums.append(float(item))
            return nums
        if is_excel_error(val):
            raise ExcelError(str(val))
        if val is None:
            return [] if is_range else [0.0]
        return [coerce_to_number(val)]

    def _eval_call(
        self,
        fn: str,
        args: list[tuple[Any, ...]],
        sh: str,
        coord: str,
        env: dict[str, Any] | None,
    ) -> Any:
        ev = lambda idx: self._eval_node(args[idx], sh, coord, env)
        ev_s = lambda idx: self._scalar(ev(idx))

        # --- 1. 惰性分支控制函数 ---
        if fn == "IF":
            if len(args) < 2:
                raise ExcelError("#SYNTAX!")
            cond = coerce_to_bool(ev_s(0))
            if cond:
                return ev(1)
            return ev(2) if len(args) >= 3 else False

        if fn == "IFS":
            for i in range(0, len(args) - 1, 2):
                if coerce_to_bool(ev_s(i)):
                    return ev(i + 1)
            raise ExcelError("#N/A")

        if fn == "IFERROR":
            try:
                res = ev(0)
                if isinstance(res, RangeValue):
                    res = res.flat()[0] if res.flat() else None
                if is_excel_error(res):
                    return ev(1)
                return res
            except ExcelError:
                return ev(1)

        if fn == "IFNA":
            try:
                res = ev_s(0)
                return res
            except ExcelError as e:
                if e.code == "#N/A":
                    return ev(1)
                raise

        if fn == "CHOOSE":
            idx = int(math.trunc(coerce_to_number(ev_s(0))))
            if idx < 1 or idx >= len(args):
                raise ExcelError("#VALUE!")
            return ev(idx)

        if fn == "SWITCH":
            target = ev_s(0)
            i = 1
            while i + 1 < len(args):
                if self._compare_values(target, ev_s(i), "="):
                    return ev(i + 1)
                i += 2
            if i < len(args):
                return ev(i)
            raise ExcelError("#N/A")

        if fn == "LET":
            local_env = dict(env or {})
            for i in range(0, len(args) - 1, 2):
                name_node = args[i]
                if name_node[0] not in ("name", "ref"):
                    raise ExcelError("#SYNTAX!")
                local_env[str(name_node[1]).upper()] = self._eval_node(args[i + 1], sh, coord, local_env)
            return self._eval_node(args[-1], sh, coord, local_env)

        # --- 2. 逻辑函数 ---
        if fn in ("TRUE", "FALSE"):
            return fn == "TRUE"
        if fn == "NA":
            raise ExcelError("#N/A")
        if fn == "NOT":
            return not coerce_to_bool(ev_s(0))
        if fn in ("AND", "OR", "XOR"):
            bools: list[bool] = []
            for a in args:
                v = self._eval_node(a, sh, coord, env)
                if isinstance(v, RangeValue):
                    for cell in v.flat():
                        if is_excel_error(cell):
                            raise ExcelError(str(cell))
                        if isinstance(cell, bool):
                            bools.append(cell)
                        elif isinstance(cell, (int, float)):
                            bools.append(cell != 0)
                else:
                    if is_excel_error(v):
                        raise ExcelError(str(v))
                    if v is not None and v != "":
                        bools.append(coerce_to_bool(v))
            if not bools:
                raise ExcelError("#VALUE!")
            if fn == "AND":
                return all(bools)
            if fn == "OR":
                return any(bools)
            return sum(1 for b in bools if b) % 2 == 1

        # --- 3. 类型检测函数 ---
        if fn in ("ISERROR", "ISERR", "ISNA", "ISNUMBER", "ISBLANK", "ISTEXT", "ISLOGICAL"):
            try:
                raw = ev(0)
                if isinstance(raw, RangeValue):
                    raw = raw.flat()[0] if raw.flat() else None
            except ExcelError as e:
                raw = e.code
            if fn == "ISERROR":
                return is_excel_error(raw)
            if fn == "ISNA":
                return raw == "#N/A"
            if fn == "ISERR":
                return is_excel_error(raw) and raw != "#N/A"
            if fn == "ISBLANK":
                return raw is None
            if fn == "ISNUMBER":
                return isinstance(raw, (int, float)) and not isinstance(raw, bool)
            if fn == "ISTEXT":
                return isinstance(raw, str) and not is_excel_error(raw)
            if fn == "ISLOGICAL":
                return isinstance(raw, bool)

        # --- 4. 聚合与条件统计函数 ---
        if fn in ("SUM", "MIN", "MAX", "AVERAGE", "MEDIAN", "PRODUCT"):
            nums: list[float] = []
            for a in args:
                v = self._eval_node(a, sh, coord, env)
                nums.extend(self._iter_numbers_from_arg(v, isinstance(v, RangeValue)))
            if fn == "SUM":
                return float(sum(nums))
            if fn == "PRODUCT":
                p = 1.0
                for x in nums:
                    p *= x
                return p if nums else 0.0
            if not nums:
                return 0.0 if fn in ("MIN", "MAX") else (_ for _ in ()).throw(ExcelError("#DIV/0!"))
            if fn == "MIN":
                return min(nums)
            if fn == "MAX":
                return max(nums)
            if fn == "AVERAGE":
                return sum(nums) / len(nums)
            s_nums = sorted(nums)
            mid = len(s_nums) // 2
            return s_nums[mid] if len(s_nums) % 2 == 1 else (s_nums[mid - 1] + s_nums[mid]) / 2.0

        if fn in ("LARGE", "SMALL"):
            rv = ev(0)
            nums = self._iter_numbers_from_arg(rv, isinstance(rv, RangeValue))
            k = int(math.trunc(coerce_to_number(ev_s(1))))
            if k < 1 or k > len(nums):
                raise ExcelError("#NUM!")
            s_nums = sorted(nums, reverse=(fn == "LARGE"))
            return s_nums[k - 1]

        if fn in ("COUNT", "COUNTA", "COUNTBLANK"):
            cnt = 0
            for a in args:
                v = self._eval_node(a, sh, coord, env)
                items = v.flat() if isinstance(v, RangeValue) else [v]
                for it in items:
                    if fn == "COUNT":
                        if isinstance(it, (int, float)) and not isinstance(it, bool):
                            cnt += 1
                    elif fn == "COUNTA":
                        if it is not None and it != "":
                            cnt += 1
                    elif fn == "COUNTBLANK":
                        if it is None or it == "":
                            cnt += 1
            return float(cnt)

        if fn == "SUBTOTAL":
            f_code = int(math.trunc(coerce_to_number(ev_s(0)))) % 100
            mapping = {1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 9: "SUM"}
            sub_fn = mapping.get(f_code)
            if not sub_fn:
                raise ExcelError("#VALUE!")
            return self._eval_call(sub_fn, args[1:], sh, coord, env)

        if fn == "SUMPRODUCT":
            arrays: list[list[float]] = []
            for a in args:
                v = self._eval_node(a, sh, coord, env)
                items = v.flat() if isinstance(v, RangeValue) else [v]
                arr: list[float] = []
                for it in items:
                    if is_excel_error(it):
                        raise ExcelError(str(it))
                    if isinstance(it, bool):
                        arr.append(0.0)
                    elif isinstance(it, (int, float)):
                        arr.append(float(it))
                    else:
                        arr.append(0.0)
                arrays.append(arr)
            if not arrays or len({len(a) for a in arrays}) > 1:
                raise ExcelError("#VALUE!")
            return float(sum(math.prod(col) for col in zip(*arrays)))

        if fn in ("SUMIF", "COUNTIF", "AVERAGEIF"):
            rng = ev(0)
            crit = ev_s(1)
            crit_cells = rng.flat() if isinstance(rng, RangeValue) else [rng]
            if fn == "COUNTIF":
                return float(sum(1 for c in crit_cells if _match_criteria(c, crit)))
            val_rng = ev(2) if len(args) >= 3 else rng
            val_cells = val_rng.flat() if isinstance(val_rng, RangeValue) else [val_rng]
            matched_nums: list[float] = []
            for idx, c in enumerate(crit_cells):
                if _match_criteria(c, crit) and idx < len(val_cells):
                    vc = val_cells[idx]
                    if isinstance(vc, (int, float)) and not isinstance(vc, bool):
                        matched_nums.append(float(vc))
            if fn == "SUMIF":
                return float(sum(matched_nums))
            if not matched_nums:
                raise ExcelError("#DIV/0!")
            return sum(matched_nums) / len(matched_nums)

        if fn in ("SUMIFS", "COUNTIFS", "AVERAGEIFS", "MAXIFS", "MINIFS"):
            if fn == "COUNTIFS":
                pairs = [(ev(i), ev_s(i + 1)) for i in range(0, len(args), 2)]
                lists = [r.flat() if isinstance(r, RangeValue) else [r] for r, _ in pairs]
                if not lists or len({len(x) for x in lists}) > 1:
                    raise ExcelError("#VALUE!")
                return float(sum(1 for row_idx in range(len(lists[0])) if all(_match_criteria(lists[p][row_idx], pairs[p][1]) for p in range(len(pairs)))))
            target_rng = ev(0)
            t_cells = target_rng.flat() if isinstance(target_rng, RangeValue) else [target_rng]
            pairs = [(ev(i), ev_s(i + 1)) for i in range(1, len(args), 2)]
            lists = [r.flat() if isinstance(r, RangeValue) else [r] for r, _ in pairs]
            if any(len(lst) != len(t_cells) for lst in lists):
                raise ExcelError("#VALUE!")
            matched_nums = []
            for idx, tv in enumerate(t_cells):
                if all(_match_criteria(lists[p][idx], pairs[p][1]) for p in range(len(pairs))):
                    if isinstance(tv, (int, float)) and not isinstance(tv, bool):
                        matched_nums.append(float(tv))
            if fn == "SUMIFS":
                return float(sum(matched_nums))
            if fn == "MAXIFS":
                return max(matched_nums) if matched_nums else 0.0
            if fn == "MINIFS":
                return min(matched_nums) if matched_nums else 0.0
            if not matched_nums:
                raise ExcelError("#DIV/0!")
            return sum(matched_nums) / len(matched_nums)

        # --- 5. 舍入与数学函数 ---
        if fn in ("ROUND", "ROUNDUP", "ROUNDDOWN"):
            x = coerce_to_number(ev_s(0))
            d = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 0
            mode = {"ROUND": "half_up", "ROUNDUP": "up", "ROUNDDOWN": "down"}[fn]
            return excel_round(x, d, mode)
        if fn == "TRUNC":
            x = coerce_to_number(ev_s(0))
            d = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 0
            return excel_round(x, d, "down")
        if fn == "INT":
            return float(math.floor(coerce_to_number(ev_s(0)) + 1e-12))
        if fn == "ABS":
            return abs(coerce_to_number(ev_s(0)))
        if fn == "SIGN":
            x = coerce_to_number(ev_s(0))
            return 1.0 if x > 0 else (-1.0 if x < 0 else 0.0)
        if fn == "MOD":
            n_val = coerce_to_number(ev_s(0))
            d_val = coerce_to_number(ev_s(1))
            if abs(d_val) <= 1e-15:
                raise ExcelError("#DIV/0!")
            return n_val - d_val * math.floor(n_val / d_val)
        if fn == "QUOTIENT":
            n_val = coerce_to_number(ev_s(0))
            d_val = coerce_to_number(ev_s(1))
            if abs(d_val) <= 1e-15:
                raise ExcelError("#DIV/0!")
            return float(math.trunc(n_val / d_val))
        if fn in ("CEILING", "CEILING.MATH", "FLOOR", "FLOOR.MATH", "MROUND"):
            x = coerce_to_number(ev_s(0))
            sig = coerce_to_number(ev_s(1)) if len(args) >= 2 and args[1] != ("lit", None) else 1.0
            if abs(sig) <= 1e-15:
                return 0.0
            if fn == "MROUND":
                if x * sig < 0:
                    raise ExcelError("#NUM!")
                return excel_round(x / sig, 0, "half_up") * sig
            if fn.startswith("CEILING"):
                return math.ceil(x / sig - 1e-12) * sig
            return math.floor(x / sig + 1e-12) * sig
        if fn == "POWER":
            return float(coerce_to_number(ev_s(0)) ** coerce_to_number(ev_s(1)))
        if fn == "SQRT":
            x = coerce_to_number(ev_s(0))
            if x < 0:
                raise ExcelError("#NUM!")
            return math.sqrt(x)
        if fn == "EXP":
            return math.exp(coerce_to_number(ev_s(0)))
        if fn == "LN":
            x = coerce_to_number(ev_s(0))
            if x <= 0:
                raise ExcelError("#NUM!")
            return math.log(x)
        if fn in ("LOG", "LOG10"):
            x = coerce_to_number(ev_s(0))
            base = 10.0 if fn == "LOG10" or len(args) < 2 else coerce_to_number(ev_s(1))
            if x <= 0 or base <= 0 or abs(base - 1.0) <= 1e-12:
                raise ExcelError("#NUM!")
            return math.log(x, base)
        if fn == "PI":
            return math.pi
        if fn == "N":
            v = ev_s(0)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return float(v)
            if isinstance(v, bool):
                return 1.0 if v else 0.0
            return 0.0
        if fn == "VALUE":
            return coerce_to_number(ev_s(0), blank_as_zero=False)

        # --- 6. 全套无副作用日期函数（含 WEEKDAY / EDATE / EOMONTH / DATEDIF / WORKDAY） ---
        if fn == "DATE":
            y = int(math.trunc(coerce_to_number(ev_s(0))))
            m = int(math.trunc(coerce_to_number(ev_s(1))))
            d = int(math.trunc(coerce_to_number(ev_s(2))))
            if 0 <= y < 1900:
                y += 1900
            y_adj, m_zero = divmod(m - 1, 12)
            base_dt = _dt.date(y + y_adj, m_zero + 1, 1) + _dt.timedelta(days=d - 1)
            return float(date_to_excel_serial(base_dt))

        if fn == "DATEVALUE":
            dt = coerce_to_date(ev_s(0))
            return float(date_to_excel_serial(dt))

        if fn == "DAYS":
            end_s = coerce_to_serial(ev_s(0))
            start_s = coerce_to_serial(ev_s(1))
            return float(int(end_s) - int(start_s))

        if fn == "DAYS360":
            d1 = coerce_to_date(ev_s(0))
            d2 = coerce_to_date(ev_s(1))
            euro = coerce_to_bool(ev_s(2)) if len(args) >= 3 else False
            y1, m1, day1 = d1.year, d1.month, d1.day
            y2, m2, day2 = d2.year, d2.month, d2.day
            if euro:
                day1 = min(day1, 30)
                day2 = min(day2, 30)
            else:
                if day1 == 31 or (m1 == 2 and day1 == calendar.monthrange(y1, 2)[1]):
                    day1 = 30
                if day2 == 31 and day1 >= 30:
                    day2 = 30
            return float((y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1))

        if fn == "DATEDIF":
            d1 = coerce_to_date(ev_s(0))
            d2 = coerce_to_date(ev_s(1))
            if d1 > d2:
                raise ExcelError("#NUM!")
            unit = str(ev_s(2) or "D").strip().upper()
            if unit == "D":
                return float((d2 - d1).days)
            months = (d2.year - d1.year) * 12 + (d2.month - d1.month) - (1 if d2.day < d1.day else 0)
            if unit == "M":
                return float(months)
            if unit == "Y":
                return float(months // 12)
            if unit == "YM":
                return float(months % 12)
            if unit == "MD":
                if d2.day >= d1.day:
                    return float(d2.day - d1.day)
                prev_m_year = d2.year if d2.month > 1 else d2.year - 1
                prev_m = d2.month - 1 if d2.month > 1 else 12
                prev_days = calendar.monthrange(prev_m_year, prev_m)[1]
                return float((_dt.date(d2.year, d2.month, d2.day) - _dt.date(prev_m_year, prev_m, min(d1.day, prev_days))).days)
            if unit == "YD":
                cand = _dt.date(d2.year, d1.month, min(d1.day, calendar.monthrange(d2.year, d1.month)[1]))
                if cand > d2:
                    cand = _dt.date(d2.year - 1, d1.month, min(d1.day, calendar.monthrange(d2.year - 1, d1.month)[1]))
                return float((d2 - cand).days)
            raise ExcelError("#NUM!")

        if fn == "YEARFRAC":
            d1 = coerce_to_date(ev_s(0))
            d2 = coerce_to_date(ev_s(1))
            if d1 > d2:
                d1, d2 = d2, d1
            basis = int(math.trunc(coerce_to_number(ev_s(2)))) if len(args) >= 3 else 0
            days = (d2 - d1).days
            if basis in (0, 4):
                d360 = self._eval_call("DAYS360", [args[0], args[1], ("lit", basis == 4)], sh, coord, env)
                return abs(float(d360)) / 360.0
            if basis == 2:
                return days / 360.0
            if basis == 3:
                return days / 365.0
            # basis == 1: actual/actual
            if d1.year == d2.year:
                denom = 366.0 if calendar.isleap(d1.year) else 365.0
                return days / denom
            years = range(d1.year, d2.year + 1)
            avg_denom = sum(366.0 if calendar.isleap(y) else 365.0 for y in years) / len(years)
            return days / avg_denom

        if fn in ("YEAR", "MONTH", "DAY"):
            dt = coerce_to_date(ev_s(0))
            return float({"YEAR": dt.year, "MONTH": dt.month, "DAY": dt.day}[fn])

        if fn == "WEEKDAY":
            dt = coerce_to_date(ev_s(0))
            rtype = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 1
            iso = dt.isoweekday()  # Mon=1 .. Sun=7
            if rtype == 1 or rtype == 17:
                return float((iso % 7) + 1)  # Sun=1, Mon=2 .. Sat=7
            if rtype == 2 or rtype == 11:
                return float(iso)  # Mon=1 .. Sun=7
            if rtype == 3:
                return float(iso - 1)  # Mon=0 .. Sun=6
            if 12 <= rtype <= 16:
                start_iso = rtype - 10  # 12->Tue(2) .. 16->Sat(6)
                return float(((iso - start_iso) % 7) + 1)
            raise ExcelError("#NUM!")

        if fn in ("ISOWEEKNUM", "WEEKNUM"):
            dt = coerce_to_date(ev_s(0))
            if fn == "ISOWEEKNUM":
                return float(dt.isocalendar()[1])
            rtype = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 else 1
            if rtype == 21:
                return float(dt.isocalendar()[1])
            jan1 = _dt.date(dt.year, 1, 1)
            offset = (jan1.isoweekday() % 7) if rtype == 1 else (jan1.isoweekday() - 1)
            return float(((dt - jan1).days + offset) // 7 + 1)

        if fn in ("EDATE", "EOMONTH"):
            dt = coerce_to_date(ev_s(0))
            months = int(math.trunc(coerce_to_number(ev_s(1))))
            y_adj, m_zero = divmod((dt.month - 1) + months, 12)
            ny, nm = dt.year + y_adj, m_zero + 1
            last_day = calendar.monthrange(ny, nm)[1]
            res_dt = _dt.date(ny, nm, last_day if fn == "EOMONTH" else min(dt.day, last_day))
            return float(date_to_excel_serial(res_dt))

        if fn in ("WORKDAY", "WORKDAY.INTL"):
            cur = coerce_to_date(ev_s(0))
            days = int(math.trunc(coerce_to_number(ev_s(1))))
            weekend_set = {6, 7}  # Sat, Sun in isoweekday
            hol_arg_idx = 2
            if fn == "WORKDAY.INTL":
                hol_arg_idx = 3
                if len(args) >= 3 and args[2] != ("lit", None):
                    wk = ev_s(2)
                    if isinstance(wk, str) and len(wk) == 7 and set(wk) <= {"0", "1"}:
                        weekend_set = {i + 1 for i, ch in enumerate(wk) if ch == "1"}
                    else:
                        wk_code = int(math.trunc(coerce_to_number(wk)))
                        wk_map = {1: {6, 7}, 2: {7, 1}, 3: {1, 2}, 4: {2, 3}, 5: {3, 4}, 6: {4, 5}, 7: {5, 6}, 11: {7}, 12: {1}, 13: {2}, 14: {3}, 15: {4}, 16: {5}, 17: {6}}
                        weekend_set = wk_map.get(wk_code, {6, 7})
            holidays: set[_dt.date] = set()
            if len(args) > hol_arg_idx and args[hol_arg_idx] != ("lit", None):
                hv = ev(hol_arg_idx)
                for item in (hv.flat() if isinstance(hv, RangeValue) else [hv]):
                    if item is not None and item != "":
                        holidays.add(coerce_to_date(item))
            step = 1 if days >= 0 else -1
            rem = abs(days)
            while rem > 0:
                cur += _dt.timedelta(days=step)
                if cur.isoweekday() not in weekend_set and cur not in holidays:
                    rem -= 1
            return float(date_to_excel_serial(cur))

        if fn in ("NETWORKDAYS", "NETWORKDAYS.INTL"):
            d1 = coerce_to_date(ev_s(0))
            d2 = coerce_to_date(ev_s(1))
            weekend_set = {6, 7}
            hol_idx = 2
            if fn == "NETWORKDAYS.INTL":
                hol_idx = 3
                if len(args) >= 3 and args[2] != ("lit", None):
                    wk = ev_s(2)
                    if isinstance(wk, str) and len(wk) == 7 and set(wk) <= {"0", "1"}:
                        weekend_set = {i + 1 for i, ch in enumerate(wk) if ch == "1"}
            holidays = set()
            if len(args) > hol_idx and args[hol_idx] != ("lit", None):
                hv = ev(hol_idx)
                for item in (hv.flat() if isinstance(hv, RangeValue) else [hv]):
                    if item is not None and item != "":
                        holidays.add(coerce_to_date(item))
            sign = 1 if d2 >= d1 else -1
            lo, hi = (d1, d2) if d2 >= d1 else (d2, d1)
            cnt = 0
            cur = lo
            while cur <= hi:
                if cur.isoweekday() not in weekend_set and cur not in holidays:
                    cnt += 1
                cur += _dt.timedelta(days=1)
            return float(sign * cnt)

        # --- 7. 查找与引用函数 ---
        if fn in ("ROW", "COLUMN"):
            if not args:
                c_idx, r_idx, _, _ = split_cell_coord(coord)
                return float(r_idx if fn == "ROW" else c_idx)
            rv = ev(0)
            if isinstance(rv, RangeValue):
                return float(rv.r1 if fn == "ROW" else rv.c1)
            raise ExcelError("#VALUE!")

        if fn in ("ROWS", "COLUMNS"):
            rv = ev(0)
            if isinstance(rv, RangeValue):
                return float((rv.r2 - rv.r1 + 1) if fn == "ROWS" else (rv.c2 - rv.c1 + 1))
            return 1.0

        if fn == "INDEX":
            arr = ev(0)
            r_num = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 1
            c_num = int(math.trunc(coerce_to_number(ev_s(2)))) if len(args) >= 3 and args[2] != ("lit", None) else 1
            if not isinstance(arr, RangeValue):
                if r_num in (0, 1) and c_num in (0, 1):
                    return arr
                raise ExcelError("#REF!")
            rows_cnt, cols_cnt = len(arr.values), len(arr.values[0]) if arr.values else 0
            if rows_cnt == 1 and len(args) == 2 and r_num > 1 and cols_cnt >= r_num:
                return arr.values[0][r_num - 1]
            r_idx = max(0, r_num - 1)
            c_idx = max(0, c_num - 1)
            if r_idx >= rows_cnt or c_idx >= cols_cnt:
                raise ExcelError("#REF!")
            return arr.values[r_idx][c_idx]

        if fn == "MATCH":
            lookup = ev_s(0)
            arr = ev(1)
            m_type = int(math.trunc(coerce_to_number(ev_s(2)))) if len(args) >= 3 and args[2] != ("lit", None) else 1
            seq = arr.flat() if isinstance(arr, RangeValue) else [arr]
            if m_type == 0:
                for idx, item in enumerate(seq, start=1):
                    if _match_criteria(item, lookup) or self._compare_values(item, lookup, "="):
                        return float(idx)
                raise ExcelError("#N/A")
            best_idx: int | None = None
            for idx, item in enumerate(seq, start=1):
                if item is None or is_excel_error(item):
                    continue
                if m_type == 1 and self._compare_values(item, lookup, "<="):
                    best_idx = idx
                elif m_type == -1 and self._compare_values(item, lookup, ">="):
                    best_idx = idx
            if best_idx is None:
                raise ExcelError("#N/A")
            return float(best_idx)

        if fn in ("VLOOKUP", "HLOOKUP"):
            lookup = ev_s(0)
            tbl = ev(1)
            if not isinstance(tbl, RangeValue):
                raise ExcelError("#N/A")
            idx_num = int(math.trunc(coerce_to_number(ev_s(2))))
            approx = coerce_to_bool(ev_s(3)) if len(args) >= 4 and args[3] != ("lit", None) else True
            if fn == "VLOOKUP":
                if idx_num < 1 or idx_num > len(tbl.values[0]):
                    raise ExcelError("#REF!")
                best_r: int | None = None
                for r_i, row in enumerate(tbl.values):
                    key_cell = row[0]
                    if not approx:
                        if _match_criteria(key_cell, lookup) or self._compare_values(key_cell, lookup, "="):
                            return row[idx_num - 1]
                    elif key_cell is not None and not is_excel_error(key_cell) and self._compare_values(key_cell, lookup, "<="):
                        best_r = r_i
                if approx and best_r is not None:
                    return tbl.values[best_r][idx_num - 1]
                raise ExcelError("#N/A")
            else:
                if idx_num < 1 or idx_num > len(tbl.values):
                    raise ExcelError("#REF!")
                best_c: int | None = None
                for c_i, key_cell in enumerate(tbl.values[0]):
                    if not approx:
                        if _match_criteria(key_cell, lookup) or self._compare_values(key_cell, lookup, "="):
                            return tbl.values[idx_num - 1][c_i]
                    elif key_cell is not None and not is_excel_error(key_cell) and self._compare_values(key_cell, lookup, "<="):
                        best_c = c_i
                if approx and best_c is not None:
                    return tbl.values[idx_num - 1][best_c]
                raise ExcelError("#N/A")

        if fn == "XLOOKUP":
            lookup = ev_s(0)
            l_arr = ev(1)
            r_arr = ev(2)
            l_seq = l_arr.flat() if isinstance(l_arr, RangeValue) else [l_arr]
            r_seq = r_arr.flat() if isinstance(r_arr, RangeValue) else [r_arr]
            for idx, item in enumerate(l_seq):
                if self._compare_values(item, lookup, "=") and idx < len(r_seq):
                    return r_seq[idx]
            if len(args) >= 4 and args[3] != ("lit", None):
                return ev(3)
            raise ExcelError("#N/A")

        # --- 8. 常用文本函数 ---
        if fn in ("TRIM", "UPPER", "LOWER", "LEN", "LEFT", "RIGHT", "MID", "SUBSTITUTE", "EXACT", "CONCAT", "CONCATENATE", "TEXTJOIN", "TEXT"):
            if fn in ("CONCAT", "CONCATENATE"):
                parts: list[str] = []
                for a in args:
                    v = self._eval_node(a, sh, coord, env)
                    for it in (v.flat() if isinstance(v, RangeValue) else [v]):
                        if it is not None:
                            parts.append(str(int(it)) if isinstance(it, float) and it.is_integer() else str(it))
                return "".join(parts)
            if fn == "TEXTJOIN":
                delim = str(ev_s(0) or "")
                ignore_empty = coerce_to_bool(ev_s(1))
                parts = []
                for a in args[2:]:
                    v = self._eval_node(a, sh, coord, env)
                    for it in (v.flat() if isinstance(v, RangeValue) else [v]):
                        s_it = "" if it is None else (str(int(it)) if isinstance(it, float) and it.is_integer() else str(it))
                        if ignore_empty and s_it == "":
                            continue
                        parts.append(s_it)
                return delim.join(parts)
            if fn == "TEXT":
                val = ev_s(0)
                fmt = str(ev_s(1) or "")
                if any(tok in fmt.lower() for tok in ("yyyy", "mm-dd", "yyyy/mm")):
                    dt = coerce_to_date(val)
                    return dt.isoformat()
                m_dec = re.search(r"\.(0+)", fmt)
                if m_dec:
                    n_dec = len(m_dec.group(1))
                    return f"{excel_round(coerce_to_number(val), n_dec):.0{n_dec}f}"
                return str(val if val is not None else "")
            s0 = str(ev_s(0) or "")
            if fn == "TRIM":
                return re.sub(r"\s+", " ", s0).strip()
            if fn == "UPPER":
                return s0.upper()
            if fn == "LOWER":
                return s0.lower()
            if fn == "LEN":
                return float(len(s0))
            if fn == "LEFT":
                k = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 else 1
                return s0[: max(0, k)]
            if fn == "RIGHT":
                k = int(math.trunc(coerce_to_number(ev_s(1)))) if len(args) >= 2 else 1
                return "" if k <= 0 else s0[-k:]
            if fn == "MID":
                st = max(1, int(math.trunc(coerce_to_number(ev_s(1)))))
                ln = max(0, int(math.trunc(coerce_to_number(ev_s(2)))))
                return s0[st - 1 : st - 1 + ln]
            if fn == "SUBSTITUTE":
                old_s = str(ev_s(1) or "")
                new_s = str(ev_s(2) or "")
                if not old_s:
                    return s0
                if len(args) >= 4:
                    nth = int(math.trunc(coerce_to_number(ev_s(3))))
                    if nth < 1:
                        raise ExcelError("#VALUE!")
                    matches = list(re.finditer(re.escape(old_s), s0))
                    if nth <= len(matches):
                        m_hit = matches[nth - 1]
                        return s0[: m_hit.start()] + new_s + s0[m_hit.end() :]
                    return s0
                return s0.replace(old_s, new_s)
            if fn == "EXACT":
                return s0 == str(ev_s(1) or "")

        raise ExcelError(f"#FUNC:{fn}", f"Unsupported function: {fn}")

    # -----------------------------------------------------------------------
    # 高阶核验助手：不锁行号的主键检索 + 安全微扰动 probe()
    # -----------------------------------------------------------------------

    def find_row_metric(
        self,
        keys: str | Sequence[str],
        sheet: str | None = None,
        prefer_formula: bool = False,
    ) -> tuple[str, str, Any, str | None] | None:
        """
        按行首/标签格模糊匹配业务终点指标键（自动兼容别名、忽略（元）单位后缀、不锁行号），
        返回 (sheet_name, value_coord, evaluated_value, formula_or_none)。
        """
        aliases = [keys] if isinstance(keys, str) else list(keys)
        norm_targets = {_norm_label(_strip_unit_paren(a)) for a in aliases if str(a).strip()}
        raw_targets = {_norm_label(a) for a in aliases if str(a).strip()}
        search_sheets = [self.resolve_sheet_name(sheet)] if sheet else list(self.sheet_order)

        best_fallback: tuple[str, str, Any, str | None] | None = None

        for sh in search_sheets:
            sh_model = self.sheets[sh]
            # 按行聚合
            rows_map: dict[int, list[tuple[int, str, CellData]]] = {}
            for coord, cd in sh_model.cells.items():
                c_i, r_i, _, _ = split_cell_coord(coord)
                rows_map.setdefault(r_i, []).append((c_i, coord, cd))

            for r_i in sorted(rows_map):
                row_cells = sorted(rows_map[r_i], key=lambda x: x[0])
                hit_col_idx: int | None = None
                for pos, (c_i, coord, cd) in enumerate(row_cells[:4]):
                    val = self.evaluate_cell(sh, coord)
                    if not isinstance(val, str) or is_excel_error(val):
                        continue
                    nl = _norm_label(val)
                    nl_clean = _norm_label(_strip_unit_paren(val))
                    if nl in raw_targets or nl_clean in norm_targets:
                        hit_col_idx = c_i
                        break
                if hit_col_idx is None:
                    continue

                # 从匹配标签格右侧找第一个数值（或公式数值）单元格
                for c_i, coord, cd in row_cells:
                    if c_i <= hit_col_idx:
                        continue
                    ev_val = self.evaluate_cell(sh, coord)
                    f_str = self.get_formula(sh, coord)
                    if isinstance(ev_val, (int, float)) and not isinstance(ev_val, bool):
                        cand = (sh, coord, float(ev_val), f_str)
                        if not prefer_formula or f_str is not None:
                            return cand
                        if best_fallback is None:
                            best_fallback = cand
                    elif isinstance(ev_val, str) and not is_excel_error(ev_val):
                        try:
                            num = coerce_to_number(ev_val, blank_as_zero=False)
                            cand = (sh, coord, num, f_str)
                            if not prefer_formula or f_str is not None:
                                return cand
                            if best_fallback is None:
                                best_fallback = cand
                        except ExcelError:
                            continue
        return best_fallback

    def clone_with_overrides(
        self,
        overrides: Mapping[tuple[str | None, str] | str, Any],
    ) -> "ExcelEvaluator":
        """在内存中克隆工作簿并注入参数微扰动，返回重算后的新 ExcelEvaluator（毫秒级，零磁盘污染）。"""
        cloned = object.__new__(ExcelEvaluator)
        cloned.path = self.path
        cloned.sheets = copy.deepcopy(self.sheets)
        cloned.sheet_order = list(self.sheet_order)
        cloned.defined_names = dict(self.defined_names)
        cloned._ast_cache = dict(self._ast_cache)
        cloned._eval_cache = {}
        cloned._evaluating = set()
        cloned._date_xf_indices = set(self._date_xf_indices)

        for target, new_val in overrides.items():
            if isinstance(target, tuple):
                sh_name, cell_or_key = target
            elif "!" in target:
                sh_raw, cell_or_key = target.rsplit("!", 1)
                sh_name = sh_raw
            else:
                sh_name, cell_or_key = None, target

            if _CELL_RE.match(cell_or_key.strip()):
                sh_resolved = cloned.resolve_sheet_name(sh_name)
                norm_c = normalize_coord(cell_or_key)
                cloned.sheets[sh_resolved].cells[norm_c] = CellData(
                    coord=norm_c,
                    value=new_val,
                    formula=None,
                    data_type="b" if isinstance(new_val, bool) else ("n" if isinstance(new_val, (int, float)) else "s"),
                )
            else:
                hit = self.find_row_metric(cell_or_key, sheet=sh_name)
                if hit is None:
                    raise KeyError(f"Override target metric key not found: {target!r}")
                sh_hit, c_hit, _, _ = hit
                cloned.sheets[sh_hit].cells[c_hit] = CellData(
                    coord=c_hit,
                    value=new_val,
                    formula=None,
                    data_type="b" if isinstance(new_val, bool) else ("n" if isinstance(new_val, (int, float)) else "s"),
                )
        return cloned

    def probe(
        self,
        sheet: str | None,
        cell_or_key: str | Sequence[str],
        overrides: Mapping[tuple[str | None, str] | str, Any],
        engine: str = "python",
    ) -> tuple[float, float, float]:
        """
        对指定目标（精确单元格坐标如 "B12" 或终点指标键名如 "核定有效本金"）执行输入微扰动联动断言：
        返回 (base_value, perturbed_value, delta = perturbed_value - base_value)。
        若 engine="auto" 且宿主机安装 LibreOffice 且使用精确坐标，支持 soffice 外部验证；默认纯 Python 内存重算确定性零延迟。
        """
        if isinstance(cell_or_key, str) and _CELL_RE.match(cell_or_key.strip()):
            target_sh = self.resolve_sheet_name(sheet)
            target_coord = normalize_coord(cell_or_key)
            base_raw = self.evaluate_cell(target_sh, target_coord)
        else:
            hit = self.find_row_metric(cell_or_key, sheet=sheet, prefer_formula=True)
            if hit is None:
                raise KeyError(f"Probe target metric not found: {cell_or_key!r}")
            target_sh, target_coord, base_raw, _ = hit

        base_num = coerce_to_number(base_raw, blank_as_zero=False)

        if engine == "soffice":
            soffice_bin = shutil.which("soffice") or shutil.which("libreoffice")
            if soffice_bin:
                perturbed_num = self._probe_via_soffice(soffice_bin, target_sh, target_coord, overrides)
                return base_num, perturbed_num, perturbed_num - base_num

        perturbed_wb = self.clone_with_overrides(overrides)
        pert_raw = perturbed_wb.evaluate_cell(target_sh, target_coord)
        pert_num = coerce_to_number(pert_raw, blank_as_zero=False)
        return base_num, pert_num, pert_num - base_num

    def _probe_via_soffice(
        self,
        soffice_bin: str,
        target_sh: str,
        target_coord: str,
        overrides: Mapping[tuple[str | None, str] | str, Any],
    ) -> float:
        import openpyxl  # type: ignore

        with tempfile.TemporaryDirectory(prefix="ale-soffice-") as td:
            src_copy = Path(td) / "work.xlsx"
            wb = openpyxl.load_workbook(self.path, data_only=False)
            for target, new_val in overrides.items():
                if isinstance(target, tuple):
                    sh_n, ck = target
                elif "!" in target:
                    sh_n, ck = target.rsplit("!", 1)
                else:
                    sh_n, ck = None, target
                if _CELL_RE.match(ck.strip()):
                    sh_res = self.resolve_sheet_name(sh_n)
                    c_res = normalize_coord(ck)
                else:
                    hit = self.find_row_metric(ck, sheet=sh_n)
                    if hit is None:
                        raise KeyError(f"Override target not found: {target!r}")
                    sh_res, c_res, _, _ = hit
                wb[sh_res][c_res].value = new_val
            wb.save(src_copy)
            out_dir = Path(td) / "recalc"
            out_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [soffice_bin, "--headless", "--convert-to", "xlsx", "--outdir", str(out_dir), str(src_copy)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
            recalc_wb = ExcelEvaluator(out_dir / "work.xlsx")
            cached = recalc_wb.get_cached_value(target_sh, target_coord)
            if cached is not None and not is_excel_error(cached):
                return coerce_to_number(cached, blank_as_zero=False)
            return coerce_to_number(recalc_wb.evaluate_cell(target_sh, target_coord), blank_as_zero=False)

    def collect_formula_errors(self) -> list[dict[str, str]]:
        errors: list[dict[str, str]] = []
        for sh in self.sheet_order:
            for coord, cd in self.sheets[sh].cells.items():
                val = self.evaluate_cell(sh, coord)
                if is_excel_error(val):
                    errors.append(
                        {
                            "sheet": sh,
                            "cell": coord,
                            "error": str(val),
                            "formula": self.get_formula(sh, coord) or "",
                        }
                    )
        return errors


# ---------------------------------------------------------------------------
# DocxExtractor：兼容任意多列表格（3+ 列备注/来源/单位零误杀）与归一化枚举提取
# ---------------------------------------------------------------------------

_NS_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_NUM_IN_CELL_RE = re.compile(r"(?<![A-Za-z0-9_])([+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)\s*(万元|元|%|％)?")


class DocxExtractor:
    """纯标准库 .docx 结构化段落与多列表格提取器。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        if not self.path.is_file():
            raise FileNotFoundError(f"DOCX file not found: {self.path}")
        self.paragraphs: list[str] = []
        self.tables: list[list[list[str]]] = []
        self._load_docx()

    def _cell_text(self, tc_el: ET.Element) -> str:
        p_texts: list[str] = []
        for p in tc_el.findall(f".//{_NS_W}p"):
            runs = [t.text or "" for t in p.findall(f".//{_NS_W}t")]
            s = "".join(runs).strip()
            if s:
                p_texts.append(s)
        return "\n".join(p_texts).strip()

    def _load_docx(self) -> None:
        with zipfile.ZipFile(self.path, "r") as zf:
            if "word/document.xml" not in zf.namelist():
                raise ValueError(f"Invalid DOCX (missing word/document.xml): {self.path}")
            root = ET.fromstring(zf.read("word/document.xml"))
            body = root.find(f"{_NS_W}body")
            if body is None:
                return
            for child in body:
                if child.tag == f"{_NS_W}p":
                    txt = "".join(t.text or "" for t in child.findall(f".//{_NS_W}t")).strip()
                    if txt:
                        self.paragraphs.append(txt)
                elif child.tag == f"{_NS_W}tbl":
                    tbl_rows: list[list[str]] = []
                    for tr in child.findall(f"{_NS_W}tr"):
                        row_cells: list[str] = []
                        for tc in tr.findall(f"{_NS_W}tc"):
                            # 跳过纵向合并的续行空占位格 vMerge（无 val="restart"）
                            tc_pr = tc.find(f"{_NS_W}tcPr")
                            if tc_pr is not None:
                                vm = tc_pr.find(f"{_NS_W}vMerge")
                                if vm is not None and vm.attrib.get(f"{_NS_W}val", "") != "restart":
                                    row_cells.append("")
                                    continue
                            row_cells.append(self._cell_text(tc))
                        if any(c.strip() for c in row_cells):
                            tbl_rows.append(row_cells)
                    if tbl_rows:
                        self.tables.append(tbl_rows)

    @property
    def full_text(self) -> str:
        blocks = list(self.paragraphs)
        for tbl in self.tables:
            for row in tbl:
                blocks.append(" | ".join(row))
        return "\n".join(blocks)

    @staticmethod
    def _parse_pure_or_currency_cell(cell_str: str) -> float | None:
        s = cell_str.strip()
        if not s:
            return None
        # 剔除常见货币前缀与尾注括号（如 "¥1,234,567.89 元" 或 "1,234.50（含税）"）
        s_clean = re.sub(r"^(?:人民币|RMB|CNY|USD|¥|￥)\s*", "", s, flags=re.IGNORECASE)
        s_clean = re.sub(r"[（(][^）)]*[）)]\s*$", "", s_clean).strip()
        m = re.match(r"^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(万元|元|%|％)?$", s_clean)
        if not m:
            return None
        num = float(m.group(1).replace(",", ""))
        unit = m.group(2) or ""
        if unit == "%":
            return num / 100.0
        if unit == "％":
            return num / 100.0
        return num

    def extract_key_number(
        self,
        keys: str | Sequence[str],
        allow_paragraph_fallback: bool = True,
    ) -> float | None:
        """
        按主键（或别名列表）提取数值：
        1. 优先扫描全部表格：匹配第 1 列（或前 2 列标签格），从其右侧逐列寻找首个数值单元格
           ——天然兼容模型自加第 3 列“备注/计算公式/证据页码/单位”的异构三列/四列表格！
        2. 若表格未命中且 allow_paragraph_fallback=True，扫描包含该键名的键值段落提取紧邻数值。
        """
        aliases = [keys] if isinstance(keys, str) else list(keys)
        norm_targets = {_norm_label(_strip_unit_paren(a)) for a in aliases if str(a).strip()}
        raw_targets = {_norm_label(a) for a in aliases if str(a).strip()}

        for tbl in self.tables:
            for row in tbl:
                hit_idx: int | None = None
                for col_i, cell_txt in enumerate(row[:2]):
                    nl = _norm_label(cell_txt)
                    nl_clean = _norm_label(_strip_unit_paren(cell_txt))
                    if nl in raw_targets or nl_clean in norm_targets:
                        hit_idx = col_i
                        break
                if hit_idx is None:
                    continue
                # 优先找纯净数值格（兼容第 3 列备注）
                for val_cell in row[hit_idx + 1 :]:
                    parsed = self._parse_pure_or_currency_cell(val_cell)
                    if parsed is not None:
                        return parsed
                # 次优：若第 2 列写成 "125,000.00 元（详见底稿表2）"
                for val_cell in row[hit_idx + 1 :]:
                    m = _NUM_IN_CELL_RE.search(val_cell)
                    if m:
                        val = float(m.group(1).replace(",", ""))
                        return val / 100.0 if (m.group(2) in ("%", "％")) else val

        if allow_paragraph_fallback:
            for para in self.paragraphs:
                for alias in aliases:
                    idx = para.find(alias)
                    if idx >= 0:
                        tail = para[idx + len(alias) :]
                        # 跳过紧邻序号，只提取冒号/等号/空格后的金额
                        m = re.search(r"[:：=为即系\s]\s*(?:人民币|RMB|¥|￥)?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(万元|元|%|％)?", tail)
                        if m:
                            val = float(m.group(1).replace(",", ""))
                            return val / 100.0 if (m.group(2) in ("%", "％")) else val
        return None

    def extract_key_cell_text(self, keys: str | Sequence[str]) -> str | None:
        """按行首主键提取第 2 列（首个非空值列）原始文本。"""
        aliases = [keys] if isinstance(keys, str) else list(keys)
        norm_targets = {_norm_label(_strip_unit_paren(a)) for a in aliases if str(a).strip()}
        raw_targets = {_norm_label(a) for a in aliases if str(a).strip()}

        for tbl in self.tables:
            for row in tbl:
                for col_i, cell_txt in enumerate(row[:2]):
                    if _norm_label(cell_txt) in raw_targets or _norm_label(_strip_unit_paren(cell_txt)) in norm_targets:
                        for right_cell in row[col_i + 1 :]:
                            if right_cell.strip():
                                return right_cell.strip()
        return None

    def extract_enum_choice(
        self,
        keys: str | Sequence[str] | None,
        allowed_codes: Sequence[str],
    ) -> str | None:
        """
        安全提取固定枚举结论（自动剥离标点、书名号、引号及句末解释句，拒绝 `^` 行首截断误杀；
        同时识别“不采纳 A，应采纳 B”中的否定前文，避免反转结论 M03 混水摸鱼）。
        """
        scope_texts: list[str] = []
        if keys is not None:
            cell_txt = self.extract_key_cell_text(keys)
            if cell_txt:
                scope_texts.append(cell_txt)
            aliases = [keys] if isinstance(keys, str) else list(keys)
            for p in self.paragraphs:
                if any(a in p for a in aliases):
                    scope_texts.append(p)
        if not scope_texts:
            scope_texts = [self.full_text]

        def _clean(s: str) -> str:
            return re.sub(r"[\s`'\"“”‘’《》【】\[\]()（），,。；;：:!！?？·—\-]+", "", s).lower()

        neg_tokens = ("不", "非", "未", "拒绝", "排除", "否定", "错误", "偏离", "舍弃")

        for raw_txt in scope_texts:
            norm_txt = _clean(raw_txt)
            affirmed: list[str] = []
            for code in allowed_codes:
                norm_code = _clean(code)
                if not norm_code:
                    continue
                pos = norm_txt.find(norm_code)
                while pos >= 0:
                    prefix_win = norm_txt[max(0, pos - 6) : pos]
                    if not any(neg in prefix_win for neg in neg_tokens):
                        affirmed.append(code)
                        break
                    pos = norm_txt.find(norm_code, pos + len(norm_code))
            unique_hits = list(dict.fromkeys(affirmed))
            if len(unique_hits) == 1:
                return unique_hits[0]
        return None


# ---------------------------------------------------------------------------
# 容差比对、只读输入防篡改与标准第 7 节 GradeReporter
# ---------------------------------------------------------------------------

def approx_equal(observed: Any, expected: float, abs_tol: float = 0.02, rel_tol: float = 0.0) -> bool:
    if observed is None or isinstance(observed, bool) or is_excel_error(observed):
        return False
    try:
        obs_f = coerce_to_number(observed, blank_as_zero=False)
    except ExcelError:
        return False
    limit = max(abs_tol, abs(expected) * rel_tol)
    return abs(obs_f - expected) <= limit + 1e-9


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_frozen_inputs(
    expected_hashes: Mapping[str, str],
    input_dir: str | Path | None = None,
    artifacts_dir: str | Path | None = None,
    tests_dir: str | Path | None = None,
) -> tuple[bool, dict[str, str]]:
    """
    校验只读输入文件 SHA-256（拦截 M07 篡改只读输入作弊）：
    - 若 artifacts_dir 内混入同名 input/<file> 篡改副本，优先检出并拦截；
    - 否则核验显式传入的 input_dir 或默认 environment/input 目录。
    """
    mismatches: dict[str, str] = {}
    resolved_in = Path(input_dir) if input_dir else (Path(tests_dir).resolve().parent / "environment" / "input" if tests_dir else None)

    for rel_name, exp_sha in expected_hashes.items():
        clean_name = Path(rel_name).name
        if artifacts_dir is not None:
            tampered_cand = Path(artifacts_dir) / "input" / clean_name
            if tampered_cand.is_file():
                actual = sha256_file(tampered_cand)
                if actual.lower() != exp_sha.lower():
                    mismatches[clean_name] = f"tampered_in_artifacts:{actual[:16]}"
                    continue
        if resolved_in is not None:
            src_cand = resolved_in / clean_name
            if not src_cand.is_file():
                mismatches[clean_name] = "missing_input"
            else:
                actual = sha256_file(src_cand)
                if actual.lower() != exp_sha.lower():
                    mismatches[clean_name] = f"sha256_mismatch:{actual[:16]}"
    return len(mismatches) == 0, mismatches


@dataclass
class SubCheck:
    name: str
    passed: bool
    expected: Any = None
    observed: Any = None
    weight: float = 1.0


class GradeReporter:
    """统一读取 rubric.json 门控配置并生成符合规范第 7 节的 grade.json。"""

    def __init__(
        self,
        task_id: str | None = None,
        rubric_path: str | Path | None = None,
        pass_threshold: float | None = None,
        grader_version: str = "1.0.0",
        run_id: str | None = None,
    ) -> None:
        self.rubric_meta: dict[str, dict[str, Any]] = {}
        inferred_task_id = task_id or "UNKNOWN-TASK"
        inferred_threshold = pass_threshold if pass_threshold is not None else 0.85
        self.canary: str | None = None

        if rubric_path and Path(rubric_path).is_file():
            rub = json.loads(Path(rubric_path).read_text("utf-8"))
            inferred_task_id = task_id or str(rub.get("task_id") or inferred_task_id)
            if pass_threshold is None and isinstance(rub.get("scale", {}).get("pass_threshold"), (int, float)):
                inferred_threshold = float(rub["scale"]["pass_threshold"])
            if isinstance(rub.get("canary"), str):
                self.canary = rub["canary"]
            for c in rub.get("criteria", []):
                cid = str(c.get("criterion_id") or c.get("id") or "")
                if cid:
                    self.rubric_meta[cid] = c

        self.task_id = inferred_task_id
        self.pass_threshold = inferred_threshold
        self.grader_version = grader_version
        self.run_id = run_id
        self.items: list[dict[str, Any]] = []

    def add_item(
        self,
        criterion_id: str,
        score: float,
        expected: Any,
        observed: Any,
        evidence_path: str = "",
        weight: float | None = None,
        is_key_gate: bool | None = None,
        item_pass_threshold: float = 0.85,
    ) -> dict[str, Any]:
        meta = self.rubric_meta.get(criterion_id, {})
        w = float(weight if weight is not None else meta.get("weight", 1.0))
        gate = bool(is_key_gate if is_key_gate is not None else meta.get("is_key_gate", False))
        clamped = max(0.0, min(1.0, float(score)))
        passed = clamped >= (item_pass_threshold - 1e-9)
        rec = {
            "criterion_id": criterion_id,
            "is_key_gate": gate,
            "weight": w,
            "expected": expected,
            "observed": observed,
            "score": round(clamped, 6),
            "passed": passed,
            "evidence_path": evidence_path,
        }
        self.items.append(rec)
        return rec

    def add_subchecks(
        self,
        criterion_id: str,
        subchecks: Sequence[SubCheck],
        evidence_path: str = "",
        weight: float | None = None,
        is_key_gate: bool | None = None,
        item_pass_threshold: float = 0.85,
    ) -> dict[str, Any]:
        if not subchecks:
            return self.add_item(criterion_id, 0.0, "non-empty subchecks", "no subchecks", evidence_path, weight, is_key_gate, item_pass_threshold)
        total_w = sum(max(0.0, sc.weight) for sc in subchecks)
        passed_w = sum(max(0.0, sc.weight) for sc in subchecks if sc.passed)
        ratio = (passed_w / total_w) if total_w > 0 else 0.0
        exp_summary = {sc.name: sc.expected for sc in subchecks}
        obs_summary = {sc.name: {"ok": sc.passed, "val": sc.observed} for sc in subchecks}
        return self.add_item(
            criterion_id=criterion_id,
            score=ratio,
            expected=exp_summary,
            observed=obs_summary,
            evidence_path=evidence_path,
            weight=weight,
            is_key_gate=is_key_gate,
            item_pass_threshold=item_pass_threshold,
        )

    def fail_all_missing(self, reason: str = "missing_required_deliverables", evidence_path: str = "output/") -> dict[str, Any]:
        """当被测提交为空（B02 no-op）或核心产物缺失时，为全部 rubric 项登记 0 分并正常退出 0 码。"""
        self.items.clear()
        for cid, meta in self.rubric_meta.items():
            self.add_item(
                criterion_id=cid,
                score=0.0,
                expected=meta.get("condition", "deliverable present and valid"),
                observed=reason,
                evidence_path=evidence_path,
                weight=float(meta.get("weight", 1.0)),
                is_key_gate=bool(meta.get("is_key_gate", False)),
            )
        return self.build_report()

    def build_report(self, force_fail_reason: str | None = None) -> dict[str, Any]:
        raw_score = sum(it["weight"] * it["score"] for it in self.items if it["weight"] > 0)
        max_score = sum(it["weight"] for it in self.items if it["weight"] > 0)
        normalized = max(0.0, min(1.0, raw_score / max_score)) if max_score > 0 else 0.0
        key_gates_passed = all(it["passed"] for it in self.items if it["is_key_gate"]) and len(self.items) > 0
        if force_fail_reason:
            key_gates_passed = False
        success = (normalized + 1e-9 >= self.pass_threshold) and key_gates_passed and (force_fail_reason is None)
        return {
            "task_id": self.task_id,
            "run_id": self.run_id,
            "grader_version": self.grader_version,
            "status": "GRADED",
            "normalized_score": round(normalized, 6),
            "raw_score": round(raw_score, 6),
            "max_score": round(max_score, 6),
            "pass_threshold": self.pass_threshold,
            "key_gates_passed": key_gates_passed,
            "success": success,
            "error": force_fail_reason,
            "items": self.items,
            "judge_usage": None,
        }

    def write(self, output_path: str | Path, force_fail_reason: str | None = None) -> dict[str, Any]:
        report = self.build_report(force_fail_reason=force_fail_reason)
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report


def parse_grade_cli_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ALE Deterministic Task Grader")
    parser.add_argument("--artifacts-dir", required=True, help="Directory containing output/ deliverables")
    parser.add_argument("--output", required=True, help="Output path for grade.json")
    parser.add_argument("--input-dir", default=None, help="Optional readonly input directory")
    parser.add_argument("--run-id", default=None, help="Optional run identifier")
    return parser.parse_args(argv)

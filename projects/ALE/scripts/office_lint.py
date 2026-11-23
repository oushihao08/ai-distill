#!/usr/bin/env python3
"""
Purpose: Generic, zero-domain-knowledge Office document inspector and formula recalculation linter.
Usage: python3 office_lint.py <file1.xlsx|file2.docx|dir> [--max-rows 25] [--json]
Behavior:
  - For .xlsx files: inspects OOXML structure, sheet dimensions, formula counts, recalculates formulas
    in pure Python (supporting standard math, logical, lookup, and date functions), flags #REF!/#NAME?/
    #DIV/0!/#VALUE!/#CYCLE!/#SYNTAX! errors or stale cached values, and prints a preview of top rows.
  - For .docx files: inspects OOXML structure, paragraph count, table dimensions (rows x cols), and
    prints a preview of paragraphs and table cells.
  - Contains strictly zero task-specific field names, expected values, or grading rules.
"""
from __future__ import annotations

import argparse
import calendar
import datetime as _dt
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_UP, ROUND_UP
from pathlib import Path
from typing import Any

EXCEL_EPOCH = _dt.date(1899, 12, 30)
EXCEL_ERRORS = frozenset({"#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#CYCLE!", "#SYNTAX!"})
_NS_X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
_NS_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

_CELL_RE = re.compile(r"^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$")
_COL_ONLY_RE = re.compile(r"^(\$?)([A-Za-z]{1,3})$")
_ISO_DATE_RE = re.compile(
    r"^\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?\s*$"
)
_REF_SHIFT_RE = re.compile(
    r"""(?P<str>"(?:""|[^"])*")|(?P<sheet>(?:'(?:''|[^'])+'|[A-Za-z0-9_\u4e00-\u9fff.]+)!)?(?P<c1>\$?[A-Za-z]{1,3})(?P<r1>\$?\d+)(?::(?P<c2>\$?[A-Za-z]{1,3})(?P<r2>\$?\d+))?(?![A-Za-z0-9_(])"""
)


class FormulaEvalError(Exception):
    def __init__(self, code: str = "#VALUE!") -> None:
        super().__init__(code)
        self.code = code if code.startswith("#") else f"#{code}"


def is_err_code(val: Any) -> bool:
    return isinstance(val, str) and (val in EXCEL_ERRORS or val.startswith("#ERR") or val.startswith("#FUNC:"))


def col_to_idx(col_str: str) -> int:
    idx = 0
    for ch in col_str.upper():
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx


def idx_to_col(idx: int) -> str:
    chars: list[str] = []
    n = max(1, idx)
    while n > 0:
        n, rem = divmod(n - 1, 26)
        chars.append(chr(ord("A") + rem))
    return "".join(reversed(chars))


def split_coord(coord: str) -> tuple[int, int]:
    m = _CELL_RE.match(coord.strip())
    if not m:
        raise ValueError(f"Invalid coordinate: {coord!r}")
    return col_to_idx(m.group(2)), int(m.group(4))


def norm_coord(coord: str) -> str:
    c, r = split_coord(coord)
    return f"{idx_to_col(c)}{r}"


def shift_refs(formula: str, d_col: int, d_row: int) -> str:
    if d_col == 0 and d_row == 0:
        return formula

    def _one(c_part: str, r_part: str) -> str:
        ac = c_part.startswith("$")
        rc = c_part[1:] if ac else c_part
        ar = r_part.startswith("$")
        rr = int(r_part[1:] if ar else r_part)
        nc = col_to_idx(rc) if ac else max(1, col_to_idx(rc) + d_col)
        nr = rr if ar else max(1, rr + d_row)
        return f"{'$' if ac else ''}{idx_to_col(nc)}{'$' if ar else ''}{nr}"

    def _repl(m: re.Match[str]) -> str:
        if m.group("str") is not None:
            return m.group("str")
        pre = m.group("sheet") or ""
        left = _one(m.group("c1"), m.group("r1"))
        if m.group("c2") and m.group("r2"):
            return f"{pre}{left}:{_one(m.group('c2'), m.group('r2'))}"
        return f"{pre}{left}"

    return _REF_SHIFT_RE.sub(_repl, formula)


def date_to_serial(d: _dt.date) -> int:
    serial = (d - EXCEL_EPOCH).days
    if d < _dt.date(1900, 3, 1):
        serial -= 1
    return serial


def serial_to_date(serial: float | int) -> _dt.date:
    s = int(math.floor(float(serial) + 1e-9))
    if s == 60:
        return _dt.date(1900, 2, 28)
    if s < 60:
        return _dt.date(1899, 12, 31) + _dt.timedelta(days=s)
    return EXCEL_EPOCH + _dt.timedelta(days=s)


def parse_date_str(text: str) -> _dt.date | None:
    m = _ISO_DATE_RE.match(text)
    if not m:
        return None
    try:
        return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def to_date(val: Any) -> _dt.date:
    if is_err_code(val):
        raise FormulaEvalError(str(val))
    if isinstance(val, _dt.datetime):
        return val.date()
    if isinstance(val, _dt.date):
        return val
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        if not math.isfinite(val) or val < 1:
            raise FormulaEvalError("#NUM!")
        return serial_to_date(val)
    if isinstance(val, str):
        dt = parse_date_str(val)
        if dt is not None:
            return dt
        try:
            return serial_to_date(float(val.replace(",", "").strip()))
        except ValueError:
            pass
    raise FormulaEvalError("#VALUE!")


def to_num(val: Any, blank_zero: bool = True) -> float:
    if is_err_code(val):
        raise FormulaEvalError(str(val))
    if val is None or val == "":
        if blank_zero:
            return 0.0
        raise FormulaEvalError("#VALUE!")
    if isinstance(val, bool):
        return 1.0 if val else 0.0
    if isinstance(val, (int, float)):
        if not math.isfinite(val):
            raise FormulaEvalError("#NUM!")
        return float(val)
    if isinstance(val, (_dt.date, _dt.datetime)):
        return float(date_to_serial(val if isinstance(val, _dt.date) else val.date()))
    if isinstance(val, str):
        s = val.strip()
        if not s:
            if blank_zero:
                return 0.0
            raise FormulaEvalError("#VALUE!")
        dt = parse_date_str(s)
        if dt is not None:
            return float(date_to_serial(dt))
        c = s.replace(",", "")
        if c.endswith("%"):
            try:
                return float(c[:-1]) / 100.0
            except ValueError:
                pass
        try:
            return float(c)
        except ValueError as exc:
            raise FormulaEvalError("#VALUE!") from exc
    raise FormulaEvalError("#VALUE!")


def to_bool(val: Any) -> bool:
    if is_err_code(val):
        raise FormulaEvalError(str(val))
    if isinstance(val, bool):
        return val
    if val is None or val == "":
        return False
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        up = val.strip().upper()
        if up in ("TRUE", "FALSE"):
            return up == "TRUE"
    raise FormulaEvalError("#VALUE!")


def xl_round(val: float, digits: int = 0, mode: str = "half_up") -> float:
    if not math.isfinite(val):
        raise FormulaEvalError("#NUM!")
    d_i = int(math.trunc(digits))
    try:
        dec = Decimal(str(val))
        quant = Decimal(10) ** (-d_i)
        rm = {"half_up": ROUND_HALF_UP, "up": ROUND_UP, "down": ROUND_DOWN}[mode]
        res = float(dec.quantize(quant, rounding=rm))
        return 0.0 if res == 0.0 else res
    except (InvalidOperation, OverflowError) as exc:
        raise FormulaEvalError("#NUM!") from exc


@dataclass
class Tok:
    kind: str
    value: str


_ERR_LITS = ("#GETTING_DATA", "#DIV/0!", "#VALUE!", "#NAME?", "#NULL!", "#REF!", "#NUM!", "#N/A")


def tokenize_formula(expr: str) -> list[Tok]:
    s = expr.strip()
    if s.startswith("="):
        s = s[1:].lstrip()
    out: list[Tok] = []
    i, n = 0, len(s)
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
            out.append(Tok("STR", "".join(buf)))
            i = j
            continue
        if ch == "#":
            up = s[i:].upper()
            hit = next((lit for lit in _ERR_LITS if up.startswith(lit)), None)
            if hit:
                out.append(Tok("ERR", hit))
                i += len(hit)
                continue
        if ch == "'":
            j = i + 1
            sb: list[str] = []
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'":
                        sb.append("'")
                        j += 2
                        continue
                    j += 1
                    break
                sb.append(s[j])
                j += 1
            if j < n and s[j] == "!":
                j += 1
                rs = j
                while j < n and (s[j].isalnum() or s[j] in "$:"):
                    j += 1
                out.append(Tok("REF", f"'{''.join(sb)}'!{s[rs:j]}"))
                i = j
                continue
            raise FormulaEvalError("#SYNTAX!")
        if ch.isdigit() or (ch == "." and i + 1 < n and s[i + 1].isdigit()):
            j = i
            while j < n and (s[j].isdigit() or s[j] == "."):
                j += 1
            if j < n and s[j] in "eE":
                k = j + 1 + (1 if j + 1 < n and s[j + 1] in "+-" else 0)
                if k < n and s[k].isdigit():
                    j = k + 1
                    while j < n and s[j].isdigit():
                        j += 1
            if j < n and (s[j].isalpha() or ord(s[j]) > 127 or s[j] in "_-"):
                k = j
                while k < n and (s[k].isalnum() or ord(s[k]) > 127 or s[k] in "_-."):
                    k += 1
                if k < n and s[k] == "!":
                    sh_n = s[i:k]
                    k += 1
                    rs = k
                    while k < n and (s[k].isalnum() or s[k] in "$:"):
                        k += 1
                    out.append(Tok("REF", f"'{sh_n}'!{s[rs:k]}"))
                    i = k
                    continue
            out.append(Tok("NUM", s[i:j]))
            i = j
            continue
        if s[i : i + 2] in ("<>", "<=", ">="):
            out.append(Tok("OP", s[i : i + 2]))
            i += 2
            continue
        if ch in "+-*/^&=<>%":
            out.append(Tok("OP", ch))
            i += 1
            continue
        if ch == "(":
            out.append(Tok("LP", ch))
            i += 1
            continue
        if ch == ")":
            out.append(Tok("RP", ch))
            i += 1
            continue
        if ch == "{":
            out.append(Tok("LB", ch))
            i += 1
            continue
        if ch == "}":
            out.append(Tok("RB", ch))
            i += 1
            continue
        if ch == ",":
            out.append(Tok("COMMA", ch))
            i += 1
            continue
        if ch == ";":
            out.append(Tok("SEMI", ch))
            i += 1
            continue
        if ch.isalpha() or ch in "$_" or ord(ch) > 127:
            j = i
            while j < n and (s[j].isalnum() or s[j] in "$_." or ord(s[j]) > 127):
                j += 1
            if j < n and s[j] == "!":
                sh_n = s[i:j]
                j += 1
                rs = j
                while j < n and (s[j].isalnum() or s[j] in "$:"):
                    j += 1
                out.append(Tok("REF", f"'{sh_n}'!{s[rs:j]}"))
                i = j
                continue
            if j < n and s[j] == ":":
                j += 1
                while j < n and (s[j].isalnum() or s[j] == "$"):
                    j += 1
                out.append(Tok("REF", s[i:j]))
                i = j
                continue
            w = s[i:j]
            k = j
            while k < n and s[k] in " \t":
                k += 1
            if k < n and s[k] == "(":
                out.append(Tok("IDENT", w))
            elif w.upper() in ("TRUE", "FALSE"):
                out.append(Tok("BOOL", w.upper()))
            elif _CELL_RE.match(w):
                out.append(Tok("REF", w))
            else:
                out.append(Tok("IDENT", w))
            i = j
            continue
        raise FormulaEvalError("#SYNTAX!")
    out.append(Tok("EOF", ""))
    return out


class Parser:
    def __init__(self, tokens: list[Tok]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Tok:
        return self.tokens[self.pos]

    def eat(self, kind: str | None = None) -> Tok:
        t = self.tokens[self.pos]
        if kind and t.kind != kind:
            raise FormulaEvalError("#SYNTAX!")
        self.pos += 1
        return t

    def parse(self) -> tuple[Any, ...]:
        n = self.cmp()
        if self.peek().kind != "EOF":
            raise FormulaEvalError("#SYNTAX!")
        return n

    def cmp(self) -> tuple[Any, ...]:
        n = self.cat()
        while self.peek().kind == "OP" and self.peek().value in ("=", "<>", "<", "<=", ">", ">="):
            op = self.eat().value
            n = ("bin", op, n, self.cat())
        return n

    def cat(self) -> tuple[Any, ...]:
        n = self.add()
        while self.peek().kind == "OP" and self.peek().value == "&":
            self.eat()
            n = ("bin", "&", n, self.add())
        return n

    def add(self) -> tuple[Any, ...]:
        n = self.mul()
        while self.peek().kind == "OP" and self.peek().value in ("+", "-"):
            op = self.eat().value
            n = ("bin", op, n, self.mul())
        return n

    def mul(self) -> tuple[Any, ...]:
        n = self.pow()
        while self.peek().kind == "OP" and self.peek().value in ("*", "/"):
            op = self.eat().value
            n = ("bin", op, n, self.pow())
        return n

    def pow(self) -> tuple[Any, ...]:
        n = self.unary()
        while self.peek().kind == "OP" and self.peek().value == "^":
            self.eat()
            n = ("bin", "^", n, self.unary())
        return n

    def unary(self) -> tuple[Any, ...]:
        if self.peek().kind == "OP" and self.peek().value in ("+", "-"):
            op = self.eat().value
            return ("un", op, self.unary())
        return self.post()

    def post(self) -> tuple[Any, ...]:
        n = self.pri()
        while self.peek().kind == "OP" and self.peek().value == "%":
            self.eat()
            n = ("pct", n)
        return n

    def pri(self) -> tuple[Any, ...]:
        t = self.peek()
        if t.kind == "NUM":
            self.eat()
            return ("lit", float(t.value))
        if t.kind == "STR":
            self.eat()
            return ("lit", t.value)
        if t.kind == "BOOL":
            self.eat()
            return ("lit", t.value == "TRUE")
        if t.kind == "ERR":
            self.eat()
            return ("err", t.value)
        if t.kind == "REF":
            self.eat()
            return ("ref", t.value)
        if t.kind == "LP":
            self.eat("LP")
            n = self.cmp()
            self.eat("RP")
            return n
        if t.kind == "LB":
            self.eat("LB")
            rows: list[list[tuple[Any, ...]]] = [[]]
            if self.peek().kind != "RB":
                rows[-1].append(self.cmp())
                while self.peek().kind in ("COMMA", "SEMI"):
                    if self.eat().kind == "SEMI":
                        rows.append([])
                    rows[-1].append(self.cmp())
            self.eat("RB")
            return ("arr", rows)
        if t.kind == "IDENT":
            nm = self.eat().value
            if self.peek().kind == "LP":
                self.eat("LP")
                args: list[tuple[Any, ...]] = []
                if self.peek().kind != "RP":
                    args.append(("lit", None) if self.peek().kind == "COMMA" else self.cmp())
                    while self.peek().kind == "COMMA":
                        self.eat("COMMA")
                        args.append(("lit", None) if self.peek().kind in ("COMMA", "RP") else self.cmp())
                self.eat("RP")
                return ("call", nm, args)
            return ("name", nm)
        raise FormulaEvalError("#SYNTAX!")


@dataclass
class GridVal:
    c1: int
    r1: int
    c2: int
    r2: int
    values: list[list[Any]]

    def flat(self) -> list[Any]:
        return [x for r in self.values for x in r]


@dataclass
class CellRec:
    coord: str
    value: Any = None
    formula: str | None = None


@dataclass
class SheetRec:
    name: str
    cells: dict[str, CellRec] = field(default_factory=dict)
    min_row: int = 0
    max_row: int = 0
    min_col: int = 0
    max_col: int = 0


def _crit_match(val: Any, crit: Any) -> bool:
    if is_err_code(val):
        return False
    if isinstance(crit, (int, float)) and not isinstance(crit, bool):
        try:
            return abs(to_num(val, blank_zero=False) - float(crit)) <= 1e-9
        except FormulaEvalError:
            return False
    if isinstance(crit, bool):
        return isinstance(val, bool) and val == crit
    cs = str(crit if crit is not None else "")
    m = re.match(r"^(<>|<=|>=|=|<|>)(.*)$", cs.strip())
    op, rhs = (m.group(1), m.group(2).strip()) if m else ("=", cs)
    if rhs == "":
        empty = val is None or val == ""
        return (not empty) if op == "<>" else (empty if op == "=" else False)
    try:
        rn = to_num(rhs, blank_zero=False)
        try:
            ln = to_num(val, blank_zero=False)
            return {
                "=": abs(ln - rn) <= 1e-9,
                "<>": abs(ln - rn) > 1e-9,
                "<": ln < rn - 1e-12,
                "<=": ln <= rn + 1e-12,
                ">": ln > rn + 1e-12,
                ">=": ln >= rn - 1e-12,
            }[op]
        except FormulaEvalError:
            return op == "<>"
    except FormulaEvalError:
        pass
    ls = str(val if val is not None else "").strip()
    if op in ("=", "<>") and ("*" in rhs or "?" in rhs):
        pat = "^" + re.escape(rhs).replace(r"\*", ".*").replace(r"\?", ".") + "$"
        hit = bool(re.match(pat, ls, flags=re.IGNORECASE))
        return hit if op == "=" else not hit
    ll, rl = ls.lower(), rhs.lower()
    return {"=": ll == rl, "<>": ll != rl, "<": ll < rl, "<=": ll <= rl, ">": ll > rl, ">=": ll >= rl}[op]


class WorkbookLinter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.sheets: dict[str, SheetRec] = {}
        self.order: list[str] = []
        self.names: dict[str, tuple[str | None, str]] = {}
        self._cache: dict[tuple[str, str], Any] = {}
        self._visiting: set[tuple[str, str]] = set()
        self._load()

    def _load(self) -> None:
        with zipfile.ZipFile(self.path, "r") as zf:
            znames = set(zf.namelist())
            if "xl/workbook.xml" not in znames:
                raise ValueError("Missing xl/workbook.xml")
            sstrings: list[str] = []
            if "xl/sharedStrings.xml" in znames:
                sr = ET.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in sr.findall(f"{_NS_X}si"):
                    sstrings.append("".join(t.text or "" for t in si.iter(f"{_NS_X}t")))
            rels: dict[str, str] = {}
            if "xl/_rels/workbook.xml.rels" in znames:
                rr = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
                for rel in rr:
                    tgt = rel.attrib.get("Target", "").lstrip("/")
                    rels[rel.attrib.get("Id", "")] = tgt if tgt.startswith("xl/") else f"xl/{tgt}"
            wbr = ET.fromstring(zf.read("xl/workbook.xml"))
            entries: list[tuple[str, str]] = []
            sel = wbr.find(f"{_NS_X}sheets")
            if sel is not None:
                for idx, sh in enumerate(sel.findall(f"{_NS_X}sheet")):
                    nm = sh.attrib.get("name", f"Sheet{idx + 1}")
                    rid = sh.attrib.get(_NS_REL, "")
                    entries.append((nm, rels.get(rid, f"xl/worksheets/sheet{idx + 1}.xml")))
            dnel = wbr.find(f"{_NS_X}definedNames")
            if dnel is not None:
                for dn in dnel.findall(f"{_NS_X}definedName"):
                    dnm = dn.attrib.get("name", "").strip()
                    if dnm and not dnm.startswith("_xlnm.") and dn.text and dn.text.strip():
                        lid = dn.attrib.get("localSheetId")
                        sc = entries[int(lid)][0] if (lid and lid.isdigit() and int(lid) < len(entries)) else None
                        self.names[dnm.upper()] = (sc, dn.text.strip())

            for nm, tgt in entries:
                self.order.append(nm)
                sr_rec = SheetRec(name=nm)
                if tgt not in znames:
                    self.sheets[nm] = sr_rec
                    continue
                wsr = ET.fromstring(zf.read(tgt))
                masters: dict[str, tuple[int, int, str]] = {}
                slaves: list[tuple[CellRec, str, int, int]] = []
                for r_idx, r_el in enumerate(wsr.iter(f"{_NS_X}row"), start=1):
                    rn = int(r_el.attrib.get("r", str(r_idx)))
                    for c_idx, c_el in enumerate(r_el.findall(f"{_NS_X}c"), start=1):
                        ref_a = c_el.attrib.get("r")
                        cn, rn = split_coord(ref_a) if ref_a else (c_idx, rn)
                        coord = f"{idx_to_col(cn)}{rn}"
                        sr_rec.min_row = rn if sr_rec.min_row == 0 else min(sr_rec.min_row, rn)
                        sr_rec.max_row = max(sr_rec.max_row, rn)
                        sr_rec.min_col = cn if sr_rec.min_col == 0 else min(sr_rec.min_col, cn)
                        sr_rec.max_col = max(sr_rec.max_col, cn)
                        ct = c_el.attrib.get("t", "n")
                        fe = c_el.find(f"{_NS_X}f")
                        ve = c_el.find(f"{_NS_X}v")
                        ise = c_el.find(f"{_NS_X}is")
                        val: Any = None
                        if ct == "s" and ve is not None and ve.text is not None:
                            si_i = int(ve.text.strip())
                            val = sstrings[si_i] if 0 <= si_i < len(sstrings) else ""
                        elif ct == "inlineStr" and ise is not None:
                            val = "".join(t.text or "" for t in ise.iter(f"{_NS_X}t"))
                        elif ct == "b" and ve is not None and ve.text is not None:
                            val = ve.text.strip() in ("1", "true", "TRUE")
                        elif ct in ("str", "e") and ve is not None:
                            val = ve.text or ""
                        elif ct == "d" and ve is not None and ve.text:
                            dt = parse_date_str(ve.text[:10])
                            val = float(date_to_serial(dt)) if dt else ve.text
                        elif ve is not None and ve.text is not None and ve.text.strip() != "":
                            rv = ve.text.strip()
                            try:
                                fv = float(rv)
                                val = int(fv) if fv.is_integer() and "." not in rv and "e" not in rv.lower() else fv
                            except ValueError:
                                val = rv

                        f_txt: str | None = None
                        if fe is not None:
                            ft = fe.attrib.get("t", "")
                            si_id = fe.attrib.get("si", "")
                            raw_f = (fe.text or "").strip()
                            if ft == "shared" and si_id != "":
                                if raw_f:
                                    masters[si_id] = (cn, rn, raw_f)
                                    f_txt = raw_f
                                else:
                                    rec = CellRec(coord=coord, value=val, formula=None)
                                    sr_rec.cells[coord] = rec
                                    slaves.append((rec, si_id, cn, rn))
                                    continue
                            elif raw_f:
                                f_txt = raw_f
                        sr_rec.cells[coord] = CellRec(coord=coord, value=val, formula=f_txt)

                for sl_rec, si_id, cn, rn in slaves:
                    mst = masters.get(si_id)
                    if mst:
                        sl_rec.formula = shift_refs(mst[2], cn - mst[0], rn - mst[1])
                self.sheets[nm] = sr_rec

    def _sheet(self, name: str | None) -> str:
        if not name:
            return self.order[0]
        c = name.strip()
        if c.startswith("'") and c.endswith("'"):
            c = c[1:-1].replace("''", "'")
        if c in self.sheets:
            return c
        low = c.lower()
        for k in self.order:
            if k.lower() == low:
                return k
        raise FormulaEvalError("#REF!")

    def eval_cell(self, sheet: str, coord: str) -> Any:
        sh = self._sheet(sheet)
        nc = norm_coord(coord)
        key = (sh, nc)
        if key in self._cache:
            return self._cache[key]
        if key in self._visiting:
            return "#CYCLE!"
        rec = self.sheets[sh].cells.get(nc)
        if rec is None:
            return None
        if rec.formula is None:
            self._cache[key] = rec.value
            return rec.value
        self._visiting.add(key)
        try:
            ast_n = Parser(tokenize_formula(rec.formula)).parse()
            res = self._eval_ast(ast_n, sh, nc, None)
            if isinstance(res, GridVal):
                fl = res.flat()
                res = fl[0] if fl else None
        except FormulaEvalError as err:
            res = err.code
        except ZeroDivisionError:
            res = "#DIV/0!"
        except Exception:
            res = "#VALUE!"
        finally:
            self._visiting.discard(key)
        self._cache[key] = res
        return res

    def _ref(self, spec: str, cur_sh: str) -> GridVal:
        tsh = cur_sh
        cp = spec.strip()
        if "!" in cp:
            sr, cp = cp.rsplit("!", 1)
            tsh = self._sheet(sr)
        sm = self.sheets[tsh]
        if ":" in cp:
            ls, rs = cp.split(":", 1)
            mc1, mc2 = _COL_ONLY_RE.match(ls.strip()), _COL_ONLY_RE.match(rs.strip())
            if mc1 and mc2:
                c1, c2 = col_to_idx(mc1.group(2)), col_to_idx(mc2.group(2))
                r1, r2 = 1, max(1, sm.max_row)
            else:
                c1, r1 = split_coord(ls)
                c2, r2 = split_coord(rs)
                r2 = min(r2, max(r1, sm.max_row + 50))
        else:
            c1, r1 = split_coord(cp)
            c2, r2 = c1, r1
        cmin, cmax, rmin, rmax = min(c1, c2), max(c1, c2), min(r1, r2), max(r1, r2)
        vals = [[self.eval_cell(tsh, f"{idx_to_col(c)}{r}") for c in range(cmin, cmax + 1)] for r in range(rmin, rmax + 1)]
        return GridVal(c1=cmin, r1=rmin, c2=cmax, r2=rmax, values=vals)

    def _sc(self, v: Any) -> Any:
        if isinstance(v, GridVal):
            fl = v.flat()
            v = fl[0] if fl else None
        if is_err_code(v):
            raise FormulaEvalError(str(v))
        return v

    def _cmp(self, lv: Any, rv: Any, op: str) -> bool:
        if isinstance(lv, str) and isinstance(rv, (int, float)) and not isinstance(rv, bool):
            dt = parse_date_str(lv)
            if dt:
                lv = float(date_to_serial(dt))
        elif isinstance(rv, str) and isinstance(lv, (int, float)) and not isinstance(lv, bool):
            dt = parse_date_str(rv)
            if dt:
                rv = float(date_to_serial(dt))
        ln = 0.0 if lv is None and isinstance(rv, (int, float)) else ("" if lv is None and isinstance(rv, str) else lv)
        rn = 0.0 if rv is None and isinstance(lv, (int, float)) else ("" if rv is None and isinstance(lv, str) else rv)
        if isinstance(ln, (int, float)) and not isinstance(ln, bool) and isinstance(rn, (int, float)) and not isinstance(rn, bool):
            d = float(ln) - float(rn)
            return {"=": abs(d) <= 1e-9, "<>": abs(d) > 1e-9, "<": d < -1e-12, "<=": d <= 1e-12, ">": d > 1e-12, ">=": d >= -1e-12}[op]
        if isinstance(ln, str) and isinstance(rn, str):
            a, b = ln.lower(), rn.lower()
            return {"=": a == b, "<>": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]
        if op in ("=", "<>"):
            return (ln == rn) if op == "=" else (ln != rn)
        rk = lambda x: (0, 0) if x is None else ((3, int(x)) if isinstance(x, bool) else ((1, float(x)) if isinstance(x, (int, float)) else (2, str(x).lower())))
        ra, rb = rk(ln), rk(rn)
        return {"<": ra < rb, "<=": ra <= rb, ">": ra > rb, ">=": ra >= rb}[op]

    def _eval_ast(self, node: tuple[Any, ...], sh: str, coord: str, env: dict[str, Any] | None) -> Any:
        k = node[0]
        if k == "lit":
            return node[1]
        if k == "err":
            raise FormulaEvalError(node[1])
        if k == "ref":
            gv = self._ref(node[1], sh)
            return gv.values[0][0] if (gv.c1 == gv.c2 and gv.r1 == gv.r2) else gv
        if k == "name":
            nm = str(node[1]).upper()
            if env and nm in env:
                return env[nm]
            if nm in self.names:
                sc_sh, expr = self.names[nm]
                return self._eval_ast(Parser(tokenize_formula(expr)).parse(), sc_sh or sh, coord, env)
            raise FormulaEvalError("#NAME?")
        if k == "arr":
            mat = [[self._eval_ast(c, sh, coord, env) for c in r] for r in node[1]]
            return GridVal(1, 1, len(mat[0]) if mat else 1, len(mat), mat)
        if k == "pct":
            return to_num(self._sc(self._eval_ast(node[1], sh, coord, env))) / 100.0
        if k == "un":
            v = to_num(self._sc(self._eval_ast(node[2], sh, coord, env)))
            return -v if node[1] == "-" else v
        if k == "bin":
            op = node[1]
            lv = self._sc(self._eval_ast(node[2], sh, coord, env))
            rv = self._sc(self._eval_ast(node[3], sh, coord, env))
            if op == "&":
                f_str = lambda x: "" if x is None else (str(int(x)) if isinstance(x, float) and x.is_integer() else str(x))
                return f_str(lv) + f_str(rv)
            if op in ("+", "-", "*", "/", "^"):
                ln, rn = to_num(lv), to_num(rv)
                if op == "+":
                    return ln + rn
                if op == "-":
                    return ln - rn
                if op == "*":
                    return ln * rn
                if op == "/":
                    if abs(rn) <= 1e-15:
                        raise FormulaEvalError("#DIV/0!")
                    return ln / rn
                return float(ln**rn)
            return self._cmp(lv, rv, op)
        if k == "call":
            fn = str(node[1]).upper()
            for pre in ("_XLFN._XLWS.", "_XLFN.", "_XLWS."):
                if fn.startswith(pre):
                    fn = fn[len(pre) :]
            return self._call(fn, node[2], sh, coord, env)
        raise FormulaEvalError("#SYNTAX!")

    def _nums(self, v: Any, is_rng: bool) -> list[float]:
        if isinstance(v, GridVal):
            res: list[float] = []
            for it in v.flat():
                if is_err_code(it):
                    raise FormulaEvalError(str(it))
                if isinstance(it, (int, float)) and not isinstance(it, bool):
                    res.append(float(it))
            return res
        if is_err_code(v):
            raise FormulaEvalError(str(v))
        if v is None:
            return [] if is_rng else [0.0]
        return [to_num(v)]

    def _call(self, fn: str, args: list[tuple[Any, ...]], sh: str, coord: str, env: dict[str, Any] | None) -> Any:
        ev = lambda idx: self._eval_ast(args[idx], sh, coord, env)
        evs = lambda idx: self._sc(ev(idx))

        if fn == "IF":
            return ev(1) if to_bool(evs(0)) else (ev(2) if len(args) >= 3 else False)
        if fn == "IFS":
            for i in range(0, len(args) - 1, 2):
                if to_bool(evs(i)):
                    return ev(i + 1)
            raise FormulaEvalError("#N/A")
        if fn == "IFERROR":
            try:
                r = ev(0)
                if isinstance(r, GridVal):
                    r = r.flat()[0] if r.flat() else None
                return ev(1) if is_err_code(r) else r
            except FormulaEvalError:
                return ev(1)
        if fn == "IFNA":
            try:
                return evs(0)
            except FormulaEvalError as e:
                if e.code == "#N/A":
                    return ev(1)
                raise
        if fn == "CHOOSE":
            i = int(math.trunc(to_num(evs(0))))
            if i < 1 or i >= len(args):
                raise FormulaEvalError("#VALUE!")
            return ev(i)
        if fn == "SWITCH":
            tgt = evs(0)
            i = 1
            while i + 1 < len(args):
                if self._cmp(tgt, evs(i), "="):
                    return ev(i + 1)
                i += 2
            if i < len(args):
                return ev(i)
            raise FormulaEvalError("#N/A")
        if fn == "LET":
            loc = dict(env or {})
            for i in range(0, len(args) - 1, 2):
                loc[str(args[i][1]).upper()] = self._eval_ast(args[i + 1], sh, coord, loc)
            return self._eval_ast(args[-1], sh, coord, loc)
        if fn in ("TRUE", "FALSE"):
            return fn == "TRUE"
        if fn == "NA":
            raise FormulaEvalError("#N/A")
        if fn == "NOT":
            return not to_bool(evs(0))
        if fn in ("AND", "OR", "XOR"):
            bs: list[bool] = []
            for a in args:
                v = self._eval_ast(a, sh, coord, env)
                for it in (v.flat() if isinstance(v, GridVal) else [v]):
                    if is_err_code(it):
                        raise FormulaEvalError(str(it))
                    if it is not None and it != "":
                        bs.append(to_bool(it))
            if not bs:
                raise FormulaEvalError("#VALUE!")
            return all(bs) if fn == "AND" else (any(bs) if fn == "OR" else (sum(1 for b in bs if b) % 2 == 1))
        if fn in ("ISERROR", "ISERR", "ISNA", "ISNUMBER", "ISBLANK", "ISTEXT", "ISLOGICAL"):
            try:
                rv = ev(0)
                if isinstance(rv, GridVal):
                    rv = rv.flat()[0] if rv.flat() else None
            except FormulaEvalError as e:
                rv = e.code
            return {
                "ISERROR": is_err_code(rv),
                "ISNA": rv == "#N/A",
                "ISERR": is_err_code(rv) and rv != "#N/A",
                "ISBLANK": rv is None,
                "ISNUMBER": isinstance(rv, (int, float)) and not isinstance(rv, bool),
                "ISTEXT": isinstance(rv, str) and not is_err_code(rv),
                "ISLOGICAL": isinstance(rv, bool),
            }[fn]
        if fn in ("SUM", "MIN", "MAX", "AVERAGE", "MEDIAN", "PRODUCT"):
            ns: list[float] = []
            for a in args:
                v = self._eval_ast(a, sh, coord, env)
                ns.extend(self._nums(v, isinstance(v, GridVal)))
            if fn == "SUM":
                return float(sum(ns))
            if fn == "PRODUCT":
                return float(math.prod(ns)) if ns else 0.0
            if not ns:
                if fn in ("MIN", "MAX"):
                    return 0.0
                raise FormulaEvalError("#DIV/0!")
            if fn == "MIN":
                return min(ns)
            if fn == "MAX":
                return max(ns)
            if fn == "AVERAGE":
                return sum(ns) / len(ns)
            sn = sorted(ns)
            m = len(sn) // 2
            return sn[m] if len(sn) % 2 == 1 else (sn[m - 1] + sn[m]) / 2.0
        if fn in ("COUNT", "COUNTA", "COUNTBLANK"):
            c = 0
            for a in args:
                v = self._eval_ast(a, sh, coord, env)
                for it in (v.flat() if isinstance(v, GridVal) else [v]):
                    if fn == "COUNT" and isinstance(it, (int, float)) and not isinstance(it, bool):
                        c += 1
                    elif fn == "COUNTA" and it is not None and it != "":
                        c += 1
                    elif fn == "COUNTBLANK" and (it is None or it == ""):
                        c += 1
            return float(c)
        if fn == "SUMPRODUCT":
            arrs: list[list[float]] = []
            for a in args:
                v = self._eval_ast(a, sh, coord, env)
                items = v.flat() if isinstance(v, GridVal) else [v]
                row_f: list[float] = []
                for it in items:
                    if is_err_code(it):
                        raise FormulaEvalError(str(it))
                    row_f.append(float(it) if isinstance(it, (int, float)) and not isinstance(it, bool) else 0.0)
                arrs.append(row_f)
            if not arrs or len({len(x) for x in arrs}) > 1:
                raise FormulaEvalError("#VALUE!")
            return float(sum(math.prod(col) for col in zip(*arrs)))
        if fn in ("SUMIF", "COUNTIF", "AVERAGEIF"):
            rg = ev(0)
            cr = evs(1)
            cs = rg.flat() if isinstance(rg, GridVal) else [rg]
            if fn == "COUNTIF":
                return float(sum(1 for x in cs if _crit_match(x, cr)))
            vg = ev(2) if len(args) >= 3 else rg
            vs = vg.flat() if isinstance(vg, GridVal) else [vg]
            ms = [float(vs[i]) for i, x in enumerate(cs) if _crit_match(x, cr) and i < len(vs) and isinstance(vs[i], (int, float)) and not isinstance(vs[i], bool)]
            if fn == "SUMIF":
                return float(sum(ms))
            if not ms:
                raise FormulaEvalError("#DIV/0!")
            return sum(ms) / len(ms)
        if fn in ("SUMIFS", "COUNTIFS", "AVERAGEIFS", "MAXIFS", "MINIFS"):
            if fn == "COUNTIFS":
                prs = [(ev(i), evs(i + 1)) for i in range(0, len(args), 2)]
                ls = [r.flat() if isinstance(r, GridVal) else [r] for r, _ in prs]
                if not ls or len({len(x) for x in ls}) > 1:
                    raise FormulaEvalError("#VALUE!")
                return float(sum(1 for idx in range(len(ls[0])) if all(_crit_match(ls[p][idx], prs[p][1]) for p in range(len(prs)))))
            tg = ev(0)
            ts = tg.flat() if isinstance(tg, GridVal) else [tg]
            prs = [(ev(i), evs(i + 1)) for i in range(1, len(args), 2)]
            ls = [r.flat() if isinstance(r, GridVal) else [r] for r, _ in prs]
            if any(len(x) != len(ts) for x in ls):
                raise FormulaEvalError("#VALUE!")
            ms = [float(ts[idx]) for idx in range(len(ts)) if all(_crit_match(ls[p][idx], prs[p][1]) for p in range(len(prs))) and isinstance(ts[idx], (int, float)) and not isinstance(ts[idx], bool)]
            if fn == "SUMIFS":
                return float(sum(ms))
            if fn == "MAXIFS":
                return max(ms) if ms else 0.0
            if fn == "MINIFS":
                return min(ms) if ms else 0.0
            if not ms:
                raise FormulaEvalError("#DIV/0!")
            return sum(ms) / len(ms)
        if fn in ("ROUND", "ROUNDUP", "ROUNDDOWN", "TRUNC"):
            x = to_num(evs(0))
            d = int(math.trunc(to_num(evs(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 0
            md = {"ROUND": "half_up", "ROUNDUP": "up", "ROUNDDOWN": "down", "TRUNC": "down"}[fn]
            return xl_round(x, d, md)
        if fn == "INT":
            return float(math.floor(to_num(evs(0)) + 1e-12))
        if fn == "ABS":
            return abs(to_num(evs(0)))
        if fn == "SIGN":
            x = to_num(evs(0))
            return 1.0 if x > 0 else (-1.0 if x < 0 else 0.0)
        if fn == "MOD":
            n_v, d_v = to_num(evs(0)), to_num(evs(1))
            if abs(d_v) <= 1e-15:
                raise FormulaEvalError("#DIV/0!")
            return n_v - d_v * math.floor(n_v / d_v)
        if fn in ("POWER", "SQRT", "EXP", "LN", "LOG", "LOG10", "PI"):
            if fn == "PI":
                return math.pi
            x = to_num(evs(0))
            if fn == "POWER":
                return float(x ** to_num(evs(1)))
            if fn == "SQRT":
                if x < 0:
                    raise FormulaEvalError("#NUM!")
                return math.sqrt(x)
            if fn == "EXP":
                return math.exp(x)
            if x <= 0:
                raise FormulaEvalError("#NUM!")
            if fn == "LN":
                return math.log(x)
            base = 10.0 if fn == "LOG10" or len(args) < 2 else to_num(evs(1))
            return math.log(x, base)
        if fn == "DATE":
            y, m, d = int(math.trunc(to_num(evs(0)))), int(math.trunc(to_num(evs(1)))), int(math.trunc(to_num(evs(2))))
            if 0 <= y < 1900:
                y += 1900
            ya, mz = divmod(m - 1, 12)
            return float(date_to_serial(_dt.date(y + ya, mz + 1, 1) + _dt.timedelta(days=d - 1)))
        if fn == "DATEVALUE":
            return float(date_to_serial(to_date(evs(0))))
        if fn == "DAYS":
            return float(date_to_serial(to_date(evs(0))) - date_to_serial(to_date(evs(1))))
        if fn == "DATEDIF":
            d1, d2 = to_date(evs(0)), to_date(evs(1))
            if d1 > d2:
                raise FormulaEvalError("#NUM!")
            u = str(evs(2) or "D").strip().upper()
            if u == "D":
                return float((d2 - d1).days)
            mos = (d2.year - d1.year) * 12 + (d2.month - d1.month) - (1 if d2.day < d1.day else 0)
            return float(mos if u == "M" else (mos // 12 if u == "Y" else mos % 12))
        if fn in ("YEAR", "MONTH", "DAY"):
            dt = to_date(evs(0))
            return float({"YEAR": dt.year, "MONTH": dt.month, "DAY": dt.day}[fn])
        if fn == "WEEKDAY":
            dt = to_date(evs(0))
            rt = int(math.trunc(to_num(evs(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 1
            iso = dt.isoweekday()
            if rt in (1, 17):
                return float((iso % 7) + 1)
            if rt in (2, 11):
                return float(iso)
            if rt == 3:
                return float(iso - 1)
            if 12 <= rt <= 16:
                return float(((iso - (rt - 10)) % 7) + 1)
            raise FormulaEvalError("#NUM!")
        if fn in ("EDATE", "EOMONTH"):
            dt = to_date(evs(0))
            mos = int(math.trunc(to_num(evs(1))))
            ya, mz = divmod((dt.month - 1) + mos, 12)
            ny, nm = dt.year + ya, mz + 1
            ld = calendar.monthrange(ny, nm)[1]
            return float(date_to_serial(_dt.date(ny, nm, ld if fn == "EOMONTH" else min(dt.day, ld))))
        if fn in ("WORKDAY", "NETWORKDAYS"):
            d1 = to_date(evs(0))
            if fn == "WORKDAY":
                days = int(math.trunc(to_num(evs(1))))
                hols: set[_dt.date] = set()
                if len(args) >= 3 and args[2] != ("lit", None):
                    hv = ev(2)
                    for it in (hv.flat() if isinstance(hv, GridVal) else [hv]):
                        if it is not None and it != "":
                            hols.add(to_date(it))
                step = 1 if days >= 0 else -1
                rem = abs(days)
                cur = d1
                while rem > 0:
                    cur += _dt.timedelta(days=step)
                    if cur.isoweekday() not in (6, 7) and cur not in hols:
                        rem -= 1
                return float(date_to_serial(cur))
            d2 = to_date(evs(1))
            hols = set()
            if len(args) >= 3 and args[2] != ("lit", None):
                hv = ev(2)
                for it in (hv.flat() if isinstance(hv, GridVal) else [hv]):
                    if it is not None and it != "":
                        hols.add(to_date(it))
            sgn = 1 if d2 >= d1 else -1
            lo, hi = (d1, d2) if d2 >= d1 else (d2, d1)
            cnt, cur = 0, lo
            while cur <= hi:
                if cur.isoweekday() not in (6, 7) and cur not in hols:
                    cnt += 1
                cur += _dt.timedelta(days=1)
            return float(sgn * cnt)
        if fn in ("INDEX", "MATCH", "VLOOKUP", "XLOOKUP", "ROW", "COLUMN", "ROWS", "COLUMNS"):
            if fn in ("ROW", "COLUMN"):
                if not args:
                    c_i, r_i = split_coord(coord)
                    return float(r_i if fn == "ROW" else c_i)
                gv = ev(0)
                if isinstance(gv, GridVal):
                    return float(gv.r1 if fn == "ROW" else gv.c1)
                raise FormulaEvalError("#VALUE!")
            if fn in ("ROWS", "COLUMNS"):
                gv = ev(0)
                return float((gv.r2 - gv.r1 + 1) if fn == "ROWS" else (gv.c2 - gv.c1 + 1)) if isinstance(gv, GridVal) else 1.0
            if fn == "INDEX":
                gv = ev(0)
                rn = int(math.trunc(to_num(evs(1)))) if len(args) >= 2 and args[1] != ("lit", None) else 1
                cn = int(math.trunc(to_num(evs(2)))) if len(args) >= 3 and args[2] != ("lit", None) else 1
                if not isinstance(gv, GridVal):
                    return gv
                if len(gv.values) == 1 and len(args) == 2 and rn > 1 and len(gv.values[0]) >= rn:
                    return gv.values[0][rn - 1]
                return gv.values[max(0, rn - 1)][max(0, cn - 1)]
            if fn == "MATCH":
                lk = evs(0)
                sq = ev(1).flat() if isinstance(ev(1), GridVal) else [ev(1)]
                for idx, it in enumerate(sq, start=1):
                    if _crit_match(it, lk) or self._cmp(it, lk, "="):
                        return float(idx)
                raise FormulaEvalError("#N/A")
            if fn == "VLOOKUP":
                lk = evs(0)
                tb = ev(1)
                ci = int(math.trunc(to_num(evs(2))))
                if not isinstance(tb, GridVal) or ci < 1 or ci > len(tb.values[0]):
                    raise FormulaEvalError("#REF!")
                for row in tb.values:
                    if _crit_match(row[0], lk) or self._cmp(row[0], lk, "="):
                        return row[ci - 1]
                raise FormulaEvalError("#N/A")
            if fn == "XLOOKUP":
                lk = evs(0)
                la = ev(1).flat() if isinstance(ev(1), GridVal) else [ev(1)]
                ra = ev(2).flat() if isinstance(ev(2), GridVal) else [ev(2)]
                for idx, it in enumerate(la):
                    if self._cmp(it, lk, "=") and idx < len(ra):
                        return ra[idx]
                if len(args) >= 4 and args[3] != ("lit", None):
                    return ev(3)
                raise FormulaEvalError("#N/A")
        if fn in ("N", "VALUE", "TRIM", "LEN", "LEFT", "RIGHT", "MID", "UPPER", "LOWER", "CONCAT", "CONCATENATE", "SUBSTITUTE", "TEXT"):
            if fn == "N":
                v = evs(0)
                return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else (1.0 if v is True else 0.0)
            if fn == "VALUE":
                return to_num(evs(0), blank_zero=False)
            if fn in ("CONCAT", "CONCATENATE"):
                ps: list[str] = []
                for a in args:
                    v = self._eval_ast(a, sh, coord, env)
                    for it in (v.flat() if isinstance(v, GridVal) else [v]):
                        if it is not None:
                            ps.append(str(int(it)) if isinstance(it, float) and it.is_integer() else str(it))
                return "".join(ps)
            s0 = str(evs(0) or "")
            if fn == "TRIM":
                return re.sub(r"\s+", " ", s0).strip()
            if fn == "LEN":
                return float(len(s0))
            if fn == "UPPER":
                return s0.upper()
            if fn == "LOWER":
                return s0.lower()
            if fn == "LEFT":
                return s0[: max(0, int(math.trunc(to_num(evs(1)))) if len(args) >= 2 else 1)]
            if fn == "RIGHT":
                k_r = int(math.trunc(to_num(evs(1)))) if len(args) >= 2 else 1
                return "" if k_r <= 0 else s0[-k_r:]
            if fn == "MID":
                st = max(1, int(math.trunc(to_num(evs(1)))))
                ln = max(0, int(math.trunc(to_num(evs(2)))))
                return s0[st - 1 : st - 1 + ln]
            if fn == "SUBSTITUTE":
                return s0.replace(str(evs(1) or ""), str(evs(2) or ""))
            return s0
        raise FormulaEvalError(f"#FUNC:{fn}")


def inspect_xlsx(path: Path, max_rows: int = 25) -> dict[str, Any]:
    wb = WorkbookLinter(path)
    sheets_report: list[dict[str, Any]] = []
    total_errors = 0

    for sh_name in wb.order:
        sh = wb.sheets[sh_name]
        non_empty = 0
        formula_count = 0
        static_numeric_count = 0
        errors: list[dict[str, str]] = []
        stale_cache_warnings: list[dict[str, Any]] = []
        rows_map: dict[int, list[tuple[int, str, Any, str | None]]] = {}

        for coord, rec in sh.cells.items():
            c_i, r_i = split_coord(coord)
            ev_val = wb.eval_cell(sh_name, coord)
            if rec.formula is not None:
                formula_count += 1
                f_disp = rec.formula if rec.formula.startswith("=") else f"={rec.formula}"
                if is_err_code(ev_val):
                    errors.append({"cell": coord, "error": str(ev_val), "formula": f_disp})
                elif rec.value is not None and isinstance(rec.value, (int, float)) and isinstance(ev_val, (int, float)):
                    if abs(float(rec.value) - float(ev_val)) > 1e-4:
                        stale_cache_warnings.append({"cell": coord, "cached": rec.value, "recalculated": round(float(ev_val), 6)})
            else:
                f_disp = None
                if is_err_code(rec.value):
                    errors.append({"cell": coord, "error": str(rec.value), "formula": ""})
                elif isinstance(rec.value, (int, float)) and not isinstance(rec.value, bool):
                    static_numeric_count += 1

            if ev_val is not None and ev_val != "" or f_disp is not None:
                non_empty += 1
                rows_map.setdefault(r_i, []).append((c_i, coord, ev_val, f_disp))

        total_errors += len(errors)
        preview_rows: list[dict[str, Any]] = []
        for r_i in sorted(rows_map)[:max_rows]:
            cells_sorted = sorted(rows_map[r_i], key=lambda x: x[0])
            row_items: list[str] = []
            for _, coord, ev_val, f_disp in cells_sorted:
                if isinstance(ev_val, float) and not isinstance(ev_val, bool):
                    v_str = str(int(ev_val)) if ev_val.is_integer() else f"{ev_val:.4f}".rstrip("0").rstrip(".")
                else:
                    v_str = str(ev_val)
                if f_disp:
                    row_items.append(f"{coord}={v_str} [{f_disp}]")
                else:
                    row_items.append(f"{coord}={v_str}")
            preview_rows.append({"row": r_i, "cells": row_items})

        dim_str = (
            f"rows={sh.min_row}..{sh.max_row}, cols={idx_to_col(sh.min_col)}..{idx_to_col(sh.max_col)}"
            if sh.max_row > 0
            else "empty"
        )
        sheets_report.append(
            {
                "name": sh_name,
                "dimensions": dim_str,
                "non_empty_cells": non_empty,
                "formula_cells": formula_count,
                "static_numeric_cells": static_numeric_count,
                "formula_errors": errors,
                "stale_cache_cells": stale_cache_warnings[:15],
                "preview_rows": preview_rows,
            }
        )

    return {
        "file": str(path),
        "type": "xlsx",
        "size_bytes": path.stat().st_size,
        "sheet_count": len(wb.order),
        "total_formula_errors": total_errors,
        "status": "OK" if total_errors == 0 else "HAS_FORMULA_ERRORS",
        "sheets": sheets_report,
    }


def inspect_docx(path: Path, max_rows: int = 20) -> dict[str, Any]:
    paragraphs: list[str] = []
    tables_info: list[dict[str, Any]] = []

    with zipfile.ZipFile(path, "r") as zf:
        if "word/document.xml" not in zf.namelist():
            raise ValueError("Missing word/document.xml")
        root = ET.fromstring(zf.read("word/document.xml"))
        body = root.find(f"{_NS_W}body")
        if body is not None:
            for child in body:
                if child.tag == f"{_NS_W}p":
                    txt = "".join(t.text or "" for t in child.findall(f".//{_NS_W}t")).strip()
                    if txt:
                        paragraphs.append(txt)
                elif child.tag == f"{_NS_W}tbl":
                    rows_data: list[list[str]] = []
                    max_cols = 0
                    for tr in child.findall(f"{_NS_W}tr"):
                        cells_txt: list[str] = []
                        for tc in tr.findall(f"{_NS_W}tc"):
                            ps = ["".join(t.text or "" for t in p.findall(f".//{_NS_W}t")).strip() for p in tc.findall(f".//{_NS_W}p")]
                            cells_txt.append(" / ".join(x for x in ps if x))
                        max_cols = max(max_cols, len(cells_txt))
                        if any(c for c in cells_txt):
                            rows_data.append(cells_txt)
                    tables_info.append(
                        {
                            "table_index": len(tables_info) + 1,
                            "rows": len(rows_data),
                            "cols": max_cols,
                            "preview_rows": rows_data[:max_rows],
                        }
                    )

    return {
        "file": str(path),
        "type": "docx",
        "size_bytes": path.stat().st_size,
        "paragraph_count": len(paragraphs),
        "table_count": len(tables_info),
        "status": "OK" if (len(paragraphs) > 0 or len(tables_info) > 0) else "EMPTY_DOCUMENT",
        "preview_paragraphs": paragraphs[:max_rows],
        "tables": tables_info,
    }


def format_human_report(rep: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"=== {rep['file']} ({rep['type'].upper()}, {rep['size_bytes']} bytes) -> {rep['status']} ===")
    if rep["type"] == "xlsx":
        lines.append(f"Sheets: {rep['sheet_count']} | Total Formula Errors: {rep['total_formula_errors']}")
        for sh in rep["sheets"]:
            lines.append(
                f"  [Sheet: {sh['name']}] {sh['dimensions']} | non_empty={sh['non_empty_cells']}, formulas={sh['formula_cells']}, static_numbers={sh['static_numeric_cells']}"
            )
            if sh["formula_errors"]:
                for err in sh["formula_errors"]:
                    lines.append(f"    ! ERROR {err['cell']}: {err['error']}  formula={err['formula']}")
            if sh["stale_cache_cells"]:
                for st in sh["stale_cache_cells"]:
                    lines.append(f"    ~ CACHE_DIFF {st['cell']}: cached={st['cached']} vs recalculated={st['recalculated']}")
            for pr in sh["preview_rows"]:
                lines.append(f"    R{pr['row']:02d}: " + " | ".join(pr["cells"]))
    elif rep["type"] == "docx":
        lines.append(f"Non-empty Paragraphs: {rep['paragraph_count']} | Tables: {rep['table_count']}")
        for idx, p in enumerate(rep["preview_paragraphs"][:12], start=1):
            snippet = p if len(p) <= 140 else p[:137] + "..."
            lines.append(f"  P{idx:02d}: {snippet}")
        for tbl in rep["tables"]:
            lines.append(f"  [Table #{tbl['table_index']}] {tbl['rows']} rows x {tbl['cols']} cols")
            for r_i, r_cells in enumerate(tbl["preview_rows"], start=1):
                lines.append(f"    T{tbl['table_index']}.R{r_i:02d}: " + " | ".join(r_cells))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generic Office (.xlsx / .docx) structure and formula recalculation inspector.")
    parser.add_argument("targets", nargs="+", help="Paths to .xlsx / .docx files or directories containing them")
    parser.add_argument("--max-rows", type=int, default=25, help="Max preview rows per sheet/table (default: 25)")
    parser.add_argument("--json", action="store_true", help="Emit JSON output instead of plain text")
    args = parser.parse_args(argv)

    files: list[Path] = []
    for raw in args.targets:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(f for f in p.rglob("*") if f.is_file() and f.suffix.lower() in (".xlsx", ".docx") and not f.name.startswith("~$")))
        elif p.is_file():
            files.append(p)
        else:
            print(f"ERROR: Target not found: {raw}", file=sys.stderr)
            return 2

    reports: list[dict[str, Any]] = []
    exit_code = 0
    for f in files:
        suf = f.suffix.lower()
        try:
            if suf == ".xlsx":
                rep = inspect_xlsx(f, max_rows=args.max_rows)
                if rep["total_formula_errors"] > 0:
                    exit_code = 1
            elif suf == ".docx":
                rep = inspect_docx(f, max_rows=args.max_rows)
            else:
                rep = {"file": str(f), "type": suf.lstrip("."), "size_bytes": f.stat().st_size, "status": "UNSUPPORTED_EXTENSION"}
            reports.append(rep)
        except Exception as exc:
            exit_code = 2
            reports.append({"file": str(f), "type": suf.lstrip("."), "size_bytes": f.stat().st_size if f.exists() else 0, "status": f"CORRUPT_OR_INVALID: {exc}"})

    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    else:
        for rep in reports:
            if "sheets" in rep or "tables" in rep:
                print(format_human_report(rep))
            else:
                print(f"=== {rep['file']} -> {rep['status']} ===")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

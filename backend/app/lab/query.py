"""A small SELECT dialect over the current rate table. No joins and no writes."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from app.lab.monitor import RateRow

TABLE = "rates"
MAX_ROWS = 200
MAX_SERIES = 8

COLUMNS: dict[str, Callable[[RateRow], Any]] = {
    "ward": lambda row: row.ward_code,
    "ward_name": lambda row: row.ward_en,
    "organism": lambda row: row.organism,
    "antibiotic": lambda row: row.antibiotic,
    "code": lambda row: row.antibiotic_code,
    "n_4w": lambda row: row.n_4w,
    "pct_4w": lambda row: row.pct_4w,
    "n_year": lambda row: row.n_year,
    "pct_year": lambda row: row.pct_year,
    "z": lambda row: row.z,
    "level": lambda row: row.level,
    "direction": lambda row: row.direction,
}
ALIASES = {
    "ward_code": "ward",
    "ward_en": "ward_name",
    "antibiotic_code": "code",
}
SHEET_COLUMNS = list(COLUMNS)

_TOKEN = re.compile(
    r"\s+|--[^\n]*|'(?:[^']|'')*'|\d+(?:\.\d+)?|!=|<>|<=|>=|-|[(),*=<>]|[A-Za-z_][A-Za-z0-9_]*"
)
_KEYWORDS = {
    "SELECT",
    "FROM",
    "WHERE",
    "AND",
    "OR",
    "NOT",
    "ORDER",
    "BY",
    "LIMIT",
    "ASC",
    "DESC",
    "IS",
    "NULL",
    "LIKE",
    "IN",
    "AS",
}


class QueryError(ValueError):
    pass


@dataclass
class _Tok:
    kind: str
    text: str


def _tokenize(sql: str) -> list[_Tok]:
    tokens: list[_Tok] = []
    pos = 0
    while pos < len(sql):
        match = _TOKEN.match(sql, pos)
        if match is None:
            raise QueryError(f"Unexpected character {sql[pos]!r}.")
        raw = match.group(0)
        pos = match.end()
        if raw[0].isspace() or raw.startswith("--"):
            continue
        if raw.startswith("'"):
            tokens.append(_Tok("string", raw[1:-1].replace("''", "'")))
        elif raw[0].isdigit():
            tokens.append(_Tok("number", raw))
        elif raw.upper() in _KEYWORDS:
            tokens.append(_Tok(raw.upper(), raw))
        elif re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", raw):
            tokens.append(_Tok("ident", raw))
        else:
            tokens.append(_Tok(raw, raw))
    tokens.append(_Tok("eof", ""))
    return tokens


class _Parser:
    def __init__(self, tokens: list[_Tok]) -> None:
        self.tokens = tokens
        self.i = 0

    def peek(self) -> _Tok:
        return self.tokens[self.i]

    def take(self, kind: str | None = None) -> _Tok:
        tok = self.peek()
        if kind is not None and tok.kind != kind:
            raise QueryError(f"Expected {kind}, got {tok.text or 'end of query'}.")
        self.i += 1
        return tok

    def accept(self, kind: str) -> _Tok | None:
        if self.peek().kind == kind:
            return self.take()
        return None


def _column(name: str) -> str:
    key = name.lower()
    key = ALIASES.get(key, key)
    if key not in COLUMNS:
        known = ", ".join(SHEET_COLUMNS)
        raise QueryError(f"Unknown column {name}. Use one of: {known}.")
    return key


def _value(row: RateRow, column: str) -> Any:
    return COLUMNS[column](row)


def _like(text: str, pattern: str) -> bool:
    escaped = ""
    for char in pattern:
        if char == "%":
            escaped += ".*"
        elif char == "_":
            escaped += "."
        else:
            escaped += re.escape(char)
    return re.fullmatch(escaped, text, flags=re.IGNORECASE) is not None


def _cmp(left: Any, op: str, right: Any) -> bool:
    if left is None or right is None:
        return False
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        a, b = float(left), float(right)
    else:
        a, b = str(left), str(right)
    if op == "=":
        return a == b
    if op in {"!=", "<>"}:
        return a != b
    if op == "<":
        return a < b
    if op == ">":
        return a > b
    if op == "<=":
        return a <= b
    if op == ">=":
        return a >= b
    raise QueryError(f"Unknown comparison {op}.")


def run_query(rows: list[RateRow], sql: str) -> dict[str, Any]:
    text = sql.strip()
    if not text:
        raise QueryError("Enter a SELECT query against rates.")
    if ";" in text:
        raise QueryError("One SELECT statement only.")
    parser = _Parser(_tokenize(text))
    parser.take("SELECT")
    columns = _select_list(parser)
    parser.take("FROM")
    table = parser.take("ident")
    if table.text.lower() != TABLE:
        raise QueryError("Queries read FROM rates.")
    where = _where(parser)
    order = _order(parser)
    limit = _limit(parser)
    if parser.peek().kind != "eof":
        raise QueryError(f"Unexpected {parser.peek().text}.")

    matched = [row for row in rows if where(row)]
    matched.sort(key=lambda row: tuple(_sort_key(row, column, descending) for column, descending in order))
    total = len(matched)
    if limit is not None:
        matched = matched[:limit]
    sheet = matched[:MAX_ROWS]
    chart_rows = matched[:MAX_SERIES]
    return {
        "columns": columns,
        "rows": [{column: _value(row, column) for column in columns} for row in sheet],
        "series": [
            {
                "name": f"{row.ward_code} · {row.organism} · {row.antibiotic_code}",
                "values": list(row.sparkline),
                "limit": row.pct_year,
            }
            for row in chart_rows
        ],
        "matched": total,
        "sheet_count": len(sheet),
    }


def _sort_key(row: RateRow, column: str, descending: bool) -> tuple:
    value = _value(row, column)
    missing = value is None
    if isinstance(value, (int, float)):
        ranked: Any = float(value)
    else:
        ranked = "" if value is None else str(value).lower()
    if descending:
        if isinstance(ranked, float):
            ranked = -ranked
        else:
            ranked = tuple(-ord(ch) for ch in str(ranked))
    return (missing, ranked)


def _select_list(parser: _Parser) -> list[str]:
    if parser.accept("*"):
        return list(SHEET_COLUMNS)
    columns: list[str] = []
    while True:
        name = parser.take("ident")
        column = _column(name.text)
        if parser.accept("AS"):
            parser.take("ident")
        columns.append(column)
        if parser.accept(",") is None:
            break
    return columns


def _where(parser: _Parser) -> Callable[[RateRow], bool]:
    if parser.accept("WHERE") is None:
        return lambda _row: True
    return _or(parser)


def _or(parser: _Parser) -> Callable[[RateRow], bool]:
    left = _and(parser)
    while parser.accept("OR"):
        right = _and(parser)
        previous = left
        left = lambda row, a=previous, b=right: a(row) or b(row)
    return left


def _and(parser: _Parser) -> Callable[[RateRow], bool]:
    left = _not(parser)
    while parser.accept("AND"):
        right = _not(parser)
        previous = left
        left = lambda row, a=previous, b=right: a(row) and b(row)
    return left


def _not(parser: _Parser) -> Callable[[RateRow], bool]:
    if parser.accept("NOT"):
        inner = _not(parser)
        return lambda row, pred=inner: not pred(row)
    return _primary(parser)


def _primary(parser: _Parser) -> Callable[[RateRow], bool]:
    if parser.accept("("):
        inner = _or(parser)
        parser.take(")")
        return inner
    column = _column(parser.take("ident").text)
    if parser.accept("IS"):
        negated = parser.accept("NOT") is not None
        parser.take("NULL")
        return lambda row, col=column, neg=negated: (_value(row, col) is None) ^ neg
    if parser.accept("LIKE"):
        pattern = parser.take("string").text
        return lambda row, col=column, pat=pattern: isinstance(_value(row, col), str) and _like(str(_value(row, col)), pat)
    if parser.accept("IN"):
        parser.take("(")
        values = [_literal(parser)]
        while parser.accept(","):
            values.append(_literal(parser))
        parser.take(")")
        return lambda row, col=column, opts=tuple(values): _value(row, col) in opts
    op = parser.peek()
    if op.kind not in {"=", "!=", "<>", "<", ">", "<=", ">="}:
        raise QueryError(f"Expected a comparison after {column}.")
    parser.take()
    literal = _literal(parser)
    return lambda row, col=column, oper=op.kind, lit=literal: _cmp(_value(row, col), oper, lit)


def _literal(parser: _Parser) -> Any:
    sign = -1 if parser.accept("-") else 1
    tok = parser.peek()
    if sign < 0 and tok.kind != "number":
        raise QueryError("Expected a number after '-'.")
    if tok.kind == "string":
        parser.take()
        return tok.text
    if tok.kind == "number":
        parser.take()
        number = float(tok.text) if "." in tok.text else int(tok.text)
        return number * sign
    if tok.kind == "NULL":
        parser.take()
        return None
    raise QueryError(f"Expected a value, got {tok.text or 'end of query'}.")


def _order(parser: _Parser) -> list[tuple[str, bool]]:
    if parser.accept("ORDER") is None:
        return [("organism", False), ("code", False), ("ward", False)]
    parser.take("BY")
    items: list[tuple[str, bool]] = []
    while True:
        column = _column(parser.take("ident").text)
        descending = False
        if parser.accept("DESC"):
            descending = True
        else:
            parser.accept("ASC")
        items.append((column, descending))
        if parser.accept(",") is None:
            break
    return items


def _limit(parser: _Parser) -> int | None:
    if parser.accept("LIMIT") is None:
        return None
    number = parser.take("number")
    if "." in number.text:
        raise QueryError("LIMIT must be a whole number.")
    value = int(number.text)
    if value < 0:
        raise QueryError("LIMIT must be zero or more.")
    return value

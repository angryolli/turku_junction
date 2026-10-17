import unittest

from app.lab.monitor import RateRow
from app.lab.query import QueryError, run_query


def row(**kwargs) -> RateRow:
    base = dict(
        ward_code="ICU",
        ward_en="Intensive care unit",
        organism="Escherichia coli",
        antibiotic="ampicillin",
        antibiotic_code="AMP",
        n_4w=10,
        pct_4w=None,
        n_year=40,
        pct_year=12.5,
        z=None,
        level="normal",
        direction="",
        sparkline=[1.0, 2.0],
    )
    base.update(kwargs)
    return RateRow(**base)


class QueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [
            row(),
            row(ward_code="ED", ward_en="Emergency department", antibiotic_code="CXM", antibiotic="cefuroxime", z=2.4, pct_4w=20.0, n_4w=40, direction="up", level="yellow", sparkline=[3.0, 4.0]),
            row(ward_code="PHC-N", organism="Klebsiella pneumoniae", antibiotic_code="MEM", antibiotic="meropenem", pct_4w=0.0, n_4w=30, z=-0.2),
        ]

    def test_where_and_order(self) -> None:
        result = run_query(
            self.rows,
            "SELECT ward, code, z FROM rates WHERE organism = 'Escherichia coli' AND code = 'AMP' ORDER BY ward",
        )
        self.assertEqual(result["rows"], [{"ward": "ICU", "code": "AMP", "z": None}])
        self.assertEqual(result["series"][0]["values"], [1.0, 2.0])

    def test_like_or_and_null(self) -> None:
        result = run_query(
            self.rows,
            "SELECT ward FROM rates WHERE organism LIKE '%coli%' OR (ward = 'PHC-N' AND pct_4w IS NOT NULL)",
        )
        wards = {item["ward"] for item in result["rows"]}
        self.assertEqual(wards, {"ICU", "ED", "PHC-N"})

    def test_comparison_and_limit(self) -> None:
        result = run_query(self.rows, "SELECT ward, z FROM rates WHERE z > 2 ORDER BY z DESC LIMIT 1")
        self.assertEqual(result["rows"], [{"ward": "ED", "z": 2.4}])
        self.assertEqual(result["matched"], 1)

    def test_rejects_writes(self) -> None:
        with self.assertRaises(QueryError):
            run_query(self.rows, "DELETE FROM rates")
        with self.assertRaises(QueryError):
            run_query(self.rows, "SELECT * FROM rates; SELECT * FROM rates")


if __name__ == "__main__":
    unittest.main()

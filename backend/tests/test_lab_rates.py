from __future__ import annotations

import unittest
from datetime import date, timedelta

import numpy as np

from app.lab.monitor import LabMonitor
from app.lab.rates import MIN_ISOLATES, accumulate, first_isolate_indices, proportion_z, window_bounds
from app.lab.table import LabTable


def _table(rows: list[tuple]) -> LabTable:
    """rows: date, patient, organism, specimen, ward, sex, drug results tuple."""
    n = len(rows)
    start = min(item[0] for item in rows)
    end = max(item[0] for item in rows)
    days: list[date] = []
    cursor = start
    while cursor <= end:
        days.append(cursor)
        cursor += timedelta(days=1)
    n_drugs = len(rows[0][6])
    return LabTable(
        dates=np.array([item[0].toordinal() for item in rows], dtype=np.int32),
        patient=np.array([item[1] for item in rows], dtype=np.int32),
        organism=np.array([item[2] for item in rows], dtype=np.int32),
        specimen=np.array([item[3] for item in rows], dtype=np.int32),
        ward=np.array([item[4] for item in rows], dtype=np.int32),
        sex=np.array([item[5] for item in rows], dtype=np.int32),
        results=np.array([item[6] for item in rows], dtype=np.int8),
        drug_codes=["AMP", "NIT"],
        drug_names=["ampicillin", "nitrofurantoin"],
        urine_only=np.array([False, True]),
        organism_names=["Escherichia coli"],
        specimen_names=["urine", "blood"],
        sex_names=["F", "M"],
        ward_codes=["ICU", "ED"],
        ward_names=["Intensive care unit", "Emergency department"],
        ward_types=["in", "out"],
        days=days,
        urine_specimen=0,
    )


class FirstIsolateTests(unittest.TestCase):
    def test_repeat_patient_is_dropped(self) -> None:
        day = date(2024, 1, 1)
        table = _table(
            [
                (day, 1, 0, 0, 0, 0, (0, -1)),
                (day + timedelta(days=1), 1, 0, 0, 0, 0, (1, -1)),
                (day, 2, 0, 0, 0, 0, (1, -1)),
            ]
        )
        lo, hi = window_bounds((day + timedelta(days=10)).toordinal())[0]
        kept = first_isolate_indices(table, lo, hi)
        self.assertEqual(kept.tolist(), [0, 2])
        counts = accumulate(table, kept)
        cell = counts[(0, 0, 0)]
        self.assertEqual((cell.n, cell.resistant), (2, 1))

    def test_later_ward_does_not_replace_an_earlier_isolate(self) -> None:
        day = date(2024, 1, 1)
        table = _table(
            [
                (day, 1, 0, 0, 1, 0, (0, -1)),
                (day + timedelta(days=1), 1, 0, 0, 0, 0, (1, -1)),
            ]
        )
        lo, hi = window_bounds((day + timedelta(days=10)).toordinal())[0]
        kept = first_isolate_indices(table, lo, hi)
        icu = accumulate(table, kept, ward=0)
        self.assertEqual(icu, {})

    def test_rate_stays_blank_below_thirty(self) -> None:
        day = date(2024, 1, 1)
        table = _table([(day, i, 0, 0, 0, 0, (1, -1)) for i in range(MIN_ISOLATES - 1)])
        lo, hi = window_bounds((day + timedelta(days=10)).toordinal())[0]
        counts = accumulate(table, first_isolate_indices(table, lo, hi))
        cell = counts[(0, 0, 0)]
        self.assertIsNone(cell.percent)
        self.assertIsNone(proportion_z(cell, cell))

    def test_urine_only_drug_ignores_blood(self) -> None:
        day = date(2024, 1, 1)
        table = _table([(day, 1, 0, 1, 0, 0, (-1, 1))])
        lo, hi = window_bounds((day + timedelta(days=5)).toordinal())[0]
        counts = accumulate(table, first_isolate_indices(table, lo, hi))
        self.assertNotIn((0, 0, 1), counts)


class AlertTests(unittest.TestCase):
    def test_alert_fires_once_when_the_rate_crosses(self) -> None:
        start = date(2024, 1, 1)
        rows = []
        patient = 0
        for offset in range(365):
            patient += 1
            rows.append((start + timedelta(days=offset), patient, 0, 0, 0, 0, (0, -1)))
        for offset in range(365, 400):
            for _ in range(2):
                patient += 1
                rows.append((start + timedelta(days=offset), patient, 0, 0, 0, 0, (1, -1)))
        monitor = LabMonitor(_table(rows))
        fired: list[str] = []
        for _ in range(len(monitor.table.days)):
            alerts = monitor.step()
            fired.extend(alert.level for alert in alerts)
        self.assertEqual(fired.count("red"), 1)
        self.assertLessEqual(fired.count("yellow"), 1)
        self.assertTrue(monitor.hot)
        self.assertIsNotNone(monitor.hot[0].pct_4w)
        self.assertGreater(monitor.hot[0].pct_4w or 0, 50)

    def test_blank_cell_does_not_alert(self) -> None:
        start = date(2024, 6, 1)
        rows = [(start + timedelta(days=i), i, 0, 0, 0, 0, (1, -1)) for i in range(40)]
        monitor = LabMonitor(_table(rows))
        alerts = []
        for _ in range(len(monitor.table.days)):
            alerts.extend(monitor.step())
        self.assertEqual(alerts, [])


if __name__ == "__main__":
    unittest.main()

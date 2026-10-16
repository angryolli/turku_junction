from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from app.config import REPO_ROOT


def lab_data_dir() -> Path:
    raw = Path(os.environ.get("LAB_DATA_DIR", "").strip() or REPO_ROOT / "turku_data_processing").expanduser()
    if not (raw / "cultures.csv").is_file():
        raise FileNotFoundError(f"Lab CSVs not found in {raw}")
    return raw


@dataclass
class LabTable:
    """One row per isolate, susceptibility packed as S=0 / R=1 / not tested=-1."""

    dates: np.ndarray
    patient: np.ndarray
    organism: np.ndarray
    specimen: np.ndarray
    ward: np.ndarray
    sex: np.ndarray
    results: np.ndarray
    drug_codes: list[str]
    drug_names: list[str]
    urine_only: np.ndarray
    organism_names: list[str]
    specimen_names: list[str]
    sex_names: list[str]
    ward_codes: list[str]
    ward_names: list[str]
    ward_types: list[str]
    days: list[date]
    urine_specimen: int

    def drug_index(self, code: str) -> int:
        return self.drug_codes.index(code)

    def name_index(self, names: list[str], value: str | None) -> int | None:
        if value is None or value == "" or value == "all":
            return None
        return names.index(value)


def _codes(series: pd.Series, order: list[str] | None = None) -> tuple[np.ndarray, list[str]]:
    if order is None:
        names = list(dict.fromkeys(series.astype(str).tolist()))
    else:
        present = set(series.astype(str))
        names = [name for name in order if name in present]
        names.extend(name for name in dict.fromkeys(series.astype(str).tolist()) if name not in names)
    lookup = {name: i for i, name in enumerate(names)}
    coded = np.fromiter((lookup[str(value)] for value in series.tolist()), dtype=np.int32, count=len(series))
    return coded, names


def load_lab(directory: Path | None = None) -> LabTable:
    folder = directory or lab_data_dir()
    patients = pd.read_csv(folder / "patients.csv", dtype=str)
    wards = pd.read_csv(folder / "wards.csv", dtype=str)
    antibiotics = pd.read_csv(folder / "antibiotics.csv", dtype=str)
    cultures = pd.read_csv(
        folder / "cultures.csv",
        usecols=["culture_id", "patient_id", "sample_date", "ward_code", "specimen"],
        dtype=str,
    )
    isolates = pd.read_csv(
        folder / "isolates.csv",
        usecols=["isolate_id", "culture_id", "organism"],
        dtype=str,
    )
    susceptibility = pd.read_csv(
        folder / "susceptibility.csv",
        usecols=["isolate_id", "antibiotic_code", "result"],
        dtype=str,
    )

    base = isolates.merge(cultures, on="culture_id", how="inner")
    base = base.merge(patients[["patient_id", "sex"]], on="patient_id", how="left")
    base["sex"] = base["sex"].fillna("U")
    base["sample_date"] = pd.to_datetime(base["sample_date"])
    base = base.sort_values(["sample_date", "isolate_id"], kind="mergesort").reset_index(drop=True)

    drug_codes = antibiotics["antibiotic_code"].astype(str).tolist()
    drug_names = antibiotics["antibiotic"].astype(str).tolist()
    urine_only = antibiotics["reported_for"].astype(str).eq("urine").to_numpy()

    organism_order = base["organism"].value_counts().index.astype(str).tolist()
    ward_order = wards["ward_code"].astype(str).tolist()
    specimen_order = ["urine", "blood", "wound"]
    sex_order = ["F", "M", "U"]

    patient, _ = _codes(base["patient_id"])
    organism, organism_names = _codes(base["organism"], organism_order)
    specimen, specimen_names = _codes(base["specimen"], specimen_order)
    sex, sex_names = _codes(base["sex"], sex_order)
    ward, ward_codes = _codes(base["ward_code"], ward_order)

    ward_meta = wards.set_index(wards["ward_code"].astype(str))
    ward_names = [str(ward_meta.loc[code, "ward_en"]) if code in ward_meta.index else code for code in ward_codes]
    ward_types = [str(ward_meta.loc[code, "ward_type"]) if code in ward_meta.index else "" for code in ward_codes]

    code_to_j = {code: j for j, code in enumerate(drug_codes)}
    id_to_row = {isolate_id: i for i, isolate_id in enumerate(base["isolate_id"].astype(str).tolist())}
    results = np.full((len(base), len(drug_codes)), -1, dtype=np.int8)
    isolate_ids = susceptibility["isolate_id"].astype(str).tolist()
    codes = susceptibility["antibiotic_code"].astype(str).tolist()
    bits = np.where(susceptibility["result"].astype(str).eq("R").to_numpy(), np.int8(1), np.int8(0))
    for isolate_id, code, bit in zip(isolate_ids, codes, bits, strict=True):
        row = id_to_row.get(isolate_id)
        col = code_to_j.get(code)
        if row is None or col is None:
            continue
        results[row, col] = bit

    ordinals = np.fromiter(
        (value.toordinal() for value in base["sample_date"].dt.date.tolist()),
        dtype=np.int32,
        count=len(base),
    )
    start = base["sample_date"].min().date()
    end = base["sample_date"].max().date()
    days: list[date] = []
    cursor = start
    while cursor <= end:
        days.append(cursor)
        cursor += timedelta(days=1)

    urine_specimen = specimen_names.index("urine") if "urine" in specimen_names else -1
    return LabTable(
        dates=ordinals,
        patient=patient,
        organism=organism,
        specimen=specimen,
        ward=ward,
        sex=sex,
        results=results,
        drug_codes=drug_codes,
        drug_names=drug_names,
        urine_only=urine_only,
        organism_names=organism_names,
        specimen_names=specimen_names,
        sex_names=sex_names,
        ward_codes=ward_codes,
        ward_names=ward_names,
        ward_types=ward_types,
        days=days,
        urine_specimen=urine_specimen,
    )

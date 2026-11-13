#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import pandas as pd

REQUIRED = {"path", "label", "generator", "source_id", "split", "domain"}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("manifest", type=Path)
    args = p.parse_args()
    df = pd.read_csv(args.manifest)
    missing = REQUIRED - set(df.columns)
    if missing:
        raise SystemExit(f"Missing columns: {sorted(missing)}")
    if df["path"].duplicated().any():
        raise SystemExit("Duplicate paths detected.")
    if df["source_id"].isna().any():
        raise SystemExit("source_id cannot be empty; use it to prevent identity leakage.")
    leakage = df.groupby("source_id")["split"].nunique()
    if (leakage > 1).any():
        bad = leakage[leakage > 1].index.tolist()[:10]
        raise SystemExit(f"Data leakage: source_id occurs in multiple splits: {bad}")
    print(df.groupby(["split", "label"]).size().to_string())
    print("Generators:", df["generator"].nunique())
    print("Rows:", len(df))


if __name__ == "__main__":
    main()

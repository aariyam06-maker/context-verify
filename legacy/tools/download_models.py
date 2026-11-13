#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parents[1]
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"


def main() -> None:
    p = argparse.ArgumentParser(description="Download optional local face detector weights.")
    p.add_argument("--yunet", action="store_true")
    args = p.parse_args()
    target = ROOT / "data" / "models" / "face_detection_yunet_2023mar.onnx"
    if args.yunet:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            print(f"Already exists: {target}")
        else:
            print(f"Downloading YuNet -> {target}")
            urlretrieve(YUNET_URL, target)
            print("Done")
    else:
        p.print_help()


if __name__ == "__main__":
    main()

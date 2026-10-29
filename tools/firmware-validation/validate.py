# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Run independent offline machine checks; output JSON evidence, never firmware."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from validation import validate


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stock", type=Path, help="Ordinary local exact OEM v1.04 binary; also CRUSH80_STOCK_V104")
    parser.add_argument("--require-stock", action="store_true", help="Fail if exact OEM input was not supplied")
    parser.add_argument("--out", type=Path, help="Optional JSON report path (never firmware bytes)")
    args = parser.parse_args()
    stock_path = args.stock or (Path(os.environ["CRUSH80_STOCK_V104"]) if os.environ.get("CRUSH80_STOCK_V104") else None)
    if args.require_stock and stock_path is None:
        print("ERROR: --require-stock needs --stock or CRUSH80_STOCK_V104; OEM checks were not run", file=sys.stderr)
        return 2
    try:
        if stock_path is not None:
            resolved = stock_path.resolve(strict=True)
            if not resolved.is_file() or str(resolved).startswith("\\\\"):
                raise ValueError("Stock input must be an ordinary local file")
            if args.out is not None and args.out.resolve() == resolved:
                raise ValueError("Report output must not overwrite the stock input")
            stock = resolved.read_bytes()
        else:
            stock = None
        report = validate(stock)
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    text = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

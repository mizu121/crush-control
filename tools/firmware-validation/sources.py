# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Load the explicitly permitted GPL generators, never a previous verifier."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load permitted source {path}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


pkrg = load("_validation_pkrg_generator", "tools/per-key-firmware/pkrg_routines.py")
rear = load("_validation_rear_generator", "tools/rear-sync/build_proof.py")


def combined(stock: bytes):
    previous = sys.modules.get("pkrg_routines")
    sys.modules["pkrg_routines"] = pkrg
    try:
        builder = load("_validation_combined_builder", "tools/per-key-firmware/build_v104.py")
        return builder.build(stock)
    finally:
        if previous is None:
            sys.modules.pop("pkrg_routines", None)
        else:
            sys.modules["pkrg_routines"] = previous

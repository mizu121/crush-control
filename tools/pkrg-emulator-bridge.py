# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Offline JSON adapter for generated patch instructions, not OEM USB emulation.

No device access, flashing, image output or synthesized stock-firmware response.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys


def byte_array(value, size):
    if not isinstance(value, list) or len(value) != size or any(type(v) is not int or not 0 <= v <= 255 for v in value):
        raise ValueError(f"Expected exactly {size} byte integers")
    return bytes(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stock", nargs="?", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent / "firmware-validation"))
    from session import Session
    session = Session(args.stock.read_bytes() if args.stock else None)
    print(json.dumps({"ready": True, "scope": "PATCH_CPU_AT_OEM_CONTINUATION_BOUNDARIES", "physicalUSB": False}), flush=True)
    for line in sys.stdin:
        message = {}
        try:
            message = json.loads(line)
            operation = message.get("op")
            if operation == "request":
                result = session.request(byte_array(message["packet"], 32))
                result = None if result is None else list(result)
            elif operation == "frame":
                scale = message.get("multiplier", 256)
                if type(scale) is not int or not 0 <= scale <= 256:
                    raise ValueError("Multiplier fixture must be 0..256")
                native = message.get("native")
                result = list(session.render_frame(scale, native_frame=None if native is None else byte_array(native, 276)))
            elif operation == "rear_source":
                result = session.rear_source(byte_array(message["rgb"], 3))
            else:
                raise ValueError("Unsupported offline operation; native hue, USB and hardware behavior are not simulated")
            answer = {"id": message.get("id"), "result": result}
        except Exception as error:
            answer = {"id": message.get("id"), "error": f"{type(error).__name__}: {error}"}
        print(json.dumps(answer), flush=True)


if __name__ == "__main__":
    main()

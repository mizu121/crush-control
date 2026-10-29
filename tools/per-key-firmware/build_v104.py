# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Wobkey Crush 80 firmware patch contributors
# Adapted for an exact OEM v1.04 combined offline proof. See NOTICE.md.
"""EXPERIMENTAL / HARDWARE_UNTESTED PKRG v2 + rear-color offline proof.

Only explicit local file input and text/JSON outputs. Candidate bytes never
leave memory. No device APIs, firmware exporter, OTA container or flasher.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import struct

from pkrg_routines import (
    CAVE, CAVE_END, FRAME_BOUNDARY, FRONT, GET_SITE, IMAGE_SIZE, MAIN_ENTRY,
    MODE, RENDER_RETURN, RENDER_SITE, RESERVED_SIZE, RGB_BUFFER, SET_SITE,
    STACK_TOP, USB_SEND, VIA_RETURN, VIA_SILENT_RETURN, T0,
    build_routines, immediate, jump, startup_call,
)

REAR_PATH = Path(__file__).resolve().parents[1] / "rear-sync" / "build_proof.py"
_spec = importlib.util.spec_from_file_location("_rear_sync_proof", REAR_PATH)
rear = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rear)

STATUS = ["EXPERIMENTAL", "HARDWARE_UNTESTED", "OFFLINE_ANALYSIS_ONLY"]
STOCK_SHA256 = rear.STOCK_SHA256
SOURCE_COMMIT = "e7e4700ff903be8a679a56308f0753a6671f84ab"
ANCHORS = {
    0x44: "938202fc",
    0x1CE: "938262fc",
    0x172: "0100973200e09382023182920100010001000100010001a0",
    0x2D0: "0100973200009382223482920100010001000100010001a0",
    FRAME_BOUNDARY: "5d71a2c4",
    RENDER_SITE: "2300a700a300b7002301d700",
    SET_SITE: "8b174007",
    GET_SITE: "8b174007",
}
# Additional observed native continuations: these are checked, never patched.
CONTINUATIONS = {
    0xD4A4: "f2406244d2444249b249224a05618280",
    0xD60C: "8b6720155bd827005be817a809470b35e02e59b5",
    0xC6F8: "8b67802e2a87d9c7b72700e49c43dd8bb5e7b71610808386b68093f6f60fb9ce",
    0xA6C8: "8507e39ff8fc1308a802",
    0x7C4: "01080000",
}


def build(stock: bytes):
    """Return (combined candidate bytes, manifest), without writing any file."""
    rear.validate_stock(stock)
    for offset, expected_hex in {**ANCHORS, **CONTINUATIONS}.items():
        expected = bytes.fromhex(expected_hex)
        if stock[offset:offset+len(expected)] != expected:
            raise ValueError(f"Exact v1.04 anchor mismatch at {offset:#x}")
    if stock[CAVE:CAVE_END] != bytes(CAVE_END-CAVE):
        raise ValueError("Per-key cave is not entirely zero")
    routines, labels = build_routines()
    if CAVE + len(routines) > CAVE_END:
        raise ValueError("PKRG routines exceed the v1.04 zero cave")
    # Rear builder validates the immutable OEM source; changes are composed
    # in memory, not by weakening its guard to accept an arbitrary patch.
    rear_image, rear_manifest = rear.build(stock)
    result = bytearray(rear_image)
    replacements = {
        0x44: immediate(T0, T0, -0x40 - RESERVED_SIZE),
        0x1CE: immediate(T0, T0, -0x3A - RESERVED_SIZE),
        0x172: startup_call(labels["initialize"]),
        0x2D0: startup_call(labels["initialize"]),
        FRAME_BOUNDARY: jump(labels["boundary"] - FRAME_BOUNDARY),
        RENDER_SITE: jump(labels["render"] - RENDER_SITE) + bytes.fromhex("0100") * 4,
        SET_SITE: jump(labels["set_entry"] - SET_SITE),
        GET_SITE: jump(labels["get_entry"] - GET_SITE),
    }
    for offset, replacement in replacements.items():
        expected = bytes.fromhex(ANCHORS[offset])
        if len(replacement) != len(expected):
            raise ValueError(f"Splice length mismatch at {offset:#x}")
        if result[offset:offset+len(replacement)] != expected:
            raise ValueError(f"Rear/per-key overlap at {offset:#x}")
        result[offset:offset+len(replacement)] = replacement
    result[CAVE:CAVE+len(routines)] = routines
    result[-4:] = struct.pack("<I", rear.footer_crc(result))
    candidate = bytes(result)
    if len(candidate) != IMAGE_SIZE:
        raise ValueError("Image length changed")
    approved = [(CAVE,CAVE+len(routines)), (rear.CAVE_START,rear.CAVE_START+rear_manifest["cave"]["used_bytes"]), (len(stock)-4,len(stock))]
    approved += [(o,o+len(v)) for o,v in replacements.items()]
    approved += [(o,o+len(v)) for o,v in rear.HOOKS.items()]
    if any(not any(lo <= i < hi for lo,hi in approved) for i,(x,y) in enumerate(zip(stock,candidate)) if x != y):
        raise ValueError("Unexpected modification outside approved regions")
    ranges = rear.changed_ranges(stock,candidate)
    manifest = {
        "status": STATUS, "source_commit": SOURCE_COMMIT,
        "input": {"sha256": rear.sha(stock), "size": len(stock), "footer_crc": hex(rear.footer_crc(stock))},
        "candidate_in_memory": {"sha256": rear.sha(candidate), "size": len(candidate), "footer_crc": hex(rear.footer_crc(candidate))},
        "raw_firmware_exported": False,
        "protocol": {"magic": "PKRG", "version": 2, "channel": 127, "led_slots": 92, "chunk_slots": 8, "stream_fragment_slots": 9, "stream_fragments": 11},
        "per_key_cave": {"start": hex(CAVE), "end_exclusive": hex(CAVE_END), "available_bytes": CAVE_END-CAVE, "used_bytes": len(routines)},
        "rear_cave": rear_manifest["cave"],
        "ram": {"original_stack_top": hex(STACK_TOP), "new_stack_top": hex(RGB_BUFFER), "reserved_bytes": RESERVED_SIZE, "buffer0": hex(RGB_BUFFER), "buffer1": hex(RGB_BUFFER+276), "metadata": hex(FRONT), "mode": hex(MODE)},
        "labels": {name:hex(offset) for name,offset in labels.items()},
        "native_continuations": {"render":hex(RENDER_RETURN), "via_reply":hex(VIA_RETURN), "via_silent_full_epilogue":hex(VIA_SILENT_RETURN), "usb_send":hex(USB_SEND), "main_ram_address":hex(MAIN_ENTRY), "main_file_offset":"0x3534", "effect_dispatch":"0xa19c", "effect_return":"0xa1d0"},
        "per_key_splices": [{"offset":hex(o),"original":ANCHORS[o],"replacement":v.hex()} for o,v in replacements.items()],
        "rear_splices": rear_manifest["splices"],
        "checked_unchanged_anchors": [{"offset":hex(o),"bytes":b} for o,b in CONTINUATIONS.items()],
        "changed_byte_count":sum(row["length"] for row in ranges), "exact_changed_ranges":ranges,
        "preserved": ["OEM hue conversion, including Andes 0xC4E616FF", "native VIA paths outside channel127", "rear power/palette fields and mode5 behavior", "image length", "OEM CRC convention", "no new flash-writing routine"],
        "limitations": ["No hardware, boot-to-main, flash journal, full scheduler or wireless validation", "Main entry is a RAM execution address, not file offset", "Reserved608 bytes are not proof of worst-case stack headroom", "Only wired streaming supported", "Rear follows selected main solid color, not per-key frame colors", "Firmware-reported identity of connected device remains unverified", "Recovery from non-enumerating firmware remains unverified"]
    }
    return candidate,manifest


def build_image(stock: bytes) -> bytes:
    return build(stock)[0]


def assembly_listing(candidate, manifest):
    from capstone import Cs, CS_ARCH_RISCV, CS_MODE_RISCV32, CS_MODE_RISCVC
    decoder = Cs(CS_ARCH_RISCV, CS_MODE_RISCV32 | CS_MODE_RISCVC)
    blocks = [(CAVE,manifest["per_key_cave"]["used_bytes"],"PKRG v2 routines"),
              (rear.CAVE_START,manifest["rear_cave"]["used_bytes"],"Rear follow routines")]
    blocks += [(int(row["offset"],16),len(bytes.fromhex(row["replacement"])),"PKRG splice") for row in manifest["per_key_splices"]]
    lines = ["EXPERIMENTAL / HARDWARE_UNTESTED / OFFLINE ANALYSIS ONLY", "No firmware image exported.", ""]
    for offset,size,title in blocks:
        lines.append(f"{title} at {offset:#x} ({size} bytes)")
        decoded = 0
        for ins in decoder.disasm(candidate[offset:offset+size],offset):
            lines.append(f"{ins.address:05x}  {ins.bytes.hex():12s} {ins.mnemonic:10s} {ins.op_str}")
            decoded += ins.size
        if decoded != size:
            raise ValueError(f"Disassembly incomplete at {offset:#x}: {decoded}/{size}")
        lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stock",type=Path,help="Exact local OEM v1.04 source; never a device path")
    parser.add_argument("--out",required=True,type=Path)
    args = parser.parse_args()
    candidate,manifest = build(args.stock.read_bytes())
    listing = assembly_listing(candidate,manifest)
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/"combined-proof-manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    (args.out/"combined-proof-assembly.txt").write_text(listing,encoding="utf-8")
    print(json.dumps({"status":STATUS,"candidate_sha256":rear.sha(candidate),"per_key_cave_bytes":manifest["per_key_cave"]["used_bytes"],"raw_firmware_exported":False}))


if __name__ == "__main__":
    main()

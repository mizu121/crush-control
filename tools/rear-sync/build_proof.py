"""EXPERIMENTAL / HARDWARE_UNTESTED offline Crush80 v1.04 rear-sync proof.

Only reads/writes ordinary files. No device, HID, USB, OTA or flasher code.
Constructs the candidate image in memory; emits only manifest and assembly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

STOCK_SHA256 = "f8042ea15d9edaa1ce66fb898ac3cb0e1e5626fc96399d16e5ea42c45f72bd66"
STOCK_SIZE = 121332
CAVE_START, CAVE_END = 0x10A4, 0x12B0
HOOKS = {
    0xD8F4: bytes.fromhex("6ff09fd1"),
    0xAF04: bytes.fromhex("11476374f700"),
    0xAFE0: bytes.fromhex("83c75402"),
}
STATUS = ["EXPERIMENTAL", "HARDWARE_UNTESTED", "OFFLINE_ANALYSIS_ONLY"]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def footer_crc(data: bytes) -> int:
    return (~zlib.crc32(data[:-4])) & 0xFFFFFFFF


def i_type(op: int, rd: int, funct: int, rs1: int, imm: int) -> bytes:
    if not -2048 <= imm <= 2047:
        raise ValueError("I immediate out of range")
    return struct.pack("<I", ((imm & 0xFFF) << 20) | (rs1 << 15) | (funct << 12) | (rd << 7) | op)


def sb(rs2: int, rs1: int, imm: int) -> bytes:
    if not -2048 <= imm <= 2047:
        raise ValueError("S immediate out of range")
    n = imm & 0xFFF
    return struct.pack("<I", ((n >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | ((n & 31) << 7) | 0x23)


def or_reg(rd: int, rs1: int, rs2: int) -> bytes:
    return struct.pack("<I", (rs2 << 20) | (rs1 << 15) | (6 << 12) | (rd << 7) | 0x33)


def jump(pc: int, target: int) -> bytes:
    n = target - pc
    if n & 1 or not -(1 << 20) <= n < (1 << 20):
        raise ValueError("JAL target out of range")
    n &= 0x1FFFFF
    word = ((n >> 20) << 31) | (((n >> 1) & 0x3FF) << 21) | (((n >> 11) & 1) << 20) | (((n >> 12) & 0xFF) << 12) | 0x6F
    return struct.pack("<I", word)


def branch(pc: int, target: int, rs1: int, rs2: int, funct: int) -> bytes:
    n = target - pc
    if n & 1 or not -4096 <= n <= 4094:
        raise ValueError("Branch target out of range")
    n &= 0x1FFF
    word = (((n >> 12) & 1) << 31) | (((n >> 5) & 63) << 25) | (rs2 << 20) | (rs1 << 15) | (funct << 12) | (((n >> 1) & 15) << 8) | (((n >> 11) & 1) << 7) | 0x63
    return struct.pack("<I", word)


class Assembly:
    """Tiny explicit RV32I encoder; no assembler or downloaded patcher execution."""

    def __init__(self):
        self.labels: dict[str, int] = {}
        self.rows: list[dict] = []

    @property
    def pc(self):
        return CAVE_START + 4 * len(self.rows)

    def label(self, name):
        self.labels[name] = self.pc

    def emit(self, source, data):
        self.rows.append({"offset": self.pc, "asm": source, "data": data})

    def j(self, target):
        self.emit(f"j {target}", ("j", target))

    def b(self, source, rs1, rs2, funct, target):
        self.emit(source, ("b", target, rs1, rs2, funct))

    def finish(self):
        code = bytearray()
        for row in self.rows:
            data = row["data"]
            if isinstance(data, tuple):
                target = self.labels[data[1]] if isinstance(data[1], str) else data[1]
                data = jump(row["offset"], target) if data[0] == "j" else branch(row["offset"], target, *data[2:])
            row["bytes"] = data.hex()
            del row["data"]
            code.extend(data)
        if CAVE_START + len(code) > CAVE_END:
            raise ValueError("Proof exceeds verified zero cave")
        return bytes(code)


def make_code():
    a = Assembly()
    a.label("via_color_tail")
    # At D8F4: a5=state, a3=signed saturation, a4=~a3 from D8DC.
    # Reconstruct a4 instead of introducing stack/RAM scratch writes.
    a.emit("addi a4,zero,5", i_type(0x13, 14, 0, 0, 5))
    a.emit("sb a4,0x24(a5)", sb(14, 15, 0x24))
    a.emit("xori a4,a3,-1", i_type(0x13, 14, 4, 13, -1))
    a.j(0xD60C)

    a.label("side_dispatch")
    a.emit("addi a4,zero,5", i_type(0x13, 14, 0, 0, 5))
    a.b("beq a5,a4,follow_dispatch", 15, 14, 0, "follow_dispatch")
    a.emit("addi a4,zero,4", i_type(0x13, 14, 0, 0, 4))
    a.b("bgeu a4,a5,native_dispatch", 14, 15, 7, "native_dispatch")
    a.j(0xAF0A)
    a.label("native_dispatch")
    a.j(0xAF0E)
    a.label("follow_dispatch")
    a.emit("addi a4,zero,4", i_type(0x13, 14, 0, 0, 4))
    a.j(0xAF50)

    a.label("side_color_source")
    a.emit("lbu a5,0x24(s1)", i_type(0x03, 15, 4, 9, 0x24))
    a.emit("addi a5,a5,-5", i_type(0x13, 15, 0, 15, -5))
    a.b("bne a5,zero,native_source", 15, 0, 1, "native_source")
    a.emit("lbu a5,0x1e(s1)", i_type(0x03, 15, 4, 9, 0x1E))
    for reg, name, off in [(22, "s6", 6), (25, "s9", 7), (26, "s10", 8)]:
        a.emit(f"lbu {name},{off}(s1)", i_type(0x03, reg, 4, 9, off))
        a.emit(f"or {name},{name},a5", or_reg(reg, reg, 15))
    a.j(0xAFFC)
    a.label("native_source")
    a.emit("lbu a5,0x25(s1)", i_type(0x03, 15, 4, 9, 0x25))
    a.j(0xAFE4)
    code = a.finish()
    return code, a


def validate_stock(stock: bytes):
    if len(stock) != STOCK_SIZE or sha(stock) != STOCK_SHA256:
        raise ValueError("Rejected: input must exactly match audited OEM v1.04 SHA256 and length")
    if stock[CAVE_START:CAVE_END] != bytes(CAVE_END - CAVE_START):
        raise ValueError("Rejected: reserved cave is not entirely zero")
    for offset, expected in HOOKS.items():
        if stock[offset:offset + len(expected)] != expected:
            raise ValueError(f"Rejected: splice precondition differs at {offset:#x}")
    if struct.unpack("<I", stock[-4:])[0] != footer_crc(stock):
        raise ValueError("Rejected: original OEM footer CRC mismatch")


def changed_ranges(old: bytes, new: bytes):
    ranges = []
    start = None
    for i in range(len(old) + 1):
        different = i < len(old) and old[i] != new[i]
        if different and start is None:
            start = i
        if not different and start is not None:
            ranges.append({"offset": start, "offset_hex": hex(start), "length": i - start,
                           "before": old[start:i].hex(), "after": new[start:i].hex()})
            start = None
    return ranges


def build(stock: bytes):
    validate_stock(stock)
    code, assembly = make_code()
    image = bytearray(stock)
    image[CAVE_START:CAVE_START + len(code)] = code
    image[0xD8F4:0xD8F8] = jump(0xD8F4, assembly.labels["via_color_tail"])
    image[0xAF04:0xAF0A] = jump(0xAF04, assembly.labels["side_dispatch"]) + bytes.fromhex("0100")
    image[0xAFE0:0xAFE4] = jump(0xAFE0, assembly.labels["side_color_source"])
    image[-4:] = struct.pack("<I", footer_crc(image))
    assert len(image) == len(stock)
    approved = [(CAVE_START, CAVE_START + len(code)), (0xD8F4, 0xD8F8), (0xAF04, 0xAF0A), (0xAFE0, 0xAFE4), (len(stock) - 4, len(stock))]
    assert all(any(lo <= i < hi for lo, hi in approved) for i, (x, y) in enumerate(zip(stock, image)) if x != y)
    result = bytes(image)
    ranges = changed_ranges(stock, result)
    manifest = {
        "status": STATUS, "purpose": "Offline feasibility proof; no hardware validation or supported installation package",
        "input": {"label": "Audited OEM v1.04 source artifact (not a device readback)", "sha256": sha(stock), "size": len(stock), "footer_crc_hex": hex(footer_crc(stock))},
        "output": {"sha256": sha(result), "size": len(result), "footer_crc_hex": hex(footer_crc(result))},
        "cave": {"start": hex(CAVE_START), "end_exclusive": hex(CAVE_END), "available_bytes": CAVE_END-CAVE_START, "used_bytes": len(code)},
        "entry_points": {name: hex(value) for name, value in assembly.labels.items()},
        "splices": [{"offset": hex(o), "original": b.hex(), "replacement": result[o:o+len(b)].hex()} for o,b in HOOKS.items()],
        "instructions": [{"offset": hex(row["offset"]), "asm": row["asm"], "bytes": row["bytes"]} for row in assembly.rows],
        "changed_byte_count": sum(r["length"] for r in ranges), "exact_changed_ranges": ranges,
        "preserved": ["OEM hue-to-RGB conversion", "native rear modes 0-4", "rear power state[0x27]", "global inhibit state[0x28]", "native palette flag/index state[0x25:0x27]", "OEM brightness scaling and renderer timing", "image length", "no added flash writes or dirty flags"],
        "limitations": ["Not run on hardware; actual connected firmware is not CRC/SHA verified", "Not a complete CPU/peripheral/scheduler emulator", "No OTA container or flasher is provided", "Mode5 may persist through ordinary settings save; stock rollback rejects it until physical side-mode change/reset", "Physical side-color changes remain latent during mode5; physical side-mode exits5 to0", "Some Andes packed operations remain outside the independent whole-image audit"]
    }
    return result, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stock", type=Path, help="Exact audited OEM v1.04 firmware.bin; local file only")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    image, manifest = build(args.stock.read_bytes())
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "rear-sync-proof-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    listing = "EXPERIMENTAL / HARDWARE_UNTESTED / OFFLINE ANALYSIS ONLY\n\n"
    listing += "\n".join(f"{row['offset']:>8}  {row['bytes']}  {row['asm']}" for row in manifest["instructions"])
    (args.out / "rear-sync-proof-assembly.txt").write_text(listing + "\n", encoding="utf-8")
    print(json.dumps({"status": STATUS, "output_sha256": sha(image), "cave_bytes": manifest["cave"]["used_bytes"], "changed_bytes": manifest["changed_byte_count"], "raw_image_emitted": False}))


if __name__ == "__main__":
    main()

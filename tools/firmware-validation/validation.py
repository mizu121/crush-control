# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Independent machine-observation checks for the licensed patch generators.

Expected protocol values are asserted independently of generator constants.
Addresses and routine entry points come from those explicitly permitted
generators. This suite never imports an older emulator or verifier.
"""
from __future__ import annotations

import hashlib
import platform
from typing import Callable

import unicorn

from engine import FLASH, GP, OUTPUT, PACKET, STACK, STOP, ExecutionError, Machine, require_registers
from sources import combined, pkrg as p, rear


class Suite:
    def __init__(self, stock: bytes | None = None):
        routine, self.labels = p.build_routines()
        rear_code, rear_assembly = rear.make_code()
        self.rear_labels = rear_assembly.labels
        self.stock = stock
        if stock is None:
            image = bytearray(0x12000)
            image[p.CAVE:p.CAVE + len(routine)] = routine
            image[rear.CAVE_START:rear.CAVE_START + len(rear_code)] = rear_code
            self.image, self.manifest = bytes(image), None
        else:
            self.image, self.manifest = combined(stock)
        self.patch_code = [(FLASH + p.CAVE, FLASH + p.CAVE + len(routine))]
        self.rear_code = [(FLASH + rear.CAVE_START, FLASH + rear.CAVE_START + len(rear_code))]
        self.instructions = 0
        self.runs = 0
        self.responses: list[dict] = []

    def machine(self) -> Machine:
        result = Machine(self.image)
        result.write(GP + 0x153, b"\x02")  # explicitly modeled wired transport state
        return result

    def entry(self, label: str, site: int | None = None) -> int:
        return FLASH + (site if self.stock is not None and site is not None else self.labels[label])

    def execute(self, machine: Machine, entry: int, *, stops, writable=(), extra_code=(), budget=10000):
        result = machine.run(entry, stops=stops, code=self.patch_code + list(extra_code),
                             writable=writable, budget=budget)
        self.instructions += result.instructions
        self.runs += 1
        return result

    def packet(self, machine: Machine, command: int, operation: int, data: bytes = b"", *,
               channel: int = 127, frame_id: int = 0):
        request = bytes((command, channel, operation, frame_id)) + data
        if len(request) > 32:
            raise ValueError("Packet fixture exceeds 32 bytes")
        machine.write(PACKET, request.ljust(32, b"\0"))
        before = machine.registers()
        site = p.GET_SITE if command == 8 else p.SET_SITE
        label = "get_entry" if command == 8 else "set_entry"
        response = self.execute(machine, self.entry(label, site),
            stops=(FLASH + p.VIA_RETURN, FLASH + p.VIA_SILENT_RETURN,
                   FLASH + p.GET_SITE + 4, FLASH + p.SET_SITE + 4),
            writable=((PACKET, PACKET + 32), (p.RGB_BUFFER, p.STACK_TOP), (STACK - 64, STACK)),
            extra_code=((FLASH + site, FLASH + site + 4),))
        require_registers(before, machine, () if channel == 127 else (15,))
        packet = machine.read(PACKET, 32)
        self.responses.append({"command": command, "channel": channel, "operation": operation,
                               "stop": hex(response.stop), "response_prefix": packet[:16].hex(),
                               "capture_kind": "RAM packet at continuation boundary, not USB transmission"})
        return packet, response

    def mode(self, machine, value):
        packet, observation = self.packet(machine, 7, 1, bytes((value,)))
        assert packet[3] == 0 and observation.stop == FLASH + p.VIA_RETURN

    def initialization(self):
        machine = self.machine()
        machine.write(p.RGB_BUFFER - 4, b"\xC3" * (p.RESERVED_SIZE + 4))
        before = machine.registers()
        self.execute(machine, FLASH + self.labels["initialize"], stops=(STOP,),
                     writable=((p.RGB_BUFFER, p.STACK_TOP),))
        assert machine.read(p.RGB_BUFFER, 608) == bytes(608)
        assert machine.read(p.RGB_BUFFER - 4, 4) == b"\xC3" * 4
        require_registers(before, machine, (5, 6))

    def capability_and_modes(self):
        machine = self.machine()
        reply, result = self.packet(machine, 8, 0)
        assert result.stop == FLASH + p.VIA_RETURN
        assert reply[3:16] == b"\0PKRG\x02\x5C\x08\0\x09\x0B\0\0"
        for mode in (1, 0, 1):
            self.mode(machine, mode)
            assert machine.u32(p.MODE) == mode
            reply, _ = self.packet(machine, 8, 1)
            assert reply[3:5] == bytes((0, mode))
        for invalid in (2, 127, 255):
            reply, _ = self.packet(machine, 7, 1, bytes((invalid,)))
            assert reply[3] == 3 and machine.u32(p.MODE) == 1
        for command, operation in ((7, 0), (8, 3), (8, 4), (7, 255)):
            reply, _ = self.packet(machine, command, operation)
            assert reply[3] == 1

    def chunk_roundtrip_and_bounds(self):
        machine = self.machine()
        expected = bytes((i * 73 + 19) & 255 for i in range(276))
        for first in range(0, 92, 8):
            count = min(8, 92 - first)
            reply, _ = self.packet(machine, 7, 2, bytes((first, count)) + expected[first * 3:(first + count) * 3])
            assert reply[3] == 0
        assert machine.read(p.RGB_BUFFER, 276) == expected
        for first in range(0, 92, 8):
            count = min(8, 92 - first)
            reply, _ = self.packet(machine, 8, 2, bytes((first, count)))
            assert reply[3] == 0
            assert reply[6:6 + count * 3] == expected[first * 3:(first + count) * 3]
        before = machine.read(p.RGB_BUFFER, 608)
        for command in (7, 8):
            for first, count in ((0, 0), (0, 9), (92, 1), (91, 2), (255, 1), (250, 8)):
                reply, _ = self.packet(machine, command, 2, bytes((first, count)) + bytes(24))
                assert reply[3] == 2
                assert machine.read(p.RGB_BUFFER, 608) == before

    def render_brightness_and_registers(self):
        machine = self.machine()
        pixels = bytes((i * 53 + 101) & 255 for i in range(276))
        machine.write(p.RGB_BUFFER, pixels)
        machine.put32(p.MODE, 1)
        machine.setreg(28, OUTPUT)
        rear_guard = b"\xA7" * 48
        machine.write(OUTPUT + 0x200, rear_guard)
        for factor in (0, 1, 64, 128, 255, 256):
            machine.setreg(31, factor)
            machine.write(OUTPUT, b"\xCC" * 276)
            for slot in range(92):
                destination = OUTPUT + slot * 3
                machine.setreg(14, destination)
                before = machine.registers()
                self.execute(machine, self.entry("render", p.RENDER_SITE), stops=(FLASH + p.RENDER_RETURN,),
                    writable=((destination, destination + 3), (STACK - 16, STACK)),
                    extra_code=((FLASH + p.RENDER_SITE, FLASH + p.RENDER_SITE + 12),))
                require_registers(before, machine)
            assert machine.read(OUTPUT, 276) == bytes(value * factor // 256 for value in pixels)
            assert machine.read(OUTPUT + 0x200, len(rear_guard)) == rear_guard
        machine.put32(p.MODE, 0)
        machine.setreg(10, 213)
        machine.setreg(11, 47)
        machine.setreg(13, 151)
        machine.setreg(14, OUTPUT)
        before = machine.registers()
        self.execute(machine, self.entry("render", p.RENDER_SITE), stops=(FLASH + p.RENDER_RETURN,),
            writable=((OUTPUT, OUTPUT + 3), (STACK - 16, STACK)),
            extra_code=((FLASH + p.RENDER_SITE, FLASH + p.RENDER_SITE + 12),))
        assert machine.read(OUTPUT, 3) == bytes((213, 47, 151))
        require_registers(before, machine)

    def native_channel_passthrough(self):
        machine = self.machine()
        reserved = machine.read(p.RGB_BUFFER, 608)
        for command in (7, 8):
            for channel in (0, 1, 126, 128, 255):
                reply, observation = self.packet(machine, command, 1, b"\x01", channel=channel)
                expected = p.GET_SITE if command == 8 else p.SET_SITE
                assert observation.stop == FLASH + expected + 4
                assert machine.reg(15) == GP + 0x74
                assert reply == (bytes((command, channel, 1, 0, 1)) + bytes(27))
                assert machine.read(p.RGB_BUFFER, 608) == reserved

    def fragments(self, machine, frame: bytes, frame_id: int):
        for index in range(11):
            piece = frame[index * 27:(index + 1) * 27]
            _, result = self.packet(machine, 7, 3, bytes((index,)) + piece, frame_id=frame_id)
            assert result.stop == FLASH + p.VIA_SILENT_RETURN

    def streaming_and_boundary(self):
        machine = self.machine()
        frame = bytes((i * 31 + 5) & 255 for i in range(276))
        self.mode(machine, 1)
        self.fragments(machine, frame, 93)
        assert machine.read(p.RGB_BUFFER, 276) == bytes(276)
        assert machine.read(p.RGB_BUFFER + 276, 276) == frame
        reply, result = self.packet(machine, 7, 4, b"\x5D")
        assert result.stop == FLASH + p.VIA_SILENT_RETURN
        assert machine.u32(p.FRONT + 12) == 1 and machine.u32(p.FRONT) == 0
        assert machine.read(p.FRONT + 16, 8) == bytes((7, 127, 4, 0, 93, 0, 0, 0))
        for op, data in ((1, b"\0"), (2, b"\0\1\1\2\3"), (4, b"\x5D")):
            reply, _ = self.packet(machine, 7, op, data)
            assert reply[3] == 5
        # Stop before the displaced OEM prologue, allowing a direct live-register check.
        boundary_end = FLASH + self.labels["boundary_return"] + 8
        before = machine.registers()
        for _ in range(2):
            self.execute(machine, self.entry("boundary", p.FRAME_BOUNDARY), stops=(boundary_end,),
                writable=((p.FRONT, p.FRONT + 16), (STACK - 64, STACK)),
                extra_code=((FLASH + p.FRAME_BOUNDARY, FLASH + p.FRAME_BOUNDARY + 4),))
            require_registers(before, machine)
            assert machine.u32(p.FRONT) == 276 and machine.u32(p.FRONT + 12) == 2
        # With ready flag set, capture the actual machine arguments at the OEM
        # send entry. Do not stub its return or claim that a USB transfer occurred.
        machine.write(GP + 0x2E9, b"\1")
        self.execute(machine, self.entry("boundary", p.FRAME_BOUNDARY), stops=(FLASH + p.USB_SEND,),
            writable=((p.FRONT, p.FRONT + 16), (STACK - 64, STACK)),
            extra_code=((FLASH + p.FRAME_BOUNDARY, FLASH + p.FRAME_BOUNDARY + 4),))
        assert (machine.reg(10), machine.reg(11), machine.reg(12)) == (4, p.FRONT + 16, 32)
        assert machine.read(machine.reg(11), machine.reg(12))[:8] == bytes((7, 127, 4, 0, 93, 0, 0, 0))

    def stream_invalid_and_disabled(self):
        machine = self.machine()
        frame = bytes((i + 9) & 255 for i in range(276))
        reply, _ = self.packet(machine, 7, 4, b"\x17")
        assert reply[3] == 4 and machine.u32(p.FRONT) == 0
        self.packet(machine, 7, 3, b"\x00" + frame[:27], frame_id=23)
        self.packet(machine, 7, 3, b"\x02" + frame[54:81], frame_id=23)
        assert machine.u32(p.FRONT + 4) == 255
        reply, _ = self.packet(machine, 7, 4, b"\x17")
        assert reply[3] == 4
        self.fragments(machine, frame, 23)
        reply, _ = self.packet(machine, 7, 4, b"\x18")
        assert reply[3] == 4
        reply, result = self.packet(machine, 7, 4, b"\x17")
        assert reply[3] == 0 and result.stop == FLASH + p.VIA_RETURN
        assert machine.u32(p.FRONT) == 276 and machine.u32(p.FRONT + 12) == 0
        assert machine.read(p.RGB_BUFFER + machine.u32(p.FRONT), 276) == frame
        machine.write(GP + 0x153, b"\1")
        reply, _ = self.packet(machine, 7, 3, b"\0" + bytes(27), frame_id=24)
        assert reply[3] == 1

    def rear_routines_and_separation(self):
        machine = self.machine()
        state = GP + 0x74
        machine.setreg(9, state)
        marker = bytes((i * 7) & 255 for i in range(608))
        machine.write(p.RGB_BUFFER, marker)
        for mode in range(7):
            machine.setreg(15, mode)
            before = machine.registers()
            expected = 0xAF50 if mode == 5 else (0xAF0E if mode <= 4 else 0xAF0A)
            self.execute(machine, FLASH + self.rear_labels["side_dispatch"], stops=(FLASH + expected,),
                extra_code=self.rear_code)
            require_registers(before, machine, (14,))
        machine.write(state + 6, bytes((17, 98, 203)))
        machine.write(state + 0x1E, b"\0")
        machine.write(state + 0x24, bytes((5, 3, 4, 1, 0)))
        before_state = machine.read(state, 0x30)
        before = machine.registers()
        self.execute(machine, FLASH + self.rear_labels["side_color_source"], stops=(FLASH + 0xAFFC,),
            extra_code=self.rear_code)
        assert (machine.reg(22), machine.reg(25), machine.reg(26)) == (17, 98, 203)
        require_registers(before, machine, (15, 22, 25, 26))
        assert machine.read(state, 0x30) == before_state
        assert machine.read(p.RGB_BUFFER, 608) == marker
        machine.write(state + 0x24, b"\x04")
        before = machine.registers()
        self.execute(machine, FLASH + self.rear_labels["side_color_source"], stops=(FLASH + 0xAFE4,),
            extra_code=self.rear_code)
        assert machine.reg(15) == 3
        require_registers(before, machine, (15,))

    def actual_stock_windows(self):
        if self.stock is None:
            raise RuntimeError("OEM checks require an exact user-supplied OEM image")
        # Execute real immutable stock RGB stores in Unicorn. Compare against
        # the override-disabled generated path, not a Python native-path model.
        machine = Machine(self.stock)
        machine.setreg(10, 213)
        machine.setreg(11, 47)
        machine.setreg(13, 151)
        machine.setreg(14, OUTPUT)
        before = machine.registers()
        self.execute(machine, FLASH + p.RENDER_SITE, stops=(FLASH + p.RENDER_RETURN,),
            extra_code=((FLASH + p.RENDER_SITE, FLASH + p.RENDER_RETURN),),
            writable=((OUTPUT, OUTPUT + 3),))
        assert machine.read(OUTPUT, 3) == bytes((213, 47, 151))
        require_registers(before, machine)
        # Genuine OEM silent epilogue: register restore offsets are decoded
        # from the user-supplied stock bytes by Capstone, not copied fixtures.
        from capstone import Cs, CS_ARCH_RISCV, CS_MODE_RISCV32, CS_MODE_RISCVC
        decoder = Cs(CS_ARCH_RISCV, CS_MODE_RISCV32 | CS_MODE_RISCVC)
        decoder.detail = True
        instructions = list(decoder.disasm(self.stock[p.VIA_SILENT_RETURN:p.VIA_SILENT_RETURN + 16],
                                           FLASH + p.VIA_SILENT_RETURN))
        aliases = {"ra": 1, "s0": 8, "s1": 9, "s2": 18, "s3": 19, "s4": 20}
        restored = {}
        for ins in instructions:
            if ins.mnemonic == "c.lwsp":
                register_name, address = ins.op_str.split(", ")
                offset = int(address.split("(")[0], 0)
                index = aliases[register_name]
                value = STOP if index == 1 else (0xA0B00000 + index)
                machine.put32(STACK + offset, value)
                restored[index] = value
        assert set(restored) == {1, 8, 9, 18, 19, 20}
        before = machine.registers()
        result = self.execute(machine, FLASH + p.VIA_SILENT_RETURN, stops=(STOP,),
            extra_code=((FLASH + p.VIA_SILENT_RETURN, FLASH + p.VIA_SILENT_RETURN + 16),))
        assert result.instructions == 8
        assert machine.reg(2) == STACK + 32
        assert all(machine.reg(index) == value for index, value in restored.items())
        require_registers(before, machine, (*restored, 2))
        # Execute the original frame prologue and the patched boundary with
        # idle metadata. Their live register results and OEM stack store must
        # agree; the patch may use additional scratch stack below the entry SP.
        original, patched = Machine(self.stock), self.machine()
        for current, entry, code in (
                (original, FLASH + p.FRAME_BOUNDARY, ((FLASH + p.FRAME_BOUNDARY, FLASH + p.FRAME_BOUNDARY + 4),)),
                (patched, FLASH + p.FRAME_BOUNDARY, ((FLASH + p.FRAME_BOUNDARY, FLASH + p.FRAME_BOUNDARY + 4),))):
            self.execute(current, entry, stops=(FLASH + p.FRAME_BOUNDARY + 4,),
                extra_code=code, writable=((STACK - 128, STACK),))
        assert original.registers() == patched.registers()
        # The two original prologue instructions store s0 at new_sp + 76.
        assert original.reg(2) == STACK - 80
        assert original.read(STACK - 4, 4) == patched.read(STACK - 4, 4)

    def startup_splices(self):
        if self.stock is None:
            raise RuntimeError("Startup splice checks require the exact stock image")
        for offset in (0x172, 0x2D0):
            machine = self.machine()
            machine.write(p.RGB_BUFFER, b"\xE9" * 608)
            self.execute(machine, FLASH + offset, stops=(p.MAIN_ENTRY,),
                extra_code=((FLASH + offset, FLASH + offset + len(p.startup_call(self.labels["initialize"]))),),
                writable=((p.RGB_BUFFER, p.STACK_TOP),))
            assert machine.read(p.RGB_BUFFER, 608) == bytes(608)
        for offset, initial in ((0x44, p.STACK_TOP + 0x40), (0x1CE, p.STACK_TOP + 0x3A)):
            machine = self.machine()
            machine.setreg(5, initial)
            before = machine.registers()
            self.execute(machine, FLASH + offset, stops=(FLASH + offset + 4,),
                extra_code=((FLASH + offset, FLASH + offset + 4),))
            assert machine.reg(5) == p.RGB_BUFFER
            require_registers(before, machine, (5,))


def validate(stock: bytes | None = None) -> dict:
    """Return JSON-safe evidence. A missing OEM image is never an OEM pass.

    Invalid stock is rejected before candidate construction or execution.
    A report is not a firmware image and contains no stock bytes/disassembly.
    """
    suite = Suite(stock)
    cases = []

    def check(name: str, function: Callable, scope: str):
        start = suite.instructions
        try:
            function()
        except Exception as exc:
            cases.append({"name": name, "scope": scope, "status": "FAIL", "error": f"{type(exc).__name__}: {exc}",
                          "instructions": suite.instructions - start})
        else:
            cases.append({"name": name, "scope": scope, "status": "PASS", "instructions": suite.instructions - start})

    scope = "generated routines in exact candidate; continuation boundaries" if stock is not None else "generated routines only"
    for name in ("initialization", "capability_and_modes", "chunk_roundtrip_and_bounds", "render_brightness_and_registers",
                 "native_channel_passthrough", "streaming_and_boundary", "stream_invalid_and_disabled", "rear_routines_and_separation"):
        check(name, getattr(suite, name), scope)
    if stock is not None:
        check("actual_stock_windows", suite.actual_stock_windows, "actual unmodified OEM RGB stores, silent epilogue and frame prologue")
        check("startup_splices", suite.startup_splices, "generated calls in candidate; stops before OEM main")
    return {
        "schema": "crush80-independent-offline-validation-v1",
        "status": "PASS" if all(case["status"] == "PASS" for case in cases) else "FAIL",
        "hardware_tested": False, "raw_firmware_exported": False,
        "engine": {"name": "Unicorn", "version": unicorn.__version__, "python": platform.python_version(),
                   "isa": "RV32; standard instructions supported by Unicorn; no Andes fallback"},
        "stock": {"status": "CHECKED" if stock is not None else "NOT_REQUESTED", "required_for_oem_checks": True,
                  "sha256": hashlib.sha256(stock).hexdigest() if stock is not None else None},
        "case_count": len(cases), "passed": sum(case["status"] == "PASS" for case in cases),
        "failed": sum(case["status"] == "FAIL" for case in cases), "cases": cases,
        "machine_runs": suite.runs, "executed_instructions": suite.instructions,
        "packet_boundary_captures": suite.responses,
        "coverage_limits": [
            "Packet captures observe RAM at native continuation boundaries; no USB transmission is claimed.",
            "Ready ACK is observed at OEM USB-send entry only; USB helper execution, retry completion and peripheral effects are not validated.",
            "Brightness multiplier is an explicit input fixture; complete OEM effect selection, hue conversion and multiplier derivation are not executed.",
            "OEM execution, when supplied, is limited to RGB store window, silent-return epilogue and frame prologue; no boot-to-main, full scheduler, interrupts or wireless execution.",
            "Rear separation is checked at generated routine boundaries, not through the full OEM rear renderer.",
            "Startup tests stop before OEM main and do not establish worst-case stack headroom or hardware bootability.",
            "Unsupported CPU instructions, unmapped memory, forbidden writes and instruction budget exhaustion fail closed.",
        ],
    }

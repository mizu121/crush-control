# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Reusable offline session API backed by actual generated RV32 instructions.

This is a continuation-boundary adapter, not a HID device, USB implementation,
full OEM emulator, installation verifier, or authorization to export firmware.
"""
from __future__ import annotations

from engine import FLASH, GP, OUTPUT, PACKET, STACK, STOP, require_registers
from validation import Suite, p


class Session:
    def __init__(self, stock: bytes | None = None):
        self.suite = Suite(stock)
        self.machine = self.suite.machine()
        self.suite.execute(self.machine, FLASH + self.suite.labels["initialize"], stops=(STOP,),
                           writable=((p.RGB_BUFFER, p.STACK_TOP),))

    def request(self, packet: bytes) -> bytes | None:
        """Execute a 32-byte command 7/8 PKRG packet, stopping before OEM reply.

        Return the RAM reply packet for VIA_RETURN, or None for the silent
        continuation. Neither result represents a physical USB transaction.
        Native non-PKRG dispatch is intentionally outside this adapter.
        """
        if len(packet) != 32 or packet[0] not in (7, 8) or packet[1] != 127:
            raise ValueError("Session supports exactly 32-byte command 7/8 channel127 PKRG packets")
        self.machine.setreg(9, PACKET)
        reply, observation = self.suite.packet(self.machine, packet[0], packet[2], packet[4:], frame_id=packet[3])
        return None if observation.stop == FLASH + p.VIA_SILENT_RETURN else reply

    @property
    def mode(self) -> int:
        return self.machine.u32(p.MODE)

    @property
    def frame(self) -> bytes:
        """The 276 unscaled bytes in the currently active patch frame."""
        return self.machine.read(p.RGB_BUFFER + self.machine.u32(p.FRONT), 276)

    @property
    def pending(self) -> int:
        return self.machine.u32(p.FRONT + 12)

    def render_frame(self, multiplier: int = 256, *, native_frame: bytes | None = None) -> bytes:
        """Execute all 92 injected RGB-store invocations with explicit inputs.

        Multiplier is a fixture corresponding to live OEM t6; deriving it from
        OEM brightness settings is not covered. If override is disabled the
        caller must provide native, already-scaled RGB bytes at the store hook.
        """
        if not 0 <= multiplier <= 256:
            raise ValueError("Fixture multiplier must be between 0 and 256")
        if native_frame is not None and len(native_frame) != 276:
            raise ValueError("Native frame must contain exactly 276 bytes")
        if self.mode != 1 and native_frame is None:
            raise ValueError("Disabled override requires explicit native RGB fixture")
        machine = self.machine
        machine.setreg(28, OUTPUT)
        machine.setreg(31, multiplier)
        for slot in range(92):
            destination = OUTPUT + slot * 3
            machine.setreg(14, destination)
            if native_frame is not None:
                for index, value in zip((10, 11, 13), native_frame[slot * 3:slot * 3 + 3]):
                    machine.setreg(index, value)
            before = machine.registers()
            self.suite.execute(machine, self.suite.entry("render", p.RENDER_SITE),
                stops=(FLASH + p.RENDER_RETURN,), writable=((destination, destination + 3), (STACK - 16, STACK)),
                extra_code=((FLASH + p.RENDER_SITE, FLASH + p.RENDER_SITE + 12),))
            require_registers(before, machine)
        return machine.read(OUTPUT, 276)

    def advance_frame_without_usb(self):
        """Execute boundary swap with USB not ready; ACK remains pending.

        This intentionally does not fabricate an ACK or complete an OEM USB
        helper. Busy status will continue until a genuine supported completion
        path is implemented, rather than pretending transport validation.
        """
        machine = self.machine
        machine.write(GP + 0x2E9, b"\0")
        before = machine.registers()
        self.suite.execute(machine, self.suite.entry("boundary", p.FRAME_BOUNDARY),
            stops=(FLASH + self.suite.labels["boundary_return"] + 8,),
            writable=((p.FRONT, p.FRONT + 16), (STACK - 64, STACK)),
            extra_code=((FLASH + p.FRAME_BOUNDARY, FLASH + p.FRAME_BOUNDARY + 4),))
        require_registers(before, machine)

    def rear_source(self, main_rgb: bytes, *, rear_mode: int = 5, inhibit: int = 0, palette: int = 0) -> dict:
        """Execute generated rear-source selection, with explicit OEM state fixture.

        Returns source registers for follow mode or the native palette selector.
        It does not execute the OEM rear color conversion or physical renderer.
        """
        if len(main_rgb) != 3 or any(not 0 <= value <= 255 for value in (rear_mode, inhibit, palette)):
            raise ValueError("Rear inputs must be three RGB bytes and byte-sized selectors")
        machine = self.machine
        state = GP + 0x74
        saved_s1 = machine.reg(9)
        machine.setreg(9, state)
        machine.write(state + 6, main_rgb)
        machine.write(state + 0x1E, bytes((inhibit,)))
        machine.write(state + 0x24, bytes((rear_mode, palette)))
        before_frame = machine.read(p.RGB_BUFFER, 608)
        before = machine.registers()
        target = 0xAFFC if rear_mode == 5 else 0xAFE4
        try:
            self.suite.execute(machine, FLASH + self.suite.rear_labels["side_color_source"],
                stops=(FLASH + target,), extra_code=self.suite.rear_code)
            require_registers(before, machine, (15, 22, 25, 26) if rear_mode == 5 else (15,))
            assert machine.read(p.RGB_BUFFER, 608) == before_frame
            return {"continuation": hex(FLASH + target), "scope": "generated rear-source routine only",
                    "rgb": [machine.reg(i) for i in (22, 25, 26)] if rear_mode == 5 else None,
                    "palette": machine.reg(15) if rear_mode != 5 else None}
        finally:
            machine.setreg(9, saved_s1)

# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Bounded RV32 machine execution; no device interfaces or firmware exporter.

This module executes instructions through Unicorn. It does not substitute a
Python implementation for any instruction or firmware routine. Memory writes,
instruction addresses, exit addresses and live registers are observable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

try:
    import unicorn
    from unicorn import riscv_const as rv
except ImportError as exc:
    raise RuntimeError("Install firmware-validation/requirements.txt in a separate Python environment") from exc

FLASH = 0x20000000
RAM_START, RAM_END = 0x80000, 0xA0000
STOP = FLASH + 0x1F000
STACK = 0x9F000
GP = 0x88000
PACKET = GP + 0x398
OUTPUT = 0x90000
REGISTERS = tuple(getattr(rv, f"UC_RISCV_REG_X{i}") for i in range(32))


class ExecutionError(RuntimeError):
    """Execution did not satisfy the explicitly bounded machine contract."""


@dataclass(frozen=True)
class Observation:
    stop: int
    instructions: int
    writes: tuple[tuple[int, int, int], ...]
    pcs: tuple[int, ...]


def contains(regions: Iterable[tuple[int, int]], address: int, size: int = 1) -> bool:
    return any(low <= address and address + size <= high for low, high in regions)


class Machine:
    """A fresh isolated RV32IMC CPU with read-only flash and non-executable RAM.

    GP, SP and fixture buffers are harness choices, not claimed OEM boot state.
    Each run supplies all executable and writable intervals explicitly. No
    peripheral mappings, stubbed OEM calls, custom opcodes, or silent fallback.
    """

    def __init__(self, image: bytes):
        if len(image) > 0x1F000:
            raise ValueError("Image exceeds fixture flash capacity")
        self.cpu = unicorn.Uc(unicorn.UC_ARCH_RISCV, unicorn.UC_MODE_RISCV32)
        self.cpu.mem_map(FLASH, 0x20000, unicorn.UC_PROT_READ | unicorn.UC_PROT_EXEC)
        self.cpu.mem_write(FLASH, image)
        self.cpu.mem_map(RAM_START, RAM_END - RAM_START, unicorn.UC_PROT_READ | unicorn.UC_PROT_WRITE)
        # MAIN_ENTRY is only an explicit stop for injected startup-call tests.
        self.cpu.mem_map(0x3000, 0x1000, unicorn.UC_PROT_READ | unicorn.UC_PROT_EXEC)
        for index in range(1, 32):
            self.setreg(index, (0x10203040 + index * 0x01010101) & 0xFFFFFFFF)
        self.setreg(1, STOP)
        self.setreg(2, STACK)
        self.setreg(3, GP)
        self.setreg(9, PACKET)
        self._running = False
        self.cpu.hook_add(unicorn.UC_HOOK_CODE, self._instruction)
        self.cpu.hook_add(unicorn.UC_HOOK_MEM_WRITE, self._write)

    def reg(self, index: int) -> int:
        return self.cpu.reg_read(REGISTERS[index])

    def setreg(self, index: int, value: int):
        self.cpu.reg_write(REGISTERS[index], value & 0xFFFFFFFF)

    def registers(self) -> tuple[int, ...]:
        return tuple(self.reg(index) for index in range(32))

    def read(self, address: int, length: int) -> bytes:
        return bytes(self.cpu.mem_read(address, length))

    def write(self, address: int, data: bytes):
        if self._running:
            raise ExecutionError("Host fixture mutation during execution is forbidden")
        if not contains(((RAM_START, RAM_END),), address, len(data)):
            raise ValueError("Fixture writes must stay in RAM")
        self.cpu.mem_write(address, data)

    def u32(self, address: int) -> int:
        return int.from_bytes(self.read(address, 4), "little")

    def put32(self, address: int, value: int):
        self.write(address, int(value).to_bytes(4, "little"))

    def _abort(self, message: str):
        self._fault = message
        self.cpu.emu_stop()

    def _instruction(self, cpu, address, size, _):
        if address in self._stops:
            self._stopped = address
            cpu.emu_stop()
            return
        if not contains(self._code, address, size):
            self._abort(f"Execution escaped allowed code at {address:#x}")
            return
        self._pcs.append(address)
        if len(self._pcs) > self._budget:
            self._abort(f"Instruction budget {self._budget} exhausted")

    def _write(self, cpu, access, address, size, value, _):
        if not contains(self._writable, address, size):
            self._abort(f"Write outside allowed memory at {address:#x} ({size} bytes)")
            return
        self._writes.append((address, size, value & ((1 << (8 * size)) - 1)))

    def run(self, entry: int, *, stops: Iterable[int], code: Iterable[tuple[int, int]],
            writable: Iterable[tuple[int, int]] = (), budget: int = 10000) -> Observation:
        if budget <= 0:
            raise ValueError("Instruction budget must be positive")
        self._stops, self._code = set(stops), tuple(code)
        self._writable, self._budget = tuple(writable), budget
        self._pcs, self._writes, self._stopped, self._fault = [], [], None, None
        # Unicorn exit points stop before translating the instruction at a
        # continuation. A code hook alone cannot stop before an unsupported
        # Andes instruction has already caused a translation-time exception.
        self.cpu.ctl_exits_enabled(True)
        self.cpu.ctl_set_exits(sorted(self._stops))
        self._running = True
        try:
            self.cpu.emu_start(entry, 0xFFFFFFFF, timeout=2_000_000, count=budget + 1)
        except unicorn.UcError as exc:
            pc = self.cpu.reg_read(rv.UC_RISCV_REG_PC)
            raise ExecutionError(f"CPU rejected execution at {pc:#x}: {exc}; unsupported instructions are not emulated") from exc
        finally:
            self._running = False
        if self._fault:
            raise ExecutionError(self._fault)
        pc = self.cpu.reg_read(rv.UC_RISCV_REG_PC)
        if pc in self._stops:
            self._stopped = pc
        if self._stopped is None:
            raise ExecutionError("CPU did not reach an approved stop before its instruction/time budget")
        return Observation(self._stopped, len(self._pcs), tuple(self._writes), tuple(self._pcs))


def require_registers(before: tuple[int, ...], machine: Machine, except_indices: Iterable[int] = ()):
    allowed = set(except_indices)
    changed = [i for i, value in enumerate(before) if i not in allowed and machine.reg(i) != value]
    if changed:
        raise AssertionError(f"Live registers changed: {changed}")

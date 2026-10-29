# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Firmware-free tests; no OEM file, hardware or network is required."""
import unittest

from engine import FLASH, GP, OUTPUT, STACK, STOP, ExecutionError, Machine
from session import Session
from sources import pkrg as p
from validation import Suite, validate


class ValidationTests(unittest.TestCase):
    def test_generated_cpu_contracts(self):
        report = validate()
        failures = [case for case in report["cases"] if case["status"] != "PASS"]
        self.assertEqual([], failures)
        self.assertEqual("NOT_REQUESTED", report["stock"]["status"])
        self.assertGreater(report["executed_instructions"], 25000)
        self.assertFalse(report["raw_firmware_exported"])
        self.assertFalse(report["hardware_tested"])

    def test_unsupported_instruction_is_failure(self):
        # An invalid word authored here, not extracted from OEM or old tests.
        machine = Machine(b"\xFF\xFF\xFF\xFF")
        with self.assertRaises(ExecutionError):
            machine.run(FLASH, stops=(STOP,), code=((FLASH, FLASH + 4),), budget=10)

    def test_budget_is_failure(self):
        machine = Machine(p.jump(0))
        with self.assertRaises(ExecutionError):
            machine.run(FLASH, stops=(STOP,), code=((FLASH, FLASH + 4),), budget=9)

    def test_forbidden_write_is_failure(self):
        code = p.store(10, 14, 0) + p.immediate(0, 1, 0, 0, 0x67)
        machine = Machine(code)
        machine.setreg(14, OUTPUT)
        with self.assertRaises(ExecutionError):
            machine.run(FLASH, stops=(STOP,), code=((FLASH, FLASH + len(code)),), writable=())

    def test_cross_boundary_write_is_failure(self):
        code = p.store(10, 14, 0, 2) + p.immediate(0, 1, 0, 0, 0x67)
        machine = Machine(code)
        machine.setreg(14, OUTPUT)
        with self.assertRaises(ExecutionError):
            machine.run(FLASH, stops=(STOP,), code=((FLASH, FLASH + len(code)),),
                        writable=((OUTPUT, OUTPUT + 3),))

    def test_unmapped_read_is_failure(self):
        code = p.load_word(10, 14) + p.immediate(0, 1, 0, 0, 0x67)
        machine = Machine(code)
        machine.setreg(14, 0xE4000000)
        with self.assertRaises(ExecutionError):
            machine.run(FLASH, stops=(STOP,), code=((FLASH, FLASH + len(code)),))

    def test_code_escape_is_failure(self):
        code = p.jump(4) + p.jump(0)
        machine = Machine(code)
        with self.assertRaises(ExecutionError):
            machine.run(FLASH, stops=(STOP,), code=((FLASH, FLASH + 4),), budget=10)

    def test_wrong_stock_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "exactly match"):
            Suite(bytes(p.IMAGE_SIZE))

    def test_session_cpu_roundtrip(self):
        session = Session()
        query = bytes((8, 127, 0, 0)) + bytes(28)
        reply = session.request(query)
        self.assertEqual(b"PKRG", reply[4:8])
        session.request(bytes((7, 127, 1, 0, 1)) + bytes(27))
        session.request(bytes((7, 127, 2, 0, 91, 1, 32, 127, 255)) + bytes(23))
        self.assertEqual(1, session.mode)
        self.assertEqual(bytes((32, 127, 255)), session.frame[-3:])
        self.assertEqual(bytes((16, 63, 127)), session.render_frame(128)[-3:])
        self.assertEqual([81, 92, 103], session.rear_source(bytes((81, 92, 103)))["rgb"])
        self.assertEqual(bytes((32, 127, 255)), session.frame[-3:])

    def test_session_does_not_fake_disabled_native_rgb(self):
        session = Session()
        with self.assertRaisesRegex(ValueError, "explicit native"):
            session.render_frame()
        source = bytes((i * 17) & 255 for i in range(276))
        self.assertEqual(source, session.render_frame(native_frame=source))

    def test_session_rejects_non_pkrg(self):
        session = Session()
        for packet in (bytes(31), bytes(32), bytes((7, 1)) + bytes(30)):
            with self.assertRaises(ValueError):
                session.request(packet)

    def test_generated_instruction_mutation_changes_observation(self):
        # Mutation of the allowed generator output demonstrates that checks
        # depend on executed machine code, rather than a Python protocol model.
        suite = Suite()
        image = bytearray(suite.image)
        start = suite.labels["info"]
        end = suite.labels["mode"]
        signature = p.load_constant(5, int.from_bytes(b"PKRG", "little"))
        at = image.find(signature, start, end)
        self.assertGreaterEqual(at, start)
        replacement = p.load_constant(5, int.from_bytes(b"FAIL", "little"))
        self.assertEqual(len(signature), len(replacement))
        image[at:at + len(signature)] = replacement
        suite.image = bytes(image)
        with self.assertRaises(AssertionError):
            suite.capability_and_modes()


if __name__ == "__main__":
    unittest.main()

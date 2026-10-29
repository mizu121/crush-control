# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 Crush Control contributors
"""Explicit OEM-dependent checks. Missing stock is a failure, never a skip/pass."""
import os
from pathlib import Path
import unittest

from validation import validate


class ExactStockTests(unittest.TestCase):
    def test_user_supplied_exact_stock(self):
        source = os.environ.get("CRUSH80_STOCK_V104")
        self.assertTrue(source, "Set CRUSH80_STOCK_V104 to an ordinary local exact OEM v1.04 file")
        report = validate(Path(source).read_bytes())
        self.assertEqual("CHECKED", report["stock"]["status"])
        self.assertEqual([], [case for case in report["cases"] if case["status"] != "PASS"])
        self.assertEqual(10, report["passed"])


if __name__ == "__main__":
    unittest.main()

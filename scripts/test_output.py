"""Compact per-test output for the AI recipe contract suites."""

from __future__ import annotations

import os
import re
from pathlib import Path
import sys
import unittest
from unittest.signals import registerResult


def display_name(value):
    name = " ".join(value.split())
    name = re.sub(r"\b(ai|cpu|gpu|ipc|svg|imkg|e2e)\b", lambda match: match[0].upper(), name, flags=re.I)
    return name[:1].upper() + name[1:]


class ListedTestResult(unittest.TextTestResult):
    """Print one colored status line while retaining unittest diagnostics."""

    def __init__(self, stream, descriptions, verbosity, **kwargs):
        super().__init__(stream, descriptions, 0, **kwargs)
        self.showAll = False
        self.dots = False
        self._color = "NO_COLOR" not in os.environ and os.environ.get("FORCE_COLOR") != "0"
        self._module = None
        self._class = None

    def _label(self, test):
        module = sys.modules.get(test.__class__.__module__)
        source = getattr(module, "__file__", None)
        source = Path(source).name if source else test.__class__.__module__
        name = Path(source).stem.removeprefix("test_").replace("_", " ")
        if source != self._module:
            self.stream.write(f"{display_name(name)}\n")
            self._module = source
            self._class = None
        if test.__class__ != self._class:
            self.stream.write(f"  {test.__class__.__qualname__}\n")
            self._class = test.__class__
        name = test._testMethodName.removeprefix("test_").replace("_", " ")
        return display_name(name)

    def _status(self, test, symbol, color):
        marker = f"\x1b[{color}m{symbol}\x1b[0m" if self._color else symbol
        self.stream.write(f"    {marker} {self._label(test)}\n")
        self.stream.flush()

    def addSuccess(self, test):
        super().addSuccess(test)
        self._status(test, "✓", 32)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._status(test, "✗", 31)

    def addError(self, test, err):
        super().addError(test, err)
        self._status(test, "✗", 31)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._status(test, "-", 33)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._status(test, "-", 33)

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._status(test, "✗", 31)

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._status(test, "✗", 31)

    def printErrors(self):
        for test, traceback in self.errors + self.failures:
            self.stream.write(f"{test.id()}:\n{traceback}\n")
        for test in self.unexpectedSuccesses:
            self.stream.write(f"Unexpected success: {test.id()}\n")


class ListedTestRunner(unittest.TextTestRunner):
    """Use the same footer as the JavaScript runners, without unittest separators."""

    resultclass = ListedTestResult

    def run(self, test):
        result = self._makeResult()
        registerResult(result)
        result.failfast, result.buffer, result.tb_locals = self.failfast, self.buffer, self.tb_locals
        result.startTestRun()
        try:
            test(result)
        finally:
            result.stopTestRun()
        result.printErrors()
        failed = len(result.errors) + len(result.failures) + len(result.unexpectedSuccesses)
        skipped = len(result.skipped) + len(result.expectedFailures)
        passed = max(0, result.testsRun - failed - skipped)
        self.stream.write(f"Results: {passed} passed, {failed} failed, {skipped} skipped\n")
        self.stream.flush()
        return result


def run_tests(module=None):
    """Run one module with listed statuses and return unittest's exit code."""
    result = unittest.main(module=module or "__main__", testRunner=ListedTestRunner,
                           verbosity=0, buffer=True, exit=False).result
    return 0 if result.wasSuccessful() and (result.testsRun or result.skipped) else 1

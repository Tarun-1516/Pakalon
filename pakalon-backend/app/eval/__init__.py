"""Eval: code-execution sandbox for both JS and Python.

Used to safely execute snippets for tool evaluation, testing, and
sandboxed agent runs. Uses `subprocess` + timeouts; for production
deployments with stronger isolation, plug in Docker / firecracker.
"""
from __future__ import annotations

from .runner import EvalRunner, EvalResult, EvalLanguage
from .js import JSEval
from .py import PyEval

__all__ = ["EvalRunner", "EvalResult", "EvalLanguage", "JSEval", "PyEval"]

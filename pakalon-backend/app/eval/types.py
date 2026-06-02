"""Shared eval types: language enum and result dataclass."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class EvalLanguage(str, Enum):
    PYTHON = "python"
    JAVASCRIPT = "javascript"
    TYPESCRIPT = "typescript"
    SHELL = "shell"
    DENO = "deno"
    BUN = "bun"


@dataclass(slots=True)
class EvalResult:
    id: str
    language: EvalLanguage
    code: str
    stdout: str
    stderr: str
    exit_code: int
    duration: float
    artifacts: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "language": self.language.value, "code": self.code,
            "stdout": self.stdout, "stderr": self.stderr,
            "exit_code": self.exit_code, "duration": self.duration,
            "artifacts": self.artifacts,
        }

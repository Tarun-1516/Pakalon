"""Hindsight: multi-bank memory with mental models and transcript awareness.

Layered on top of mnemopi: hindsight organizes memories into named banks
(global, project, branch, session), synthesizes mental models, and
ingests transcript events.
"""
from __future__ import annotations

from .bank import HindsightBank, HindsightEntry
from .mental_models import MentalModel, MentalModelStore
from .transcript import TranscriptEvent, TranscriptBuffer
from .state import HindsightState
from .service import HindsightService

__all__ = [
    "HindsightBank",
    "HindsightEntry",
    "MentalModel",
    "MentalModelStore",
    "TranscriptEvent",
    "TranscriptBuffer",
    "HindsightState",
    "HindsightService",
]

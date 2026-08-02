from __future__ import annotations

from enum import Enum


class VerifyMode(str, Enum):
    OFF = "off"
    SCHEMA = "schema"
    EXECUTE = "execute"


VERIFY_MODES: tuple[str, ...] = tuple(m.value for m in VerifyMode)

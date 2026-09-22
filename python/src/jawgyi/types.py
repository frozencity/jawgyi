"""Shared types. Mirrors src/types.ts in the TypeScript package."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Encoding = Literal["unicode", "zawgyi"]
Evidence = Literal["codepoint", "markov", "jev", "no-myanmar", "conflict"]


@dataclass
class Detection:
    """The result of a detection.

    ``encoding`` is ``None`` whenever the evidence does not support a verdict. Callers
    must handle that case; it is the entire point of this library. A wrong Zawgyi to
    Unicode conversion cannot be undone, so guessing is worse than abstaining.
    """

    encoding: Encoding | None
    confidence: float
    evidence: Evidence
    probability: float | None
    myanmar_chars: int
    escalated: bool = False
    reasons: list[str] = field(default_factory=list)


@dataclass
class JevResolution(Detection):
    """A Detection that went through the Jev stage."""

    mixed: bool = False
    burmese_probability: float | None = None
    usage: dict[str, int] | None = None


class SystemOneClient(Protocol):
    """Anything that can evaluate a System One request.

    The built-in HTTP client satisfies this, and so does a hand-written stub, which is
    how the Jev stage is tested without an API key.
    """

    def evaluate(self, request: dict[str, Any]) -> dict[str, Any]: ...

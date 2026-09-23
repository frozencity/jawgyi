"""Single-question encoding classification via Jev.

``detect`` decomposes the problem: code produces both candidate readings and Jev is asked
which one is coherent Burmese. This module takes the direct route instead. It sends the
text as state and asks one Noul, "is this Zawgyi", and returns the probability.

Worth knowing before you pick between them. Jev receives decoded code points in a JSON
body, not bytes, so the source encoding is not present in what it evaluates. The answer is
therefore inferred from the shape of the text rather than observed. ``detect`` is built
around that constraint; this function works within it differently.

``scripts/compare.mjs`` scores both against text of known encoding, alongside the local
detector. Run it before choosing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .detect import detect_sync
from .types import Detection, SystemOneClient

DIRECT_QUESTION_ID = "is_it_zawgyi"

_NOTE = (
    "Jev evaluates decoded code points, not bytes, so the source encoding is inferred "
    "rather than observed. is_zawgyi decides locally from the same text without a request."
)


def build_direct_question() -> dict[str, Any]:
    """The question as sent, exported so it can be reviewed alongside the ones in jev.py."""
    return {
        DIRECT_QUESTION_ID: {
            "type": "noul",
            "instructions": "Is this text encoded in the Zawgyi font encoding rather than Unicode?",
            "criteria": {
                "true": "The text is Zawgyi encoded.",
                "false": "The text is Unicode encoded.",
            },
        }
    }


@dataclass
class DirectVerdict:
    """The probability thresholded at 0.5, plus what the local detector said."""

    zawgyi: bool
    noul: float
    stage1: Detection
    disagrees: bool
    note: str = _NOTE


def is_jawgyi(text: str, client: SystemOneClient, model: str = "jev-latest") -> DirectVerdict:
    """Classify the encoding with one Jev request.

    Returns a dataclass rather than a bool, so it cannot be substituted for the
    synchronous ``is_zawgyi`` without the difference being visible at the call site.
    """
    stage1 = detect_sync(text)
    response = client.evaluate(
        {"model": model, "state": text, "questions": build_direct_question()}
    )

    answer = response.get("answers", {}).get(DIRECT_QUESTION_ID)
    if not answer or answer.get("type") != "noul":
        raise ValueError(f"Expected a noul answer for {DIRECT_QUESTION_ID}, got {answer}")

    zawgyi = answer["noul"] > 0.5
    return DirectVerdict(
        zawgyi=zawgyi,
        noul=float(answer["noul"]),
        stage1=stage1,
        # A local None is an abstention, not a competing verdict.
        disagrees=stage1.encoding is not None
        and stage1.encoding != ("zawgyi" if zawgyi else "unicode"),
    )

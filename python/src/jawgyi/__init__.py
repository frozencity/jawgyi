"""jawgyi: Zawgyi vs Unicode detection for Burmese text.

Stage 1 is local, free and sub-millisecond, and settles essentially all real text.
Stage 2 asks Jev, and only for the samples stage 1 genuinely cannot call.

    >>> from jawgyi import detect_sync
    >>> detect_sync("hello").encoding is None   # not Unicode, unknown
    True
"""

from __future__ import annotations

from typing import Any

from .codepoints import CodepointEvidence, scan_codepoints, verdict_from_codepoints
from .convert import normalize_zawgyi, unicode_to_zawgyi, zawgyi_to_unicode
from .detect import (
    SHORT_TEXT_THRESHOLD,
    UNCERTAIN_BAND,
    UNCERTAIN_BELOW,
    detect_sync,
    is_zawgyi,
    should_escalate,
)
from .direct import DIRECT_QUESTION_ID, DirectVerdict, build_direct_question, is_jawgyi
from .jev import JevClient, TypeSafeError, build_questions, build_state, resolve_with_jev
from .markov import markov_zawgyi_probability
from .types import Detection, Encoding, Evidence, JevResolution, SystemOneClient

__version__ = "0.1.0"

__all__ = [
    "Detection",
    "JevResolution",
    "Encoding",
    "Evidence",
    "SystemOneClient",
    "CodepointEvidence",
    "detect",
    "detect_sync",
    "to_unicode",
    "is_zawgyi",
    "is_jawgyi",
    "DirectVerdict",
    "build_direct_question",
    "DIRECT_QUESTION_ID",
    "should_escalate",
    "scan_codepoints",
    "verdict_from_codepoints",
    "markov_zawgyi_probability",
    "zawgyi_to_unicode",
    "unicode_to_zawgyi",
    "normalize_zawgyi",
    "JevClient",
    "TypeSafeError",
    "resolve_with_jev",
    "build_state",
    "build_questions",
    "SHORT_TEXT_THRESHOLD",
    "UNCERTAIN_BAND",
    "UNCERTAIN_BELOW",
]


def detect(
    text: str,
    *,
    client: SystemOneClient | None = None,
    model: str = "jev-latest",
    on_error: str = "fallback",
    **options: Any,
) -> Detection:
    """Detect the encoding, escalating to Jev only when local evidence is too weak.

    Without a ``client`` this is exactly ``detect_sync``: it returns ``encoding=None``
    on samples it cannot call, which is the honest answer rather than a failure.

    ``on_error='fallback'`` (the default) keeps stage 1's result if the Jev call raises;
    ``'throw'`` propagates. An encoding guess is rarely worth taking the caller down for.
    """
    stage1 = detect_sync(text, **options)
    escalate_opts = {k: v for k, v in options.items() if k == "uncertain_below"}
    if client is None or not should_escalate(stage1, **escalate_opts):
        return stage1

    try:
        return resolve_with_jev(text, stage1, client, model)
    except Exception as e:  # noqa: BLE001 (deliberately broad; the policy is the caller's)
        if on_error == "throw":
            raise
        return Detection(
            encoding=stage1.encoding,
            confidence=stage1.confidence,
            evidence=stage1.evidence,
            probability=stage1.probability,
            myanmar_chars=stage1.myanmar_chars,
            escalated=False,
            reasons=[*stage1.reasons, f"Jev escalation failed: {e}"],
        )


def to_unicode(text: str, **kwargs: Any) -> tuple[str, Detection, bool]:
    """Normalise to Unicode, converting only on a confident Zawgyi verdict.

    Returns ``(text, detection, converted)``. Unknown text comes back untouched:
    converting on a guess is how corpora get silently corrupted, because a wrong Z2U
    pass is not recoverable by a later U2Z pass.
    """
    detection = detect(text, **kwargs)
    converted = detection.encoding == "zawgyi"
    return (zawgyi_to_unicode(text) if converted else text), detection, converted

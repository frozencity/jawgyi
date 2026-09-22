"""Stage 1: local detection. No network, no key, works anywhere Python does."""

from __future__ import annotations

from .codepoints import scan_codepoints, verdict_from_codepoints
from .markov import markov_zawgyi_probability
from .types import Detection

# Escalate below this many Myanmar characters. Measured on a 308-line parallel corpus:
# the Markov model is 86% accurate at 6 characters and 97.7% at 8, so 8 is where it
# stops being close to a coin flip.
SHORT_TEXT_THRESHOLD = 8

# Escalate when P(Zawgyi) lands in this band. Catches ~1.6% of 15-character samples
# and 0.3% of full lines, so escalation stays rare and cheap on ordinary text.
UNCERTAIN_BAND = (0.05, 0.95)

# Below this confidence the result is reported as ``encoding=None``.
UNCERTAIN_BELOW = 0.75

# Below this many Myanmar characters the Markov model is not trusted to contradict a
# code point. Measured: 99.7% accurate at 15 characters, 86% at 6. Under 15 an exclusive
# code point is the better evidence and wins outright.
CONFLICT_MIN_CHARS = 15


def detect_sync(
    text: str,
    *,
    short_text_threshold: int = SHORT_TEXT_THRESHOLD,
    uncertain_band: tuple[float, float] = UNCERTAIN_BAND,
    uncertain_below: float = UNCERTAIN_BELOW,
    conflict_min_chars: int = CONFLICT_MIN_CHARS,
) -> Detection:
    """Detect the encoding locally.

    Code points are checked first, because an exclusive code point is proof and the
    Markov model is only ever evidence.

    With one exception, which matters. A single Zawgyi-only code point sitting in a long
    passage the model reads as overwhelmingly Unicode is not proof that the passage is
    Zawgyi. It is proof that something is wrong with that passage. Those are different
    claims, and treating the first as the second lets ``to_unicode`` irreversibly rewrite
    a whole document because of one character. So a strong disagreement between the two
    layers produces no verdict at all, and escalates.
    """
    cp = scan_codepoints(text)

    if cp.myanmar_chars == 0:
        return Detection(
            encoding=None,
            confidence=0.0,
            evidence="no-myanmar",
            probability=None,
            myanmar_chars=0,
            reasons=["no Myanmar-block characters"],
        )

    encoding, confidence, reasons = verdict_from_codepoints(cp)
    probability = markov_zawgyi_probability(text)

    # Both exclusive sets fired. Whatever this text is, it is not uniformly one encoding,
    # and handing it to the model would bury that under a confident single answer.
    if cp.zawgyi_only > 0 and cp.unicode_only > 0:
        return Detection(
            encoding=None,
            confidence=0.0,
            evidence="conflict",
            probability=probability,
            myanmar_chars=cp.myanmar_chars,
            reasons=[
                *reasons,
                "likely mixed encodings or corrupt text; detect per span rather than "
                "converting the whole thing",
            ],
        )

    if encoding is not None:
        lo, hi = uncertain_band
        model_trustworthy = cp.myanmar_chars >= conflict_min_chars
        model_confident = probability is not None and (probability <= lo or probability >= hi)
        model_says = "zawgyi" if probability is not None and probability > 0.5 else "unicode"

        if model_trustworthy and model_confident and model_says != encoding:
            return Detection(
                encoding=None,
                confidence=0.0,
                evidence="conflict",
                probability=probability,
                myanmar_chars=cp.myanmar_chars,
                reasons=[
                    *reasons,
                    f"but P(Zawgyi)={probability:.3f} over {cp.myanmar_chars} "
                    f"Myanmar characters says {model_says}",
                    "likely mixed encodings or corrupt text; detect per span rather than "
                    "converting the whole thing",
                ],
            )

        return Detection(
            encoding=encoding,  # type: ignore[arg-type]
            confidence=confidence,
            evidence="codepoint",
            probability=probability,
            myanmar_chars=cp.myanmar_chars,
            reasons=reasons,
        )

    reasons = list(reasons)

    # Reachable when the text is all Myanmar digits or punctuation: they occupy the
    # block but produce no state transitions, so the chain has nothing to score.
    if probability is None:
        reasons.append("Myanmar characters present but no scoreable transitions")
        return Detection(
            encoding=None,
            confidence=0.0,
            evidence="no-myanmar",
            probability=None,
            myanmar_chars=cp.myanmar_chars,
            reasons=reasons,
        )

    lo, hi = uncertain_band
    in_band = lo < probability < hi
    too_short = cp.myanmar_chars < short_text_threshold

    # Map P(Zawgyi) onto a confidence symmetric about 0.5, then discount short text: at
    # 6 Myanmar characters the model is 86% accurate but still reports extreme
    # probabilities, so an undiscounted confidence would be a lie.
    distance = abs(probability - 0.5) * 2
    length_penalty = max(0.35, cp.myanmar_chars / short_text_threshold) if too_short else 1.0
    confidence = distance * length_penalty

    if too_short:
        reasons.append(f"only {cp.myanmar_chars} Myanmar characters")
    if in_band:
        reasons.append(f"P(Zawgyi)={probability:.3f} is inconclusive")
    if not too_short and not in_band:
        reasons.append(f"P(Zawgyi)={probability:.3f}")

    decided = ("zawgyi" if probability > 0.5 else "unicode") if confidence >= uncertain_below else None

    return Detection(
        encoding=decided,  # type: ignore[arg-type]
        confidence=confidence,
        evidence="markov",
        probability=probability,
        myanmar_chars=cp.myanmar_chars,
        reasons=reasons,
    )


def should_escalate(d: Detection, *, uncertain_below: float = UNCERTAIN_BELOW) -> bool:
    """Whether stage 1's result is weak enough to be worth a Jev call."""
    # Nothing to escalate: no Myanmar content means no question to ask, and a code-point
    # proof is already better than anything a semantic model could tell us. A conflict is
    # the opposite case: it is exactly what the is_mixed_encoding question exists for.
    if d.evidence == "no-myanmar":
        return False
    if d.evidence == "conflict":
        return True
    if d.evidence == "codepoint" and d.encoding is not None:
        return False
    return d.encoding is None or d.confidence < uncertain_below


def is_zawgyi(text: str) -> bool:
    """Boolean convenience that accepts a guess on weak evidence."""
    d = detect_sync(text)
    if d.encoding is not None:
        return d.encoding == "zawgyi"
    return (d.probability or 0.0) > 0.5

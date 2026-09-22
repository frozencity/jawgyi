"""Code-point evidence: the cases where the encoding is decidable without statistics.

Every constant here was measured against a 308-line parallel corpus rather than
recalled from a spec. ``node scripts/derive-codepoints.mjs`` in the repo root
regenerates the counts; both implementations use the same tables.
"""

from __future__ import annotations

from dataclasses import dataclass

_MM_LO, _MM_HI = 0x1000, 0x109F

# Present in the Zawgyi corpus, absent from the Unicode one.
#
# Caveat that matters: in Unicode these are legitimately assigned to Mon, Shan, Karen
# and Palaung. They mean "Zawgyi" only for *Burmese* text. Shan Unicode text trips them,
# which is why the Jev stage asks whether the text is Burmese at all.
ZAWGYI_ONLY = frozenset(
    {
        0x1033, 0x1034, 0x105A, 0x1061, 0x1062, 0x1065, 0x106B, 0x1072, 0x1075,
        0x1078, 0x107D, 0x107E, 0x107F, 0x1080, 0x1087, 0x1088, 0x108A, 0x108F,
        0x1090, 0x1093, 0x1094, 0x1095,
    }
)

# U+103E MEDIAL HA: 419 occurrences in the Unicode corpus, zero in the Zawgyi one.
# Zawgyi shifts its medials down a slot and never produces this. The cleanest marker
# in either direction.
UNICODE_ONLY = frozenset({0x103E})


def _is_consonant(cp: int) -> bool:
    return 0x1000 <= cp <= 0x1021


@dataclass
class CodepointEvidence:
    myanmar_chars: int = 0
    zawgyi_only: int = 0
    unicode_only: int = 0
    visual_order: int = 0   # U+1031 before its consonant (Zawgyi keeps visual order)
    logical_order: int = 0  # U+1031 after its consonant (Unicode keeps logical order)
    virama: int = 0         # U+1039, stacking virama in Unicode but asat in Zawgyi
    asat: int = 0           # U+103A, the Unicode asat


def scan_codepoints(text: str) -> CodepointEvidence:
    e = CodepointEvidence()
    n = len(text)
    for i, ch in enumerate(text):
        cp = ord(ch)
        if cp < _MM_LO or cp > _MM_HI:
            continue
        e.myanmar_chars += 1
        if cp in ZAWGYI_ONLY:
            e.zawgyi_only += 1
        elif cp in UNICODE_ONLY:
            e.unicode_only += 1
        elif cp == 0x1039:
            e.virama += 1
        elif cp == 0x103A:
            e.asat += 1
        elif cp == 0x1031:
            # U+1031 occurs with identical frequency in both encodings (938 vs 938 in
            # the corpus); only its position differs, so position is the whole signal.
            nxt = ord(text[i + 1]) if i + 1 < n else 0
            prv = ord(text[i - 1]) if i > 0 else 0
            if _is_consonant(nxt):
                e.visual_order += 1
            elif _is_consonant(prv):
                e.logical_order += 1
    return e


def verdict_from_codepoints(e: CodepointEvidence) -> tuple[str | None, float, list[str]]:
    """Decide from code points alone, or return ``None`` to defer to the Markov model.

    Only the exclusive sets are decisive. Ordering and virama counts are real signal but
    they overlap between encodings, so they stay advisory. The Markov model already
    weighs that kind of distributional evidence better than a threshold can.
    """
    if e.zawgyi_only > 0 and e.unicode_only == 0:
        return "zawgyi", 0.99 if e.zawgyi_only >= 2 else 0.95, [
            f"{e.zawgyi_only} Zawgyi-exclusive code point(s)"
        ]
    if e.unicode_only > 0 and e.zawgyi_only == 0:
        return "unicode", 0.99 if e.unicode_only >= 2 else 0.95, [
            f"{e.unicode_only} occurrence(s) of U+103E (Unicode-only medial ha)"
        ]
    if e.zawgyi_only > 0 and e.unicode_only > 0:
        # Both fired: the text is probably mixed, or not Burmese. Refuse to guess.
        return None, 0.0, [
            f"conflicting evidence: {e.zawgyi_only} Zawgyi-only and "
            f"{e.unicode_only} Unicode-only code points"
        ]
    return None, 0.0, []

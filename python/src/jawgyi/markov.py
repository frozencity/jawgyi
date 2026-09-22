"""Zawgyi/Unicode Markov classifier.

Ported from Google's myanmar-tools (Apache-2.0, Copyright 2017 Google LLC).
See NOTICE. The model file is shared byte-for-byte with the TypeScript package.

Behavioural change from upstream: returns ``None`` rather than ``-inf`` when the input
contains no Myanmar-range code points. Callers treating ``-inf`` as a number read it as
"strong Unicode", which silently mislabels every piece of Latin text they pass in.
"""

from __future__ import annotations

import math
import struct
from array import array
from functools import lru_cache
from importlib import resources

# Standard Myanmar range before digits
_STD_CP0, _STD_CP1 = 0x1000, 0x103F
# Standard Myanmar range after digits
_AFT_CP0, _AFT_CP1 = 0x104A, 0x109F
# Myanmar Extended A / B
_EXA_CP0, _EXA_CP1 = 0xAA60, 0xAA7F
_EXB_CP0, _EXB_CP1 = 0xA9E0, 0xA9FF
# Unicode space characters
_SPC_CP0, _SPC_CP1 = 0x2000, 0x200B

_STD_OFFSET = 1
_AFT_OFFSET = _STD_OFFSET + _STD_CP1 - _STD_CP0 + 1
_EXA_OFFSET = _AFT_OFFSET + _AFT_CP1 - _AFT_CP0 + 1
_EXB_OFFSET = _EXA_OFFSET + _EXA_CP1 - _EXA_CP0 + 1
_SPC_OFFSET = _EXB_OFFSET + _EXB_CP1 - _EXB_CP0 + 1

_SSV_STD_EXA_EXB_SPC = 0


def _state_for(cp: int, ssv: int) -> int:
    if _STD_CP0 <= cp <= _STD_CP1:
        return cp - _STD_CP0 + _STD_OFFSET
    if _AFT_CP0 <= cp <= _AFT_CP1:
        return cp - _AFT_CP0 + _AFT_OFFSET
    if _EXA_CP0 <= cp <= _EXA_CP1:
        return cp - _EXA_CP0 + _EXA_OFFSET
    if _EXB_CP0 <= cp <= _EXB_CP1:
        return cp - _EXB_CP0 + _EXB_OFFSET
    if ssv == _SSV_STD_EXA_EXB_SPC and _SPC_CP0 <= cp <= _SPC_CP1:
        return cp - _SPC_CP0 + _SPC_OFFSET
    return 0


class _Reader:
    """Big-endian cursor over the model blob, matching the Java/JS DataView reads."""

    def __init__(self, data: bytes, offset: int = 0) -> None:
        self.data = data
        self.offset = offset

    def u32(self) -> int:
        (v,) = struct.unpack_from(">I", self.data, self.offset)
        self.offset += 4
        return v

    def i16(self) -> int:
        (v,) = struct.unpack_from(">h", self.data, self.offset)
        self.offset += 2
        return v

    def f32(self) -> float:
        (v,) = struct.unpack_from(">f", self.data, self.offset)
        self.offset += 4
        return v

    def check_magic(self, lead: int, trail: int, version: int) -> None:
        got_lead = self.u32()
        if got_lead != lead:
            raise ValueError(f"Bad model magic lead: expected {lead:x}, got {got_lead:x}")
        got_trail = self.u32()
        if got_trail != trail:
            raise ValueError(f"Bad model magic trail: expected {trail:x}, got {got_trail:x}")
        if version != -1:
            got_version = self.u32()
            if got_version != version:
                raise ValueError(f"Bad model version: expected {version:x}, got {got_version:x}")


class _Model:
    def __init__(self, data: bytes) -> None:
        r = _Reader(data)
        r.check_magic(0x555A4D4F, 0x44454C20, -1)
        serial = r.u32()
        if serial == 1:
            self.ssv = 0
        elif serial == 2:
            self.ssv = r.u32()
        else:
            raise ValueError(f"Model serial version: expected 1 or 2, got {serial:x}")

        r.check_magic(0x424D4152, 0x4B4F5620, 0)
        size = r.i16()
        self.size = size
        # A flat array of doubles rather than a list of lists: same lookups, far less
        # memory and pointer chasing for a ~1400x1400 matrix.
        deltas = array("d", bytes(8 * size * size))
        for i1 in range(size):
            entries = r.i16()
            fallback = 0.0
            if entries != 0:
                fallback = r.f32()
            nxt = -1
            row = i1 * size
            for i2 in range(size):
                if entries > 0 and nxt < i2:
                    nxt = r.i16()
                    entries -= 1
                if nxt == i2:
                    deltas[row + i2] = r.f32()
                else:
                    deltas[row + i2] = fallback
        self.deltas = deltas

    def predict(self, text: str) -> float | None:
        prev = 0
        total = 0.0
        seen = False
        size = self.size
        deltas = self.deltas
        ssv = self.ssv
        # The trailing None drives the final transition back to the base state.
        for ch in (*text, None):
            curr = 0 if ch is None else _state_for(ord(ch), ssv)
            if prev != 0 or curr != 0:
                total += deltas[prev * size + curr]
                seen = True
            prev = curr
        if not seen:
            return None
        # Pz/(Pu+Pz) = 1/(1+exp(logPu-logPz))
        try:
            return 1.0 / (1.0 + math.exp(total))
        except OverflowError:
            return 0.0


@lru_cache(maxsize=1)
def _model() -> _Model:
    blob = (resources.files("jawgyi.data") / "zawgyiUnicodeModel.dat").read_bytes()
    return _Model(blob)


def markov_zawgyi_probability(text: str) -> float | None:
    """P(Zawgyi) in [0, 1], or None when the text carries no Myanmar-range signal."""
    return _model().predict(text)

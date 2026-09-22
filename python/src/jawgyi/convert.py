"""Transliteration engine.

Ported from Google's myanmar-tools (Apache-2.0, Copyright 2017 Google LLC). The rule
tables are the same JSON the TypeScript package generates, so the two implementations
cannot drift apart.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import NamedTuple
from importlib import resources


class _Rule(NamedTuple):
    pattern: re.Pattern[str]
    replacement: str
    revisit: bool
    # A few rules apply only at the very start of the string. Upstream stores this as
    # the string 'true' and only ever tests it for presence, so presence is the meaning.
    start_only: bool


@lru_cache(maxsize=4)
def _phases(name: str) -> tuple[tuple[_Rule, ...], ...]:
    raw = json.loads((resources.files("jawgyi.data.rules") / f"{name}.json").read_text("utf-8"))
    # Compiling is the expensive part, so do it once per table on first use: a caller
    # that only ever detects never pays for it.
    return tuple(
        tuple(
            _Rule(
                re.compile(rule["p"]),
                # JS $1..$9 backreferences become Python \1..\9.
                re.sub(r"\$(\d)", r"\\\1", rule["s"]),
                rule.get("revisit") is not None,
                rule.get("matchOnStart") is not None,
            )
            for rule in phase
        )
        for phase in raw
    )


def _run_phase(rules: tuple[_Rule, ...], text: str) -> str:
    out: list[str] = []
    mid = text
    start_of_string = True
    while mid:
        found = False
        for rule in rules:
            if rule.start_only and not start_of_string:
                continue
            m = rule.pattern.match(mid)
            if m is not None:
                found = True
                right = len(mid) - len(m.group(0))
                mid = rule.pattern.sub(rule.replacement, mid, count=1)
                new_start = len(mid) - right
                if not rule.revisit:
                    out.append(mid[:new_start])
                    mid = mid[new_start:]
        if not found:
            out.append(mid[0])
            mid = mid[1:]
        start_of_string = False
    return "".join(out)


def _run_all(name: str, text: str) -> str:
    for phase in _phases(name):
        text = _run_phase(phase, text)
    return text


def zawgyi_to_unicode(text: str) -> str:
    """Zawgyi to Unicode. Many-to-one, so it cannot be reversed. Convert once."""
    return _run_all("z2u", text)


def unicode_to_zawgyi(text: str) -> str:
    return _run_all("u2z", text)


def normalize_zawgyi(text: str) -> str:
    """Collapse Zawgyi's equivalent spellings to one canonical form."""
    return _run_all("znorm", text)

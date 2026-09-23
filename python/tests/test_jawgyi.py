"""Mirrors the TypeScript suite. Same fixtures, same assertions, no network."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from jawgyi import (
    JevClient,
    TypeSafeError,
    detect,
    detect_sync,
    is_zawgyi,
    scan_codepoints,
    should_escalate,
    to_unicode,
    unicode_to_zawgyi,
    zawgyi_to_unicode,
)
from jawgyi.direct import DIRECT_QUESTION_ID, build_direct_question, is_jawgyi
from jawgyi.jev import AS_WRITTEN, IF_CONVERTED, IS_BURMESE, IS_MIXED, NEITHER, READING

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures"

# Three Myanmar characters: below the 8-character threshold, so stage 1 abstains.
AMBIGUOUS = "နျပ"


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def burmese_lines(name: str) -> list[str]:
    return [l for l in read(name).split("\n") if any("က" <= c <= "႟" for c in l) and l.strip()]


UNICODE_DOC = read("udhr_mya_unicode_src.txt")
# Burmese prose only, long enough that the Markov model may overrule a code point.
UNICODE_PROSE = " ".join(burmese_lines("udhr_mya_unicode_src.txt"))[:400]
ZAWGYI_DOC = read("udhr_mya_zawgyi_out.txt")


class StubClient:
    """Returns shaped answers without a network call.

    Matches the documented answer schema exactly, including the detail that Noul answers
    carry no ``confidence`` field. Only Choice and Score do.
    """

    def __init__(self, choice: str = AS_WRITTEN, confidence: float = 0.95,
                 burmese: float = 0.98, mixed: float = 0.01) -> None:
        self.choice, self.confidence = choice, confidence
        self.burmese, self.mixed = burmese, mixed
        self.requests: list[dict[str, Any]] = []

    def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(request)
        others = [o for o in (AS_WRITTEN, IF_CONVERTED, NEITHER) if o != self.choice]
        rest = (1 - self.confidence) / len(others)
        probs = {self.choice: self.confidence, **{o: rest for o in others}}
        return {
            "model": "jev-1.13.0",
            "answers": {
                READING: {"type": "choice", "choice": self.choice,
                          "probabilities": probs, "confidence": self.confidence},
                IS_BURMESE: {"type": "noul", "noul": self.burmese},
                IS_MIXED: {"type": "noul", "noul": self.mixed},
            },
            "usage": {"input_tokens": 412, "output_tokens": 61},
        }


class TestStageOne:
    def test_unicode_document(self) -> None:
        d = detect_sync(UNICODE_DOC)
        assert d.encoding == "unicode"
        assert d.confidence > 0.9

    def test_zawgyi_document(self) -> None:
        d = detect_sync(ZAWGYI_DOC)
        assert d.encoding == "zawgyi"
        assert d.confidence > 0.9

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("udhr_mya_unicode_src.txt", "unicode"),
            ("mmgov_unicode_out.txt", "unicode"),
            ("udhr_mya_zawgyi_out.txt", "zawgyi"),
            ("mmgov_zawgyi_src.txt", "zawgyi"),
        ],
    )
    def test_never_confidently_wrong(self, name: str, expected: str) -> None:
        lines = burmese_lines(name)
        assert len(lines) > 20
        other = "unicode" if expected == "zawgyi" else "zawgyi"
        results = [(l, detect_sync(l)) for l in lines]

        # The contract is not "always right" but "never confidently wrong": a caller can
        # recover from None, not from a confident lie.
        wrong = [l for l, d in results if d.encoding == other]
        assert not wrong, f"{len(wrong)}/{len(lines)} misclassified: {wrong[:1]}"

        abstained = [(l, d) for l, d in results if d.encoding is None]
        assert len(abstained) / len(lines) < 0.05
        # Whatever stage 1 could not call must be handed to stage 2, not dropped.
        assert all(should_escalate(d) for _, d in abstained)


class TestRefusingToGuess:
    def test_no_myanmar_characters(self) -> None:
        d = detect_sync("Hello world, this is plain English.")
        assert d.encoding is None
        assert d.evidence == "no-myanmar"
        assert d.probability is None
        assert should_escalate(d) is False

    def test_empty_string_is_unknown_not_unicode(self) -> None:
        assert detect_sync("").encoding is None

    def test_myanmar_digits_carry_no_signal(self) -> None:
        # Upstream reports this as strong Unicode; there is nothing to score.
        d = detect_sync("၁၂၃")
        assert d.encoding is None
        assert d.myanmar_chars > 0

    def test_short_sample_is_uncertain(self) -> None:
        d = detect_sync(AMBIGUOUS)
        assert d.encoding is None
        # The raw probability is extreme, which is exactly why it must be discounted.
        assert d.probability is not None and d.probability > 0.9
        assert d.confidence < 0.5


class TestCodepoints:
    def test_u103e_proves_unicode(self) -> None:
        e = scan_codepoints("ကှ")
        assert (e.unicode_only, e.zawgyi_only) == (1, 0)

    def test_u1033_proves_zawgyi(self) -> None:
        e = scan_codepoints("ကဳ")
        assert (e.zawgyi_only, e.unicode_only) == (1, 0)

    def test_conflicting_proof_yields_no_verdict(self) -> None:
        assert detect_sync("ကှခဳ").encoding is None

    def test_isolated_codepoint_in_long_text_is_a_conflict(self) -> None:
        # Pins the regression: one stray code point used to return zawgyi at 0.95
        # confidence over a passage the model scored at P(Zawgyi)=0.000000.
        d = detect_sync(UNICODE_PROSE + "ဳ")
        assert d.encoding is None
        assert d.evidence == "conflict"
        assert d.probability is not None and d.probability < 0.05
        assert should_escalate(d) is True
        assert any("mixed" in r for r in d.reasons)

    def test_lone_zawgyi_codepoint_the_model_contradicts_is_a_conflict(self) -> None:
        # The other route into a conflict: no Unicode-only marker present, so the
        # code-point layer is certain, and the model disagrees over enough text.
        clean = UNICODE_PROSE.replace("ှ", "")
        d = detect_sync(clean + "ဳ")
        assert d.myanmar_chars >= 15
        assert d.encoding is None
        assert d.evidence == "conflict"
        assert any("says unicode" in r for r in d.reasons)

    def test_codepoints_still_win_when_model_agrees_or_is_untrusted(self) -> None:
        assert detect_sync(ZAWGYI_DOC).encoding == "zawgyi"
        short = detect_sync("ကခဳ")
        assert short.encoding == "zawgyi"
        assert short.evidence == "codepoint"


class TestConversion:
    def test_z2u_matches_reference_exactly(self) -> None:
        z = burmese_lines("mmgov_zawgyi_src.txt")
        u = burmese_lines("mmgov_unicode_out.txt")
        assert len(z) == len(u)
        wrong = [i for i, (a, b) in enumerate(zip(z, u)) if zawgyi_to_unicode(a) != b]
        assert not wrong, f"{len(wrong)}/{len(z)} lines differ"

    def test_u2z_matches_reference(self) -> None:
        u = burmese_lines("udhr_mya_unicode_src.txt")
        z = burmese_lines("udhr_mya_zawgyi_out.txt")
        wrong = [i for i, (a, b) in enumerate(zip(u, z)) if unicode_to_zawgyi(a) != b]
        assert len(wrong) <= 1

    def test_round_trip_is_lossy(self) -> None:
        # Zawgyi to Unicode is many-to-one, so the trip back cannot recover the original.
        # Anyone tempted to store Zawgyi and convert on read should see this.
        z = burmese_lines("mmgov_zawgyi_src.txt")
        restored = [l for l in z if unicode_to_zawgyi(zawgyi_to_unicode(l)) == l]
        assert len(restored) < len(z)

    def test_converted_zawgyi_detects_as_unicode(self) -> None:
        assert detect_sync(zawgyi_to_unicode(ZAWGYI_DOC)).encoding == "unicode"

    def test_is_zawgyi_convenience(self) -> None:
        assert is_zawgyi(ZAWGYI_DOC) is True
        assert is_zawgyi(UNICODE_DOC) is False


class TestEscalation:
    def test_clear_document_never_hits_network(self) -> None:
        client = StubClient()
        detect(UNICODE_DOC, client=client)
        assert client.requests == []

    def test_no_myanmar_never_hits_network(self) -> None:
        client = StubClient()
        assert detect("Just some English prose.", client=client).encoding is None
        assert client.requests == []

    def test_without_client_result_is_honest(self) -> None:
        d = detect(AMBIGUOUS)
        assert d.encoding is None
        assert d.escalated is False

    def test_as_written_means_unicode(self) -> None:
        client = StubClient(choice=AS_WRITTEN, confidence=0.93)
        d = detect(AMBIGUOUS, client=client)
        assert (d.encoding, d.evidence, d.escalated) == ("unicode", "jev", True)
        assert d.confidence == 0.93
        assert len(client.requests) == 1

    def test_if_converted_means_zawgyi(self) -> None:
        d = detect(AMBIGUOUS, client=StubClient(choice=IF_CONVERTED, confidence=0.91))
        assert d.encoding == "zawgyi"

    def test_low_confidence_abstains(self) -> None:
        d = detect(AMBIGUOUS, client=StubClient(choice=IF_CONVERTED, confidence=0.45))
        assert d.encoding is None
        assert any("confidence below" in r for r in d.reasons)

    def test_neither_abstains(self) -> None:
        assert detect(AMBIGUOUS, client=StubClient(choice=NEITHER, confidence=0.99)).encoding is None

    def test_non_burmese_abstains(self) -> None:
        # Shan and Mon legitimately use code points otherwise treated as Zawgyi-only.
        d = detect(AMBIGUOUS, client=StubClient(choice=IF_CONVERTED, burmese=0.1))
        assert d.encoding is None
        assert any("P(Burmese)" in r for r in d.reasons)

    def test_mixed_is_reported_not_averaged(self) -> None:
        d = detect(AMBIGUOUS, client=StubClient(choice=IF_CONVERTED, mixed=0.9))
        assert d.encoding is None
        assert d.mixed is True  # type: ignore[attr-defined]

    def test_usage_is_reported(self) -> None:
        d = detect(AMBIGUOUS, client=StubClient())
        assert d.usage == {"input_tokens": 412, "output_tokens": 61}  # type: ignore[attr-defined]

    def test_request_shape(self) -> None:
        client = StubClient()
        detect(AMBIGUOUS, client=client, model="jev-1.13.0")
        req = client.requests[0]
        assert req["model"] == "jev-1.13.0"
        # All three ride in one request: Jev evaluates them in parallel against one
        # ingestion of the state, so batching costs only the extra question tokens.
        assert set(req["questions"]) == {READING, IS_BURMESE, IS_MIXED}
        assert set(req["questions"][READING]["criteria"]) == {AS_WRITTEN, IF_CONVERTED, NEITHER}
        assert req["state"][AS_WRITTEN] == AMBIGUOUS
        assert req["state"][IF_CONVERTED] != AMBIGUOUS


class TestFailureHandling:
    class Failing:
        def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
            raise TypeSafeError("TypeSafe 429: rate limited", 429, "rate limited")

    def test_falls_back_to_stage_one(self) -> None:
        d = detect(AMBIGUOUS, client=self.Failing())
        assert d.evidence == "markov"
        assert any("escalation failed" in r for r in d.reasons)

    def test_throws_when_asked(self) -> None:
        with pytest.raises(TypeSafeError):
            detect(AMBIGUOUS, client=self.Failing(), on_error="throw")

    def test_client_requires_a_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
        with pytest.raises(ValueError, match="No TypeSafe API key"):
            JevClient()


class TestToUnicode:
    def test_converts_zawgyi(self) -> None:
        text, detection, converted = to_unicode(ZAWGYI_DOC)
        assert converted is True
        assert detection.encoding == "zawgyi"
        assert detect_sync(text).encoding == "unicode"

    def test_leaves_unicode_alone(self) -> None:
        text, _, converted = to_unicode(UNICODE_DOC)
        assert converted is False
        assert text == UNICODE_DOC

    def test_leaves_unknown_untouched(self) -> None:
        text, _, converted = to_unicode(AMBIGUOUS)
        assert converted is False
        # A wrong conversion is not reversible, so never convert on a guess.
        assert text == AMBIGUOUS


class TestRegressions:
    """One test per code review finding, so none of them come back quietly."""

    def test_detect_forwards_thresholds_to_should_escalate(self) -> None:
        # detect() used to pass options to detect_sync but call should_escalate with
        # defaults, so a loosened threshold made Python pay for a call TypeScript skipped.
        client = StubClient()
        detect(AMBIGUOUS, client=client, uncertain_below=0.3)
        assert client.requests == [], "a loosened threshold must suppress the call"

        strict = StubClient()
        detect(AMBIGUOUS, client=strict, uncertain_below=0.9)
        assert len(strict.requests) == 1

    def test_retry_after_http_date_does_not_raise(self) -> None:
        # Retry-After may be an HTTP date. float() raised on that, turning a retryable
        # 429 into a ValueError and losing the original error.
        from jawgyi.jev import _retry_delay

        # A far-future date must be capped, not slept through. Uncapped this was ~73 years.
        from jawgyi.jev import MAX_RETRY_DELAY

        assert _retry_delay({"retry-after": "Wed, 21 Oct 2099 07:28:00 GMT"}, 1) == MAX_RETRY_DELAY
        assert _retry_delay({"retry-after": "86400"}, 1) == MAX_RETRY_DELAY
        assert _retry_delay({"retry-after": "not a date at all"}, 1) == pytest.approx(0.2)

        # A whitespace-only header used to raise IndexError out of parsedate_to_datetime,
        # turning a retryable 429 into a crash: the exact bug class this function exists
        # to prevent, reintroduced by the fix for it.
        for junk in ("   ", "\t\n", "", "Infinity", "NaN", "0x10", "1e9", "-5", "1.5"):
            assert _retry_delay({"retry-after": junk}, 1) == pytest.approx(0.2)
        assert _retry_delay({"retry-after": "2"}, 1) == pytest.approx(2.0)
        assert _retry_delay({}, 1) == pytest.approx(0.2)
        assert _retry_delay(None, 2) == pytest.approx(0.4)
        # A date already in the past means retry now, not sleep for a negative time.
        assert _retry_delay({"retry-after": "Wed, 21 Oct 1999 07:28:00 GMT"}, 1) == 0.0

    def test_shipped_rule_tables_match_the_generator_output(self) -> None:
        # The package data used to be hand-copied and nothing regenerated it, so the
        # Python port could silently run stale rules.
        import json
        from importlib import resources

        repo = Path(__file__).resolve().parents[2]
        for name in ("z2u", "u2z", "znorm"):
            shipped = json.loads(
                (resources.files("jawgyi.data.rules") / f"{name}.json").read_text("utf-8")
            )
            canonical = json.loads((repo / "shared" / "rules" / f"{name}.json").read_text("utf-8"))
            assert shipped == canonical, f"{name}.json has drifted from shared/"

    def test_shipped_model_matches_the_canonical_one(self) -> None:
        from importlib import resources

        repo = Path(__file__).resolve().parents[2]
        shipped = (resources.files("jawgyi.data") / "zawgyiUnicodeModel.dat").read_bytes()
        assert shipped == (repo / "shared" / "zawgyiUnicodeModel.dat").read_bytes()


class TestDirect:
    """is_jawgyi: the single-question path."""

    class Stub:
        def __init__(self, noul: float) -> None:
            self.noul = noul
            self.requests: list[dict[str, Any]] = []

        def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
            self.requests.append(request)
            return {
                "model": "jev-1.13.0",
                "answers": {DIRECT_QUESTION_ID: {"type": "noul", "noul": self.noul}},
                "usage": {"input_tokens": 120, "output_tokens": 8},
            }

    def test_sends_one_noul_with_bare_text_as_state(self) -> None:
        s = self.Stub(0.9)
        is_jawgyi("ကဳ", s)
        q = s.requests[0]["questions"][DIRECT_QUESTION_ID]
        assert q["type"] == "noul"
        assert "Zawgyi font encoding" in q["instructions"]
        # Bare text, not the two candidate readings that resolve_with_jev builds.
        assert s.requests[0]["state"] == "ကဳ"

    def test_reports_the_local_answer_alongside(self) -> None:
        v = is_jawgyi(ZAWGYI_DOC, self.Stub(0.02))
        assert v.zawgyi is False
        assert v.stage1.encoding == "zawgyi"
        assert v.disagrees is True
        assert "decoded code points" in v.note

    def test_local_abstention_is_not_a_disagreement(self) -> None:
        v = is_jawgyi(AMBIGUOUS, self.Stub(0.99))
        assert v.stage1.encoding is None
        assert v.disagrees is False

    def test_rejects_a_non_noul_answer(self) -> None:
        class Wrong:
            def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
                return {
                    "model": "m",
                    "answers": {DIRECT_QUESTION_ID: {"type": "choice", "choice": "x"}},
                    "usage": {},
                }

        with pytest.raises(ValueError, match="Expected a noul"):
            is_jawgyi("ကဳ", Wrong())

    def test_matches_the_typescript_question_verbatim(self) -> None:
        # The two packages must send byte-identical questions or their numbers are not
        # comparable, and comparing them is the entire reason this path exists.
        import json
        import re

        ts = (Path(__file__).resolve().parents[2] / "src" / "jev" / "direct.ts").read_text("utf-8")
        py = json.dumps(build_direct_question(), sort_keys=True)
        for field in ("Is this text encoded in the Zawgyi font encoding rather than Unicode?",
                      "The text is Zawgyi encoded.",
                      "The text is Unicode encoded."):
            assert field in ts, f"TypeScript is missing {field!r}"
            assert field in py, f"Python is missing {field!r}"
        assert re.search(r"DIRECT_QUESTION_ID = 'is_it_zawgyi'", ts)
        assert DIRECT_QUESTION_ID == "is_it_zawgyi"

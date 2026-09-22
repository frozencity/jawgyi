# jawgyi

JEV + Zawgyi. Yes, the name is a pun. It's downhill from here.

Zawgyi vs Unicode detection for Burmese text.

```bash
npm install jawgyi
```

```ts
import { detectSync, toUnicode } from 'jawgyi';

detectSync(text).encoding; // 'unicode' | 'zawgyi' | null

const { text: clean, converted } = await toUnicode(text);
```

## The problem with every detector I could find

They return a number between 0 and 1. You threshold it at 0.5. Above that it's Zawgyi, below it's Unicode.

Great. Ship it.

Which is fine right up until the number is 0.51.

Here's what that costs. Zawgyi-to-Unicode conversion is many-to-one. Several Zawgyi spellings collapse to the same Unicode. So if you convert text that was already Unicode, you don't get an error. You get slightly different Unicode, and no way back.

No exception. No warning. No log line. Just a slightly different document, forever.

You find out about it in 2029, when someone opens a contract and it's soup, and the backups are soup too, because you converted those in the same batch job.

The number never told you it was guessing. That's the whole problem.

So this library returns `null`.

```ts
detectSync('hello');
// { encoding: null, evidence: 'no-myanmar', probability: null,
//   reasons: ['no Myanmar-block characters'] }

detectSync('နျပ');   // 3 Myanmar characters
// { encoding: null, evidence: 'markov', probability: 0.987, confidence: 0.36,
//   myanmarChars: 3, reasons: ['only 3 Myanmar characters'] }
```

Look at the second one. The raw probability is 0.987, which is the kind of number that ends arguments. A thresholding detector calls that Zawgyi and doesn't blink.

It's three characters.

At three characters the model is a coin flip wearing a lab coat, and there's a table below that proves it. So the confidence gets discounted and the answer is "I don't know."

If you want the old behaviour, `isZawgyi(text)` returns a boolean and takes the guess. It's right there. I just refuse to make it the default.

## How it decides

### Stage 1, which handles almost everything

Local. No key, no network, no dependencies, sub-millisecond. Runs in Node, browsers, edge workers.

It checks two things, in this order:

1. **Code points.** Some code points only ever appear in one encoding. U+103E shows up 419 times in the Unicode corpus and zero times in the Zawgyi one. Twenty-two code points run the other way. That's proof, not statistics, so it's checked first.
2. **A Markov model.** Google's trained bigram classifier over Myanmar code points, vendored from [myanmar-tools](https://github.com/google/myanmar-tools).

Then it discounts confidence on short text, because the model keeps reporting extreme probabilities long after it stops earning them. Confidence and accuracy part ways around character six and never speak again.

There's one case where neither layer gets to decide. If a single Zawgyi-only code point turns up in 400 characters the model scores at P(Zawgyi) of 0.000000, that is not evidence the passage is Zawgyi. It's evidence something is wrong with the passage. Those are different claims, and the first version of this library conflated them, which meant one stray character could make `toUnicode` irreversibly rewrite a whole document. Now that returns `evidence: 'conflict'`, no verdict, and escalates. Same for a document where both exclusive sets fire.

I measured that on a 308-line parallel corpus of UDHR Burmese and Myanmar government text, the same documents in both encodings:

| Myanmar chars | accuracy | lands in the uncertain band |
|---|---|---|
| 2 | 60.8% | 81.4% |
| 4 | 72.2% | 56.9% |
| 6 | 86.4% | 28.6% |
| 8 | 97.7% | 8.4% |
| 15 | 99.7% | 1.6% |
| 30+ | 100% | 0.3% |

That table is the argument for the whole design, and it is also mildly embarrassing, because I started this project intending to solve the problem with a language model and the table says the problem was already solved in 2017 by a Markov chain.

Above about 15 characters, local detection is effectively perfect. Sending that to a network API would make it slower, more expensive, and no more correct. Below about 8, it's guessing.

So the threshold is 8. Not because 8 is a nice round number. Because that's where the curve turns.

### Stage 2, which handles the rest

Opt in by passing a client. Measured on the corpus, 1.0% of 15-character samples get here and 0.32% of full lines. (The 1.6% in the table above is a different number: it's how often the raw probability lands in the uncertain band, which is not the same test as whether stage 1 escalates.)

```ts
import { detect, JevClient } from 'jawgyi';

const client = new JevClient({ model: 'jev-1.13.0' }); // reads TYPESAFE_API_KEY
const result = await detect(text, { client });
```

Now, the obvious move is to send the text to Jev and ask whether it's Zawgyi.

Don't.

Jev never sees bytes. By the time the request leaves your process the text is decoded code points in a JSON string. The encoding question was settled upstream by whatever did the decoding. Asking Jev to weigh in is asking it about something it cannot observe.

It will answer. It always answers. You'll get a plausible verdict with a confidence score bolted to it, which is strictly worse than getting nothing, because nothing doesn't look like data.

So the code does the mechanical half itself. It produces both candidate readings and asks Jev the one question that genuinely needs somebody who can read:

```jsonc
{
  "state": {
    "reading_a": "<the text as written>",
    "reading_b": "<the text after Zawgyi→Unicode conversion>"
  },
  "questions": {
    "coherent_reading": { "type": "choice", /* a, b, or neither */ },
    "is_burmese":       { "type": "noul"   },
    "is_mixed_encoding":{ "type": "noul"   }
  }
}
```

If `reading_a` is the readable one, the text was already Unicode. If `reading_b` is, it was Zawgyi.

That question a Markov chain cannot touch. A person who reads Burmese answers it in about a second and wonders why you asked.

All three questions ride in one request. Jev ingests the state once and evaluates questions in parallel, so the extra two cost their own tokens and almost no extra latency.

The two extra questions exist because a single probability hides two specific failures:

- **`is_burmese`**: the Zawgyi-exclusive code-point table is only valid for Burmese. Unicode assigns most of U+1050 to U+1095 to other languages that use Myanmar script: Mon at U+105A to U+1060, then Karen, Kayah, Shan and Rumai Palaung. Of the 22 code points this library treats as Zawgyi-only, 13 are Shan, 3 are Mon, 4 are Karen, and one each are Kayah and Rumai Palaung. Without this guard the library mislabels Shan documents in particular, at 0.99 confidence, cheerfully.
- **`is_mixed_encoding`**: a document that's half Zawgyi averages out to a confident wrong answer. Asking directly lets you split it and detect per span.

Stage 2 abstains when Choice confidence is below 0.7, when Jev answers `neither`, when P(Burmese) drops under 0.5, or when it reports mixed encodings.

## What I don't know

**Whether Jev can actually read Burmese.** TypeSafe publishes no per-language benchmarks and Burmese is low-resource. I wrote the questions against their documented guidance: literal phrasing, explicit criteria, the [known jagged edges](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

I was careful. Careful is not a measurement. Careful is a feeling I had on a Tuesday.

So there's a script:

```bash
npm run calibrate:dry                 # inspect the request, send nothing
npm run build
TYPESAFE_API_KEY=... node scripts/calibrate.mjs --samples 40
```

It reports how often Jev decided, how often it was right, and what it cost.

If accuracy comes back near chance, ship stage 1 alone. The library works fine without a key. Yes, that would make the second half of the name decorative. I'd still rather find out for half a cent than in production.

## Other things worth knowing

**State is untrusted.** `jev-1.13` doesn't treat state as hostile, and the text you pass it is attacker-controlled. The criteria are written to be explicit about it. If you're running this on arbitrary user input, test it.

**Round-tripping loses data.** `unicodeToZawgyi(zawgyiToUnicode(x)) !== x` for most real text. There is a test asserting that it fails, which is a strange test to write and a necessary one, because otherwise somebody eventually decides to store Zawgyi and convert on read. Convert once, store Unicode, don't look back.

**Pin the model.** `jev-latest` moves. The thresholds here were reasoned against one version. Pass `model: 'jev-1.13.0'`.

**Get keys from [console.typesafe.ai](https://console.typesafe.ai).** There are unaffiliated resellers. One of them, `jevtypesafeai.com`, admits in its own footer that it isn't affiliated with TypeSafe, directly beneath the part where it sells you keys. Routing your prompts and your credit card through a domain that appeared last Tuesday is not the same as using the API.

## API

| Export | |
|---|---|
| `detectSync(text, opts?)` | Local only. Returns `Detection`. Never throws, never blocks. |
| `detect(text, opts?)` | Async. Escalates to Jev when `opts.client` is set and stage 1 is weak. |
| `toUnicode(text, opts?)` | `{ text, detection, converted }`. Converts only on a confident Zawgyi verdict. |
| `isZawgyi(text, opts?)` | Boolean. Accepts a guess on weak evidence. |
| `zawgyiToUnicode` / `unicodeToZawgyi` / `normalizeZawgyi` | Transliteration. |
| `JevClient` | Zero-dependency client for `POST /v1/systemone`, retries 429/529. |
| `scanCodepoints` | Raw evidence counts, if you want your own policy. |

```ts
interface Detection {
  encoding: 'unicode' | 'zawgyi' | null;
  confidence: number;
  evidence: 'codepoint' | 'markov' | 'jev' | 'no-myanmar' | 'conflict';
  probability: number | null;   // raw P(Zawgyi), null when there is no signal
  myanmarChars: number;
  escalated: boolean;
  reasons: string[];
}
```

Thresholds are tunable through `DetectOptions`: `shortTextThreshold`, `uncertainBand`, `uncertainBelow`, `conflictMinChars`.

Every question and threshold the Jev stage uses lives in one file, [`src/jev/questions.ts`](src/jev/questions.ts). That's deliberate. TypeSafe's own guidance is that questions and thresholds are the part humans need to read, and they're right. Scattered across six files, nobody reviews them.

## Why not just use myanmar-tools

You should, for the model. That's why it's vendored here with attribution. The classifier is good and I didn't want to retrain it.

But `myanmar-tools@1.2.0` on npm has been broken since 2022. Its `index.js` requires `./build_node/zawgyi_detector`. There is no `build_node/` directory in the tarball. There is `src/`, there is a gulpfile, and there is a confident `module.exports` pointing at a folder that did not make the flight.

`require('myanmar-tools')` throws `MODULE_NOT_FOUND`. It has been doing this for four years. The model inside is excellent.

There's also a behaviour I changed. Upstream returns `-Infinity` when the text contains no Myanmar code points, and the docs say callers read that as strong Unicode. So you hand it the word "hello" and it tells you, with total conviction, that this is Unicode Burmese.

Here that's `null`, and you have to deal with it. Sorry.

## Python

There's a port in [`python/`](python/). Same API, same behaviour.

```python
from jawgyi import detect_sync, to_unicode
detect_sync(text).encoding      # 'unicode' | 'zawgyi' | None
```

One build step generates the model and the rule tables into both packages, `shared/` for the TypeScript side and `python/src/jawgyi/data/` for the Python one, from the same vendored source. Each package reads its own copy at import time rather than reaching across the repo, and two Python tests assert the shipped copies still match `shared/` byte for byte. Hand-copying them is how they drifted the first time. The detection policy is written twice, though, which is exactly the kind of thing that rots. So `npm run cross-check` runs both implementations over the corpus and fails on any disagreement. It checks the verdict, the evidence, the confidence, the reason strings and the conversion output, at eight different threshold settings, over samples generated at lengths that straddle every threshold. Earlier versions were softer than that and I proved it by hand: with only default thresholds a threshold-forwarding bug walked straight through, and with only long samples I could change one implementation's conflict threshold from 15 to 40 and still get a clean run. Right now it's 0 differences across 7584 comparisons.

```bash
cd python && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest
```

## Development

```bash
npm install
npm run build        # regenerate vendored assets, emit ESM + CJS
npm test             # no network
npm run derive       # re-derive the code-point tables from the corpus
npm run cross-check  # TypeScript vs Python
```

The fixtures are parallel corpora, the same documents in both encodings, so conversion gets tested against a reference instead of a snapshot of its own output.

One thing about them: they're generated pairs, and the direction matters. `mmgov_zawgyi_src.txt` is the source and `mmgov_unicode_out.txt` is what Z2U made from it. The UDHR pair runs the other way. Test each converter in the direction its fixture was built for.

I did not do this. I spent a while investigating why a converter that is 63 out of 63 exact appeared to be failing a third of the time, which is the sort of number that makes you doubt the converter instead of the test.

## License

Dual licensed, MIT or [WTFPL](http://www.wtfpl.net/), whichever you prefer. You do not have to tell me which.

With one carve out that isn't up to me. The Markov model, the transliteration rules and the test fixtures come from Google's myanmar-tools and stay Apache-2.0, Copyright 2017 Google LLC, which means their attribution has to travel with them. Choosing WTFPL for everything else doesn't change that, and no license I pick can, because those files were never mine to relicense. [LICENSE](LICENSE) lists exactly which paths are which, and [NOTICE](NOTICE) has the attribution.

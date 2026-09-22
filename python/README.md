# jawgyi (Python)

Zawgyi vs Unicode detection for Burmese text. Fast local detection, with an optional
[Jev](https://docs.typesafe.ai) stage for genuinely ambiguous samples.

```python
from jawgyi import detect_sync, to_unicode

detect_sync(text).encoding      # 'unicode' | 'zawgyi' | None

clean, detection, converted = to_unicode(text)
```

`encoding` is `None` whenever the evidence does not support a verdict. That is the
feature, not a gap. A wrong Zawgyi→Unicode conversion cannot be undone, so this library
abstains rather than guessing. Use `is_zawgyi(text)` if you want a boolean and accept
the guess.

To enable the Jev stage:

```python
from jawgyi import JevClient, detect

detect(text, client=JevClient(model="jev-1.13.0"))   # reads TYPESAFE_API_KEY
```

See the [repository README](../README.md) for the design, the measured accuracy table,
and the limitations, in particular that Jev's Burmese ability is unvalidated and should
be calibrated before you rely on stage 2.

No runtime dependencies. Python 3.9+.

## License

Dual licensed, MIT or WTFPL, your choice.

The vendored Markov model and transliteration rules are Apache-2.0, Copyright 2017
Google LLC, and stay that way regardless of which you pick. See [NOTICE](../NOTICE).

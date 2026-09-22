/*
 * Zawgyi/Unicode Markov classifier ported from Google's myanmar-tools (Apache-2.0).
 * Copyright 2017 Google LLC. See NOTICE and vendor/LICENSE-myanmar-tools.md.
 *
 * Changes from upstream:
 *  - base64 decoding works on Node and in browsers without branching on `Buffer`/`atob`
 *  - the model loads lazily, so importing jawgyi costs nothing until you detect
 *  - `predict` returns null instead of -Infinity when there is no Myanmar-range signal,
 *    because callers that treat -Infinity as a number silently read it as "strong Unicode"
 *    for Latin text. Making the absence of signal a distinct value forces the caller to
 *    handle it, which is the bug this library exists to avoid.
 */
import { MODEL_BASE64 } from './model-data.ts';

// Standard Myanmar code point range before digits
const STD_CP0 = 0x1000;
const STD_CP1 = 0x103f;
// Standard Myanmar code point range after digits
const AFT_CP0 = 0x104a;
const AFT_CP1 = 0x109f;
// Myanmar Extended A
const EXA_CP0 = 0xaa60;
const EXA_CP1 = 0xaa7f;
// Myanmar Extended B
const EXB_CP0 = 0xa9e0;
const EXB_CP1 = 0xa9ff;
// Unicode space characters
const SPC_CP0 = 0x2000;
const SPC_CP1 = 0x200b;

const STD_OFFSET = 1;
const AFT_OFFSET = STD_OFFSET + STD_CP1 - STD_CP0 + 1;
const EXA_OFFSET = AFT_OFFSET + AFT_CP1 - AFT_CP0 + 1;
const EXB_OFFSET = EXA_OFFSET + EXA_CP1 - EXA_CP0 + 1;
const SPC_OFFSET = EXB_OFFSET + EXB_CP1 - EXB_CP0 + 1;

/** State Set Version: 0 includes space-like code points in the chain, 1 does not. */
const SSV_STD_EXA_EXB_SPC = 0;

function getIndexForCodePoint(cp: number, ssv: number): number {
  if (STD_CP0 <= cp && cp <= STD_CP1) return cp - STD_CP0 + STD_OFFSET;
  if (AFT_CP0 <= cp && cp <= AFT_CP1) return cp - AFT_CP0 + AFT_OFFSET;
  if (EXA_CP0 <= cp && cp <= EXA_CP1) return cp - EXA_CP0 + EXA_OFFSET;
  if (EXB_CP0 <= cp && cp <= EXB_CP1) return cp - EXB_CP0 + EXB_OFFSET;
  if (ssv === SSV_STD_EXA_EXB_SPC && SPC_CP0 <= cp && cp <= SPC_CP1) {
    return cp - SPC_CP0 + SPC_OFFSET;
  }
  return 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Runtime-agnostic base64 -> bytes. Avoids Buffer (Node-only) and atob (deprecated in Node). */
function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let out = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (acc >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, out);
}

function checkMagic(
  view: DataView,
  offset: number,
  expectLead: number,
  expectTrail: number,
  expectVersion: number,
): number {
  const lead = view.getUint32(offset);
  offset += 4;
  if (lead !== expectLead) {
    throw new Error(`Bad model magic lead: expected ${expectLead.toString(16)}, got ${lead.toString(16)}`);
  }
  const trail = view.getUint32(offset);
  offset += 4;
  if (trail !== expectTrail) {
    throw new Error(`Bad model magic trail: expected ${expectTrail.toString(16)}, got ${trail.toString(16)}`);
  }
  if (expectVersion !== -1) {
    const version = view.getUint32(offset);
    offset += 4;
    if (version !== expectVersion) {
      throw new Error(`Bad model version: expected ${expectVersion.toString(16)}, got ${version.toString(16)}`);
    }
  }
  return offset;
}

/**
 * Sparse matrix of log-probability differences between the Zawgyi and Unicode chains,
 * indexed by [previous state][current state].
 */
class BinaryMarkov {
  private readonly deltas: Float64Array;
  private readonly size: number;

  constructor(view: DataView, offset: number) {
    offset = checkMagic(view, offset, 0x424d4152, 0x4b4f5620, 0);
    const size = view.getInt16(offset);
    offset += 2;
    this.size = size;
    // A flat typed array rather than upstream's number[][]: same lookups, one allocation,
    // and ~8x less memory than a jagged array of boxed numbers for a 1400^2 matrix.
    const deltas = new Float64Array(size * size);
    for (let i1 = 0; i1 < size; i1++) {
      let entries = view.getInt16(offset);
      offset += 2;
      let fallback = 0;
      if (entries !== 0) {
        fallback = view.getFloat32(offset);
        offset += 4;
      }
      let next = -1;
      const row = i1 * size;
      for (let i2 = 0; i2 < size; i2++) {
        if (entries > 0 && next < i2) {
          next = view.getInt16(offset);
          offset += 2;
          entries--;
        }
        if (next === i2) {
          deltas[row + i2] = view.getFloat32(offset);
          offset += 4;
        } else {
          deltas[row + i2] = fallback;
        }
      }
    }
    this.deltas = deltas;
  }

  delta(i1: number, i2: number): number {
    return this.deltas[i1 * this.size + i2]!;
  }
}

class ZawgyiUnicodeMarkovModel {
  private readonly classifier: BinaryMarkov;
  private readonly ssv: number;

  constructor(view: DataView, offset: number) {
    offset = checkMagic(view, offset, 0x555a4d4f, 0x44454c20, -1);
    const version = view.getUint32(offset);
    offset += 4;
    if (version === 1) {
      this.ssv = 0;
    } else if (version === 2) {
      this.ssv = view.getUint32(offset);
      offset += 4;
    } else {
      throw new Error(`Model serial version: expected 1 or 2, got ${version.toString(16)}`);
    }
    this.classifier = new BinaryMarkov(view, offset);
  }

  /** P(Zawgyi | text is either Zawgyi or Unicode), or null when the text carries no signal. */
  predict(input: string): number | null {
    let prevState = 0;
    let totalDelta = 0;
    let seenTransition = false;
    for (let offset = 0; offset <= input.length; offset++) {
      // All states of interest are in the BMP, so charCodeAt is correct here.
      const currState = offset === input.length ? 0 : getIndexForCodePoint(input.charCodeAt(offset), this.ssv);
      if (prevState !== 0 || currState !== 0) {
        totalDelta += this.classifier.delta(prevState, currState);
        seenTransition = true;
      }
      prevState = currState;
    }
    if (!seenTransition) return null;
    // Pz/(Pu+Pz) = 1/(1+exp(logPu-logPz))
    return 1 / (1 + Math.exp(totalDelta));
  }
}

let model: ZawgyiUnicodeMarkovModel | undefined;

/** P(Zawgyi) in [0,1], or null if the text contains no Myanmar-range code points. */
export function markovZawgyiProbability(text: string): number | null {
  if (model === undefined) {
    const bytes = decodeBase64(MODEL_BASE64);
    model = new ZawgyiUnicodeMarkovModel(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
  }
  return model.predict(text);
}

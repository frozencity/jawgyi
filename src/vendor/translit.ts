/*
 * Transliteration engine ported from Google's myanmar-tools (Apache-2.0).
 * Copyright 2017 Google LLC. See NOTICE and vendor/LICENSE-myanmar-tools.md.
 *
 * The algorithm is unchanged from upstream; only the rule storage differs
 * (sources compiled at build time rather than regexes literal in a .js resource).
 */

export interface RawRule {
  /** Regex source, anchored with ^. runPhase walks the string itself. */
  readonly p: string;
  /** Replacement, may reference $1..$n. */
  readonly s: string;
  readonly matchOnStart?: boolean;
  readonly revisit?: number;
}

interface Rule {
  readonly p: RegExp;
  readonly s: string;
  readonly matchOnStart?: boolean | undefined;
  readonly revisit?: number | undefined;
}

/**
 * Regex construction is the expensive part, so compile each table once on first use
 * rather than at module load. A caller that only ever detects never pays for it.
 */
function compile(phases: readonly (readonly RawRule[])[]): Rule[][] {
  return phases.map((phase) =>
    phase.map((r) => ({
      p: new RegExp(r.p),
      s: r.s,
      matchOnStart: r.matchOnStart,
      revisit: r.revisit,
    })),
  );
}

const cache = new WeakMap<readonly (readonly RawRule[])[], Rule[][]>();

function phasesFor(raw: readonly (readonly RawRule[])[]): Rule[][] {
  let compiled = cache.get(raw);
  if (compiled === undefined) {
    compiled = compile(raw);
    cache.set(raw, compiled);
  }
  return compiled;
}

function runPhase(rules: readonly Rule[], inString: string): string {
  let outString = '';
  let midString = inString;
  let startOfString = true;
  while (midString.length > 0) {
    let foundRule = false;
    for (const rule of rules) {
      if (rule.matchOnStart == null || startOfString) {
        const m = midString.match(rule.p);
        if (m != null) {
          foundRule = true;
          const rightPartSize = midString.length - m[0].length;
          midString = midString.replace(rule.p, rule.s);
          const newStart = midString.length - rightPartSize;
          if (rule.revisit == null) {
            outString += midString.substring(0, newStart);
            midString = midString.substring(newStart);
          }
        }
      }
    }
    if (!foundRule) {
      outString += midString[0];
      midString = midString.substring(1);
    }
    startOfString = false;
  }
  return outString;
}

export function runAllPhases(raw: readonly (readonly RawRule[])[], inString: string): string {
  let out = inString;
  for (const phase of phasesFor(raw)) out = runPhase(phase, out);
  return out;
}

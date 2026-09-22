import { runAllPhases } from './vendor/translit.ts';
import { Z2U_RULES } from './vendor/translit/z2u.ts';
import { U2Z_RULES } from './vendor/translit/u2z.ts';
import { ZNORM_RULES } from './vendor/translit/znorm.ts';

/** Zawgyi -> Unicode. */
export function zawgyiToUnicode(text: string): string {
  return runAllPhases(Z2U_RULES, text);
}

/** Unicode -> Zawgyi. Lossy in the usual direction-of-travel sense; prefer keeping Unicode. */
export function unicodeToZawgyi(text: string): string {
  return runAllPhases(U2Z_RULES, text);
}

/** Normalise Zawgyi's many equivalent spellings to one canonical form. */
export function normalizeZawgyi(text: string): string {
  return runAllPhases(ZNORM_RULES, text);
}

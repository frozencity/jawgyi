/**
 * The root package.json declares "type": "module", which would make Node treat the .js
 * files under dist/cjs as ESM too. Dropping a scoped package.json into that directory
 * overrides the type for that subtree. It is the standard dual-package trick, and cheaper
 * than renaming everything to .cjs.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cjs');
if (!existsSync(dist)) throw new Error(`Expected ${dist} to exist; run tsc first.`);
writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
console.log('dist/cjs marked as commonjs');

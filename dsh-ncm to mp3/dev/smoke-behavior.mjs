// Lead-owned behaviour smoke test for the registered `ncm2mp3` tool.
// Covers directory scanning, recursion, dryRun, skip/overwrite and error paths.
// Usage: node dev/smoke-behavior.mjs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { apply } from '../index.js';

const ROOT = path.join(import.meta.dirname, 'out', 'behavior');
const SRC_DIR = 'C:\\Users\\16192\\Music\\VipSongsDownload';
const SAMPLES = [
  'The_Mountain - Siren in the Streets.ncm',
  'MyGO!!!!! - エガクミライ.ncm',
];
const OUT_DIR = path.join(ROOT, 'converted');
const INPUT_DIR = path.join(ROOT, 'input');
const NESTED_DIR = path.join(INPUT_DIR, 'nested');

const registrations = [];
apply(
  { effect: (fn) => fn(), tools: { register: (def) => (registrations.push(def), () => {}) } },
  {},
);
const tool = registrations[0];
const exec = { signal: new AbortController().signal, callId: 'behavior', name: tool.name, arguments: {} };

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

await fsp.rm(ROOT, { recursive: true, force: true });
await fsp.mkdir(OUT_DIR, { recursive: true });
await fsp.mkdir(NESTED_DIR, { recursive: true });
for (const sample of SAMPLES) {
  await fsp.copyFile(path.join(SRC_DIR, sample), path.join(INPUT_DIR, sample));
  await fsp.copyFile(path.join(SRC_DIR, sample), path.join(NESTED_DIR, sample));
}
await fsp.writeFile(path.join(INPUT_DIR, 'readme.txt'), 'not an ncm file\n');
await fsp.writeFile(path.join(ROOT, 'fake.ncm'), 'this is not a real ncm file\n');

const oneFile = path.join(INPUT_DIR, SAMPLES[0]);

// A: dryRun on a single file — nothing is written.
const dry = await tool.execute({ input: oneFile, outputDir: OUT_DIR, dryRun: true }, exec);
check('A dryRun plans one file', dry.planned === 1 && dry.converted === 0, dry);
check('A dryRun writes nothing', !fs.existsSync(path.join(OUT_DIR, 'The_Mountain - Siren in the Streets.mp3')), null);

// B: directory, non-recursive → the two top-level .ncm files only.
const dirRun = await tool.execute({ input: INPUT_DIR, outputDir: OUT_DIR, exportCover: true }, exec);
check('B dir finds 2 .ncm files', dirRun.total === 2, dirRun);
check('B dir converts both', dirRun.converted === 2 && dirRun.failed === 0, dirRun);
check(
  'B mp3 output written',
  fs.statSync(path.join(OUT_DIR, 'The_Mountain - Siren in the Streets.mp3')).size === 3282326,
  null,
);
check(
  'B flac output written',
  fs.statSync(path.join(OUT_DIR, 'MyGO!!!!! - エガクミライ.mp3')).size === 9580937,
  null,
);
check(
  'B cover sidecar written',
  fs.existsSync(path.join(OUT_DIR, 'The_Mountain - Siren in the Streets.jpg')),
  null,
);

// C: re-run without overwrite → everything skipped.
const rerun = await tool.execute({ input: INPUT_DIR, outputDir: OUT_DIR }, exec);
check('C re-run skips existing outputs', rerun.skipped === 2 && rerun.converted === 0, rerun);
check('C re-run keeps ok true', rerun.ok === true, rerun);

// D: overwrite replaces them.
const overwrite = await tool.execute({ input: INPUT_DIR, outputDir: OUT_DIR, overwrite: true }, exec);
check('D overwrite converts again', overwrite.converted === 2 && overwrite.skipped === 0, overwrite);

// E: recursive scan finds the nested copies too.
const recursive = await tool.execute(
  { input: INPUT_DIR, outputDir: path.join(ROOT, 'recursive'), recursive: true },
  exec,
);
check('E recursive finds 4 .ncm files', recursive.total === 4, recursive);
check('E recursive converts 4 without name collisions', recursive.converted === 4 && recursive.failed === 0, recursive);
check(
  'E colliding outputs are de-duplicated',
  new Set(recursive.files.map((f) => f.output.toLowerCase())).size === 4,
  recursive.files.map((f) => f.output),
);
check(
  'E de-duplicated flac exists',
  fs.existsSync(path.join(ROOT, 'recursive', 'MyGO!!!!! - エガクミライ (2).mp3')),
  null,
);

// F: missing path surfaces as a call error.
let missingError = null;
try {
  await tool.execute({ input: path.join(ROOT, 'does-not-exist'), outputDir: OUT_DIR }, exec);
} catch (error) {
  missingError = error;
}
check('F missing input throws', missingError !== null, missingError && missingError.message);

// G: a bogus .ncm file is reported per-file instead of aborting the batch.
const bogus = await tool.execute({ input: path.join(ROOT, 'fake.ncm'), outputDir: OUT_DIR }, exec);
check(
  'G bogus ncm reported as failed',
  bogus.failed === 1 && bogus.files[0].error.includes('NCM_INVALID_HEADER'),
  bogus,
);

// H: input as a non-ncm, non-directory file.
let notNcmError = null;
try {
  await tool.execute({ input: path.join(INPUT_DIR, 'readme.txt'), outputDir: OUT_DIR }, exec);
} catch (error) {
  notNcmError = error;
}
check('H non-ncm input file is rejected', notNcmError !== null, notNcmError && notNcmError.message);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error('failed:', failed.map((r) => r.name).join('; '));
  process.exitCode = 1;
}

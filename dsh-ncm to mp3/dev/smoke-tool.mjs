// Lead-owned smoke test: exercise the registered tool without loading DSH.
// Usage: node dev/smoke-tool.mjs [inputPath] [outputDir]
import path from 'node:path';
import { apply } from '../index.js';

const input =
  process.argv[2] ||
  'C:\\Users\\16192\\Music\\VipSongsDownload\\MyGO!!!!! - エガクミライ.ncm';
const outputDir =
  process.argv[3] || path.join(import.meta.dirname, '..', 'test', 'out', 'smoke');

const registrations = [];
const fakeCtx = {
  effect(fn) {
    return fn();
  },
  tools: {
    register(definition) {
      registrations.push(definition);
      return () => {};
    },
  },
};

apply(fakeCtx, {});
if (registrations.length !== 1) {
  throw new Error(`expected exactly one tool registration, got ${registrations.length}`);
}
const tool = registrations[0];
console.log('tool name:', tool.name);
console.log('tool params required:', tool.parameters && tool.parameters.required);

const exec = {
  signal: new AbortController().signal,
  callId: 'smoke-call',
  name: tool.name,
  arguments: {},
};

const started = Date.now();
const result = await tool.execute({ input, outputDir, exportCover: true }, exec);
const elapsed = Date.now() - started;
console.log('elapsed(ms):', elapsed);
console.log('result:', JSON.stringify(result, null, 2));
if (typeof tool.output.render === 'function') {
  console.log('--- rendered ---');
  for (const block of tool.output.render({ input }, result)) {
    console.log(block.type === 'text' ? block.text : JSON.stringify(block));
  }
}

const fs = await import('node:fs');
const outFile = result.files && result.files[0] && result.files[0].output;
if (outFile && fs.existsSync(outFile)) {
  const size = fs.statSync(outFile).size;
  const head = fs.readFileSync(outFile).subarray(0, 12);
  console.log('output exists, size =', size, 'head =', head.toString('hex'));
}

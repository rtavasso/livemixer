import { build } from 'esbuild';
await build({ entryPoints: ['src/control/hand.worker.ts'], outfile: 'public/models/hand.worker.js', bundle: true, format: 'iife', platform: 'browser', target: 'es2022', sourcemap: false });
console.log('Classic camera worker bundled locally.');

// Runs devices/LiveMixer Living FX/living-fx.js against a small mock of Live's API (LiveAPI, Task, outlet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../devices/LiveMixer Living FX/living-fx.js', import.meta.url), 'utf8');

function liveSet(songs, cues) {
  const objects = new Map(); let next = 1;
  const make = (props) => { const id = next++; const o = { id, ...props }; objects.set(id, o); return o; };
  const param = (name, value) => make({ name, value });
  const mixer = (sendCount) => make({ sends: Array.from({ length: sendCount }, (_, i) => param(`Send ${i}`, 0)), volume: param('Track Volume', .85) });
  const track = (name, devices = []) => make({ name, devices, mixer_device: mixer(2) });
  const tracks = [];
  for (let s = 0; s < songs; s++) {
    tracks.push(track(`Song ${s}`), track('DRUM FX'), track('01 Kick'), track('02 Snare'), track('03 Other Drums'), track('04 Bass'),
      track('TEXTURE FX', [make({ class_name: 'AutoFilter2', parameters: [param('Control', .5)] })]), track('05 Guitar'),
      track('VOCALS', [make({ class_name: 'StereoGain', parameters: [param('Output', s === 0 ? .3 : 1)] })]), track('08 Lead Vocals'));
  }
  const song = make({ tracks, cue_points: cues.map(([time, name]) => make({ time, name })), current_song_time: 0, is_playing: 1, tempo: 120 });
  return { objects, song, byName: (name) => tracks.filter(t => t.name === name) };
}

function load(set) {
  const out = []; let task = null; let clock = 1000;
  const ref = (v) => Array.isArray(v) ? v.flatMap(o => ['id', o.id]) : typeof v === 'object' && v !== null ? ['id', v.id] : [v];
  class LiveAPI {
    constructor(_cb, path) { this.o = path === 'live_set' ? set.song : set.objects.get(Number(String(path).split(' ')[1])); this.id = String(this.o.id); }
    get(prop) { return ref(this.o[prop]); }
    set(prop, v) { this.o[prop] = v; }
  }
  class Task { constructor(fn) { this.fn = fn; task = this; } repeat() {} cancel() { task = null; } }
  const ctx = { LiveAPI, Task, outlet: (...a) => out.push(a), arrayfromargs: (a) => Array.prototype.slice.call(a), error: () => {}, post: () => {}, Date: { now: () => clock } };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, out, tick: (ms = 40) => { clock += ms; task?.fn(); }, advance: (ms) => { clock += ms; } };
}

test('drives every song group and mirrors the vocal gain', () => {
  const set = liveSet(3, []); const d = load(set);
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /Ready · 3 songs/);
  d.ctx.values(0, .5, 1, .5, 1);
  const filters = set.byName('TEXTURE FX').map(t => t.devices[0].parameters[0].value);
  assert.deepEqual(filters.map(v => +v.toFixed(3)), [.13, .13, .13]);
  for (const t of set.byName('TEXTURE FX')) { assert.ok(t.mixer_device.sends[0].value > 0); assert.ok(t.mixer_device.sends[1].value > 0); assert.ok(Math.abs(t.mixer_device.volume.value - (.85 + .1)) < 1e-9); }
  for (const t of set.byName('DRUM FX')) assert.ok(Math.abs(t.mixer_device.volume.value - (.85 - .1)) < 1e-9);
  for (const t of set.byName('02 Snare')) assert.ok(t.mixer_device.sends[0].value > 0);
  d.tick();
  assert.deepEqual(set.byName('VOCALS').map(t => t.devices[0].parameters[0].value), [.3, .3, .3]);
});

test('reports the song position for the simulation page', () => {
  const set = liveSet(2, []); const d = load(set);
  d.ctx.init(); set.song.current_song_time = 12.5; d.tick(120);
  assert.deepEqual(d.out.filter(a => a[0] === 2).at(-1), [2, '/livemixer/state', 0, 0, 0, 12.5, 1, 0, 0]);
});

test('FX QUIET holds home until the next non-SONG cue and eases back after', () => {
  const set = liveSet(2, [[64, 'FX QUIET'], [72, 'SONG: B · 120 BPM · 8A'], [128, 'FX ON']]); const d = load(set);
  d.ctx.init(); d.ctx.values(0, 0, 1, 0, .5);
  set.song.current_song_time = 100; for (let i = 0; i < 100; i++) { d.ctx.values(0, 0, 1, 0, .5); d.tick(); }
  const filter = () => set.byName('TEXTURE FX')[0].devices[0].parameters[0].value;
  assert.equal(filter(), .5, 'inside the zone (past the SONG: cue) the filter is home');
  set.song.current_song_time = 140; for (let i = 0; i < 100; i++) { d.ctx.values(0, 0, 1, 0, .5); d.tick(); }
  assert.ok(Math.abs(filter() - .13) < 1e-3, 'after FX ON the value returns');
});

test('eases home when the bridge goes silent and restores group volumes on reset', () => {
  const set = liveSet(2, []); const d = load(set);
  d.ctx.init(); d.ctx.values(0, 1, 1, 1, 0);
  d.advance(2000); for (let i = 0; i < 200; i++) d.tick();
  assert.equal(set.byName('TEXTURE FX')[0].devices[0].parameters[0].value, .5);
  d.ctx.values(0, 0, 0, 0, 1); d.ctx.reset();
  for (const t of [...set.byName('DRUM FX'), ...set.byName('TEXTURE FX')]) assert.equal(t.mixer_device.volume.value, .85);
});

test('refuses a set without TEXTURE FX groups', () => {
  const d = load({ objects: new Map(), song: { id: 1, tracks: [], cue_points: [] }, byName: () => [] });
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /Setup: No TEXTURE FX/);
});

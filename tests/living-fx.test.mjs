// Runs devices/LiveMixer Living FX/living-fx.js against a small mock of Live's API (LiveAPI, Task, outlet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../devices/LiveMixer Living FX/living-fx.js', import.meta.url), 'utf8');

function liveSet(songs, cues, { gestures = false } = {}) {
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
  // A --gestures set: RHYTHM / MELODIC groups with Muffle, Tilt and Level, and Main's Whoosh, Freeze and Span.
  const device = (class_name, name, params) => make({ class_name, name, parameters: params.map(([n, v]) => param(n, v)) });
  const half = (name) => track(name, [device('AutoFilter', 'Muffle', [['Frequency', 135]]), device('Eq8', 'Tilt', [['1 Gain A', 0], ['4 Gain A', 0]]),
    device('StereoGain', 'Level', [['Gain', 0]])]);
  if (gestures) tracks.unshift(half('RHYTHM'), half('MELODIC'));
  const master = make({ name: 'Main', devices: gestures ? [device('Reverb', 'Space - CC21', [['Dry/Wet', 0]]), device('AutoFilter', 'Whoosh', [['Frequency', 135], ['LFO Amount', 0], ['LFO Frequency', .6], ['LFO Waveform', 2], ['LFO Sync', 1], ['LFO Stereo Mode', 0], ['LFO Spin', .5]]),
    device('Spectral', 'Freeze', [['Frozen', 0], ['Dry Wet', 0], ['Fade In', .6]]), device('StereoGain', 'Span', [['Stereo Width', 1]])] : [] });
  const song = make({ tracks, cue_points: cues.map(([time, name]) => make({ time, name })), current_song_time: 0, is_playing: 1, tempo: 120 });
  const value = (track, dev, name) => tracks.find(t => t.name === track)?.devices.find(d => d.name === dev)?.parameters.find(q => q.name === name)?.value
    ?? master.devices.find(d => d.name === dev)?.parameters.find(q => q.name === name)?.value;
  return { objects, song, master, value, byName: (name) => tracks.filter(t => t.name === name) };
}

function load(set) {
  const out = []; let task = null; let clock = 1000; const calls = { set: 0, id: 0 };
  const ref = (v) => Array.isArray(v) ? v.flatMap(o => ['id', o.id]) : typeof v === 'object' && v !== null ? ['id', v.id] : [v];
  class LiveAPI {
    constructor(_cb, path) { this.o = path === 'live_set' ? set.song : path === 'live_set master_track' ? set.master : set.objects.get(Number(String(path).split(' ')[1])); }
    get id() { calls.id++; return String(this.o.id); }  // a call into Live in Max
    set id(v) { this.o = set.objects.get(Number(v)); }  // re-pointing a LiveAPI object (Living FX's cursor)
    get(prop) { if (prop === 'name' && this.o.mixer_device) calls.trackNames = (calls.trackNames ?? 0) + 1; return ref(this.o[prop]); }
    set(prop, v) { calls.set++; this.o[prop] = v; }
  }
  // repeat() is the device's update loop; schedule(ms) a one-off (setup retry), recorded so tests can run it.
  const scheduled = [];
  class Task { constructor(fn) { this.fn = fn; } repeat() { task = this; } schedule(ms) { scheduled.push({ ms, fn: this.fn }); } cancel() { if (task === this) task = null; } }
  const ctx = { LiveAPI, Task, outlet: (...a) => out.push(a), arrayfromargs: (a) => Array.prototype.slice.call(a), error: () => {}, post: () => {}, Date: { now: () => clock } };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  const tick = (ms = 40) => { clock += ms; task?.fn(); };
  // /fx/values only stores the newest values; the next tick applies them.
  return { ctx, out, calls, scheduled, tick, send: (...v) => { ctx.values(...v); tick(); }, advance: (ms) => { clock += ms; } };
}

test('drives every song group and mirrors the vocal gain', () => {
  const set = liveSet(3, []); const d = load(set);
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /Ready · 3 songs/);
  d.send(0, .5, 1, .5, 1);
  const filters = set.byName('TEXTURE FX').map(t => t.devices[0].parameters[0].value);
  assert.deepEqual(filters.map(v => +v.toFixed(3)), [.13, .13, .13]);
  for (const t of set.byName('TEXTURE FX')) { assert.ok(t.mixer_device.sends[0].value > 0); assert.ok(t.mixer_device.sends[1].value > 0); assert.ok(Math.abs(t.mixer_device.volume.value - (.85 + .1)) < 1e-9); }
  for (const t of set.byName('DRUM FX')) assert.ok(Math.abs(t.mixer_device.volume.value - (.85 - .1)) < 1e-9);
  for (const t of set.byName('02 Snare')) assert.ok(t.mixer_device.sends[0].value > 0);
  d.tick();
  assert.deepEqual(set.byName('VOCALS').map(t => t.devices[0].parameters[0].value), [.3, .3, .3]);
});

test('closes the Live 11 Auto Filter low-pass for dive', () => {
  const set = liveSet(2, []);
  for (const t of set.byName('TEXTURE FX')) {
    t.devices[0].class_name = 'AutoFilter';
    Object.assign(t.devices[0].parameters[0], { name: 'Frequency', value: 135, min: 20, max: 135 });
  }
  const d = load(set);
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /Ready · 2 songs/);
  const cutoffs = () => set.byName('TEXTURE FX').map(t => +t.devices[0].parameters[0].value.toFixed(3));
  assert.deepEqual(cutoffs(), [135, 135]);
  d.send(0, 0, 1, 0, .5);
  assert.deepEqual(cutoffs(), [71.75, 71.75]);
});

test('sends a merged Drums track to the dub echo, never the kick', () => {
  const set = liveSet(2, []);
  for (const t of set.byName('02 Snare')) t.name = '02 Drums';
  const d = load(set);
  d.ctx.init();
  d.send(0, 1, 0, 0, .5);
  for (const t of set.byName('02 Drums')) assert.equal(+t.mixer_device.sends[0].value.toFixed(4), +(1 + 20 * Math.log10(.8) / 40).toFixed(4));
  for (const t of set.byName('01 Kick')) assert.equal(t.mixer_device.sends[0].value, 0);
});

test('setup reads every track name once, however many groups it looks for (a 48-song set has ~380 tracks)', () => {
  const set = liveSet(4, [], { gestures: true }); const d = load(set);
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /Ready · 4 songs/);
  assert.equal(d.calls.trackNames, set.song.tracks.length);
});

test('an idle tick writes nothing and never reads parameter ids', () => {
  const set = liveSet(3, []); const d = load(set);
  d.ctx.init();
  d.send(0, .5, .5, .5, .7);
  d.tick();
  const before = { ...d.calls };
  for (let i = 0; i < 25; i++) d.tick();
  assert.deepEqual(d.calls, before);
});

test('mirrors the vocal gain in Live 11, where Utility calls it Gain', () => {
  const set = liveSet(3, []);
  for (const t of set.byName('VOCALS')) t.devices[0].parameters[0].name = 'Gain';
  const d = load(set);
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /vocals 3\/3/);
  set.byName('VOCALS')[0].devices[0].parameters[0].value = 0;  // hand out of the box: CC20 at 0
  d.tick();
  assert.deepEqual(set.byName('VOCALS').map(t => t.devices[0].parameters[0].value), [0, 0, 0]);
});

test('drives the gesture devices of a --gestures set, per half', () => {
  const set = liveSet(2, [], { gestures: true }); const d = load(set);
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /gestures 12\/12/);
  //                 flicker dub dive halo bal | muffleR muffleM tiltR tiltM levelR levelM freeze bloom span whoosh
  d.send(0, 0, 0, 0, .5,                 1, 0,      0,   1,    0,     1,     0,     0,    1,   0);
  assert.equal(set.value('RHYTHM', 'Muffle', 'Frequency'), 70);   // fist on the rhythm half: low-pass ~450 Hz
  assert.equal(set.value('MELODIC', 'Muffle', 'Frequency'), 135); // open
  assert.deepEqual([set.value('RHYTHM', 'Tilt', '1 Gain A'), set.value('RHYTHM', 'Tilt', '4 Gain A')], [3, 0]);  // palm down: a little weight
  assert.deepEqual([set.value('MELODIC', 'Tilt', '1 Gain A'), set.value('MELODIC', 'Tilt', '4 Gain A')], [0, 3]); // palm up: a little air
  // The palms are heard as space and time, not tone: palm down sinks the drums into the dub echo (send A),
  // palm up lifts the textures into the halo reverb (send B); the other sends stay dry.
  const send = (track, n) => set.byName(track)[0].mixer_device.sends[n].value;
  assert.equal(send('02 Snare', 0), d.ctx.sendlevel(.8)); assert.equal(send('02 Snare', 1), 0);
  assert.ok(send('TEXTURE FX', 1) >= d.ctx.sendlevel(.8), 'palm up lifts the textures (the wide span adds to it)'); assert.equal(send('TEXTURE FX', 0), 0);
  assert.equal(send('01 Kick', 0), 0, 'never the kick');
  assert.ok(Math.abs(set.value('RHYTHM', 'Level', 'Gain') - -10 / 35) < 1e-9);
  assert.ok(Math.abs(set.value('MELODIC', 'Level', 'Gain') - 6 / 35) < 1e-9);
  assert.ok(Math.abs(set.value(null, 'Span', 'Stereo Width') - Math.sqrt(1.8)) < 1e-9);  // 180 %
  assert.equal(set.value(null, 'Fade In', 'Fade In') ?? set.value(null, 'Freeze', 'Fade In'), .3);
  d.send(0, 0, 0, 0, .5);  // an old page without gesture values: home
  assert.equal(set.value('RHYTHM', 'Muffle', 'Frequency'), 135);
  assert.equal(set.value(null, 'Span', 'Stereo Width'), 1);
});

test('a turbulent scene is heard: swarm flutters and spins the mix through Whoosh', () => {
  const set = liveSet(1, [], { gestures: true }); const d = load(set);
  d.ctx.init();
  const whoosh = (name) => set.value(null, 'Whoosh', name);
  assert.deepEqual([whoosh('LFO Waveform'), whoosh('LFO Sync'), whoosh('LFO Stereo Mode'), whoosh('LFO Spin')], [0, 0, 1, .25]);  // sine, free, spinning
  assert.equal(whoosh('LFO Amount'), 0);
  const swarm = (x) => d.send(0, 0, 0, 0, .5, 0, 0, .5, .5, .5, .5, 0, 0, .5, 0, x);
  swarm(1);
  assert.equal(whoosh('LFO Amount'), 16); assert.equal(whoosh('Frequency'), 113);
  assert.ok(Math.abs(whoosh('LFO Frequency') - .95) < 1e-9);  // ~7.5 Hz
  swarm(.5); assert.equal(whoosh('LFO Amount'), 8);
  d.send(0, 0, 0, 0, .5, 0, 0, .5, .5, .5, .5, 0, 0, .5, 0);  // a page without swarm: calm
  assert.equal(whoosh('LFO Amount'), 0); assert.equal(whoosh('Frequency'), 135);
});

test('freeze holds the moment, then fades out and unfreezes', () => {
  const set = liveSet(1, [], { gestures: true }); const d = load(set);
  d.ctx.init();
  const freeze = (on) => d.send(0, 0, 0, 0, .5, 0, 0, .5, .5, .5, .5, on, 0, .5, 0);
  freeze(1); d.tick(); assert.equal(set.value(null, 'Freeze', 'Frozen'), 1);
  for (let i = 0; i < 10; i++) { freeze(1); d.tick(); }
  assert.ok(Math.abs(set.value(null, 'Freeze', 'Dry Wet') - .65) < 1e-9, 'fully in after ~0.3 s');
  freeze(0); d.tick(); assert.equal(set.value(null, 'Freeze', 'Frozen'), 1, 'still frozen while it fades');
  for (let i = 0; i < 50; i++) { freeze(0); d.tick(); }
  assert.equal(set.value(null, 'Freeze', 'Dry Wet'), 0); assert.equal(set.value(null, 'Freeze', 'Frozen'), 0);
});

test('FX QUIET holds the gestures at home', () => {
  const set = liveSet(1, [[0, 'FX QUIET'], [64, 'FX ON']], { gestures: true }); const d = load(set);
  d.ctx.init(); set.song.current_song_time = 8;  // inside the zone, past its 2-beat fade
  for (let i = 0; i < 100; i++) { d.send(0, 0, 0, 0, .5, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1); d.tick(); }
  assert.equal(set.value('RHYTHM', 'Muffle', 'Frequency'), 135);
  assert.equal(set.value(null, 'Freeze', 'Frozen'), 0);
});

test('reports the song position for the simulation page', () => {
  const set = liveSet(2, []); const d = load(set);
  d.ctx.init(); set.song.current_song_time = 12.5; d.tick(120);
  // amount = the first song's Vocal Presence gain as Live has it (.3 in this set); bound: set found
  assert.deepEqual(d.out.filter(a => a[0] === 2 && a[1] === '/livemixer/state').at(-1), [2, '/livemixer/state', 0, 0, 0, 12.5, 1, .3, 1]);
});

test('reports the output meters of Main, RHYTHM and MELODIC so the simulations can pulse with the audio', () => {
  const set = liveSet(2, [], { gestures: true }); const d = load(set);
  set.master.output_meter_level = .8; set.byName('RHYTHM')[0].output_meter_level = .6; set.byName('MELODIC')[0].output_meter_level = .4;
  d.ctx.init(); d.tick(120);
  assert.deepEqual(d.out.filter(a => a[0] === 2 && a[1] === '/livemixer/levels').at(-1), [2, '/livemixer/levels', .8, .6, .4]);
  const plain = liveSet(1, []); const p = load(plain); plain.master.output_meter_level = .5;
  p.ctx.init(); p.tick(120);
  assert.deepEqual(p.out.filter(a => a[0] === 2 && a[1] === '/livemixer/levels').at(-1), [2, '/livemixer/levels', .5, -1, -1], 'no gesture groups: Main only');
});

test('a wall clock stepping backwards never stalls the state reports', () => {
  const set = liveSet(1, []); const d = load(set);
  d.ctx.init(); d.tick(120);
  const states = () => d.out.filter(a => a[0] === 2 && a[1] === '/livemixer/state').length;
  const before = states();
  d.advance(-3600 * 1000);  // the clock jumps back an hour (time change, NTP after wake)
  for (let i = 0; i < 10; i++) d.tick(40);
  assert.ok(states() - before >= 3, 'still reporting about every 100 ms');
});

test('FX QUIET holds home until the next non-SONG cue and eases back after', () => {
  const set = liveSet(2, [[64, 'FX QUIET'], [72, 'SONG: B · 120 BPM · 8A'], [128, 'FX ON']]); const d = load(set);
  d.ctx.init(); d.send(0, 0, 1, 0, .5);
  set.song.current_song_time = 100; for (let i = 0; i < 100; i++) { d.send(0, 0, 1, 0, .5); d.tick(); }
  const filter = () => set.byName('TEXTURE FX')[0].devices[0].parameters[0].value;
  assert.equal(filter(), .5, 'inside the zone (past the SONG: cue) the filter is home');
  set.song.current_song_time = 140; for (let i = 0; i < 100; i++) { d.send(0, 0, 1, 0, .5); d.tick(); }
  assert.ok(Math.abs(filter() - .13) < 1e-3, 'after FX ON the value returns');
});

test('eases home when the bridge goes silent and restores group volumes on reset', () => {
  const set = liveSet(2, []); const d = load(set);
  d.ctx.init(); d.send(0, 1, 1, 1, 0);
  d.advance(2000); for (let i = 0; i < 200; i++) d.tick();
  assert.equal(set.byName('TEXTURE FX')[0].devices[0].parameters[0].value, .5);
  d.send(0, 0, 0, 0, 1); d.ctx.reset();
  for (const t of [...set.byName('DRUM FX'), ...set.byName('TEXTURE FX')]) assert.equal(t.mixer_device.volume.value, .85);
});

test('refuses a set without TEXTURE FX groups', () => {
  const d = load({ objects: new Map(), song: { id: 1, tracks: [], cue_points: [] }, byName: () => [] });
  d.ctx.init();
  assert.match(d.out.filter(a => a[0] === 0 && a[1] === 'set').at(-1)[2], /Setup: No TEXTURE FX.*retrying in 5 s/);
  assert.deepEqual(d.scheduled.map(s => s.ms), [5000], 'an unattended show retries setup instead of staying dead');
});

test('writes only the songs within earshot of the playhead, and catches the next one up as it arrives', () => {
  const cues = Array.from({ length: 6 }, (_, s) => [s * 100, `SONG: Song ${s} · 120 BPM · 8A`]);
  const set = liveSet(6, cues); const d = load(set);
  d.ctx.init();
  set.song.current_song_time = 310;  // in song 3
  d.tick();
  d.send(0, 0, 1, 0, .5);  // dive: every song's texture filter closes, but only where it can be heard
  d.tick();
  const filters = () => set.byName('TEXTURE FX').map(t => +t.devices[0].parameters[0].value.toFixed(3));
  assert.deepEqual(filters(), [.5, .5, .13, .13, .13, .5]);
  set.song.current_song_time = 410;  // song 4 plays: song 5 comes into earshot before it is heard
  d.tick();
  assert.deepEqual(filters(), [.5, .5, .13, .13, .13, .13]);
});

test('caps the per-song writes per tick on a 48-song set, and finishes them over the next ticks', () => {
  const set = liveSet(48, []); const d = load(set);
  d.ctx.init(); d.tick();
  const before = d.calls.set;
  d.send(0, 1, 1, 1, 1);  // every per-song send, filter and volume at once
  d.tick();
  assert.ok(d.calls.set - before <= 2 * 64, `${d.calls.set - before} writes in one tick`);
  for (let i = 0; i < 40; i++) d.tick();
  assert.deepEqual(new Set(set.byName('TEXTURE FX').map(t => +t.devices[0].parameters[0].value.toFixed(3))), new Set([.13]));
  for (const t of set.byName('DRUM FX')) assert.ok(Math.abs(t.mixer_device.volume.value - (.85 - .1)) < 1e-9);
});

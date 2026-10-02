// LiveMixer Living FX: the living installation's effects across every song of a generated stem set.
// Max JS is ES5: no let/const/arrow functions.
//
// OSC 7403 /fx/values flicker dub dive halo balance (all 0..1, flicker ignored: no one-shots).
//   dub     -> TEXTURE FX send A (.8), 02 Snare send A, 03 Other Drums send A (.6); in a merged set
//              (ableton-stem-set.py --merge) 02 Drums send A (.8): Snare + Other Drums, never the kick
//   dive    -> TEXTURE FX Auto Filter 'Control' (.5 - .37 dive); in Live 11 (no DJ filter) the low-pass
//              'Frequency' closes from fully open to 45% of its range
//   halo    -> TEXTURE FX send B
//   balance -> DRUM FX down / TEXTURE FX up (or the reverse) by up to 4 dB around each group's home volume
// Every song's group is driven together; only the song that is playing is heard.
// The first VOCALS group's Vocal Presence gain (MIDI CC20) is mirrored to every other VOCALS group.
// Cue points named "FX QUIET" hold everything at home until the next cue point that is not a "SONG:" locator.
// Without /fx/values for 1.5 s, values ease home. Live's position is reported to the bridge (UDP 7401)
// so the simulation page can follow the beat.
autowatch=0;inlets=1;outlets=3;
var song=null,refs=null,mix=null,mirror=[],zones=[],task=null,label='',last={},applied='';
// Live's output meters (Main, RHYTHM, MELODIC) for the simulations: /livemixer/levels on UDP 7401 with each state.
var meters=null;
var manual=[0,0,0,0],balance=.5,quiet=0,oscOwned=0,lastValues=0,lastTick=0,lastState=0;
// Hand gestures (/fx/values 5..14, docs/superpowers/specs/2026-10-02-hand-gesture-audio-design.md): muffle R/M,
// tilt R/M, level R/M, freeze, bloom, span, whoosh. They need a set built with --gestures (RHYTHM / MELODIC groups).
var GHOME=[0,0,.5,.5,.5,.5,0,0,.5,0,0],gest=GHOME.slice(),gref=null,frozen=0,freezeMix=0;

function ids(v){var r=[];for(var i=0;i<v.length;i++)if(v[i]==='id'&&Number(v[i+1])>0)r.push(Number(v[++i]));return r;}
function api(id){return new LiveAPI(null,'id '+id);}
// A parameter with its id kept: reading LiveAPI's id calls into Live, too slow to do per write.
function ref(id){return {a:api(id),id:Number(id)};}
function scalar(o,p){return o.get(p)[0];}
// Setup cost matters: a 48-song set has ~380 tracks and ~200 devices, and every LiveAPI object or call runs on Live's
// main thread. Names and classes are read through one reusable cursor (re-pointed by id, not a new object per
// lookup); only objects that are kept get their own LiveAPI. A naive scan took minutes and starved the tick.
var cur=null;
function cursor(id){if(!cur)cur=new LiveAPI(null,'id '+id);else cur.id=Number(id);return cur;}
function nameof(id){return String(scalar(cursor(id),'name'));}
// Tracks by name from one pass over the set (ids; LiveAPI objects made only for tracks that are looked up).
var tindex=null;
function scantracks(){var all=ids(song.get('tracks')),r={};for(var i=0;i<all.length;i++){var n=nameof(all[i]);(r[n]=r[n]||[]).push(all[i]);}tindex=r;}
function tracks(name){if(!tindex)scantracks();var r=[],l=tindex[name]||[];for(var i=0;i<l.length;i++)r.push(api(l[i]));return r;}
function device(t,cls){var ds=ids(t.get('devices'));for(var i=0;i<ds.length;i++)if(String(scalar(cursor(ds[i]),'class_name'))===cls)return api(ds[i]);return null;}
// Every copy of a device lists its parameters in the same order: remember where a name was found and check only
// that slot on the next copy (one call instead of a scan).
var pslot={};
function param(d,name){if(!d)return null;var ps=ids(d.get('parameters')),k=pslot[name];
  if(k!==undefined&&k<ps.length&&nameof(ps[k])===name)return ref(ps[k]);
  for(var i=0;i<ps.length;i++)if(nameof(ps[i])===name){pslot[name]=i;return ref(ps[i]);}return null;}
function meter(t){if(!t)return -1;var v=Number(scalar(t,'output_meter_level'));return v===v?Math.max(0,Math.min(1,v)):-1;}
function named(t,name){if(!t)return null;var ds=ids(t.get('devices'));for(var i=0;i<ds.length;i++)if(nameof(ds[i])===name)return api(ds[i]);return null;}
function mixer(t){return api(ids(t.get('mixer_device'))[0]);}
function sends(t){return ids(mixer(t).get('sends'));}
function volume(t){return ref(ids(mixer(t).get('volume'))[0]);}
function put(p,v){if(!p)return;if(p instanceof Array){for(var i=0;i<p.length;i++)put(p[i],v);return;}if(last[p.id]!==undefined&&Math.abs(last[p.id]-v)<.001)return;p.a.set('value',v);last[p.id]=v;}
function status(s){if(s!==label){label=s;outlet(0,'set',s);}}
function sendlevel(u){if(u<=.0001)return 0;var db=20*Math.log(u)/Math.LN10;return Math.max(0,db>=-20?1+db/40:.5+(db+20)/60);}

// `e` adds each half's palm sends: mA / rA dub echo (palm down), mB / rB halo reverb (palm up); m = TEXTURE FX, r = drums.
function apply(v,e){if(!refs)return;e=e||{mA:0,mB:0,rA:0,rB:0};var u=function(x){return sendlevel(Math.min(1,x));};
  put(refs.echo,u(.8*v[1]+e.mA));put(refs.snare,u(v[1]+e.rA));put(refs.other,u(.6*v[1]+.8*e.rA));put(refs.drums,u(.8*v[1]+e.rA));
  put(refs.filter,.5-.37*v[2]);for(var i=0;i<refs.cutoff.length;i++){var c=refs.cutoff[i];put(c.p,c.hi-(c.hi-c.lo)*.55*v[2]);}
  put(refs.bloom,u(v[3]+e.mB));put(refs.drumhalo,u(e.rB));}
function setbalance(b){if(!mix)return;var db=8*(b-.5);for(var i=0;i<mix.length;i++)put(mix[i].p,Math.max(0,Math.min(1,mix[i].home+mix[i].sign*db/40)));}
// Live 11 scales, read from Live with str_for_value: Auto Filter Frequency 20..135 (135 = 19.9 kHz open, 70 ≈ 450 Hz),
// Utility Gain −1..1 at ~35 dB per unit, Utility Stereo Width v with percent = 100·v².
function leveldb(l){return l<.5?-20*(.5-l):12*(l-.5);}  // .5 → 0 dB, 0 → −10 dB, 1 → +6 dB
function utilgain(db){return Math.max(-1,Math.min(1,db/35));}
function widthvalue(pct){return Math.sqrt(Math.max(0,pct)/100);}
function gestureat(k){var g=[];for(var i=0;i<GHOME.length;i++)g.push(GHOME[i]+(gest[i]-GHOME[i])*k);return g;}
// Three kinds of sound so the gestures never blur: a fist is tone (Muffle closes the half's low-pass), palm up is
// space (the half lifts into the halo reverb, see palmsends), palm down is time (it sinks into the dub echo). The
// tilt shelves only colour that: +3 dB air up, +3 dB weight down, nothing cut. Level is each half's gain; whoosh
// sweeps Main's filter; span sets Main's width (40% together … 180% apart).
function palm(g,h){var d=g[2+h]-.5;return {up:Math.max(0,d)*2,down:Math.max(0,-d)*2};}
function palmsends(k){if(!gref)return {mA:0,mB:0,rA:0,rB:0};var g=gestureat(k),r=palm(g,0),m=palm(g,1);
  return {mA:.8*m.down,mB:.8*m.up,rA:.8*r.down,rB:.6*r.up};}
function applygestures(k){if(!gref)return;var g=gestureat(k);
  for(var h=0;h<2;h++){put(gref.muffle[h],135-65*g[h]);var p=palm(g,h);put(gref.hi[h],3*p.up);put(gref.lo[h],3*p.down);put(gref.level[h],utilgain(leveldb(g[4+h])));}
  // Swarm (the scene's turbulence): Whoosh's LFO flutters the whole mix and spins it across the stereo field, faster and
  // deeper the busier the flock: rate 3 → 7.5 Hz (LFO Frequency doubles every 0.1), depth 0 → ±16 cutoff steps, the
  // cutoff lowered to ~5.5 kHz so the flutter sweeps both ways.
  var w=g[10];put(gref.whoosh,135-75*g[9]-22*w);put(gref.lfoAmount,16*w);put(gref.lfoRate,.82+.13*w);var s=g[8];put(gref.span,widthvalue(s<.5?100-120*(.5-s):100+160*(s-.5)));}
// Freeze: Frozen on, then Dry Wet up over 0.3 s; on release Dry Wet down over 1.5 s, then unfrozen.
function freezestep(dt){if(!gref||!gref.frozen)return;var want=gest[6]*(1-quiet)>=.5;
  if(want&&!frozen){put(gref.frozen,1);frozen=1;}
  freezeMix=want?Math.min(.65,freezeMix+dt/.3*.65):Math.max(0,freezeMix-dt/1.5*.65);put(gref.mix,freezeMix);
  if(!want&&frozen&&freezeMix<=0){put(gref.frozen,0);frozen=0;}}
function gesturesathome(){for(var i=0;i<GHOME.length;i++)if(gest[i]!==GHOME[i])return false;return true;}
// Back to each group's home volume, unless the operator has moved that fader since our last write.
function restorehome(){if(!mix)return;for(var i=0;i<mix.length;i++){var m=mix[i],id=m.p.id;if(last[id]!==undefined&&Math.abs(Number(scalar(m.p.a,'value'))-last[id])>=.001)continue;m.p.a.set('value',m.home);last[id]=m.home;}}
// Writes only when the controls, the balance or an FX QUIET fade have moved since the last write.
function steady(){var sig=manual.join()+'|'+balance+'|'+quiet+'|'+gest.join();if(sig===applied)return;applied=sig;var k=1-quiet,v=[];for(var i=0;i<4;i++)v.push(manual[i]*k);
  // The release bloom and a wide span swell the halo reverb (Main's Space reverb belongs to CC21).
  v[3]=Math.min(1,v[3]+(.6*gest[7]+.6*Math.max(0,gest[8]-.5))*k);apply(v,palmsends(k));setbalance(.5+(balance-.5)*k);applygestures(k);}
function athome(){return balance===.5&&!manual[1]&&!manual[2]&&!manual[3]&&gesturesathome();}
function quietzone(t){var q=0;for(var i=0;i<zones.length;i++){var z=zones[i];if(t>=z[0]&&t<z[1])q=Math.max(q,Math.min(1,(t-z[0])/2));else if(t>=z[1]&&t<z[1]+2)q=Math.max(q,1-(t-z[1])/2);}return q;}

var retry=null,t0=0;
// Setup timing to UDP 7401 (/livemixer/log stage ms) so a slow setup in a large set can be seen from outside Live.
function lap(stage){outlet(2,'/livemixer/log',stage,clock()-t0);}
// A clock that only moves forward: the wall clock's step since the last reading, but a step backwards (a manual time
// change, an NTP correction after waking) or a jump over 5 s counts as one 40 ms tick, so the state reports and the
// OSC-silence easing never stall for the size of the step.
var monoMs=0,lastWall=0;
function clock(){var n=Date.now(),d=lastWall?n-lastWall:0;lastWall=n;monoMs+=d<0||d>5000?40:d;return monoMs;}
function init(){t0=clock();try{
  if(retry){retry.cancel();retry=null;}
  if(task)task.cancel();try{restorehome();}catch(e){}
  song=new LiveAPI(null,'live_set');tindex=null;mix=null;refs={filter:[],cutoff:[],echo:[],bloom:[],snare:[],other:[],drums:[],drumhalo:[]};
  var texture=tracks('TEXTURE FX'),drums=tracks('DRUM FX'),vocals=tracks('VOCALS'),sn=tracks('02 Snare'),od=tracks('03 Other Drums'),dr=tracks('02 Drums'),i;
  if(!texture.length)throw new Error('No TEXTURE FX groups: build the set with scripts/ableton-stem-set.py');
  lap('tracks');
  for(i=0;i<texture.length;i++){var f=param(device(texture[i],'AutoFilter2'),'Control');if(f)refs.filter.push(f);else{f=param(device(texture[i],'AutoFilter'),'Frequency');if(f)refs.cutoff.push({p:f,lo:Number(scalar(f.a,'min')),hi:Number(scalar(f.a,'max'))});}var ts=sends(texture[i]);if(ts.length>1){refs.echo.push(ref(ts[0]));refs.bloom.push(ref(ts[1]));}}
  lap('textures');
  for(i=0;i<sn.length;i++){var s1=sends(sn[i]);if(s1.length)refs.snare.push(ref(s1[0]));}
  for(i=0;i<od.length;i++){var s2=sends(od[i]);if(s2.length)refs.other.push(ref(s2[0]));}
  for(i=0;i<dr.length;i++){var s3=sends(dr[i]);if(s3.length)refs.drums.push(ref(s3[0]));}
  // Palm up lifts the drums into the halo reverb: send B of every drum track (never the kick).
  var dh=sn.concat(od,dr);for(i=0;i<dh.length;i++){var s4=sends(dh[i]);if(s4.length>1)refs.drumhalo.push(ref(s4[1]));}
  lap('drum sends');
  mix=[];for(i=0;i<drums.length;i++){var dv=volume(drums[i]);mix.push({p:dv,home:Number(scalar(dv.a,'value')),sign:-1});}
  for(i=0;i<texture.length;i++){var tv=volume(texture[i]);mix.push({p:tv,home:Number(scalar(tv.a,'value')),sign:1});}
  // Utility's gain is 'Output' in Live 12 and 'Gain' in Live 11: find which on the first song, then go straight to it.
  lap('volumes');
  var gainname=null;mirror=[];for(i=0;i<vocals.length;i++){var u=device(vocals[i],'StereoGain'),g=gainname?param(u,gainname):null;if(!g){g=param(u,'Output');gainname=g?'Output':null;}if(!g){g=param(u,'Gain');gainname=g?'Gain':null;}if(g)mirror.push(g);}
  lap('vocals');
  var cs=ids(song.get('cue_points')),cues=[];zones=[];
  for(i=0;i<cs.length;i++){var c=cursor(cs[i]);cues.push({t:Number(scalar(c,'time')),name:String(scalar(c,'name'))});}
  cues.sort(function(a,b){return a.t-b.t;});
  for(i=0;i<cues.length;i++)if(cues[i].name.indexOf('FX QUIET')===0){var end=Infinity;for(var j=i+1;j<cues.length;j++)if(cues[j].t>cues[i].t&&cues[j].name.indexOf('SONG:')!==0){end=cues[j].t;break;}zones.push([cues[i].t,end]);}
  // Gesture devices: on the RHYTHM / MELODIC groups by class, on Main by name (it has two Utilities and two Auto Filters).
  lap('cues');
  var halves=[tracks('RHYTHM')[0],tracks('MELODIC')[0]];gref=null;
  meters={main:new LiveAPI(null,'live_set master_track'),rhythm:halves[0]||null,melodic:halves[1]||null};
  if(halves[0]&&halves[1]){
    var main=new LiveAPI(null,'live_set master_track'),fz=named(main,'Freeze');
    gref={muffle:[],lo:[],hi:[],level:[],frozen:param(fz,'Frozen'),mix:param(fz,'Dry Wet'),whoosh:param(named(main,'Whoosh'),'Frequency'),lfoAmount:param(named(main,'Whoosh'),'LFO Amount'),lfoRate:param(named(main,'Whoosh'),'LFO Frequency'),span:param(named(main,'Span'),'Stereo Width')};
    for(i=0;i<2;i++){var eq=device(halves[i],'Eq8');gref.muffle.push(param(device(halves[i],'AutoFilter'),'Frequency'));gref.lo.push(param(eq,'1 Gain A'));gref.hi.push(param(eq,'4 Gain A'));gref.level.push(param(device(halves[i],'StereoGain'),'Gain'));}
    var fadein=param(fz,'Fade In');if(fadein)fadein.a.set('value',.3);  // ~230 ms: the freeze answers the fist promptly
    // The swarm's LFO: a smooth sine, free-running, spinning 25% across the stereo field (Spin mode).
    var wh=named(main,'Whoosh'),lfo=[['LFO Waveform',0],['LFO Sync',0],['LFO Stereo Mode',1],['LFO Spin',.25]];
    for(i=0;i<lfo.length;i++){var lp=param(wh,lfo[i][0]);if(lp)lp.a.set('value',lfo[i][1]);}
  }
  last={};applied='';quiet=0;balance=.5;manual=[0,0,0,0];gest=GHOME.slice();frozen=0;freezeMix=0;apply(manual);setbalance(.5);applygestures(1);
  if(gref){put(gref.mix,0);put(gref.frozen,0);}lastTick=0;
  // The parameter report (dumpparams) is slow LiveAPI work: only on /fx/command dumpparams, never at setup.
  task=new Task(tick,this);task.interval=40;task.repeat();
  var found=gref?[gref.muffle[0],gref.muffle[1],gref.lo[0],gref.hi[1],gref.level[0],gref.level[1],gref.frozen,gref.mix,gref.whoosh,gref.span,gref.lfoAmount,gref.lfoRate].filter(function(p){return p;}).length:0;
  lap('gestures');
  status('Ready · '+texture.length+' songs · vocals '+mirror.length+'/'+vocals.length+(gref?' · gestures '+found+'/12':'')+(zones.length?' · '+zones.length+' FX QUIET':''));
  lap('ready');
}catch(e){refs=null;mix=null;status('Setup: '+e.message+' · retrying in 5 s');error(e+'\n');
  // Unattended: a set that is still loading (or a transient API error) gets another try instead of staying dead.
  if(retry)retry.cancel();retry=new Task(init,this);retry.schedule(5000);}}

// Diagnostics: each gesture device's class and parameters (name, min, max, value) to the bridge port on
// /fx/command dumpparams,
// so the parameter names this Live version uses can be read without any other tooling.
function dumpdevices(t,label){if(!t)return;var ds=ids(t.get('devices'));for(var i=0;i<ds.length;i++){var d=api(ds[i]),ps=ids(d.get('parameters')),out=['/livemixer/params',label,String(scalar(d,'class_name')),String(scalar(d,'name'))];for(var j=0;j<ps.length;j++){var p=api(ps[j]);out.push(String(scalar(p,'name')),Number(scalar(p,'min')),Number(scalar(p,'max')),Number(scalar(p,'value')));}outlet(2,out);}}
// The displayed value at 11 points across a parameter's range, for parameters whose units are not obvious.
var SCALES=['Gain','Frequency','1 Frequency A','4 Frequency A','Stereo Width','Dry Wet','Dry/Wet','Fade In','Fade Out','LFO Amount','LFO Frequency','LFO Spin','LFO Waveform','LFO Stereo Mode'];
function dumpscales(t,label){if(!t)return;var ds=ids(t.get('devices'));for(var i=0;i<ds.length;i++){var d=api(ds[i]),ps=ids(d.get('parameters'));for(var j=0;j<ps.length;j++){var p=api(ps[j]),n=String(scalar(p,'name'));if(SCALES.indexOf(n)<0)continue;var lo=Number(scalar(p,'min')),hi=Number(scalar(p,'max')),out=['/livemixer/scale',label,String(scalar(d,'name')),n];for(var k=0;k<=10;k++){var v=lo+(hi-lo)*k/10;out.push(v,String(p.call('str_for_value',v)));}outlet(2,out);}}}
function dumpparams(){try{var r=tracks('RHYTHM'),m=tracks('MELODIC'),main=new LiveAPI(null,'live_set master_track');dumpdevices(r[0],'RHYTHM');dumpdevices(m[0],'MELODIC');dumpdevices(main,'Main');dumpscales(r[0],'RHYTHM');dumpscales(main,'Main');}catch(e){error('dumpparams: '+e+'\n');}}

function values(){var v=arrayfromargs(arguments);oscOwned=1;lastValues=clock();for(var i=1;i<4;i++)manual[i]=Math.max(0,Math.min(1,Number(v[i])||0));var b=Number(v[4]);balance=v.length>4&&b===b?Math.max(0,Math.min(1,b)):.5;
  for(var j=0;j<GHOME.length;j++){var x=Number(v[5+j]);gest[j]=v.length>5+j&&x===x?Math.max(0,Math.min(1,x)):GHOME[j];}steady();if(!quiet)status('Living · following the box');}
function control(index,value){oscOwned=0;var k=Number(index);if(k>0&&k<4)manual[k]=Math.max(0,Math.min(1,Number(value)));steady();status('Manual · combine gently');}
function auto(v){outlet(1,'auto',0);}
function reset(){oscOwned=0;manual=[0,0,0,0];balance=.5;gest=GHOME.slice();for(var i=0;i<4;i++)outlet(1,'dial'+i,0);apply(manual);applygestures(1);restorehome();applied='';status('Dry · tails fade naturally');}

function tick(){try{
  var now=clock(),dt=lastTick?Math.min(.5,Math.max(0,(now-lastTick)/1000)):0;lastTick=now;
  if(!song)return;
  var t=Number(scalar(song,'current_song_time')),playing=Number(scalar(song,'is_playing'))?1:0;
  // The last value is "bound": 1 once setup found the set, so the controls page can show "Live connected".
  // The first song's Vocal Presence gain (CC20's target) is read once per tick: mirrored to every other song, and
  // reported in the state's "amount" slot (raw Utility gain, -1 when there is none) so the page can show what Live has.
  var g=mirror.length?Number(scalar(mirror[0].a,'value')):-1;
  if(now-lastState>=100){lastState=now;outlet(2,'/livemixer/state',0,0,0,t,playing,g,refs?1:0);
    // Three meter reads per report (never one per song), so the simulations can pulse with the audio itself.
    if(meters)outlet(2,'/livemixer/levels',meter(meters.main),meter(meters.rhythm),meter(meters.melodic));}
  for(var i=1;i<mirror.length;i++)put(mirror[i],g);
  if(!refs)return;
  if(oscOwned&&now-lastValues>1500&&!athome()){var e=Math.exp(-dt/.8);for(var k=1;k<4;k++){manual[k]*=e;if(manual[k]<.002)manual[k]=0;}balance=.5+(balance-.5)*e;if(Math.abs(balance-.5)<.002)balance=.5;
    for(var n=0;n<GHOME.length;n++){gest[n]=GHOME[n]+(gest[n]-GHOME[n])*e;if(Math.abs(gest[n]-GHOME[n])<.002)gest[n]=GHOME[n];}status(athome()?'OSC silent · home':'OSC silent · easing home');}
  var target=zones.length?quietzone(t):0;
  if(target!==quiet){var tempo=Number(scalar(song,'tempo'));if(!(tempo>0))tempo=120;var q=dt*tempo/120;quiet=target>quiet?Math.min(target,quiet+q):Math.max(target,quiet-q);}
  steady();freezestep(dt);
  if(quiet>0)status('FX QUIET · the song leads');else if(label==='FX QUIET · the song leads')status('Living · following the box');
}catch(e){status('Setup: '+e.message);}}

function notifydeleted(){if(task)task.cancel();try{apply([0,0,0,0]);}catch(e){}try{gest=GHOME.slice();applygestures(1);if(gref){put(gref.mix,0);put(gref.frozen,0);}}catch(e){}try{restorehome();}catch(e){}}
// Read-only status for local verification.
function snapshot(){try{var v={playing:Number(scalar(song,'is_playing')),beat:Number(scalar(song,'current_song_time')),tempo:Number(scalar(song,'tempo')),status:label,ready:!!refs,balance:balance,quiet:quiet,zones:zones,songs:refs?refs.filter.length:0,mirrors:mirror.length};var f=new File('/tmp/livemixer-living-fx-state.json','write','TEXT');f.eof=0;f.writestring(JSON.stringify(v));f.close();}catch(e){error(e+'\n');}}

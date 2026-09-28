// LiveMixer Living FX: the living installation's effects across every song of a generated stem set.
// Max JS is ES5: no let/const/arrow functions.
//
// OSC 7403 /fx/values flicker dub dive halo balance (all 0..1, flicker ignored: no one-shots).
//   dub     -> TEXTURE FX send A (.8), 02 Snare send A, 03 Other Drums send A (.6)
//   dive    -> TEXTURE FX Auto Filter 'Control' (.5 - .37 dive)
//   halo    -> TEXTURE FX send B
//   balance -> DRUM FX down / TEXTURE FX up (or the reverse) by up to 4 dB around each group's home volume
// Every song's group is driven together; only the song that is playing is heard.
// The first VOCALS group's Vocal Presence gain (MIDI CC20) is mirrored to every other VOCALS group.
// Cue points named "FX QUIET" hold everything at home until the next cue point that is not a "SONG:" locator.
// Without /fx/values for 1.5 s, values ease home. Live's position is reported to the bridge (UDP 7401)
// so the simulation page can follow the beat.
autowatch=0;inlets=1;outlets=3;
var song=null,refs=null,mix=null,mirror=[],zones=[],task=null,label='',last={};
var manual=[0,0,0,0],balance=.5,quiet=0,oscOwned=0,lastValues=0,lastTick=0,lastState=0;

function ids(v){var r=[];for(var i=0;i<v.length;i++)if(v[i]==='id'&&Number(v[i+1])>0)r.push(Number(v[++i]));return r;}
function api(id){return new LiveAPI(null,'id '+id);}
function scalar(o,p){return o.get(p)[0];}
function tracks(name){var all=ids(song.get('tracks')),r=[];for(var i=0;i<all.length;i++){var t=api(all[i]);if(String(scalar(t,'name'))===name)r.push(t);}return r;}
function device(t,cls){var ds=ids(t.get('devices'));for(var i=0;i<ds.length;i++){var d=api(ds[i]);if(String(scalar(d,'class_name'))===cls)return d;}return null;}
function param(d,name){if(!d)return null;var ps=ids(d.get('parameters'));for(var i=0;i<ps.length;i++){var p=api(ps[i]);if(String(scalar(p,'name'))===name)return p;}return null;}
function mixer(t){return api(ids(t.get('mixer_device'))[0]);}
function sends(t){return ids(mixer(t).get('sends'));}
function volume(t){return api(ids(mixer(t).get('volume'))[0]);}
function put(p,v){if(!p)return;if(p instanceof Array){for(var i=0;i<p.length;i++)put(p[i],v);return;}var id=Number(p.id);if(last[id]!==undefined&&Math.abs(last[id]-v)<.001)return;p.set('value',v);last[id]=v;}
function status(s){if(s!==label){label=s;outlet(0,'set',s);}}
function sendlevel(u){if(u<=.0001)return 0;var db=20*Math.log(u)/Math.LN10;return Math.max(0,db>=-20?1+db/40:.5+(db+20)/60);}

function apply(v){if(!refs)return;put(refs.echo,sendlevel(.8*v[1]));put(refs.snare,sendlevel(v[1]));put(refs.other,sendlevel(.6*v[1]));put(refs.filter,.5-.37*v[2]);put(refs.bloom,sendlevel(v[3]));}
function setbalance(b){if(!mix)return;var db=8*(b-.5);for(var i=0;i<mix.length;i++)put(mix[i].p,Math.max(0,Math.min(1,mix[i].home+mix[i].sign*db/40)));}
// Back to each group's home volume, unless the operator has moved that fader since our last write.
function restorehome(){if(!mix)return;for(var i=0;i<mix.length;i++){var m=mix[i],id=Number(m.p.id);if(last[id]!==undefined&&Math.abs(Number(scalar(m.p,'value'))-last[id])>=.001)continue;m.p.set('value',m.home);last[id]=m.home;}}
function steady(){var k=1-quiet,v=[];for(var i=0;i<4;i++)v.push(manual[i]*k);apply(v);setbalance(.5+(balance-.5)*k);}
function athome(){return balance===.5&&!manual[1]&&!manual[2]&&!manual[3];}
function quietzone(t){var q=0;for(var i=0;i<zones.length;i++){var z=zones[i];if(t>=z[0]&&t<z[1])q=Math.max(q,Math.min(1,(t-z[0])/2));else if(t>=z[1]&&t<z[1]+2)q=Math.max(q,1-(t-z[1])/2);}return q;}

function init(){try{
  if(task)task.cancel();try{restorehome();}catch(e){}
  song=new LiveAPI(null,'live_set');mix=null;refs={filter:[],echo:[],bloom:[],snare:[],other:[]};
  var texture=tracks('TEXTURE FX'),drums=tracks('DRUM FX'),vocals=tracks('VOCALS'),sn=tracks('02 Snare'),od=tracks('03 Other Drums'),i;
  if(!texture.length)throw new Error('No TEXTURE FX groups: build the set with scripts/ableton-stem-set.py');
  for(i=0;i<texture.length;i++){var f=param(device(texture[i],'AutoFilter2'),'Control');if(f)refs.filter.push(f);var ts=sends(texture[i]);if(ts.length>1){refs.echo.push(api(ts[0]));refs.bloom.push(api(ts[1]));}}
  for(i=0;i<sn.length;i++){var s1=sends(sn[i]);if(s1.length)refs.snare.push(api(s1[0]));}
  for(i=0;i<od.length;i++){var s2=sends(od[i]);if(s2.length)refs.other.push(api(s2[0]));}
  mix=[];for(i=0;i<drums.length;i++){var dv=volume(drums[i]);mix.push({p:dv,home:Number(scalar(dv,'value')),sign:-1});}
  for(i=0;i<texture.length;i++){var tv=volume(texture[i]);mix.push({p:tv,home:Number(scalar(tv,'value')),sign:1});}
  mirror=[];for(i=0;i<vocals.length;i++){var g=param(device(vocals[i],'StereoGain'),'Output');if(g)mirror.push(g);}
  var cs=ids(song.get('cue_points')),cues=[];zones=[];
  for(i=0;i<cs.length;i++){var c=api(cs[i]);cues.push({t:Number(scalar(c,'time')),name:String(scalar(c,'name'))});}
  cues.sort(function(a,b){return a.t-b.t;});
  for(i=0;i<cues.length;i++)if(cues[i].name.indexOf('FX QUIET')===0){var end=Infinity;for(var j=i+1;j<cues.length;j++)if(cues[j].t>cues[i].t&&cues[j].name.indexOf('SONG:')!==0){end=cues[j].t;break;}zones.push([cues[i].t,end]);}
  last={};quiet=0;balance=.5;manual=[0,0,0,0];apply(manual);setbalance(.5);lastTick=0;
  task=new Task(tick,this);task.interval=40;task.repeat();
  status('Ready · '+texture.length+' songs'+(zones.length?' · '+zones.length+' FX QUIET':''));
}catch(e){refs=null;mix=null;status('Setup: '+e.message);error(e+'\n');}}

function values(){var v=arrayfromargs(arguments);oscOwned=1;lastValues=Date.now();for(var i=1;i<4;i++)manual[i]=Math.max(0,Math.min(1,Number(v[i])||0));var b=Number(v[4]);balance=v.length>4&&b===b?Math.max(0,Math.min(1,b)):.5;steady();if(!quiet)status('Living · following the box');}
function control(index,value){oscOwned=0;var k=Number(index);if(k>0&&k<4)manual[k]=Math.max(0,Math.min(1,Number(value)));steady();status('Manual · combine gently');}
function auto(v){outlet(1,'auto',0);}
function reset(){oscOwned=0;manual=[0,0,0,0];balance=.5;for(var i=0;i<4;i++)outlet(1,'dial'+i,0);apply(manual);restorehome();status('Dry · tails fade naturally');}

function tick(){try{
  var now=Date.now(),dt=lastTick?Math.min(.5,Math.max(0,(now-lastTick)/1000)):0;lastTick=now;
  if(!song)return;
  var t=Number(scalar(song,'current_song_time')),playing=Number(scalar(song,'is_playing'))?1:0;
  if(now-lastState>=100){lastState=now;outlet(2,'/livemixer/state',0,0,0,t,playing,0,0);}
  if(mirror.length>1){var g=Number(scalar(mirror[0],'value'));for(var i=1;i<mirror.length;i++)put(mirror[i],g);}
  if(!refs)return;
  if(oscOwned&&now-lastValues>1500&&!athome()){var e=Math.exp(-dt/.8);for(var k=1;k<4;k++){manual[k]*=e;if(manual[k]<.002)manual[k]=0;}balance=.5+(balance-.5)*e;if(Math.abs(balance-.5)<.002)balance=.5;status(athome()?'OSC silent · home':'OSC silent · easing home');}
  var target=zones.length?quietzone(t):0;
  if(target!==quiet){var tempo=Number(scalar(song,'tempo'));if(!(tempo>0))tempo=120;var q=dt*tempo/120;quiet=target>quiet?Math.min(target,quiet+q):Math.max(target,quiet-q);}
  steady();
  if(quiet>0)status('FX QUIET · the song leads');else if(label==='FX QUIET · the song leads')status('Living · following the box');
}catch(e){status('Setup: '+e.message);}}

function notifydeleted(){if(task)task.cancel();try{apply([0,0,0,0]);}catch(e){}try{restorehome();}catch(e){}}
// Read-only status for local verification.
function snapshot(){try{var v={playing:Number(scalar(song,'is_playing')),beat:Number(scalar(song,'current_song_time')),tempo:Number(scalar(song,'tempo')),status:label,ready:!!refs,balance:balance,quiet:quiet,zones:zones,songs:refs?refs.filter.length:0,mirrors:mirror.length};var f=new File('/tmp/livemixer-living-fx-state.json','write','TEXT');f.eof=0;f.writestring(JSON.stringify(v));f.close();}catch(e){error(e+'\n');}}

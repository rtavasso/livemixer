// Slow musical gestures use Live's position; slice timing stays in Quick Stutter's Gen DSP.
autowatch=0;inlets=1;outlets=2;
var refs=null, song=null, automatic=0, manual=[0,0,0,0], last={}, task=null, label='', demoSection=0, demoOrigin=0;
function ids(v){var r=[];for(var i=0;i<v.length;i++)if(v[i]==='id'&&Number(v[i+1])>0)r.push(Number(v[++i]));return r;}
function api(id){return new LiveAPI(null,'id '+id);}
function scalar(o,p){return o.get(p)[0];}
function track(name){var ts=ids(song.get('tracks'));for(var i=0;i<ts.length;i++){var t=api(ts[i]);if(String(scalar(t,'name'))===name)return t;}throw new Error('Missing '+name);}
function device(t,cls){var ds=ids(t.get('devices'));for(var i=0;i<ds.length;i++){var d=api(ds[i]);if(String(scalar(d,'class_name'))===cls)return d;}throw new Error('Missing '+cls);}
function param(d,name){var ps=ids(d.get('parameters'));for(var i=0;i<ps.length;i++){var p=api(ps[i]);if(String(scalar(p,'name'))===name)return p;}throw new Error('Missing '+name);}
function sends(t){return ids(api(ids(t.get('mixer_device'))[0]).get('sends'));}
function put(p,v){if(!p)return;if(p instanceof Array){for(var i=0;i<p.length;i++)put(p[i],v);return;}var id=Number(p.id);if(last[id]!==undefined&&Math.abs(last[id]-v)<.001)return;p.set('value',v);last[id]=v;}
function status(s){if(s!==label){label=s;outlet(0,'set',s);}}
function tracks(name){var all=ids(song.get('tracks')),r=[];for(var i=0;i<all.length;i++){var t=api(all[i]);if(String(scalar(t,'name'))===name)r.push(t);}return r;}
var vocalMirror=null,boundaries=[];
// Living installation: arrangement balance (DRUM FX vs TEXTURE FX group volumes), FX QUIET zones, OSC watchdog.
var mix=null,balance=.5,quiet=0,zones=[],oscOwned=0,lastValues=0,lastTick=0,note='';
function volume(t){return api(ids(api(ids(t.get('mixer_device'))[0]).get('volume'))[0]);}
// Back to each group's home volume, unless the operator has moved that fader since our last write.
function restorehome(){if(!mix)return;for(var i=0;i<mix.length;i++){var m=mix[i],id=Number(m.p.id);if(last[id]!==undefined&&Math.abs(Number(scalar(m.p,'value'))-last[id])>=.001)continue;m.p.set('value',m.home);last[id]=m.home;}}
function setbalance(b){if(!mix)return;var db=8*(b-.5);for(var i=0;i<mix.length;i++)put(mix[i].p,Math.max(0,Math.min(1,mix[i].home+mix[i].sign*db/40)));}
function quietzone(t){var q=0;for(var i=0;i<zones.length;i++){var z=zones[i];if(t>=z[0]&&t<z[1])q=Math.max(q,Math.min(1,(t-z[0])/2));else if(t>=z[1]&&t<z[1]+2)q=Math.max(q,1-(t-z[1])/2);}return q;}
function steady(){var k=1-quiet,v=[];for(var i=0;i<4;i++)v.push(manual[i]*k);apply(v);setbalance(.5+(balance-.5)*k);}
function athome(){return balance===.5&&!manual[0]&&!manual[1]&&!manual[2]&&!manual[3];}
function living(dt){
if(oscOwned&&Date.now()-lastValues>1500&&!athome()){var e=Math.exp(-dt/.8);for(var i=0;i<4;i++){manual[i]*=e;if(manual[i]<.002)manual[i]=0;}balance=.5+(balance-.5)*e;if(Math.abs(balance-.5)<.002)balance=.5;status(athome()?'OSC silent · home':'OSC silent · easing home');}
var target=0;if(zones.length)target=quietzone(Number(scalar(song,'current_song_time')));
if(target!==quiet||quiet>0){var tempo=Number(scalar(song,'tempo'));if(!(tempo>0))tempo=120;var stepq=dt*tempo/120;quiet=target>quiet?Math.min(target,quiet+stepq):Math.max(target,quiet-stepq);}
steady();if(quiet>0)status('FX QUIET · the song leads');else if(label==='FX QUIET · the song leads')status('Manual · combine gently');}
function init(){try{if(task)task.cancel();try{restorehome();}catch(e){}mix=null;song=new LiveAPI(null,'live_set');
var texture=tracks('TEXTURE FX'),sn=tracks('02 Snare'),od=tracks('03 Other Drums'),vs=tracks('VOCALS'),master=new LiveAPI(null,'live_set master_track');
refs={flicker:null,filter:[],echo:[],bloom:[],snare:[],other:[]};var ds=ids(master.get('devices'));
for(var i=0;i<ds.length;i++){var d=api(ds[i]);if(String(scalar(d,'name'))==='LiveMixer Two Song Stutter')refs.flicker=param(d,'Amount');}
if(!refs.flicker||texture.length!==2)throw new Error('Load Two Song Stutter and both song groups');
for(var i=0;i<texture.length;i++){refs.filter.push(param(device(texture[i],'AutoFilter2'),'Control'));var ts=sends(texture[i]);refs.echo.push(api(ts[0]));refs.bloom.push(api(ts[1]));refs.snare.push(api(sends(sn[i])[0]));refs.other.push(api(sends(od[i])[0]));}
var drums=tracks('DRUM FX');note='';if(drums.length===texture.length){mix=[];for(var i=0;i<texture.length;i++){var dv=volume(drums[i]),tv=volume(texture[i]);mix.push({p:dv,home:Number(scalar(dv,'value')),sign:-1});mix.push({p:tv,home:Number(scalar(tv,'value')),sign:1});}}else note=' · balance off (no DRUM FX pair)';
vocalMirror=vs.length===2?[param(device(vs[0],'StereoGain'),'Output'),param(device(vs[1],'StereoGain'),'Output')]:null;
boundaries=[];var cs=ids(song.get('cue_points'));for(var i=0;i<cs.length;i++){var c=api(cs[i]);if(String(scalar(c,'name')).indexOf('SONG:')===0)boundaries.push(Number(scalar(c,'time')));}boundaries.sort(function(a,b){return a-b;});
zones=[];var cues=[],starts=[];for(var i=0;i<cs.length;i++){var c=api(cs[i]),ct=Number(scalar(c,'time'));cues.push(ct);if(String(scalar(c,'name')).indexOf('FX QUIET')===0)starts.push(ct);}cues.sort(function(a,b){return a-b;});
for(var i=0;i<starts.length;i++){var end=Infinity;for(var j=0;j<cues.length;j++)if(cues[j]>starts[i]){end=cues[j];break;}zones.push([starts[i],end]);}quiet=0;
last={};balance=.5;apply([0,0,0,0]);setbalance(.5);lastTick=0;task=new Task(tick,this);task.interval=40;task.repeat();status('Ready - both song groups'+(zones.length?' · '+zones.length+' FX QUIET':'')+note);}catch(e){refs=null;mix=null;status('Setup: '+e.message);error(e+'\n');}}
function localtime(t){var start=0;for(var i=0;i<boundaries.length;i++)if(t>=boundaries[i])start=boundaries[i];return t-start;}
function sendlevel(u){if(u<=.0001)return 0;var db=20*Math.log(u)/Math.LN10;return Math.max(0,db>=-20?1+db/40:.5+(db+20)/60);}
function apply(v){if(!refs)return;put(refs.flicker,v[0]);put(refs.echo,sendlevel(.8*v[1]));put(refs.snare,sendlevel(v[1]));put(refs.other,sendlevel(.6*v[1]));put(refs.filter,.5-.37*v[2]);put(refs.bloom,sendlevel(v[3]));}
function control(index,value){automatic=0;oscOwned=0;outlet(1,'auto',0);manual[Number(index)]=Math.max(0,Math.min(1,Number(value)));steady();status('Manual · combine gently');}
function values(){var v=arrayfromargs(arguments);automatic=0;oscOwned=1;lastValues=Date.now();outlet(1,'auto',0);for(var i=0;i<4;i++)manual[i]=Math.max(0,Math.min(1,Number(v[i])||0));var b=Number(v[4]);balance=v.length>4&&b===b?Math.max(0,Math.min(1,b)):.5;steady();if(!quiet)status('Manual · combine gently');}
function auto(v){automatic=Number(v)>0?1:0;if(!automatic)steady();}
function demo(index,origin){demoSection=Math.max(0,Math.min(4,Math.floor(Number(index))));demoOrigin=Number(origin);automatic=2;outlet(1,'auto',0);}
function reset(){automatic=0;oscOwned=0;manual=[0,0,0,0];balance=.5;outlet(1,'auto',0);for(var i=0;i<4;i++)outlet(1,'dial'+i,0);apply(manual);restorehome();status('Dry · tails fade naturally');}
function tick(){try{var now=Date.now(),dt=lastTick?Math.min(.5,Math.max(0,(now-lastTick)/1000)):0;lastTick=now;if(refs&&vocalMirror)put(vocalMirror[1],Number(scalar(vocalMirror[0],'value')));if(!refs)return;if(!automatic){living(dt);return;}setbalance(.5);if(!Number(scalar(song,'is_playing'))){apply([0,0,0,0]);status('Audition ready · press Play');return;}var t=Number(scalar(song,'current_song_time')),local=automatic===2?Math.max(0,t-demoOrigin):localtime(t),section=automatic===2?(local<16?demoSection:0):Math.floor(local/16)%5,p=local%16,v=[0,0,0,0],names=['Dry reference','Drum Flicker','Dub Throw','Velvet Dive','Halo Bloom'];
if(section===1)v[0]=p<12?1:0;
if(section===2)v[1]=(p%4>=2.75&&p%4<3.75) ? .9 : 0;
if(section===3)v[2]=.92*Math.pow(Math.sin(Math.PI*(p%8)/8),2);
if(section===4)v[3]=.9*Math.pow(Math.sin(Math.PI*p/16),2);
apply(v);status(names[section]+' · '+Math.ceil(16-p)+' beats left');
}catch(e){status('Setup: '+e.message);}}
function notifydeleted(){if(task)task.cancel();try{apply([0,0,0,0]);}catch(e){}try{restorehome();}catch(e){}}
// Read-only status used by local verification and the pending-save guard.
function snapshot(){try{var s=new LiveAPI(null,'live_set'),v={name:String(scalar(s,'name')),file:String(scalar(s,'file_path')),playing:Number(scalar(s,'is_playing')),beat:Number(scalar(s,'current_song_time')),tempo:Number(scalar(s,'tempo')),automatic:automatic,status:label,ready:!!refs,balance:balance,quiet:quiet,zones:zones,targets:{}};if(mix)v.targets.mix=mix.map(function(m){return Number(scalar(m.p,'value'));});if(refs)for(var k in refs){var p=refs[k];v.targets[k]=p instanceof Array?p.map(function(x){return Number(scalar(x,'value'));}):Number(scalar(p,'value'));}var f=new File('/tmp/livemixer-fx-state.json','write','TEXT');f.eof=0;f.writestring(JSON.stringify(v));f.close();}catch(e){error(e+'\n');}}

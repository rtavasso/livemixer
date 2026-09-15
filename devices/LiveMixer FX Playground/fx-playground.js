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
function put(p,v){if(!p)return;var id=Number(p.id);if(last[id]!==undefined&&Math.abs(last[id]-v)<.001)return;p.set('value',v);last[id]=v;}
function status(s){if(s!==label){label=s;outlet(0,'set',s);}}
function init(){try{if(task)task.cancel();song=new LiveAPI(null,'live_set');var drums=track('DRUM FX'),texture=track('TEXTURE FX');var ts=sends(texture),sn=sends(track('02 Snare')),od=sends(track('03 Other Drums'));
refs={flicker:param(device(drums,'MxDeviceAudioEffect'),'Amount'),filter:param(device(texture,'AutoFilter2'),'Control'),echo:api(ts[0]),bloom:api(ts[1]),snare:api(sn[0]),other:api(od[0])};last={};apply([0,0,0,0]);task=new Task(tick,this);task.interval=40;task.repeat();status('Ready · vocals and bass stay clear');}catch(e){refs=null;status('Setup: '+e.message);error(e+'\n');}}
function sendlevel(u){if(u<=.0001)return 0;var db=20*Math.log(u)/Math.LN10;return Math.max(0,db>=-20?1+db/40:.5+(db+20)/60);}
function apply(v){if(!refs)return;put(refs.flicker,v[0]);put(refs.echo,sendlevel(.8*v[1]));put(refs.snare,sendlevel(v[1]));put(refs.other,sendlevel(.6*v[1]));put(refs.filter,.5-.37*v[2]);put(refs.bloom,sendlevel(v[3]));}
function control(index,value){automatic=0;outlet(1,'auto',0);manual[Number(index)]=Math.max(0,Math.min(1,Number(value)));apply(manual);status('Manual · combine gently');}
function values(){var v=arrayfromargs(arguments);automatic=0;outlet(1,'auto',0);for(var i=0;i<4;i++)manual[i]=Math.max(0,Math.min(1,Number(v[i])||0));apply(manual);status('Manual · combine gently');}
function auto(v){automatic=Number(v)>0?1:0;if(!automatic)apply(manual);}
function demo(index,origin){demoSection=Math.max(0,Math.min(4,Math.floor(Number(index))));demoOrigin=Number(origin);automatic=2;outlet(1,'auto',0);}
function reset(){automatic=0;manual=[0,0,0,0];outlet(1,'auto',0);for(var i=0;i<4;i++)outlet(1,'dial'+i,0);apply(manual);status('Dry · tails fade naturally');}
function tick(){try{if(!refs||!automatic)return;if(!Number(scalar(song,'is_playing'))){apply([0,0,0,0]);status('Audition ready · press Play');return;}var t=Number(scalar(song,'current_song_time')),local=automatic===2?Math.max(0,t-demoOrigin):t-(t>=308?308:0),section=automatic===2?(local<16?demoSection:0):Math.floor(local/16)%5,p=local%16,v=[0,0,0,0],names=['Dry reference','Drum Flicker','Dub Throw','Velvet Dive','Halo Bloom'];
if(section===1)v[0]=p<12?1:0;
if(section===2)v[1]=(p%4>=2.75&&p%4<3.75) ? .9 : 0;
if(section===3)v[2]=.92*Math.pow(Math.sin(Math.PI*(p%8)/8),2);
if(section===4)v[3]=.9*Math.pow(Math.sin(Math.PI*p/16),2);
apply(v);status(names[section]+' · '+Math.ceil(16-p)+' beats left');
}catch(e){status('Setup: '+e.message);}}
function notifydeleted(){if(task)task.cancel();try{apply([0,0,0,0]);}catch(e){}}
// Read-only status used by local verification and the pending-save guard.
function snapshot(){try{var s=new LiveAPI(null,'live_set'),v={name:String(scalar(s,'name')),file:String(scalar(s,'file_path')),playing:Number(scalar(s,'is_playing')),beat:Number(scalar(s,'current_song_time')),tempo:Number(scalar(s,'tempo')),automatic:automatic,status:label,ready:!!refs,targets:{}};if(refs)for(var k in refs)v.targets[k]=Number(scalar(refs[k],'value'));var f=new File('/tmp/livemixer-fx-state.json','write','TEXT');f.eof=0;f.writestring(JSON.stringify(v));f.close();}catch(e){error(e+'\n');}}
function finish_setup(){var s=new LiveAPI(null,'live_set');if(String(scalar(s,'name'))!=='LiveMixer - FX Playground'||Number(scalar(s,'is_playing')))return;reset();var t=new LiveAPI(null,'live_set master_track'),ds=ids(t.get('devices'));for(var i=ds.length-1;i>=0;i--)if(String(scalar(api(ds[i]),'name'))==='LiveMixer Setup')t.call('delete_device',i);automatic=1;outlet(1,'auto',1);snapshot();}

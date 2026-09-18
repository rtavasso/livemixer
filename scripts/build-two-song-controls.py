#!/usr/bin/env python3
"""Build the two-song variants from the original Quick Stutter and FX Playground devices."""
from pathlib import Path
import json,struct
root=Path(__file__).resolve().parents[1]
out=root/'devices/LiveMixer Two Song Controls';out.mkdir(exist_ok=True)
def unpack(path):
 b=path.read_bytes();i=b.index(b'ptch');return json.loads(b[i+8:].rstrip(b'\0\n'))
def save(name,p):
 raw=(json.dumps(p,indent=2)+'\n\0').encode();(out/name).write_bytes(b'ampf'+struct.pack('<I',4)+b'aaaa'+b'meta'+struct.pack('<II',4,0)+b'ptch'+struct.pack('<I',len(raw))+raw)
p=unpack(root/'devices/LiveMixer Beat Cycle/LiveMixer Quick Stutter.amxd');q=p['patcher']
for item in q['boxes']:
 b=item['box']
 if b['id']=='bind':b['text']='js two-song-bind.js';b['numoutlets']=5
 if b['id']=='title':b['text']='LIVEMIXER - TWO SONG STUTTER'
q['boxes'].append({'box':dict(id='remoteB',maxclass='newobj',text='live.remote~ @normalized 1 @smoothing 0',numinlets=2,numoutlets=1,patching_rect=[280,620,240,22])})
q['lines'] += [{'patchline':dict(source=['engine',0],destination=['remoteB',0])},{'patchline':dict(source=['bind',4],destination=['remoteB',1])}]
q['dependency_cache']=[dict(name='two-song-bind.js',patcherrelativepath='.',type='TEXT',implicit=1)]
s=(root/'devices/LiveMixer Beat Cycle/livemixer-bind.js').read_text().replace('outlets = 4','outlets = 5')
a=s.index('        var self =');z=s.index('        var live =',a)
s=s[:a]+'''        var song = new LiveAPI(null, "live_set"), tracks = ids(song.get("tracks")), targets=[];
        for(var t=0;t<tracks.length;t++) {
            var track=api(tracks[t]);
            if(String(scalar(track,"name"))!=="DRUM FX")continue;
            var ds=ids(track.get("devices"));
            for(var d=0;d<ds.length;d++)if(String(scalar(api(ds[d]),"class_name"))==="BeatRepeat") {
                var params=ids(api(ds[d]).get("parameters"));
                for(var p=0;p<params.length;p++)if(String(scalar(api(params[p]),"name"))==="Repeat")targets.push(params[p]);
            }
        }
        if(targets.length!==2)throw new Error("Expected two DRUM FX Beat Repeats");
        outlet(0,"id",targets[0]);outlet(4,"id",targets[1]);
        var target=targets.join(",");
''' +s[z:]
s=s.replace('outlet(0, "id", 0);','outlet(0, "id", 0);\n        outlet(4, "id", 0);')
s=s.replace('"Ready · "','"Both drum groups · "')
(out/'two-song-bind.js').write_text(s);save('LiveMixer Two Song Stutter.amxd',p)
p=unpack(root/'devices/LiveMixer FX Playground/LiveMixer FX Playground.amxd');q=p['patcher']
for item in q['boxes']:
 b=item['box']
 if b.get('text')=='js fx-playground.js':b['text']='js two-song-fx.js'
 if b.get('text')=='LIVEMIXER FX PLAYGROUND':b['text']='LIVEMIXER - TWO SONG FX'
q['dependency_cache']=[dict(name='two-song-fx.js',patcherrelativepath='.',type='TEXT',implicit=1)]
s=(root/'devices/LiveMixer FX Playground/fx-playground.js').read_text()
s=s.replace("function put(p,v){if(!p)return;", "function put(p,v){if(!p)return;if(p instanceof Array){for(var i=0;i<p.length;i++)put(p[i],v);return;}")
a=s.index('function init()');z=s.index('function sendlevel',a)
s=s[:a]+'''function tracks(name){var all=ids(song.get('tracks')),r=[];for(var i=0;i<all.length;i++){var t=api(all[i]);if(String(scalar(t,'name'))===name)r.push(t);}return r;}
var vocalMirror=null,boundaries=[];
function init(){try{if(task)task.cancel();song=new LiveAPI(null,'live_set');
var texture=tracks('TEXTURE FX'),sn=tracks('02 Snare'),od=tracks('03 Other Drums'),vs=tracks('VOCALS'),master=new LiveAPI(null,'live_set master_track');
refs={flicker:null,filter:[],echo:[],bloom:[],snare:[],other:[]};var ds=ids(master.get('devices'));
for(var i=0;i<ds.length;i++){var d=api(ds[i]);if(String(scalar(d,'name'))==='LiveMixer Two Song Stutter')refs.flicker=param(d,'Amount');}
if(!refs.flicker||texture.length!==2)throw new Error('Load Two Song Stutter and both song groups');
for(var i=0;i<texture.length;i++){refs.filter.push(param(device(texture[i],'AutoFilter2'),'Control'));var ts=sends(texture[i]);refs.echo.push(api(ts[0]));refs.bloom.push(api(ts[1]));refs.snare.push(api(sends(sn[i])[0]));refs.other.push(api(sends(od[i])[0]));}
vocalMirror=vs.length===2?[param(device(vs[0],'StereoGain'),'Output'),param(device(vs[1],'StereoGain'),'Output')]:null;
boundaries=[];var cs=ids(song.get('cue_points'));for(var i=0;i<cs.length;i++){var c=api(cs[i]);if(String(scalar(c,'name')).indexOf('SONG:')===0)boundaries.push(Number(scalar(c,'time')));}boundaries.sort(function(a,b){return a-b;});
last={};apply([0,0,0,0]);task=new Task(tick,this);task.interval=40;task.repeat();status('Ready - both song groups');}catch(e){refs=null;status('Setup: '+e.message);error(e+'\\n');}}
function localtime(t){var start=0;for(var i=0;i<boundaries.length;i++)if(t>=boundaries[i])start=boundaries[i];return t-start;}
''' +s[z:]
s=s.replace("function tick(){try{if(!refs||!automatic)return;", "function tick(){try{if(refs&&vocalMirror)put(vocalMirror[1],Number(scalar(vocalMirror[0],'value')));if(!refs||!automatic)return;")
s=s.replace("t-(t>=308?308:0)","localtime(t)")
s=s.replace("if(refs)for(var k in refs)v.targets[k]=Number(scalar(refs[k],'value'));", "if(refs)for(var k in refs){var p=refs[k];v.targets[k]=p instanceof Array?p.map(function(x){return Number(scalar(x,'value'));}):Number(scalar(p,'value'));}")
s=s[:s.index('function finish_setup()')]
(out/'two-song-fx.js').write_text(s);save('LiveMixer Two Song FX.amxd',p)
print(out)

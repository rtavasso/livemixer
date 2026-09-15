#!/usr/bin/env python3
"""Build the four-control audition hub for the prepared Live effects buses."""
from pathlib import Path
import json,struct
root=Path(__file__).resolve().parents[1];folder=root/'devices/LiveMixer FX Playground'
b=[];lines=[]
def box(id,text=None,cls='newobj',rect=None,**kw):
 d=dict(id=id,maxclass=cls,patching_rect=rect or [20,240+len(b)*25,240,22],**kw)
 if text is not None:d['text']=text
 b.append({'box':d})
def wire(a,ao,d,di=0):lines.append({'patchline':dict(source=[a,ao],destination=[d,di])})
def show(id,text,rect,cls='live.comment',**kw):box(id,text,cls,rect,presentation=1,presentation_rect=rect,**kw)
box('in','plugin~');box('out','plugout~');wire('in',0,'out',0);wire('in',1,'out',1)
show('title','LIVEMIXER · FX PLAYGROUND',[12,8,380,20],fontface=1)
show('description','Drums flicker. Textures move. Words stay clear.',[12,29,400,18])
params={}
for i,name in enumerate(['Flicker','Dub','Dive','Halo']):
 id='dial'+str(i)
 show(id,None,[14+i*97,56,70,61],'live.dial',varname=id,parameter_enable=1,saved_attribute_attributes={'valueof':dict(parameter_longname='FX '+name,parameter_shortname=name,parameter_type=0,parameter_mmin=0.,parameter_mmax=1.,parameter_initial=[0.],parameter_initial_enable=1,parameter_unitstyle=1)})
 box('msg'+str(i),'prepend control '+str(i));wire(id,0,'msg'+str(i));wire('msg'+str(i),0,'js');params[id]=['FX '+name,name,0]
show('auto','Auto audition',[12,137,116,18],'live.text',texton='Auto audition ON',varname='auto',parameter_enable=1,saved_attribute_attributes={'valueof':dict(parameter_longname='FX Auto Audition',parameter_shortname='Audition',parameter_type=2,parameter_enum=['Off','On'],parameter_initial=[0],parameter_initial_enable=1)})
params['auto']=['FX Auto Audition','Audition',0]
show('reset','Dry / reset',[143,137,90,18],'textbutton',mode=0)
show('refresh','Refresh',[246,137,69,18],'textbutton',mode=0)
show('status','Connecting…',[12,113,395,20])
box('js','js fx-playground.js',numinlets=1,numoutlets=2);wire('js',0,'status')
box('automsg','prepend auto');wire('auto',0,'automsg');wire('automsg',0,'js')
box('resetmsg','reset','message');wire('reset',0,'resetmsg');wire('resetmsg',0,'js')
box('loaded','live.thisdevice');box('defer','deferlow');box('init','init','message');wire('loaded',0,'defer');wire('defer',0,'init');wire('init',0,'js');wire('refresh',0,'init')
box('updates','route auto dial0 dial1 dial2 dial3');wire('js',1,'updates')
for i,id in enumerate(['auto','dial0','dial1','dial2','dial3']):box('set'+id,'prepend set');wire('updates',i,'set'+id);wire('set'+id,0,id)
box('udp','udpreceive 7403 @defer 1');box('route','route /fx/values /fx/auto /fx/release /fx/capture /fx/command');wire('udp',0,'route');wire('route',4,'js')
box('values','prepend values');wire('route',0,'values');wire('values',0,'js');wire('route',1,'auto');wire('route',2,'resetmsg')
box('sync','plugsync~');box('pos','sig~ 0');box('playing','sig~ 0');wire('sync',6,'pos');wire('sync',0,'playing')
box('record','sfrecord~ 4');wire('in',0,'record',0);wire('in',1,'record',1);wire('pos',0,'record',2);wire('playing',0,'record',3)
box('capturesel','sel 1 0');wire('route',3,'capturesel');box('start','samptype float32, open /tmp/livemixer-fx-capture.wav, 1','message');box('stop','0','message');wire('capturesel',0,'start');wire('capturesel',1,'stop');wire('start',0,'record');wire('stop',0,'record')
params['parameterbanks']={'0':{'index':0,'name':'FX Playground','parameters':['dial0','dial1','dial2','dial3','auto','-','-','-']}}
p=dict(fileversion=1,classnamespace='box',rect=[100,100,900,850],openrect=[0,0,411,169],devicewidth=411,openinpresentation=1,default_fontsize=11,default_fontname='Arial',boxes=b,lines=lines,parameters=params,dependency_cache=[dict(name='fx-playground.js',patcherrelativepath='.',type='TEXT',implicit=1)])
raw=(json.dumps({'patcher':p},indent=2)+'\n\0').encode();target=folder/'LiveMixer FX Playground.amxd';target.write_bytes(b'ampf'+struct.pack('<I',4)+b'aaaa'+b'meta'+struct.pack('<II',4,0)+b'ptch'+struct.pack('<I',len(raw))+raw);print(target)

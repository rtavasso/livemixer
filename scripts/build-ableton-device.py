#!/usr/bin/env python3
"""Build the uncompressed .amxd container; all musical scheduling is embedded Gen DSP."""
from pathlib import Path
import json
import struct

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / "devices/LiveMixer Beat Cycle"


def build():
    code = (FOLDER / "beat-cycle.genexpr").read_text()
    code = code.replace("// BOUNDARY_PARAMETERS", "\n".join(f"Param b{i}(-1);" for i in range(1, 32)))
    code = code.replace("segment = 0; // BOUNDARY_EXPRESSION", "segment = " + " + ".join(f"(b{i} >= 0 && beat >= b{i})" for i in range(1, 32)) + ";")
    boxes, lines = [], []

    def box(id, text=None, cls="newobj", rect=None, **kw):
        d = dict(id=id, maxclass=cls, patching_rect=rect or [20, 240 + len(boxes)*26, 220, 22], **kw)
        if text is not None: d["text"] = text
        boxes.append({"box": d})
        return id

    def wire(a, ao, b, bi=0, **kw):
        lines.append({"patchline": dict(source=[a, ao], destination=[b, bi], **kw)})

    def show(id, text, rect, cls="live.comment", **kw):
        return box(id, text, cls, rect=rect, presentation=1, presentation_rect=rect, **kw)

    box("audio", "plugin~", numinlets=2, numoutlets=2, outlettype=["signal", "signal"])
    box("output", "plugout~", numinlets=2, numoutlets=2)
    wire("audio",0,"output",0); wire("audio",1,"output",1)
    show("title", "LIVEMIXER · QUICK STUTTER", [12,8,270,20], fontface=1)
    show("amount", None, [12,39,65,65], "live.dial", varname="amount", parameter_enable=1,
         saved_attribute_attributes={"valueof": dict(parameter_longname="Stutter Amount", parameter_shortname="Amount", parameter_type=0,
              parameter_mmin=0., parameter_mmax=1., parameter_initial=[0.], parameter_initial_enable=1, parameter_unitstyle=1)})
    show("guide", "1–4 sixteenth-note stutters\nAt least 4 beats OFF\nChanges apply next burst", [92,40,185,53], linecount=3)
    show("status", "Connecting…", [12,113,280,20])
    show("refresh", "Refresh songs", [12,141,80,18], "textbutton", mode=0)
    show("release", "Release", [101,141,60,18], "textbutton", mode=0)
    show("activeLabel", "Repeat", [196,140,48,18])
    show("active", None, [249,141,16,16], "led", ignoreclick=1)
    box("clock", "plugphasor~", numinlets=0,numoutlets=1,outlettype=["signal"])
    box("sync", "plugsync~", numinlets=1,numoutlets=9)
    box("position", "sig~ 0"); box("running", "sig~ 0")
    wire("sync",6,"position");wire("sync",0,"running")
    gb=[]; gl=[]
    for i in range(1,4):
        gb.append({"box":dict(id=f"in{i}",maxclass="newobj",text=f"in {i}",patching_rect=[i*100,20,40,22])})
        gl.append({"patchline":dict(source=[f"in{i}",0],destination=["code",i-1])})
    gb.append({"box":dict(id="code",maxclass="codebox",numinlets=3,numoutlets=4,code=code,patching_rect=[50,80,650,500])})
    for i in range(1,5):
        gb.append({"box":dict(id=f"out{i}",maxclass="newobj",text=f"out {i}",patching_rect=[i*100,620,45,22])})
        gl.append({"patchline":dict(source=["code",i-1],destination=[f"out{i}",0])})
    box("engine", "gen~", numinlets=3,numoutlets=4,outlettype=["signal"]*4,
        patcher=dict(fileversion=1,classnamespace="dsp.gen",rect=[100,100,800,750],boxes=gb,lines=gl))
    wire("clock",0,"engine",0);wire("position",0,"engine",1);wire("running",0,"engine",2)
    box("amountOrder", "t f b");box("clearAbort", "abort 0", "message");box("amountMessage", "prepend amount")
    wire("amount",0,"amountOrder");wire("amountOrder",1,"clearAbort");wire("clearAbort",0,"engine");wire("amountOrder",0,"amountMessage");wire("amountMessage",0,"engine")
    box("remote", "live.remote~ @normalized 1 @smoothing 0", numinlets=2,numoutlets=1)
    wire("engine",0,"remote")
    box("loaded", "live.thisdevice");box("defer", "deferlow");box("initialize", "init", "message")
    box("bind", "js livemixer-bind.js", numinlets=1,numoutlets=4)
    wire("loaded",0,"defer");wire("defer",0,"initialize");wire("initialize",0,"bind");wire("refresh",0,"initialize")
    wire("bind",0,"remote",1);wire("bind",1,"status");wire("bind",2,"engine")
    box("poll", "qmetro 50");box("load", "loadbang");box("one", "1", "message")
    wire("load",0,"one");wire("one",0,"poll")
    box("gateSnapshot", "snapshot~");wire("engine",0,"gateSnapshot");wire("gateSnapshot",0,"active")
    box("statusOrder", "t b b b b");wire("poll",0,"statusOrder")
    box("statusPack", "pack 0. 0. 0. 0. 0. 0. 0.")
    wire("statusOrder",0,"gateSnapshot");wire("gateSnapshot",0,"statusPack",0)
    for i in range(1,4):
        box(f"snapshot{i}", "snapshot~");wire("engine",i,f"snapshot{i}");wire("statusOrder",i,f"snapshot{i}");wire(f"snapshot{i}",0,"statusPack",i)
    wire("sync",0,"statusPack",4);wire("amount",0,"statusPack",5);wire("bind",3,"statusPack",6)
    box("statusAddress", "prepend /livemixer/state");box("statusSend", "udpsend 127.0.0.1 7401")
    wire("statusPack",0,"statusAddress");wire("statusAddress",0,"statusSend")
    # Standard OSC messages are decoded natively. A stale simulation aborts the burst.
    box("udp", "udpreceive 7400 @defer 1")
    box("route", "route /livemixer/stutter /livemixer/release /livemixer/capture /livemixer/refresh")
    wire("udp",0,"route");wire("route",3,"initialize")
    box("clip", "clip 0. 1.");box("incoming", "t f b b");box("watchStop", "stop", "message");box("watch", "delay 1500")
    wire("route",0,"clip");wire("clip",0,"incoming");wire("incoming",2,"watchStop");wire("watchStop",0,"watch");wire("incoming",1,"watch");wire("incoming",0,"amount")
    box("panic", "t b b");box("zero", "0", "message");box("abort", "abort 1", "message")
    wire("route",1,"panic");wire("release",0,"panic");wire("watch",0,"panic");wire("panic",1,"zero");wire("zero",0,"amount");wire("panic",0,"abort");wire("abort",0,"engine")
    # Explicit opt-in local diagnostic capture, never started on device load.
    box("record", "sfrecord~ 8")
    for source,ao,dest in [("audio",0,0),("audio",1,1),("clock",0,2),("engine",0,3),("engine",1,4),("engine",2,5),("position",0,6),("running",0,7)]:wire(source,ao,"record",dest)
    box("captureSel", "sel 1 0");wire("route",2,"captureSel")
    box("captureStart", "samptype float32, open /tmp/livemixer-cycle-capture.wav, 1", "message");box("captureStop", "0", "message")
    wire("captureSel",0,"captureStart");wire("captureSel",1,"captureStop");wire("captureStart",0,"record");wire("captureStop",0,"record")
    patch=dict(fileversion=1,appversion=dict(major=9,minor=0,revision=0,architecture="x64",modernui=1),classnamespace="box",
        rect=[100,100,950,800],openrect=[0,0,290,169],openinpresentation=1,devicewidth=290,default_fontsize=11,
        default_fontname="Arial",boxes=boxes,lines=lines,parameters={"amount":["Stutter Amount","Amount",0],"parameterbanks":{"0":{"index":0,"name":"","parameters":["amount","-","-","-","-","-","-","-"]}}},
        dependency_cache=[dict(name="livemixer-bind.js",patcherrelativepath=".",type="TEXT",implicit=1)],
        latency=0,autosave=0)
    raw=(json.dumps({"patcher":patch},indent=2)+"\n\0").encode()
    container=b"ampf"+struct.pack("<I",4)+b"aaaa"+b"meta"+struct.pack("<II",4,0)+b"ptch"+struct.pack("<I",len(raw))+raw
    target=FOLDER/"LiveMixer Quick Stutter.amxd";target.write_bytes(container)
    print(target)


if __name__ == "__main__": build()

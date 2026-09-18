// Max's legacy JS is used only to discover objects. Beat timing stays in DSP.
autowatch = 0;
inlets = 1;
outlets = 5;

function ids(values) {
    var result = [];
    for (var i = 0; i < values.length; i++) {
        if (values[i] === "id" && Number(values[i + 1]) > 0) result.push(Number(values[++i]));
    }
    return result;
}
function api(id) { return new LiveAPI(null, "id " + id); }
function scalar(obj, prop) { return obj.get(prop)[0]; }

function init() {
    try {
        var song = new LiveAPI(null, "live_set"), tracks = ids(song.get("tracks")), targets=[];
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
        var live = new LiveAPI(null, "live_set");
        var cues = ids(live.get("cue_points")), boundaries = [];
        for (var c = 0; c < cues.length; c++) {
            var cue = api(cues[c]);
            var name = String(scalar(cue, "name"));
            var time = Number(scalar(cue, "time"));
            if (name.indexOf("SONG:") === 0 && time > 0) boundaries.push(time);
        }
        boundaries.sort(function(a, b) { return a - b; });
        if (boundaries.length > 31) throw new Error("Maximum 32 songs per controller");
        for (var b = 1; b <= 31; b++) outlet(2, "b" + b, b <= boundaries.length ? boundaries[b - 1] : -1);
        outlet(1, "set", "Both drum groups · " + (boundaries.length + 1) + " songs");
        outlet(3, 1);
        post("LiveMixer: Repeat bound to id " + target + "; song boundaries " + boundaries.join(", ") + "\n");
    } catch (e) {
        outlet(0, "id", 0);
        outlet(4, "id", 0);
        outlet(3, 0);
        outlet(1, "set", "Setup: " + e.message);
        error("LiveMixer: " + e.message + "\n");
    }
}

// Max's legacy JS is used only to discover objects. Beat timing stays in DSP.
autowatch = 0;
inlets = 1;
outlets = 4;

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
        var self = new LiveAPI(null, "this_device");
        var track = new LiveAPI(null, "this_device canonical_parent");
        var devices = ids(track.get("devices"));
        var candidates = [], ownIndex = -1;
        for (var i = 0; i < devices.length; i++) {
            if (devices[i] == self.id) ownIndex = i;
            var d = api(devices[i]);
            if (String(scalar(d, "class_name")) === "BeatRepeat") candidates.push({id: devices[i], index: i});
        }
        if (candidates.length !== 1) throw new Error("Keep exactly one Beat Repeat on this track");
        var params = ids(api(candidates[0].id).get("parameters"));
        var target = 0;
        for (var p = 0; p < params.length; p++) {
            var param = api(params[p]);
            if (String(scalar(param, "name")) === "Repeat") target = params[p];
        }
        if (!target) throw new Error("Repeat parameter not found");
        outlet(0, "id", target);
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
        outlet(1, "set", "Ready · " + (boundaries.length + 1) + " songs");
        outlet(3, 1);
        post("LiveMixer: Repeat bound to id " + target + "; song boundaries " + boundaries.join(", ") + "\n");
    } catch (e) {
        outlet(0, "id", 0);
        outlet(3, 0);
        outlet(1, "set", "Setup: " + e.message);
        error("LiveMixer: " + e.message + "\n");
    }
}

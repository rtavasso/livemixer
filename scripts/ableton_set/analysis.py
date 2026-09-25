"""Beat analysis of rendered songs, run in an isolated librosa environment and cached per song."""
import hashlib
import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

WORKER = Path(__file__).with_name("beats_worker.py")
# numba 0.61+ has no Intel macOS wheels; these versions install on both architectures.
UV = ["uv", "run", "--no-project", "--python", "3.12",
      "--with", "librosa==0.10.2.post1", "--with", "numba==0.60.0", "python"]


def _fingerprint(render_dir, prior):
    manifest = json.loads((render_dir / "_render.json").read_text())
    worker = hashlib.sha256(WORKER.read_bytes()).hexdigest()[:16]
    return {"render": [manifest["frames"], manifest["rate"], manifest["sources"]], "prior": prior, "worker": worker}


def analyze(render_dir, prior):
    """Return the analysis for one rendered song folder, reusing the cache when inputs match."""
    cache = render_dir / "_analysis.json"
    fingerprint = _fingerprint(render_dir, prior)
    if cache.exists():
        cached = json.loads(cache.read_text())
        if cached.get("fingerprint") == fingerprint:
            return cached
    result = subprocess.run(UV + [str(WORKER), str(render_dir), str(prior or "")], capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"Beat analysis failed for {render_dir.name}:\n{result.stderr[-2000:]}")
    analysis = json.loads(result.stdout)
    analysis["fingerprint"] = fingerprint
    cache.write_text(json.dumps(analysis))
    return analysis


def analyze_all(render_dirs, priors, workers=3):
    if not shutil.which("uv"):
        sys.exit("Beat analysis needs uv: brew install uv")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(analyze, render_dirs, priors))

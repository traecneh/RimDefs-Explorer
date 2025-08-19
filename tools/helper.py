#!/usr/bin/env python3
"""
RimDefs Helper: same-origin static UI host + tiny API to manage paths and trigger builds.

Layout assumption:
- UI lives at the repo root (the parent of tools/), e.g. RimDefs3/index.html.
- JSON artifacts are served from /data (configurable via config).

API:
  GET  /api/ping                  -> { ok: true }
  GET  /api/health                -> { uiRoot, hasIndex, configPath, outDir }
  GET  /api/config                -> current config + detectedVersion
  PUT  /api/config                -> write config (accepts arrays or single strings)
  POST /api/rebuild               -> { jobId } body: { layers:["official","workshop","dev"], includeLanguages?, extraExcludes? }
  GET  /api/status?jobId=...      -> { state, progress, logTail }
  GET  /api/data/manifest         -> { files:[{name,size,mtime}], version }
  GET  /data/<filename>           -> serve generated artifacts
  GET  /                          -> serves index.html from the repo root

This file wraps the functions in rimdefs_build.py, which already handles:
- Deep scanning of mod trees with a prune list (Textures, AssetBundles, etc.)
- Optional inclusion of Languages/**
- Version autodetect from Version.txt
- Emitting items.official.json / items.workshop.json / items.dev.json / rim_meta.json
(We do not reimplement parsing; we just call the builder.)  # filecite: turn0file0 
"""
from __future__ import annotations

import io
import json
import os
import sys
import threading
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from flask import Flask, jsonify, request, send_from_directory, Response

# --- Import builder module (lives next to this helper in tools/) ---
# Provides DEFAULT_OUT, DEFAULT_CONFIG_PATH, DEFAULT_PRUNE_DIRS,
# detect_rimworld_version(), build_layer(), ensure_default_config(), etc.  # filecite: turn0file0 
import rimdefs_build as rb


# ---------- Paths & roots ----------

TOOLS_DIR = Path(__file__).resolve().parent
# UI root = repo root (parent of tools/)
UI_ROOT = TOOLS_DIR.parent
# Config (kept next to the builder under tools/)
CONFIG_PATH = rb.DEFAULT_CONFIG_PATH  # tools/rimdefs.config.json  # filecite: turn0file0 


def resolve_out_dir(cfg: Dict) -> Path:
    """
    Resolve the output directory for /data artifacts.
    If config["out"] is present, resolve relative to the config file.
    Otherwise fall back to the builder's DEFAULT_OUT (which is ../data for this layout).
    """
    if "out" in cfg and str(cfg["out"]).strip():
        out = Path(cfg["out"])
        if not out.is_absolute():
            out = (CONFIG_PATH.parent / out).resolve()
        return out
    return rb.DEFAULT_OUT  # in this layout it's <repo>/data  # filecite: turn0file0 


# ---------- Config IO ----------

def load_config() -> Dict:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    rb.ensure_default_config(CONFIG_PATH)  # writes built-in defaults if missing  # filecite: turn0file0 
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def write_config(cfg: Dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def _as_list(v) -> List[str]:
    """Normalize a possibly-empty string/array into a clean list[str]."""
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if str(x).strip()]
    s = str(v).strip()
    return [s] if s else []


# ---------- Build job handling ----------

class _Job:
    def __init__(
        self,
        layers: List[str],
        include_languages: Optional[bool] = None,
        extra_excludes: Optional[List[str]] = None,
    ):
        self.id = uuid.uuid4().hex
        self.layers = layers
        self.include_languages = include_languages
        self.extra_excludes = extra_excludes or []
        self.state = "queued"  # queued | running | done | error
        self.progress = 0.0
        self._log = ""
        self._err: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def log_write(self, s: str) -> None:
        with self._lock:
            self._log += s
            if len(self._log) > 100_000:
                self._log = self._log[-80_000:]

    def log_tail(self) -> str:
        with self._lock:
            return self._log[-5000:]

    def start(self) -> None:
        t = threading.Thread(target=self._run, name=f"rebuild-{self.id}", daemon=True)
        self._thread = t
        t.start()

    def _run(self) -> None:
        self.state = "running"

        class _Writer(io.TextIOBase):
            def write(_self, s):
                self.log_write(s)
                return len(s)

        w = _Writer()

        try:
            cfg = load_config()
            base_for_rel = CONFIG_PATH.parent

            # Normalize roots for each layer  # filecite: turn0file0 
            official = rb._norm_path_list(cfg.get("official", []), base_for_rel)
            workshop = rb._norm_path_list(cfg.get("workshop", []), base_for_rel)
            dev      = rb._norm_path_list(cfg.get("dev", []), base_for_rel)

            out_dir = resolve_out_dir(cfg)
            out_dir.mkdir(parents=True, exist_ok=True)

            # Version precedence: config.version or autodetected Version.txt  # filecite: turn0file0 
            detected_version = rb.detect_rimworld_version(official) or None
            version = cfg.get("version") or detected_version or "unknown"

            # Build prune set  # filecite: turn0file0 
            prune = set(rb.DEFAULT_PRUNE_DIRS)
            include_lang = self.include_languages
            if include_lang is None:
                include_lang = bool(cfg.get("include_languages", False))
            if include_lang and "languages" in prune:
                prune.remove("languages")
            for nm in (cfg.get("exclude") or []):
                prune.add(str(nm).lower())
            for nm in (self.extra_excludes or []):
                prune.add(str(nm).lower())

            # Base rim_meta skeleton (builder fills members as it sees defs)  # filecite: turn0file0 
            meta = {"version": version, "defTypes": {}, "enums": {}, "types": {}}

            layer_roots = {"official": official, "workshop": workshop, "dev": dev}
            selected = [L for L in ["official", "workshop", "dev"] if L in (self.layers or [])]
            if not selected:
                selected = ["official", "workshop", "dev"]

            total_steps = len(selected) + 1
            step = 0

            old_out = sys.stdout
            sys.stdout = w
            try:
                for L in selected:
                    roots = layer_roots[L]
                    if not roots:
                        (out_dir / f"items.{L}.json").write_text("[]", encoding="utf-8")
                        print(f"[{L}] no roots provided; wrote empty list.")
                    else:
                        print(f"=== Building layer: {L} ===")
                        print("    Roots:", ", ".join(p.as_posix() for p in roots))
                        if detected_version and L == "official":
                            print(f"    Detected Version.txt: {detected_version}")

                        # Delegates all the heavy lifting to the builder  # filecite: turn0file0 
                        rb.build_layer(
                            L,
                            roots,
                            out_dir,
                            meta,
                            prune_dirs_lower=prune,
                            verbose=True,
                            deprec_include_patches=False,
                        )
                    step += 1
                    self.progress = min(0.95, step / total_steps)

                # rim_meta.json (collected during the loop)  # filecite: turn0file0 
                meta_path = out_dir / "rim_meta.json"
                meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"→ wrote {meta_path} (defTypes: {len(meta['defTypes'])})")

                self.progress = 1.0
                self.state = "done"
                print("✔ Done.")
            finally:
                sys.stdout = old_out

        except Exception as e:
            self.state = "error"
            self._err = str(e)
            self.log_write(f"\n[error] {e}\n")


_current_job: Optional[_Job] = None
_job_lock = threading.Lock()


def start_job(layers: List[str], include_languages: Optional[bool], extra_excludes: Optional[List[str]]) -> _Job:
    global _current_job
    with _job_lock:
        if _current_job and _current_job.state in ("queued", "running"):
            return _current_job
        job = _Job(layers, include_languages, extra_excludes)
        _current_job = job
        job.start()
        return job


def get_job(job_id: str) -> Optional[_Job]:
    j = _current_job
    return j if (j and j.id == job_id) else None


# ---------- Flask app ----------

app = Flask(
    __name__,
    static_folder=str(UI_ROOT),  # serve /index.html, /css, /js, /assets straight from repo root
    static_url_path="",
)


@app.get("/")
def index():
    idx = UI_ROOT / "index.html"
    if not idx.exists():
        return Response(f"Missing index.html at {idx.as_posix()}", status=404)
    return send_from_directory(UI_ROOT, "index.html")


# Serve /data/* (generated artifacts from the configured output folder)
@app.get("/data/<path:filename>")
def data_file(filename: str):
    cfg = load_config()
    out_dir = resolve_out_dir(cfg)
    return send_from_directory(out_dir, filename)


# ---------- API routes ----------

@app.get("/api/ping")
def api_ping():
    return jsonify({"ok": True})


@app.get("/api/health")
def api_health():
    cfg = load_config()
    out_dir = resolve_out_dir(cfg)
    has_index = (UI_ROOT / "index.html").exists()
    return jsonify({
        "uiRoot": UI_ROOT.as_posix(),
        "hasIndex": has_index,
        "configPath": CONFIG_PATH.as_posix(),
        "outDir": out_dir.as_posix(),
    })


@app.get("/api/config")
def api_get_config():
    cfg = load_config()
    # Preserve optional devPaths (labels for UI), but always expose plain dev array too.
    dev_paths = cfg.get("devPaths") or [{"path": p} for p in cfg.get("dev", [])]

    base_for_rel = CONFIG_PATH.parent
    official = rb._norm_path_list(cfg.get("official", []), base_for_rel)  # normalize for detection  # filecite: turn0file0 
    detected = rb.detect_rimworld_version(official) or ""

    return jsonify({
        "official": cfg.get("official", []),
        "workshop": cfg.get("workshop", []),
        "devPaths": dev_paths,
        "out": cfg.get("out", "../data"),
        "include_languages": bool(cfg.get("include_languages", False)),
        "exclude": cfg.get("exclude", []),
        "version": cfg.get("version", "unknown"),
        "detectedVersion": detected,
    })


@app.put("/api/config")
def api_put_config():
    payload = request.get_json(force=True, silent=True) or {}
    cfg = load_config()

    # Accept both array and single string forms
    off = _as_list(payload.get("official") or payload.get("officialPath"))
    wk  = _as_list(payload.get("workshop") or payload.get("workshopPath"))

    dev_paths = payload.get("devPaths")
    if dev_paths is None:
        dev = _as_list(payload.get("dev"))
        dev_paths = [{"path": p} for p in dev]
    else:
        dev_paths = [
            {
                "path": str(d.get("path", "")).strip(),
                "label": (str(d.get("label", "")).strip() or None),
            }
            for d in (dev_paths or [])
            if str(d.get("path", "")).strip()
        ]
    dev = [d["path"] for d in dev_paths]

    out = payload.get("out", cfg.get("out", "../data"))
    include_languages = bool(payload.get("include_languages", cfg.get("include_languages", False)))
    exclude = [str(x) for x in (payload.get("exclude", cfg.get("exclude", [])) or [])]
    version = payload.get("version", cfg.get("version", "unknown"))

    new_cfg = {
        "official": off or cfg.get("official", []),
        "workshop": wk  or cfg.get("workshop", []),
        "dev": dev,
        "devPaths": dev_paths,  # optional UI metadata
        "out": out,
        "include_languages": include_languages,
        "exclude": exclude,
        "version": version,
    }
    write_config(new_cfg)
    return jsonify(new_cfg)


@app.post("/api/rebuild")
def api_rebuild():
    payload = request.get_json(force=True, silent=True) or {}
    layers = payload.get("layers") or ["official", "workshop", "dev"]
    include_languages = payload.get("includeLanguages")  # optional override (bool|None)
    extra_excludes = payload.get("extraExcludes") or []
    job = start_job(layers, include_languages, extra_excludes)
    return jsonify({"jobId": job.id})


@app.get("/api/status")
def api_status():
    job_id = request.args.get("jobId") or ""
    job = get_job(job_id)
    if not job:
        return jsonify({"state": "idle", "progress": 0, "logTail": ""})
    return jsonify({
        "state": job.state,
        "progress": round(float(job.progress), 4),
        "logTail": job.log_tail(),
    })


@app.get("/api/data/manifest")
def api_manifest():
    cfg = load_config()
    out_dir = resolve_out_dir(cfg)
    files = []
    for name in ["items.official.json", "items.workshop.json", "items.dev.json", "rim_meta.json"]:
        p = out_dir / name
        if p.exists():
            st = p.stat()
            files.append({"name": name, "size": st.st_size, "mtime": int(st.st_mtime)})
    version = ""
    meta = out_dir / "rim_meta.json"
    if meta.exists():
        try:
            version = json.loads(meta.read_text(encoding="utf-8")).get("version", "")
        except Exception:
            pass
    return jsonify({"files": files, "version": version})


# ---------- Entrypoint ----------

if __name__ == "__main__":
    port = int(os.environ.get("RIMDEFS_PORT", "6159"))
    # Helpful startup prints
    print(f"[helper] UI root   : {UI_ROOT.as_posix()}")
    print(f"[helper] Config    : {CONFIG_PATH.as_posix()}")
    try:
        cfg = load_config()
    except Exception as e:
        print(f"[helper] Could not read config: {e}")
        cfg = {}
    out_dir = resolve_out_dir(cfg)
    print(f"[helper] Data out  : {out_dir.as_posix()}")
    print(f"[helper] API       : http://127.0.0.1:{port}/api/ping")
    print(f"[helper] Explorer  : http://127.0.0.1:{port}/")

    # One process, one origin—no CORS trouble.
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)

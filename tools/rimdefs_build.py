#!/usr/bin/env python3
"""
RimDefs XML → JSON builder (stdlib only) with deep scanning, config, and version autodetect.

New:
- Auto-detect RimWorld version from Version.txt by walking upward from each --official path.
- Precedence for rim_meta.version: CLI --version > detected Version.txt > config value > built-in.
- --no-auto-version to disable detection; --print-config shows detectedVersion.
- Output default: if a ../project directory exists next to this script, uses ../project/data;
  otherwise uses ../data (still overridable via config or --out).

Scanning:
- Deeply scans entire mod trees (not just Defs). By default prunes heavy/non-def dirs:
  Languages, Textures, AssetBundles, Assemblies, Sounds, Meshes, Shaders, VCS/build dirs.
- You can --include-languages to include Languages/**.xml.
- Emits ONLY "def-like" XML elements (tag endswith Def/DefBase/RulePackDef) to items.*.json.

Outputs (default):
  data/items.official.json, data/items.workshop.json, data/items.dev.json, data/rim_meta.json
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.dom import minidom
from typing import Dict, Iterable, List, Optional, Set, Tuple

ET.register_namespace("", "")  # avoid ns clutter

# ---------- Defaults & paths ----------

SCRIPT_DIR = Path(__file__).resolve().parent

def _guess_default_out() -> Path:
    """
    If repo has a 'project' folder next to this script (e.g., /repo/tools + /repo/project),
    default to /repo/project/data to match the Explorer; else use /repo/data.
    If the script lives at /repo/project/tools, default to /repo/project/data.
    """
    if SCRIPT_DIR.name.lower() == "tools":
        repo_base = SCRIPT_DIR.parent
    else:
        repo_base = SCRIPT_DIR

    project_dir = repo_base / "project"
    if project_dir.exists() and project_dir.is_dir():
        return project_dir / "data"
    return repo_base / "data"

DEFAULT_OUT = _guess_default_out()
DEFAULT_CONFIG_PATH = (SCRIPT_DIR / "rimdefs.config.json")

# Windows-friendly built-in defaults
BUILTIN_DEFAULTS = {
    "official": [
        "C:/Program Files (x86)/Steam/steamapps/common/RimWorld/Data"
    ],
    "workshop": [
        "C:/Program Files (x86)/Steam/steamapps/workshop/content/294100"
    ],
    "dev": [],
    # Keep this relative for portability when config lives under tools/
    "out": "../data",
    "version": "unknown"
}

# Directories pruned by default during scanning (case-insensitive match on path parts)
DEFAULT_PRUNE_DIRS = {
    "languages", "textures", "assetbundles", "assemblies", "sounds", "meshes", "shaders",
    ".git", ".svn", "__macosx", ".idea", ".vs", "obj", "bin"
}

# ---------- Small path helpers ----------

def _norm_path_list(values: List[str], base: Path) -> List[Path]:
    out: List[Path] = []
    for v in values or []:
        s = str(v).strip()
        if not s:
            continue
        p = Path(s)
        if not p.is_absolute():
            p = (base / s)
        out.append(p.resolve())
    return out

def _to_config_strings(paths: List[Path], base: Path) -> List[str]:
    out: List[str] = []
    for p in paths:
        try:
            rel = p.resolve().relative_to(base.resolve())
            out.append(rel.as_posix())
        except Exception:
            out.append(p.as_posix())
    return out

# ---------- Config IO ----------

def load_config(path: Path) -> Dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

def write_config(path: Path, cfg: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

def ensure_default_config(path: Path) -> Dict:
    if not path.exists():
        write_config(path, BUILTIN_DEFAULTS)
        print(f"ℹ Created default config at {path} (edit to change paths).")
    return load_config(path)

# ---------- Containment & dedupe ----------

def is_within(child: Path, ancestor: Path) -> bool:
    try:
        child.resolve().relative_to(ancestor.resolve())
        return True
    except Exception:
        return False

def nearest_about_root(start_dir: Path, scan_root: Path) -> Optional[Path]:
    """Walk upward from start_dir until scan_root looking for About/About.xml."""
    cur = start_dir.resolve()
    limit = scan_root.resolve()
    while True:
        if (cur / "About" / "About.xml").exists():
            return cur
        if cur == limit or cur.parent == cur:
            return None
        cur = cur.parent

def add_mod_root(mod_roots: Set[Path], candidate: Path) -> None:
    """Maintain a minimal set of mod roots (prefer topmost ancestor)."""
    candidate = candidate.resolve()
    to_remove: Set[Path] = set()
    for r in list(mod_roots):
        if is_within(candidate, r):
            # existing root dominates
            return
        if is_within(r, candidate):
            to_remove.add(r)
    mod_roots.difference_update(to_remove)
    mod_roots.add(candidate)

# ---------- Mod discovery (deep) ----------

def discover_mod_dirs(scan_root: Path) -> List[Path]:
    """
    Deeply scan 'scan_root' for mod roots.
      - Prefer About/About.xml as mod root.
      - Map Defs dirs to nearest About ancestor; if none, use Defs' parent.
    """
    mod_roots: Set[Path] = set()
    if not scan_root.exists():
        return []

    # Explicit About roots
    for about_xml in scan_root.rglob("About/About.xml"):
        add_mod_root(mod_roots, about_xml.parent.parent)

    # Defs dirs → associate to nearest About ancestor
    for defs_dir in scan_root.rglob("Defs"):
        if not defs_dir.is_dir():
            continue
        about_ancestor = nearest_about_root(defs_dir.parent, scan_root)
        add_mod_root(mod_roots, about_ancestor or defs_dir.parent)

    return sorted(mod_roots, key=lambda p: p.as_posix().lower())

# ---------- XML & meta helpers ----------

def read_mod_display(mod_dir: Path) -> str:
    about_xml = mod_dir / "About" / "About.xml"
    if about_xml.exists():
        try:
            tree = ET.parse(about_xml)
            root = tree.getroot()
            name_el = root.find(".//name")
            if name_el is not None and (name_el.text or "").strip():
                return name_el.text.strip()
        except Exception:
            pass
    return mod_dir.name

def pretty_xml_of_element(elem: ET.Element) -> str:
    raw = ET.tostring(elem, encoding="utf-8")
    try:
        dom = minidom.parseString(raw)
        pretty = dom.toprettyxml(indent="  ", encoding="utf-8").decode("utf-8")
        lines = [ln for ln in pretty.splitlines() if ln.strip()]
        if lines and lines[0].startswith("<?xml"):
            lines = lines[1:]
        return "\n".join(lines)
    except Exception:
        return raw.decode("utf-8", errors="replace")

def first_text(el: Optional[ET.Element]) -> Optional[str]:
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t if t else None

def extract_def_name(elem: ET.Element) -> Optional[str]:
    dn = first_text(elem.find("defName"))
    if dn:
        return dn
    nm = elem.attrib.get("Name")
    if nm and nm.strip():
        return nm.strip()
    return None

def collect_tag_map(elem: ET.Element) -> Dict[str, List[str]]:
    seen: Dict[str, Set[str]] = {}

    def add(tag: str, value: Optional[str]):
        if not value:
            return
        s = value.strip()
        if not s:
            return
        if tag not in seen:
            seen[tag] = set()
        seen[tag].add(s if len(s) <= 200 else (s[:197] + "…"))

    def walk(node: ET.Element):
        for k, v in node.attrib.items():
            add(k, v)
        add(node.tag, (node.text or "").strip() or None)
        for ch in list(node):
            if isinstance(ch.tag, str):
                walk(ch)

    walk(elem)
    return {k: sorted(list(vals)) for k, vals in seen.items()}

def _strip_ns(tag: str) -> str:
    """Trim XML namespace from a tag like '{ns}ThingDef' → 'ThingDef'."""
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag

def looks_like_def_tag(tag: str) -> bool:
    t = _strip_ns(tag) or ""
    return t.endswith("Def") or t.endswith("DefBase") or t.endswith("RulePackDef")

def infer_member_kind(member_elem: ET.Element) -> str:
    children = [ch for ch in list(member_elem) if isinstance(ch.tag, str)]
    if not children:
        return "Scalar"
    if all(ch.tag == "li" for ch in children):
        if any((c.find("key") is not None and c.find("value") is not None) for c in children):
            return "Map"
        return "List"
    if member_elem.find("key") is not None and member_elem.find("value") is not None:
        return "Map"
    for ch in children:
        if ch.find("key") is not None and ch.find("value") is not None:
            return "Map"
    return "Class"

def accumulate_meta(meta: Dict, def_type: str, elem: ET.Element) -> None:
    """
    Update meta.defTypes[def_type].members with observed members and inferred kinds.
    """
    dt = meta["defTypes"].setdefault(def_type, {"fqcn": def_type, "members": {}})
    members = dt["members"]
    for ch in list(elem):
        if not isinstance(ch.tag, str):
            continue
        name = _strip_ns(ch.tag)
        kind = infer_member_kind(ch)
        prior = members.get(name)
        if prior:
            order = {"Scalar": 0, "List": 1, "Map": 2, "Class": 3}
            if order.get(kind, 0) > order.get(prior["kind"], 0):
                members[name] = {"kind": kind, "type": "unknown"}
        else:
            members[name] = {"kind": kind, "type": "unknown"}

def iter_def_elements(file_path: Path) -> Iterable[ET.Element]:
    """
    Parse XML file and yield *only* elements that look like Defs.
    - If root is <Defs>, yield each child that looks like a Def.
    - If single-root, yield it only if it looks like a Def.
    """
    try:
        tree = ET.parse(file_path)
        root = tree.getroot()
    except Exception as e:
        raise RuntimeError(f"Parse error: {e}")

    root_tag = _strip_ns(root.tag)
    if root_tag == "Defs":
        for ch in list(root):
            if isinstance(ch.tag, str) and looks_like_def_tag(ch.tag):
                yield ch
    else:
        if looks_like_def_tag(root.tag):
            yield root

# ---------- XML file enumeration (pruned deep walk) ----------

def iter_xml_files_pruned(base_dir: Path, prune_dirs_lower: Set[str]) -> Iterable[Path]:
    """
    Yield XML files under base_dir while pruning directories whose *name*
    matches any entry in prune_dirs_lower (case-insensitive).
    """
    base_dir = base_dir.resolve()
    for root, dirnames, filenames in os.walk(base_dir):
        dirnames[:] = [d for d in dirnames if d.lower() not in prune_dirs_lower]
        for fn in filenames:
            if fn.lower().endswith(".xml"):
                yield Path(root) / fn

# ---------- Version autodetect ----------

def _ancestor_with_version_txt(start: Path) -> Optional[Path]:
    """
    Walk up from 'start' to drive root; return the first ancestor
    that contains a Version.txt file.
    """
    cur = start.resolve()
    while True:
        vt = cur / "Version.txt"
        if vt.exists() and vt.is_file():
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent

def detect_rimworld_version(official_roots: List[Path]) -> Optional[str]:
    """
    Try to read Version.txt from the nearest ancestor of any official root.
    If multiple different values are found, return the most frequent one.
    """
    counts: Dict[str, int] = {}
    for r in official_roots or []:
        base = _ancestor_with_version_txt(r)
        if not base:
            continue
        try:
            txt = (base / "Version.txt").read_text(encoding="utf-8", errors="ignore")
            # Use the first non-empty line
            line = next((ln.strip() for ln in txt.splitlines() if ln.strip()), "")
            if line:
                counts[line] = counts.get(line, 0) + 1
        except Exception:
            continue
    if not counts:
        return None
    # Pick the most frequent (stable if only one)
    return max(counts.items(), key=lambda kv: kv[1])[0]

# ---------- Build layer ----------

def build_layer(layer_name: str,
                roots: List[Path],
                out_dir: Path,
                meta: Dict,
                prune_dirs_lower: Set[str],
                verbose: bool = True,
                deprec_include_patches: bool = False) -> Tuple[int, List[Dict]]:
    if deprec_include_patches:
        if verbose:
            print("ℹ NOTE: --include-patches is now the default and the flag is a no-op.")

    items: List[Dict] = []
    total_defs = 0
    seen_mods: Set[Path] = set()

    for scan_root in roots:
        mod_dirs = discover_mod_dirs(scan_root)
        for mod_dir in mod_dirs:
            real = mod_dir.resolve()
            if real in seen_mods:
                continue
            seen_mods.add(real)

            mod_disp = read_mod_display(mod_dir)

            # Enumerate *all* XML files under this mod, pruned
            xml_files = list(iter_xml_files_pruned(mod_dir, prune_dirs_lower))
            emitted_for_mod = 0

            if verbose:
                print(f"[{layer_name}] {mod_disp}: scanning {len(xml_files)} XML files (pruned dirs: {sorted(prune_dirs_lower)})")

            for xf in xml_files:
                # Skip About.xml quickly (no defs)
                if xf.name.lower() == "about.xml" and xf.parent.name.lower() == "about":
                    continue
                try:
                    for def_elem in iter_def_elements(xf):
                        def_type = _strip_ns(def_elem.tag)
                        def_name = extract_def_name(def_elem) or ""
                        xml_str = pretty_xml_of_element(def_elem)
                        tag_map = collect_tag_map(def_elem)

                        accumulate_meta(meta, def_type, def_elem)

                        item = {
                            "defType": def_type,
                            "defName": def_name,
                            "modDisplay": mod_disp,
                            "layer": layer_name,
                            "path": str(xf.relative_to(mod_dir).as_posix()) if is_within(xf, mod_dir) else xf.name,
                            "absPath": xf.as_posix(),
                            "xml": xml_str,
                            "tagMap": tag_map,
                        }
                        items.append(item)
                        emitted_for_mod += 1
                        total_defs += 1
                except Exception as e:
                    print(f"  ! Error in {xf}: {e}")

            if verbose:
                print(f"    → emitted {emitted_for_mod} defs from {mod_disp}")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"items.{layer_name}.json"
    out_path.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if verbose:
        print(f"  → wrote {out_path} ({len(items)} items, {total_defs} defs emitted)")
    return total_defs, items

# ---------- Main ----------

def main():
    ap = argparse.ArgumentParser(description="Convert RimWorld Defs XML into Explorer JSONs.")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH,
                    help="Path to rimdefs.config.json (default: tools/rimdefs.config.json)")

    # CLI overrides (None means 'not provided' → use config/built-in)
    ap.add_argument("--official", nargs="*", type=str, default=None,
                    help="Official/Core/DLC roots (e.g., .../RimWorld/Data).")
    ap.add_argument("--workshop", nargs="*", type=str, default=None,
                    help="Workshop roots (e.g., .../workshop/content/294100).")
    ap.add_argument("--dev", nargs="*", type=str, default=None,
                    help="Local dev mods roots.")
    ap.add_argument("--out", type=str, default=None,
                    help="Output folder for JSON artifacts (default guessed).")
    ap.add_argument("--version", type=str, default=None,
                    help="Explicit RimWorld version to store in rim_meta.json (overrides autodetect).")

    # Scanning controls
    ap.add_argument("--include-languages", action="store_true",
                    help="Also scan Languages/**.xml (disabled by default for performance).")
    ap.add_argument("--exclude", nargs="*", type=str, default=None,
                    help="Additional directory names to exclude (case-insensitive).")

    # Back-compat (no-op)
    ap.add_argument("--include-patches", action="store_true",
                    help="Deprecated: patches are scanned by default; this flag is a no-op.")

    # Version autodetect control
    ap.add_argument("--no-auto-version", action="store_true",
                    help="Disable Version.txt autodetection (use CLI/config/built-in).")

    ap.add_argument("--quiet", action="store_true", help="Reduce log noise.")
    ap.add_argument("--save-config", action="store_true",
                    help="Persist the effective settings back to the config file.")
    ap.add_argument("--write-default-config", action="store_true",
                    help="Write a fresh default config (overwrites existing).")
    ap.add_argument("--print-config", action="store_true",
                    help="Print the effective settings and exit.")
    args = ap.parse_args()

    cfg_path: Path = args.config
    if args.write_default_config:
        write_config(cfg_path, BUILTIN_DEFAULTS)
        print(f"✔ Wrote default config to {cfg_path}")
        return

    cfg = load_config(cfg_path) or ensure_default_config(cfg_path)
    base_for_rel = cfg_path.parent

    official = _norm_path_list(
        args.official if args.official is not None else cfg.get("official", BUILTIN_DEFAULTS["official"]),
        base_for_rel
    )
    workshop = _norm_path_list(
        args.workshop if args.workshop is not None else cfg.get("workshop", BUILTIN_DEFAULTS["workshop"]),
        base_for_rel
    )
    dev = _norm_path_list(
        args.dev if args.dev is not None else cfg.get("dev", BUILTIN_DEFAULTS["dev"]),
        base_for_rel
    )

    out_dir = (
        Path(args.out) if args.out is not None
        else (base_for_rel / cfg.get("out")).resolve() if "out" in cfg
        else DEFAULT_OUT
    ).resolve()

    # Version precedence: CLI > auto-detect > config > built-in
    detected_version = None if args.no_auto_version else detect_rimworld_version(official)
    version = (
        args.version if args.version is not None
        else detected_version if detected_version
        else cfg.get("version", BUILTIN_DEFAULTS["version"])
    )

    if args.print_config:
        print("Effective configuration:")
        print(f"  official: {[p.as_posix() for p in official]}")
        print(f"  workshop: {[p.as_posix() for p in workshop]}")
        print(f"  dev     : {[p.as_posix() for p in dev]}")
        print(f"  out     : {out_dir.as_posix()}")
        print(f"  version : {version}")
        print(f"  detectedVersion: {detected_version or '(none)'}")
        print(f"  scan    : include_languages={args.include_languages}, extra_excludes={args.exclude or []}")
        return

    if args.save_config:
        new_cfg = {
            "official": _to_config_strings(official, base_for_rel),
            "workshop": _to_config_strings(workshop, base_for_rel),
            "dev": _to_config_strings(dev, base_for_rel),
            "out": _to_config_strings([out_dir], base_for_rel)[0],
            # Save the resolved value so the UI can display it later if needed
            "version": version
        }
        write_config(cfg_path, new_cfg)
        print(f"✔ Saved configuration to {cfg_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    verbose = not args.quiet

    # Build prune set
    prune = set(DEFAULT_PRUNE_DIRS)
    if args.include_languages and "languages" in prune:
        prune.remove("languages")
    if args.exclude:
        prune.update(n.lower() for n in args.exclude)

    # Base rim_meta skeleton
    meta = {
        "version": version,
        "defTypes": {},
        "enums": {},
        "types": {}
    }

    grand_total = 0
    layers = [
        ("official", official),
        ("workshop", workshop),
        ("dev", dev),
    ]
    for layer_name, layer_roots in layers:
        if not layer_roots:
            (out_dir / f"items.{layer_name}.json").write_text("[]", encoding="utf-8")
            if verbose:
                print(f"[{layer_name}] no roots provided; wrote empty list.")
            continue
        if verbose:
            roots_list = ", ".join(r.as_posix() for r in layer_roots)
            print(f"=== Building layer: {layer_name} ===")
            print(f"    Roots: {roots_list}")
            if detected_version and layer_name == "official":
                print(f"    Detected Version.txt: {detected_version}")
        total_defs, _ = build_layer(
            layer_name,
            layer_roots,
            out_dir,
            meta,
            prune_dirs_lower=prune,
            verbose=verbose,
            deprec_include_patches=args.include_patches
        )
        grand_total += total_defs

    # Write meta
    meta_path = out_dir / "rim_meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"→ wrote {meta_path} (defTypes: {len(meta['defTypes'])}, total defs observed: {grand_total})")

    print("✔ Done.")

if __name__ == "__main__":
    main()

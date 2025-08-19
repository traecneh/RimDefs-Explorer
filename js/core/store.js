// Store: loads artifacts safely, maintains filters/prefs, indexes data, and exposes it to Explorer.
// Robust to missing /data/*.json and designed to work with boot.js + detailsView usage patterns.

import { parseQuery } from './search.js'; // only for initial compile; boot.js supplies matches()

const LS_KEY = 'rimdefs.prefs.v1';

const defaultPrefs = {
  searchQuery: '',
  sidebarVisible: true,
  // master visibility per source
  srcFilters: { official: true, workshop: true, dev: true },
  // per-mod excludes
  modExcludes: { official: {}, workshop: {}, dev: {} },
  // def types selection
  defTypeFilters: {},     // empty = all on
  defTypesAllOn: true,    // master switch
  // collapsed groups by defType
  collapsed: {}
};

function readPrefs() {
  try { return { ...defaultPrefs, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) }; }
  catch { return { ...defaultPrefs }; }
}
function writePrefs(p) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {}
}

// --- safe fetch that never throws and never returns non-JSON ---
// (Handles cases where server returns HTML like "<!doctype ...>" by falling back to [])
async function safeJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    if (!ct.includes('application/json')) {
      try { return JSON.parse(text); } catch { return []; }
    }
    return JSON.parse(text);
  } catch (e) {
    console.warn('safeJson: returning [] for', url, e);
    return [];
  }
}

function uniqSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

// Key generator (stable-ish across reloads for same record)
function makeKey(it, idx) {
  const dn = (it.defName || '').replace(/\s+/g, ' ').trim();
  return `${it.layer}|${it.modDisplay}|${it.defType}|${dn}|${idx}`;
}

// Build byKey map and helpers
function indexItems(itemsAll) {
  const byKey = new Map();
  const defTypes = uniqSorted(itemsAll.map(it => it.defType).filter(Boolean));

  itemsAll.forEach((it, i) => {
    const key = makeKey(it, i);
    it.key = key;
    byKey.set(key, it);
  });

  // mods per layer
  const modsByLayer = { official: new Set(), workshop: new Set(), dev: new Set() };
  for (const it of itemsAll) {
    if (it && it.layer && it.modDisplay) modsByLayer[it.layer]?.add(it.modDisplay);
  }
  const modsList = {
    official: Array.from(modsByLayer.official).sort(),
    workshop: Array.from(modsByLayer.workshop).sort(),
    dev: Array.from(modsByLayer.dev).sort()
  };

  return { byKey, defTypes, modsList };
}

// Heuristic: harvest obvious defRef candidates from XML text.
// We keep this light: look for <ThingDef>Steel</ThingDef>, <ThingDefName>Steel</ThingDefName>
// and attributes like PawnKindDef="Raider", StuffDef="Steel", etc.
function scanDefRefCandidates(xml, findDefFn, max = 64) {
  if (!xml) return [];
  const out = [];
  const seen = new Set();

  // 1) <ThingDef>Steel</ThingDef>
  const rxTagDef = /<\s*([A-Za-z_][\w\.]*?Def)\s*>\s*([^<]+?)\s*<\/\s*\1\s*>/g;
  // 2) <ThingDefName>Steel</ThingDefName>  → defType = ThingDef
  const rxTagDefName = /<\s*([A-Za-z_][\w\.]*?Def)Name\s*>\s*([^<]+?)\s*<\/\s*\1Name\s*>/g;
  // 3) attributes ... FooDef="Steel" / FooDefName="Steel"
  const rxAttr = /([A-Za-z_][\w\.]*?Def(Name)?)\s*=\s*"([^"]+)"/g;

  const push = (defType, defName) => {
    const k = `${defType}|${defName}`;
    if (seen.has(k)) return;
    // Only include refs that actually exist (using the provided resolver)
    if (findDefFn && !findDefFn(defType, defName)) return;
    seen.add(k);
    out.push({ defType, defName });
  };

  let m;
  while ((m = rxTagDef.exec(xml)) && out.length < max) {
    push(m[1], m[2].trim());
  }
  while ((m = rxTagDefName.exec(xml)) && out.length < max) {
    push(m[1], m[2].trim()); // m[1] already w/o trailing "Name"
  }
  while ((m = rxAttr.exec(xml)) && out.length < max) {
    const name = m[1];
    const isName = /DefName$/.test(name);
    const defType = isName ? name.replace(/DefName$/, 'Def') : name; // PawnKindDefName → PawnKindDef
    push(defType, m[3].trim());
  }
  return out;
}

export async function createStore() {
  // Load artifacts safely. Missing files become [].
  const [oRaw, wRaw, dRaw, metaRaw] = await Promise.all([
    safeJson('/data/items.official.json'),
    safeJson('/data/items.workshop.json'),
    safeJson('/data/items.dev.json'),
    safeJson('/data/rim_meta.json')
  ]);

  const ensureLayer = (arr, layer) => (arr || []).map(x => (x && x.layer ? x : { ...x, layer }));
  const itemsAll = []
    .concat(ensureLayer(oRaw, 'official'))
    .concat(ensureLayer(wRaw, 'workshop'))
    .concat(ensureLayer(dRaw, 'dev'));

  // Internal state (underscore = private backing fields)
  const prefs = readPrefs();                         // keep identity stable; mutate in place
  let _compiled = parseQuery(prefs.searchQuery || '');
  let _filteredFlat = [];
  let _selectedKey = null;
  let _selected = null;
  let _meta = (metaRaw && typeof metaRaw === 'object') ? metaRaw : null;

  // Indexes
  let { byKey: _byKey, defTypes: _defTypes, modsList: _modsList } = indexItems(itemsAll);

  // ---------- helpers used by Explorer (boot.js & detailsView) ----------

  function updatePrefs(next) {
    if (!next) return;
    // Mutate in place so existing references (store.prefs.*) remain valid
    Object.assign(prefs, next);
    writePrefs(prefs);
  }

  function modsFor(layer) {
    const names = _modsList[layer] || [];
    return names.map(name => ({ name }));
  }

  function setCompiledQuery(c) { _compiled = c || null; }

  // Visibility checks (for list filtering only)
  function isTypeVisible(defType) {
    if (prefs.defTypesAllOn === false) return false;
    const map = prefs.defTypeFilters || {};
    const keys = Object.keys(map).filter(k => map[k]);
    if (keys.length === 0) return true; // none specified = all on
    return !!map[defType];
  }
  function isSourceVisible(it) {
    if (!prefs.srcFilters?.[it.layer]) return false;
    const ex = prefs.modExcludes?.[it.layer] || {};
    if (ex[it.modDisplay]) return false;
    return true;
  }

  function computeFiltered({ matchesFn }) {
    const groups = new Map();

    for (const it of _byKey.values()) {
      if (!isSourceVisible(it)) continue;
      if (!isTypeVisible(it.defType)) continue;
      if (_compiled && matchesFn && !matchesFn(it, _compiled)) continue;

      if (!groups.has(it.defType)) groups.set(it.defType, []);
      groups.get(it.defType).push(it);
    }

    // Build flat list with collapsible groups
    const flat = [];
    const sortedTypes = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

    for (const dt of sortedTypes) {
      const list = groups.get(dt);
      const collapsed = !!prefs.collapsed?.[dt];
      flat.push({ __group: true, defType: dt, count: list.length, collapsed });
      if (!collapsed) {
        // deterministic order: by defName then by mod
        list.sort((a, b) =>
          (a.defName || '').localeCompare(b.defName || '') ||
          (a.modDisplay || '').localeCompare(b.modDisplay || '')
        );
        for (const it of list) flat.push(it);
      }
    }

    _filteredFlat = flat;
    return flat;
  }

  function setSelected(key) {
    _selectedKey = key || null;
    _selected = _selectedKey ? _byKey.get(_selectedKey) : null;
  }

  // Resolver that respects *current* source/mod visibility (kept for callers that want it)
  function findDef(defType, defName) {
    const targetName = String(defName || '').trim();
    if (!targetName) return null;
    for (const it of _byKey.values()) {
      if (it.defType !== defType) continue;
      if (it.defName !== targetName) continue;
      if (!isSourceVisible(it)) continue;
      return it;
    }
    return null;
  }

  // NEW: Resolver that ignores visibility filters (useful for XML linking)
  function findDefAny(defType, defName) {
    const targetName = String(defName || '').trim();
    if (!targetName) return null;
    for (const it of _byKey.values()) {
      if (it.defType === defType && it.defName === targetName) return it;
    }
    return null;
  }

  async function reloadData() {
    const [o, w, d, m] = await Promise.all([
      safeJson('/data/items.official.json'),
      safeJson('/data/items.workshop.json'),
      safeJson('/data/items.dev.json'),
      safeJson('/data/rim_meta.json')
    ]);

    const merged = []
      .concat(ensureLayer(o, 'official'))
      .concat(ensureLayer(w, 'workshop'))
      .concat(ensureLayer(d, 'dev'));

    ({ byKey: _byKey, defTypes: _defTypes, modsList: _modsList } = indexItems(merged));
    _meta = (m && typeof m === 'object') ? m : _meta;

    // Keep selection if possible
    if (_selectedKey && !_byKey.has(_selectedKey)) { _selectedKey = null; _selected = null; }
    else if (_selectedKey) { _selected = _byKey.get(_selectedKey) || null; }
  }

  // Public API (live getters to avoid stale snapshots)
  return {
    // data (live)
    get byKey() { return _byKey; },
    get defTypes() { return _defTypes; },
    get filteredFlat() { return _filteredFlat; },

    // preferences (live)
    get prefs() { return prefs; },
    updatePrefs,

    // querying
    get compiledQuery() { return _compiled; },
    setCompiledQuery,
    computeFiltered,

    // selection (live)
    setSelected,
    get selected() { return _selected; },
    get selectedKey() { return _selectedKey; },

    // utilities
    findDef,          // respects visibility (for list-sensitive use)
    findDefAny,       // ignores visibility (use in XML links)
    modsFor,
    reloadData,

    // meta/types (for C# insight & tooltips)
    get meta() { return _meta; },
    defRefCandidatesFromText(xml) {
      // Use the new visibility-agnostic resolver here as well.
      return scanDefRefCandidates(String(xml || ''), findDefAny);
    },

    // meta
    get size() { return _byKey.size; }
  };
}

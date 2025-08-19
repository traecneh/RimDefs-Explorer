const KEY = 'rimdefs.prefs.v1';

const defaults = {
  sidebarVisible: true,
  srcFilters: { official: true, workshop: true, dev: true },
  modExcludes: { official: {}, workshop: {}, dev: {} },
  // NEW: master switch for DefTypes (true = all ON, false = all OFF)
  defTypesAllOn: true,
  defTypeFilters: {},     // name->true (whitelist). Empty + defTypesAllOn=true => include all.
  searchQuery: '',
  collapsed: {},          // defType -> true (collapsed)
  selectedKey: null
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    const p = JSON.parse(raw);
    return {
      ...defaults,
      ...p,
      srcFilters: { ...defaults.srcFilters, ...(p.srcFilters||{}) },
      modExcludes: {
        official: { ...(p.modExcludes?.official||{}) },
        workshop: { ...(p.modExcludes?.workshop||{}) },
        dev:      { ...(p.modExcludes?.dev||{}) }
      },
      collapsed: { ...(p.collapsed||{}) }
    };
  } catch {
    return { ...defaults };
  }
}

export function savePrefs(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}

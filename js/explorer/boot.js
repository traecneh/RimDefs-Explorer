import { h, clear, on } from '../core/dom.js';
import { parseQuery, matches as matchesRec } from '../core/search.js';
import { srcColor, modColor, defTypeColor } from '../core/colors.js';
import { makePill } from '../ui/badges.js';
import { createDetailsView } from './detailsView.js';

function debounce(fn, ms = 120) { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
const enc = (s)=> encodeURIComponent(s);
const dec = (s)=> decodeURIComponent(s||'');

// number formatter
const fmt = (n)=> new Intl.NumberFormat().format(n);

// Resolve a defName robustly from multiple sources.
function getDefName(row) {
  if (row && typeof row.defName === 'string' && row.defName.trim()) return row.defName.trim();
  if (row && row.tagMap && typeof row.tagMap.defName === 'string' && row.tagMap.defName.trim()) return row.tagMap.defName.trim();
  if (row && typeof row.xml === 'string') {
    const m = /<\s*defName\s*>\s*([^<]+)\s*<\/\s*defName\s*>/i.exec(row.xml);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

export function bootExplorer(container, store, statusEl) {
  if (!container) return;
  clear(container);

  // Ensure grid rules apply even if HTML missed the class
  container.classList.add('app-shell');

  // --- Layout (three panels) ---
  const sidebar   = h('section', { class: 'panel sidebar', id: 'filtersPanel', role: 'region', 'aria-label': 'Filters' });
  const listPanel = h('section', { class: 'panel scroll',  role: 'region', 'aria-label': 'Results' });
  const details   = h('section', { class: 'panel details', role: 'region', 'aria-label': 'Details' });
  container.append(sidebar, listPanel, details);

  // Snap the document (and details panel) to the very top.
  function jumpToTop() {
    // Instant jump (no smooth scrolling)
    try { window.scrollTo(0, 0); } catch { /* ignore */ }
    // Also reset the details panel's own scroll, in case it's tall
    try { details.scrollTop = 0; } catch { /* ignore */ }
  }



  // ===== Results toolbar (counts + Toggle Groups) =====
  const rtCountsItems  = h('span', { id: 'rt-items'  }, '0 items');
  const rtCountsGroups = h('span', { id: 'rt-groups' }, '0 groups');
  const toggleGroupsBtn = h('button', { class: 'mini', id: 'toggleGroupsBtn', title: 'Collapse/Expand all groups' }, 'Toggle Groups');

  const resultsToolbar = h('div', { class: 'results-toolbar' },
    h('div', { class: 'counts' }, rtCountsItems, '•', rtCountsGroups),
    h('span', { class: 'spacer' }),
    toggleGroupsBtn
  );
  const listWrap = h('div', { class: 'list' });
  listPanel.append(resultsToolbar, listWrap);

  // Keep sticky offset correct
  function setResultsOffsets() {
    const cs = getComputedStyle(resultsToolbar);
    const mt = parseFloat(cs.marginTop) || 0;
    const mb = parseFloat(cs.marginBottom) || 0;
    const top = resultsToolbar.offsetHeight + mt + mb;
    listPanel.style.setProperty('--rtTop', `${top}px`);
  }
  setResultsOffsets();
  window.addEventListener('resize', setResultsOffsets);

  // ===== Filters column (sources + types) =====
  const srcBank = h('div', { class: 'filter-bank', id: 'sourceBank' },
    h('h4', {}, 'Source'),
    buildLayerSection('official', 'Official', { withSearch: false }),
    buildLayerSection('workshop','Workshop', { withSearch: true  }),
    buildLayerSection('dev',      'Dev',      { withSearch: false })
  );

  function buildLayerSection(layer, title, { withSearch }) {
    const headerRow = h('div', { class: 'subheader' },
      // Informational master chip (non-interactive)
      h('span', { class: 'chip', dataset: { layerMaster: layer } },
        h('span', { class: 'dot', style: `background:${srcColor(layer)}` }),
        title,
        h('span', { class: 'count' }, '0')
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'mini', dataset: { action: 'toggle', layer }, title: 'Toggle all on/off' }, 'Toggle')
    );

    const toolRow = withSearch
      ? h('div', { class: 'toolrow' },
          h('input', {
            class: 'mini-search',
            id: `modFilter-${layer}`,
            placeholder: 'Filter mods…',
            'aria-label': `Filter ${title} mods`
          })
        )
      : null;

    const chipsWrap = h('div', { class: 'modlist', id: `mods-${layer}` });
    const mods = store.modsFor(layer);
    const ex = store.prefs.modExcludes?.[layer] || {};
    chipsWrap.append(...mods.map(({name}) => h('span', {
      class: 'chip line',
      'data-active': String(!ex[name]),
      'aria-pressed': String(!ex[name]),
      tabindex: '0', role: 'button',
      title: name,
      dataset: { mod: enc(name), layer, label: name.toLowerCase() }
    },
      h('span', { class: 'dot', style: `background:${modColor(layer, name)}` }),
      h('span', { class: 'label' }, name),
      h('span', { class: 'count' }, '0')
    )));

    const section = h('div', { class: 'filter-sub', dataset: { layer } },
      headerRow, ...(toolRow ? [toolRow] : []), chipsWrap
    );

    if (withSearch) {
      const input = section.querySelector(`#modFilter-${layer}`);
      input?.addEventListener('input', () => {
        const needle = (input.value || '').toLowerCase().trim();
        const wrap = section.querySelector(`#mods-${layer}`);
        wrap?.querySelectorAll('.chip[data-mod]')?.forEach(chip => {
          chip.style.display = (!needle || (chip.dataset.label||'').includes(needle)) ? '' : 'none';
        });
      });
    }
    return section;
  }

  // ===== DefTypes bank + Toggle =====
  const typeHeader = h('div', { class: 'subheader' },
    h('span', { class: 'chip' },
      h('span', { class: 'dot', style: `background:${defTypeColor()}` }),
      'DefTypes'
    ),
    h('span', { class: 'spacer' }),
    h('button', { class: 'mini', dataset: { action: 'toggle-defTypes' }, title: 'Toggle all types on/off' }, 'Toggle')
  );

  const typeFilterBox = h('input', { class: 'mini-search', id: 'filter-defTypes', placeholder: 'Filter types…', 'aria-label': 'Filter def types' });
  const typeChips = h('div', { class: 'typelist', id: 'defTypeChips' });
  const typeBank  = h('div', { class: 'filter-bank' }, h('h4', {}, 'DefTypes'), typeHeader, typeFilterBox, typeChips);

  const sidebarWrap = h('div', { class: 'filters' }, srcBank, typeBank);
  sidebar.append(sidebarWrap);

  // ===== Details view =====
  const detailsView = createDetailsView(store);
  details.append(detailsView.el);

  // ===== Header search =====
  const qInput = document.getElementById('q');
  if (qInput) {
    qInput.value = store.prefs.searchQuery || '';
    const debouncedSearch = debounce(() => compileAndSearch('search'), 120);
    qInput.addEventListener('input', debouncedSearch);
    window.addEventListener('keydown', (ev) => {
      const isTyping = document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName);
      if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !isTyping) { ev.preventDefault(); qInput.focus(); qInput.select(); }
      else if (ev.key === 'Escape' && document.activeElement === qInput) { qInput.value = ''; compileAndSearch('search'); }
    });
  }

  // ===== Filters toggle (header) =====
  const toggleBtn = document.getElementById('toggleFilters');

  applySidebarVisibility(!!store.prefs.sidebarVisible);
  function applySidebarVisibility(v) {
    container.classList.toggle('sidebar-hidden', !v);
    toggleBtn?.setAttribute('aria-expanded', String(v));
    toggleBtn?.setAttribute('aria-pressed', String(v));
  }
  function toggleSidebar() {
    const next = !store.prefs.sidebarVisible; // live via getter now
    store.updatePrefs({ sidebarVisible: next });
    applySidebarVisibility(next);
  }
  toggleBtn?.addEventListener('click', toggleSidebar);
  toggleBtn?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleSidebar(); } });
  window.addEventListener('keydown', (ev) => {
    const isTyping = document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName);
    if (!isTyping && (ev.key === 'f' || ev.key === 'F')) toggleSidebar();
  });

  // ===== Behavior =====
  function compileAndSearch(cause) {
    const q = qInput ? (qInput.value || '') : '';
    store.updatePrefs({ searchQuery: q });
    const compiled = parseQuery(q);
    store.setCompiledQuery(compiled);
    computeAndRenderList({ avoidFocus: cause === 'search' });
  }

  function computeAndRenderList({ avoidFocus = false } = {}) {
    const flat = store.computeFiltered({ matchesFn: matchesRec });
    renderDefTypeChips();
    renderList(flat);
    updateCountsUI();

    const sel = store.selected;
    const activeIsSearch = document.activeElement === qInput;

    if (!sel) {
      const firstItem = flat.find(x => !x.__group);
      if (firstItem) {
        store.setSelected(firstItem.key);
        renderDetails(firstItem);
        if (!avoidFocus && !activeIsSearch) focusSelectedInList();
      }
    } else {
      renderDetails(sel);
      if (!avoidFocus && !activeIsSearch) focusSelectedInList(false);
    }

    if (statusEl) statusEl.textContent = `${flat.filter(x=>!x.__group).length} items`;
  }

  function renderDefTypeChips() {
    if (typeChips.childElementCount) return;
    const selMap = store.prefs.defTypeFilters || {};
    typeChips.append(...store.defTypes.map(dt => h('span', {
      class: 'chip line',
      'data-active': String(store.prefs.defTypesAllOn !== false && (!!selMap[dt] || Object.keys(selMap).length === 0)),
      tabindex: '0', role: 'button',
      'aria-pressed': 'true',
      dataset: { deftype: dt, label: dt.toLowerCase() }
    },
      h('span', { class: 'dot', style: `background:${defTypeColor()}` }),
      h('span', { class: 'label' }, dt)
    )));

    typeFilterBox.addEventListener('input', () => {
      const needle = (typeFilterBox.value || '').toLowerCase().trim();
      for (const chip of typeChips.querySelectorAll('.chip')) {
        chip.style.display = (!needle || (chip.dataset.label||'').includes(needle)) ? '' : 'none';
      }
    });
  }

  function renderList(flat) {
    clear(listWrap);

    // counts that ignore collapse
    let groupCount = 0, itemCount = 0;
    for (const r of flat) { if (r.__group) { groupCount++; itemCount += (r.count || 0); } }
    rtCountsItems.textContent  = `${fmt(itemCount)} item${itemCount===1?'':'s'}`;
    rtCountsGroups.textContent = `${fmt(groupCount)} group${groupCount===1?'':'s'}`;

    const compiled = store.compiledQuery;

    for (const row of flat) {
      if (row.__group) {
        listWrap.append(
          h('div', { class: 'group', 'data-collapsed': String(row.collapsed), dataset: { deftype: row.defType } },
            h('div', { class: 'group-header', tabindex: '0' },
              h('span', { class: 'tri' }),
              h('span', { class: 'group-title' }, row.defType),
              h('span', { class: 'group-count' }, String(row.count))
            ),
            h('div', { class: 'items' })
          )
        );
        continue;
      }

      const itemsEl = listWrap.lastElementChild?.querySelector('.items');
      if (!itemsEl) continue;

      const dn = getDefName(row);
      const titleHTML = dn ? (compiled?.highlighters?.highlight(dn) || dn) : '(no defName)';
      const sel = store.selected && store.selected.key === row.key;

      itemsEl.append(
        h('div', {
          class: 'item',
          role: 'option',
          'aria-selected': String(!!sel),
          tabindex: '0',
          dataset: { key: row.key }
        },
          h('div', {}, h('div', { class: 'title', innerHTML: titleHTML })),
          h('div', { class: 'pills' }, makePill('mod', row.modDisplay, modColor(row.layer, row.modDisplay)))
        )
      );
    }
  }

  function renderDetails(item) { detailsView.setItem(item); }

  function focusSelectedInList(scrollIntoView = true) {
    const el = listWrap.querySelector(`.item[aria-selected="true"]`);
    if (!el) return;
    if (scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    el.focus({ preventScroll: !scrollIntoView });
  }

  // ===== Counts respecting ALL filters (used for counts in Source bank) =====
  function computeCounts() {
    const perMod = { official: new Map(), workshop: new Map(), dev: new Map() };
    const totals = { official: 0, workshop: 0, dev: 0 };

    if (store.prefs.defTypesAllOn === false) return { perMod, totals };

    const srcFilters = store.prefs.srcFilters || { official:true, workshop:true, dev:true };
    const modEx = store.prefs.modExcludes || { official:{}, workshop:{}, dev:{} };
    const map = store.prefs.defTypeFilters || {};
    const typeSet = new Set(Object.entries(map).filter(([,v])=>v).map(([k])=>k));
    const considerType = (t) => typeSet.size === 0 || typeSet.has(t);

    for (const it of store.byKey.values()) {
      if (!srcFilters[it.layer]) continue;
      if (modEx[it.layer]?.[it.modDisplay]) continue;
      if (!considerType(it.defType)) continue;
      if (store.compiledQuery && !matchesRec(it, store.compiledQuery)) continue;

      const layerMap = perMod[it.layer]; if (!layerMap) continue;
      const name = it.modDisplay || '(unnamed)';
      layerMap.set(name, (layerMap.get(name) || 0) + 1);
      totals[it.layer] += 1;
    }
    return { perMod, totals };
  }

  function updateCountsUI() {
    const { perMod, totals } = computeCounts();

    // per-mod chips
    for (const layer of ['official','workshop','dev']) {
      const wrap = srcBank.querySelector(`#mods-${layer}`); if (!wrap) continue;
      for (const chip of wrap.querySelectorAll('.chip[data-mod]')) {
        const name = dec(chip.dataset.mod);
        const n = perMod[layer].get(name) || 0;
        const el = chip.querySelector('.count');
        if (el) el.textContent = String(n);
        chip.classList.toggle('zero', n === 0);
      }
      // master chip count
      const masterCountEl = srcBank.querySelector(`.subheader .chip[data-layer-master="${layer}"] .count`);
      if (masterCountEl) masterCountEl.textContent = String(totals[layer] || 0);
    }
  }

  // ===== Events: Toggle Groups =====
  toggleGroupsBtn.addEventListener('click', () => {
    const groups = store.filteredFlat.filter(x => x.__group).map(g => g.defType);
    const anyOpen = groups.some(dt => !store.prefs.collapsed[dt]);
    for (const dt of groups) store.prefs.collapsed[dt] = anyOpen ? true : false;
    store.updatePrefs({ collapsed: store.prefs.collapsed });
    computeAndRenderList({ avoidFocus: true });
  });

  // ===== Events: Source bank =====
  on(srcBank, 'click', '.mini[data-action="toggle"]', (_, btn) => {
    const layer = btn.dataset.layer; if (!layer) return;
    const chips = Array.from(srcBank.querySelectorAll(`#mods-${layer} .chip[data-mod]`));
    const allOn = chips.every(chip => chip.getAttribute('data-active') === 'true');

    if (allOn) {
      const ex = {};
      for (const chip of chips) {
        const name = dec(chip.dataset.mod);
        ex[name] = true;
        chip.setAttribute('data-active','false'); chip.setAttribute('aria-pressed','false');
      }
      store.prefs.modExcludes[layer] = ex;
    } else {
      for (const chip of chips) {
        chip.setAttribute('data-active','true'); chip.setAttribute('aria-pressed','true');
      }
      store.prefs.modExcludes[layer] = {};
    }
    store.updatePrefs({ modExcludes: store.prefs.modExcludes });
    compileAndSearch('filters');
  });

  on(srcBank, 'click', '.chip[data-mod]', (_, chip) => toggleModChip(chip));
  on(srcBank, 'keydown', '.chip[data-mod]', (ev, chip) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleModChip(chip); } });
  function toggleModChip(chip) {
    const layer = chip.dataset.layer;
    const name = dec(chip.dataset.mod);
    const ex = store.prefs.modExcludes[layer] || (store.prefs.modExcludes[layer] = {});
    const isActive = chip.getAttribute('data-active') === 'true';
    if (isActive) { ex[name] = true;  chip.setAttribute('data-active','false'); chip.setAttribute('aria-pressed','false'); }
    else          { delete ex[name];   chip.setAttribute('data-active','true');  chip.setAttribute('aria-pressed','true'); }
    store.updatePrefs({ modExcludes: store.prefs.modExcludes });
    compileAndSearch('filters');
  }

  // ===== Events: DefTypes =====
  on(typeBank, 'click', '.mini[data-action="toggle-defTypes"]', () => {
    const allOn = store.prefs.defTypesAllOn !== false;
    if (allOn) {
      store.prefs.defTypesAllOn = false;
      store.prefs.defTypeFilters = {};
      typeChips.querySelectorAll('.chip').forEach(ch => ch.setAttribute('data-active','false'));
    } else {
      store.prefs.defTypesAllOn = true;
      store.prefs.defTypeFilters = {};
      typeChips.querySelectorAll('.chip').forEach(ch => ch.setAttribute('data-active','true'));
    }
    store.updatePrefs({ defTypesAllOn: store.prefs.defTypesAllOn, defTypeFilters: store.prefs.defTypeFilters });
    compileAndSearch('filters');
  });

  on(typeChips, 'click', '.chip', (_, chip) => toggleTypeChip(chip));
  on(typeChips, 'keydown', '.chip', (ev, chip) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleTypeChip(chip); } });
  function toggleTypeChip(chip) {
    if (store.prefs.defTypesAllOn === false) {
      store.prefs.defTypesAllOn = true;
      const cur = chip.getAttribute('data-active') === 'true';
      chip.setAttribute('data-active', String(!cur));
    } else {
      const cur = chip.getAttribute('data-active') === 'true';
      chip.setAttribute('data-active', String(!cur));
    }
    const actives = Array.from(typeChips.querySelectorAll('.chip'))
      .filter(ch => ch.getAttribute('data-active') === 'true')
      .map(ch => ch.dataset.deftype);
    if (actives.length === store.defTypes.length) store.prefs.defTypeFilters = {};
    else { const map = {}; for (const k of actives) map[k] = true; store.prefs.defTypeFilters = map; }
    store.updatePrefs({ defTypesAllOn: store.prefs.defTypesAllOn, defTypeFilters: store.prefs.defTypeFilters });
    compileAndSearch('filters');
  }

  // ===== List interactions =====
  on(listPanel, 'click', '.group-header', (_, gh) => toggleGroup(gh));
  on(listPanel, 'keydown', '.group-header', (ev, gh) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleGroup(gh); } });
  function toggleGroup(gh) {
    const group = gh.closest('.group');
    const dt = group.dataset.deftype;
    const collapsed = group.getAttribute('data-collapsed') === 'true';
    group.setAttribute('data-collapsed', String(!collapsed));
    store.prefs.collapsed[dt] = !collapsed;
    store.updatePrefs({ collapsed: store.prefs.collapsed });
    computeAndRenderList({ avoidFocus: false });
  }

  on(listPanel, 'click', '.item', (_, el) => selectItemEl(el));
  on(listPanel, 'keydown', '.item', (ev, el) => { if (ev.key === 'Enter') { selectItemEl(el); details.querySelector('.tabpanel')?.focus(); } });
  function selectItemEl(el) {
    const key = el.dataset.key;
    store.setSelected(key);
    listWrap.querySelectorAll('.item[aria-selected="true"]').forEach(n => n.setAttribute('aria-selected','false'));
    el.setAttribute('aria-selected', 'true');
    renderDetails(store.byKey.get(key));
    jumpToTop();                    // <— new line
  }

  listPanel.tabIndex = 0;
  listPanel.addEventListener('keydown', (ev) => {
    if (!['ArrowDown','ArrowUp','j','k'].includes(ev.key)) return;
    ev.preventDefault();
    const flat = store.filteredFlat;
    let idx = flat.findIndex(x => !x.__group && x.key === store.selectedKey);
    if (idx === -1) idx = flat.findIndex(x => !x.__group);
    if (idx === -1) return;
    const dir = (ev.key === 'ArrowDown' || ev.key === 'j') ? 1 : -1;
    let next = idx + dir;
    while (next >= 0 && next < flat.length && flat[next].__group) next += dir;
    if (next < 0 || next >= flat.length) return;
    const item = flat[next];
    store.setSelected(item.key);
    renderDetails(item);
    const el = listWrap.querySelector(`.item[data-key="${item.key}"]`);
    el?.scrollIntoView({ block: 'nearest' });
    el?.focus({ preventScroll: true });
  });


  window.addEventListener('rimdefs:select', (ev) => {
    const key = ev.detail?.key; if (!key) return;
    const it = store.byKey.get(key); if (!it) return;
    store.setSelected(key);
    renderDetails(it);
    const el = listWrap.querySelector(`.item[data-key="${key}"]`);
    if (el) {
      listWrap.querySelectorAll('.item[aria-selected="true"]').forEach(n => n.setAttribute('aria-selected','false'));
      el.setAttribute('aria-selected','true');
      el.scrollIntoView({ block: 'nearest' });
    }
    jumpToTop();                    // <— new line
  });

  // Initial render
  compileAndSearch('init'); // triggers list + counts
}

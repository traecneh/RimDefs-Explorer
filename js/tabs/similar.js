// Tag Values tab: lists tags of the current XML and lets you explore their values
// across *visible* defs via two on-demand tables ("Unique" and "All") with
// click-to-sort (numeric or alpha). Now with pills in All + clickable defName links.

import { h, clear, on } from '../core/dom.js';
import { matches as matchesRec } from '../core/search.js';
import { makePill } from '../ui/badges.js';
import { modColor, defTypeColor } from '../core/colors.js';

// Public entry used by detailsView
export function renderSimilar(item, store) {
  const root = h('div', { class: 'tagvals' });
  if (!item || !item.tagMap) {
    root.append(h('div', { class: 'empty' }, 'No tags found for this XML.'));
    return root;
  }

  // Build the visible item set (respects Source/Mod + DefType + Search; ignores collapse)
  const visItems = visibleItems(store, item.key);

  // Present only *this* XML’s tags/values (excluding some noisy keys)
  const ignore = new Set(['defName', 'label', 'description']);
  const entries = Object.entries(item.tagMap)
    .filter(([k]) => !ignore.has(k))
    .sort(([a], [b]) => a.localeCompare(b));

  // Top part: list of rows (Unique/All buttons, tag name, this XML's value(s))
  const list = h('div', { class: 'tv-list' });
  for (const [tag, values] of entries) {
    const nice = formatVals(values);
    list.append(
      h('div', { class: 'tv-row', dataset: { tag } },
        h('div', { class: 'tv-actions' },
          h('button', { class: 'mini', dataset: { mode: 'unique', tag }, title: 'Show all unique values across visible defs' }, 'Unique'),
          h('button', { class: 'mini', dataset: { mode: 'all', tag },    title: 'Show all values across visible defs' }, 'All')
        ),
        h('div', { class: 'tv-tag' }, tag),
        h('div', { class: 'tv-val', title: nice.full }, nice.short)
      )
    );
  }

  const results = h('div', { class: 'tv-results' },
    h('div', { class: 'tv-hint muted' }, 'Pick “Unique” or “All” to inspect values across visible defs.')
  );

  root.append(list, results);

  // Interactions: click buttons to build the table
  on(list, 'click', 'button.mini', (_, btn) => {
    const tag = btn.dataset.tag;
    const mode = btn.dataset.mode; // 'unique' | 'all'
    if (!tag || !mode) return;

    // Prepare dataset
    let tableModel;
    if (mode === 'unique') {
      tableModel = datasetUnique(visItems, tag);
    } else {
      tableModel = datasetAll(visItems, tag);
    }

    // Render header + table
    clear(results);
    const table = buildSortableTable(tableModel, store).el;
    results.append(
      h('div', { class: 'tv-title' },
        h('strong', {}, tag), ' — ',
        mode === 'unique' ? 'Unique values' : 'All values',
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted' }, `${tableModel.rows.length} row${tableModel.rows.length === 1 ? '' : 's'}`)
      ),
      table
    );
  });

  return root;
}

/* --------------------------- data building --------------------------- */

function visibleItems(store, excludeKey) {
  const prefs = store.prefs || {};
  const srcFilters = prefs.srcFilters || { official: true, workshop: true, dev: true };
  const modEx = prefs.modExcludes || { official: {}, workshop: {}, dev: {} };
  const map = prefs.defTypeFilters || {};
  const typeSet = new Set(Object.entries(map).filter(([, v]) => v).map(([k]) => k));
  const considerType = (t) => prefs.defTypesAllOn !== false && (typeSet.size === 0 || typeSet.has(t));
  const compiled = store.compiledQuery || null;

  const out = [];
  for (const it of store.byKey.values()) {
    if (excludeKey && it.key === excludeKey) continue;      // exclude the current def
    if (!srcFilters[it.layer]) continue;
    if (modEx[it.layer]?.[it.modDisplay]) continue;
    if (!considerType(it.defType)) continue;
    if (compiled && !matchesRec(it, compiled)) continue;
    out.push(it);
  }
  return out;
}

function datasetUnique(items, tag) {
  const counts = new Map(); // value -> count
  for (const it of items) {
    const arr = toArray(it.tagMap?.[tag]);
    for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  }
  const rows = Array.from(counts.entries()).map(([value, count]) => ({ value, count }));
  // default sort by count desc then value asc
  rows.sort((a, b) => (b.count - a.count) || cmpAlpha(a.value, b.value));
  return {
    columns: [
      { key: 'value', label: 'Value' },
      { key: 'count', label: 'Count', numeric: true }
    ],
    rows
  };
}

function datasetAll(items, tag) {
  const rows = [];
  for (const it of items) {
    const arr = toArray(it.tagMap?.[tag]);
    for (const v of arr) {
      rows.push({
        layer: it.layer || '',           // keep for pill coloring
        source: it.modDisplay || '',
        defType: it.defType || '',
        defName: it.defName || '',
        value: v
      });
    }
  }
  // default sort: Source, DefType, defName
  rows.sort((a, b) =>
    cmpAlpha(a.source, b.source) ||
    cmpAlpha(a.defType, b.defType) ||
    cmpAlpha(a.defName, b.defName)
  );

  return {
    columns: [
      // Show Source as a pill with the correct color
      {
        key: 'source',
        label: 'Source',
        render: (r) => makePill('mod', r.source || '(unknown)', modColor(r.layer, r.source || '')),
        sortVal: (r) => r.source || ''
      },
      // Show DefType as a pill too
      {
        key: 'defType',
        label: 'DefType',
        render: (r) => makePill('type', r.defType || '(none)', defTypeColor(r.defType)),
        sortVal: (r) => r.defType || ''
      },
      // defName: clickable link → selects the item and jumps to top
      {
        key: 'defName',
        label: 'defName',
        render: (r) => h('a', {
          href: '#',
          class: 'deflink',
          dataset: { defType: r.defType || '', defName: r.defName || '' },
          title: `${r.defType}/${r.defName}`
        }, r.defName || '(no defName)'),
        sortVal: (r) => r.defName || ''
      },
      { key: 'value', label: 'Value' }
    ],
    rows
  };
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [String(v)];
}

/* --------------------------- table builder --------------------------- */

function buildSortableTable(model, store) {
  const table = h('table', { class: 'tv-table' });
  let sortKey = model.columns[0]?.key || '';
  let sortDir = 'asc';
  let rows = model.rows.slice();

  function render() {
    clear(table);

    const thead = h('thead', {},
      h('tr', {},
        ...model.columns.map(col => {
          const th = h('th', {
            tabindex: '0',
            dataset: { key: col.key },
            'aria-sort': sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
            title: 'Click to sort'
          }, col.label);
          th.addEventListener('click', () => toggleSort(col.key));
          th.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(col.key); }
          });
          return th;
        })
      )
    );

    const tbody = h('tbody', {},
      ...rows.map(r => {
        const tr = h('tr', {});
        for (const col of model.columns) {
          const td = h('td', {});
          if (typeof col.render === 'function') {
            const node = col.render(r);
            if (node instanceof Node) td.appendChild(node);
            else td.textContent = String(node ?? '');
          } else {
            td.textContent = String(r[col.key] ?? '');
          }
          tr.appendChild(td);
        }
        return tr;
      })
    );

    table.append(thead, tbody);
  }

  function toggleSort(key) {
    if (sortKey === key) sortDir = (sortDir === 'asc' ? 'desc' : 'asc');
    else { sortKey = key; sortDir = 'asc'; }
    applySort();
    render();
  }

  function applySort() {
    const col = model.columns.find(c => c.key === sortKey);
    const getVal = col && typeof col.sortVal === 'function'
      ? (r) => col.sortVal(r)
      : (r) => r[sortKey];

    const numericDetected = deduceNumeric(rows.map(r => getVal(r)));
    rows.sort((a, b) => cmpFlexible(getVal(a), getVal(b), numericDetected));
    if (sortDir === 'desc') rows.reverse();
  }

  // Click handling for defName links: select and jump to top
  on(table, 'click', 'a.deflink', (ev, a) => {
    ev.preventDefault();
    const defType = a.dataset.defType || '';
    const defName = a.dataset.defName || '';
    if (!defType || !defName) return;

    const it = store.findDef(defType, defName);
    if (!it) return;

    // Tell the app to select this item (boot.js listens for 'rimdefs:select')
    window.dispatchEvent(new CustomEvent('rimdefs:select', { detail: { key: it.key } }));
    // Jump to header/top immediately
    window.scrollTo(0, 0);
  });

  applySort();
  render();
  return { el: table };
}

/* --------------------------- comparators --------------------------- */

function deduceNumeric(values) {
  if (!values || !values.length) return false;
  let numLike = 0;
  for (const v of values) {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) numLike++;
  }
  return numLike / values.length > 0.6; // >60% looks numeric → treat as numeric
}

function cmpFlexible(a, b, numeric) {
  if (numeric) {
    const na = Number.parseFloat(a), nb = Number.parseFloat(b);
    const aOk = Number.isFinite(na), bOk = Number.isFinite(nb);
    if (aOk && bOk) return na - nb;
    if (aOk) return -1; if (bOk) return 1;
  }
  return cmpAlpha(a, b);
}

function cmpAlpha(a, b) {
  const sa = String(a ?? '').toLowerCase();
  const sb = String(b ?? '').toLowerCase();
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

/* ----------------------------- helpers ----------------------------- */

function formatVals(values) {
  const arr = toArray(values);
  if (!arr.length) return { short: '—', full: '' };
  const full = arr.join(', ');
  const short = full.length > 120 ? (full.slice(0, 117) + '…') : full;
  return { short, full };
}

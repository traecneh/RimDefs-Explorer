import { h, clear } from '../core/dom.js';
import { makePill } from '../ui/badges.js';
import { tintForLabel, srcColor } from '../core/colors.js';
import { createTabHost } from './tabHost.js';
import { renderXML } from '../tabs/xml.js';
import { renderSimilar } from '../tabs/similar.js';

export function createDetailsView(store) {
  const title = h('h2', {}, '—');
  const sub = h('div', { class: 'sub' }, '');
  const pillRow = h('div', { class: 'pills' });

  const header = h('div', { class: 'details-header' },
    h('div', { class: 'title-row' }, title),
    sub,
    pillRow
  );

  const host = createTabHost();
  const el = h('div', { class: 'details' }, header, host.el);

  let currentItem = null;

  host.addTab('xml', 'XML', (panel) => {
    clear(panel);

    // C# insight strip (if meta present)
    const strip = buildInsightStrip(currentItem, store);
    if (strip) panel.appendChild(strip);

    // XML pretty print + enhanced links/hovercards
    panel.appendChild(renderXML(currentItem, store));
  });

  host.addTab('similar', 'Similar Values of Tags', (panel) => {
    clear(panel);
    panel.appendChild(renderSimilar(currentItem, store));
  });

  host.select('xml');

  function setItem(item) {
    currentItem = item;
    title.textContent = item.display || item.defName || '(unnamed)';
    sub.textContent = `${item.defType} • ${item.path}`;
    pillRow.replaceChildren(
      makePill('DefType', item.defType, tintForLabel(item.defType)),
      makePill('Source', item.modDisplay, tintForLabel(item.modDisplay)),
      makePill('Source', item.layer, srcColor(item.layer)),
    );
    host.update();
  }

  return { el, setItem };
}

function buildInsightStrip(item, store) {
  if (!item || !store.meta?.defTypes) return null;
  const meta = store.meta.defTypes[item.defType];
  if (!meta) return null;

  // Compute present top-level members
  const present = new Set();
  try {
    const doc = new DOMParser().parseFromString(item.xml, 'application/xml');
    const root = doc.firstElementChild;
    if (root) {
      for (const ch of Array.from(root.children)) present.add(ch.tagName);
      for (const attr of Array.from(root.attributes||[])) present.add(attr.name); // include attributes as members
    }
  } catch {}

  const allMembers = Object.keys(meta.members || {});
  const presentList = allMembers.filter(m => present.has(m));
  const missingList = allMembers.filter(m => !present.has(m));

  // DefRef candidates from text (crude, but useful)
  const refCandidates = store.defRefCandidatesFromText(item.xml);

  const strip = h('div', { class: 'insight', role: 'group', 'aria-label': 'C# Insight' },
    h('span', { class: 'pill' }, meta.fqcn || item.defType),
    ...presentList.slice(0, 12).map(m => h('span', { class: 'pill good' }, m)),
    ...(missingList.length ? [h('span', { class: 'pill miss' }, `+${missingList.length} defaults`)] : [])
  );

  if (refCandidates.length) {
    strip.appendChild(h('span', { class: 'pill' }, 'Refs:'));
    for (const rc of refCandidates.slice(0, 12)) {
      const p = h('span', { class: 'pill ref', tabindex: '0' }, `${rc.defType}/${rc.defName}`);
      p.addEventListener('click', () => {
        const target = store.findDef(rc.defType, rc.defName);
        if (target) {
          store.setSelected(target.key);
          // Let outer listeners update detail
          document.querySelector('.item[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        }
      });
      strip.appendChild(p);
    }
  }
  return strip;
}

// XML renderer: pretty print + syntax color + defRef linkify + hovercards + HIGHLIGHTING
// Now with CLICKABLE ambiguous links: left-click shows a small menu to pick a target.

import { h } from '../core/dom.js';
import { attachHovercard } from '../ui/hovercard.js';

export function renderXML(item, store) {
  const pre = h('code', { class: 'xml', role: 'region', 'aria-label': 'XML' });

  if (!item || !item.xml) {
    pre.textContent = 'Select a def from the list to view XML.';
    return pre;
  }

  // Index ALL defs by defName (ignores filters/mod visibility on purpose)
  const defNameIndex = buildDefNameIndexAll(store);

  const output = prettyAndEnhance(item.xml, store, defNameIndex);
  pre.innerHTML = output;

  // Click behavior: single-target defref OR ambiguous menu
  pre.addEventListener('click', (ev) => {
    const a = ev.target.closest('a.defref');
    if (!a) return;
    ev.preventDefault();

    // Ambiguous: open a click menu to choose
    if (a.dataset.amb === '1') {
      try {
        const cands = JSON.parse(a.getAttribute('data-cands') || '[]');
        openAmbiguityMenu(a, cands);
      } catch {
        // fallback: do nothing
      }
      return;
    }

    // Single target
    const defType = a.getAttribute('data-def-type');
    const defName = a.getAttribute('data-def-name');
    if (!defType || !defName) return;

    // Find ignoring filters to honor "link across everything"
    const it = findInByKey(store, defType, defName);
    if (!it) return;
    window.dispatchEvent(new CustomEvent('rimdefs:select', { detail: { key: it.key } })); // explorer listens. :contentReference[oaicite:2]{index=2}
  });

  // Hovercards for color/vector/curve previews (unchanged)
  enhanceHovercards(pre);

  return pre;
}

/* ----------------------------------------------------- */
/* Rendering + basic syntax coloring + rule-driven links */
/* ----------------------------------------------------- */

function prettyAndEnhance(xml, store, defNameIndex) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return escapeHtml(xml);
  }
  if (doc.getElementsByTagName('parsererror')[0]) return escapeHtml(xml);

  const root = doc.documentElement;
  if (!root || root.nodeType !== 1) return escapeHtml(xml);

  const hi = (s) => {
    const fn = store?.compiledQuery?.highlighters?.highlight;
    return fn ? fn(String(s ?? '')) : escapeHtml(String(s ?? ''));
  };

  const out = [];
  const indent = (n) => '  '.repeat(n);
  const push = (s) => out.push(s);

  function renderAttrs(el) {
    const parts = [];
    for (const a of Array.from(el.attributes || [])) {
      const name = a.name;
      const raw  = String(a.value ?? '');
      const linkedHTML = linkifyAttr(name, raw, el.tagName, store, hi, defNameIndex);
      if (linkedHTML) {
        parts.push(`<span class="a">${escapeHtml(name)}</span><span class="as">=</span>${linkedHTML}`);
      } else {
        parts.push(`<span class="a">${escapeHtml(name)}</span><span class="as">=</span><span class="av">"${hi(raw)}"</span>`);
      }
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  function renderText(contextTag, text) {
    const v = String(text ?? '').trim();
    if (!v) return '';
    const maybe = linkifyValue(contextTag, v, store, hi, defNameIndex);
    return maybe || `<span class="tx">${hi(v)}</span>`;
  }

  function walk(node, depth) {
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    const attrs = renderAttrs(el);

    const children = Array.from(el.childNodes || []);
    const elemKids = children.filter(n => n.nodeType === 1);
    const textKids = children.filter(n => n.nodeType === 3 && /\S/.test(n.nodeValue || ''));
    const commentKids = children.filter(n => n.nodeType === 8);

    if (elemKids.length === 0 && textKids.length === 0 && commentKids.length === 0) {
      push(`${indent(depth)}<span class="t">&lt;${tag}${attrs}/&gt;</span>\n`);
      return;
    }

    if (elemKids.length === 0 && textKids.length === 1 && commentKids.length === 0) {
      const txHTML = renderText(tag, textKids[0].nodeValue);
      push(`${indent(depth)}<span class="t">&lt;${tag}${attrs}&gt;</span>${txHTML}<span class="t">&lt;/${tag}&gt;</span>\n`);
      return;
    }

    push(`${indent(depth)}<span class="t">&lt;${tag}${attrs}&gt;</span>\n`);
    for (const ch of children) {
      if (ch.nodeType === 8) {
        push(`${indent(depth + 1)}<span class="cm">&lt;!-- ${escapeHtml(ch.nodeValue || '')} --&gt;</span>\n`);
      } else if (ch.nodeType === 3) {
        const v = String(ch.nodeValue || '').trim();
        if (v) push(`${indent(depth + 1)}${renderText(tag, v)}\n`);
      } else if (ch.nodeType === 1) {
        walk(ch, depth + 1);
      }
    }
    push(`${indent(depth)}<span class="t">&lt;/${tag}&gt;</span>\n`);
  }

  walk(root, 0);
  return out.join('');
}

/* ----------------------- Linking rules ----------------------- */

function linkifyAttr(name, value, contextTag, store, hi, defNameIndex) {
  const n = String(name || '').toLowerCase();
  const v = String(value || '').trim();
  if (!v) return null;

  // 1) ParentName / Parent → typed link to same element's defType
  if (n === 'parentname' || n === 'parent') {
    return linkSpan(contextTag, v, hi);
  }

  // 2) *Def / *DefName → prefer typed lookup (ignores filters)
  if (n.endsWith('def') || n.endsWith('defname')) {
    const typed = findAnyDefPreferType(v, store, null);
    if (typed) return linkSpan(typed.defType, v, hi);
  }

  // 3) Unique defName anywhere (attribute)
  const cands = candidatesByDefName(v, defNameIndex);
  if (cands.length === 1) return linkSpan(cands[0].defType, v, hi);
  if (cands.length > 1)  return linkSpanAmb(v, cands, hi); // clickable menu

  // Fallback: plain highlighted value
  return `<span class="av">"${hi(v)}"</span>`;
}

function linkifyValue(tag, text, store, hi, defNameIndex) {
  const v = String(text || '').trim();
  if (!v) return null;

  // A) typed fallback <ThingDef>Steel</ThingDef>
  if (tag.endsWith('Def') || tag.endsWith('DefName')) {
    const any = findAnyDefPreferType(v, store, tag);
    if (any) return linkText(any.defType, v, hi);
  }

  // B) scalars (hovercards)
  if (looksLikeColor(v))  return `<span class="tx" data-hover="color"  data-value="${htmlAttr(v)}">${hi(v)}</span>`;
  if (looksLikeVector(v)) return `<span class="tx" data-hover="vector" data-value="${htmlAttr(v)}">${hi(v)}</span>`;

  // C) Unique/ambiguous defName in element text
  const cands = candidatesByDefName(v, defNameIndex);
  if (cands.length === 1) return linkText(cands[0].defType, v, hi);
  if (cands.length > 1)  return linkTextAmb(v, cands, hi); // clickable menu

  return null;
}

/* -------------------- lookup + link HTML -------------------- */

function linkSpan(defType, defName, hi) {
  const inner = hi(defName);
  // Keep quotes for attribute values
  return `<a href="#" class="defref" data-def-type="${htmlAttr(defType)}" data-def-name="${htmlAttr(defName)}">"${inner}"</a>`;
}
function linkText(defType, defName, hi) {
  const inner = hi(defName);
  return `<a href="#" class="defref" data-def-type="${htmlAttr(defType)}" data-def-name="${htmlAttr(defName)}">${inner}</a>`;
}

function linkSpanAmb(defName, cands, hi) {
  const inner = hi(defName);
  return `<a href="#" class="defref amb" data-amb="1" data-cands="${htmlAttr(JSON.stringify(cands))}" title="Multiple matches">"${inner}"</a>`;
}
function linkTextAmb(defName, cands, hi) {
  const inner = hi(defName);
  return `<a href="#" class="defref amb" data-amb="1" data-cands="${htmlAttr(JSON.stringify(cands))}" title="Multiple matches">${inner}</a>`;
}

// Prefer typed lookup, then any match (ignores filters)
function findAnyDefPreferType(defName, store, preferredType /* may be null */) {
  const v = String(defName || '').trim();
  if (!v) return null;
  if (preferredType) {
    const it = findInByKey(store, preferredType, v);
    if (it) return { defType: it.defType, defName: v };
  }
  // fall back: first match of any type
  for (const it of store.byKey.values()) {
    if (it.defName === v) return { defType: it.defType, defName: v };
  }
  return null;
}

/* ----------------- ambiguity index + helpers ---------------- */

function buildDefNameIndexAll(store) {
  // lower(defName) -> [{ key, defType, defName, modDisplay, layer }]
  const idx = new Map();
  for (const it of store.byKey.values()) {
    if (!it || !it.defName) continue;
    const key = it.defName.toLowerCase();
    const arr = idx.get(key) || [];
    arr.push({ key: it.key, defType: it.defType, defName: it.defName, modDisplay: it.modDisplay, layer: it.layer });
    idx.set(key, arr);
  }
  return idx;
}
function candidatesByDefName(defName, defNameIndex) {
  const key = String(defName || '').trim().toLowerCase();
  if (!key) return [];
  return defNameIndex.get(key) || [];
}
function findInByKey(store, defType, defName) {
  for (const it of store.byKey.values()) {
    if (it.defType === defType && it.defName === defName) return it;
  }
  return null;
}

/* ------------------- Ambiguity click menu ------------------- */

let _ambMenu = null;

function openAmbiguityMenu(anchor, candidates) {
  closeAmbiguityMenu();

  // Build menu
  const menu = document.createElement('div');
  menu.className = 'hovercard amb-menu';
  menu.setAttribute('role', 'menu');
  menu.style.maxWidth = '360px';
  menu.style.padding = '6px 6px';

  // Title
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'Multiple matches';
  menu.appendChild(title);

  // Items
  for (const cand of candidates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'amb-item';
    btn.setAttribute('role', 'menuitem');
    btn.style.display = 'block';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.style.padding = '6px 8px';
    btn.style.border = '1px solid var(--border)';
    btn.style.background = '#0c1220';
    btn.style.color = 'var(--text)';
    btn.style.borderRadius = '6px';
    btn.style.margin = '4px 0';
    btn.dataset.key = cand.key;

    // Label: DefType • Mod  (layer dimmed)
    btn.innerHTML = `
      <div style="font-weight:600">${escapeHtml(cand.defType)} • ${escapeHtml(cand.modDisplay || '')}</div>
      <div style="font-size:12px;color:var(--weak)">${escapeHtml(cand.defName)} <span style="opacity:.7">(${escapeHtml(cand.layer)})</span></div>
    `;

    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (key) window.dispatchEvent(new CustomEvent('rimdefs:select', { detail: { key } })); // explorer handles selection. :contentReference[oaicite:3]{index=3}
      closeAmbiguityMenu();
    });

    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  _ambMenu = menu;

  // Position near anchor (keep in viewport)
  const r = anchor.getBoundingClientRect();
  const mx = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  const my = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8);
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(8, mx)}px`;
  menu.style.top  = `${Math.max(8, my)}px`;

  // Dismiss on click outside / ESC / scroll
  const onDocClick = (e) => {
    if (_ambMenu && !menu.contains(e.target) && e.target !== anchor) closeAmbiguityMenu();
  };
  const onKey = (e) => { if (e.key === 'Escape') closeAmbiguityMenu(); };
  const onScroll = () => closeAmbiguityMenu();
  document.addEventListener('click', onDocClick, { capture: true });
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  menu._cleanup = () => {
    document.removeEventListener('click', onDocClick, { capture: true });
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
}

function closeAmbiguityMenu() {
  if (_ambMenu) {
    _ambMenu._cleanup?.();
    _ambMenu.remove();
    _ambMenu = null;
  }
}

/* ----------------- misc helpers + hovercards ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function htmlAttr(s){ return String(s).replaceAll('"','&quot;'); }

function looksLikeColor(v) {
  return /^#?[0-9a-f]{6}$/i.test(v) || /^(\d+(\.\d+)?)(,\s*\d+(\.\d+)?){2,3}$/i.test(v);
}
function looksLikeVector(v) {
  return /^<?-?\d+(\.\d+)?(,\s*-?\d+(\.\d+)?){1,2}>?$/i.test(v);
}

function enhanceHovercards(root) {
  attachHovercard(root, {
    selector: '[data-hover]',
    render(el) {
      const kind = el.getAttribute('data-hover');
      const val = el.getAttribute('data-value') || '';
      const card = document.createElement('div');
      const title = document.createElement('div'); title.className = 'title';
      title.textContent = kind === 'color' ? 'Color' : kind === 'vector' ? 'Vector' : 'Preview';
      card.appendChild(title);

      if (kind === 'color') {
        const sw = document.createElement('div'); sw.className = 'swatch';
        const rgba = parseColor(val);
        sw.style.background = `rgba(${rgba.r},${rgba.g},${rgba.b},${rgba.a})`;
        const row = document.createElement('div'); row.className = 'row';
        const txt = document.createElement('div'); txt.textContent = `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`;
        row.appendChild(txt); row.appendChild(sw);
        card.appendChild(row);
      } else if (kind === 'vector') {
        const v = parseVector(val);
        const row = document.createElement('div'); row.className = 'row';
        const txt = document.createElement('div'); txt.textContent = `⟨${v.join(', ')}⟩`;
        row.appendChild(txt);
        card.appendChild(row);
      } else if (kind === 'curve') {
        const pts = (el.getAttribute('data-points') || '')
          .split(',').map(p => p.split(':').map(Number)).filter(arr => arr.length === 2 && arr.every(isFinite));
        const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 32;
        card.appendChild(canvas);
        drawSparkline(canvas, pts);
      }
      return card;
    }
  });
}

function parseColor(value) {
  let r = 0, g = 0, b = 0, a = 1;
  const v = value.trim();
  if (/^#?[0-9a-f]{6}$/i.test(v)) {
    const hex = v.replace('#','');
    r = parseInt(hex.slice(0,2),16);
    g = parseInt(hex.slice(2,4),16);
    b = parseInt(hex.slice(4,6),16);
  } else {
    const nums = v.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
    if (nums.length >= 3) {
      if (nums.every(n => n <= 1)) {
        r = Math.round(nums[0]*255); g = Math.round(nums[1]*255); b = Math.round(nums[2]*255);
        a = Number.isFinite(nums[3]) ? Math.max(0, Math.min(1, nums[3])) : 1;
      } else {
        r = Math.round(nums[0]); g = Math.round(nums[1]); b = Math.round(nums[2]);
        a = Number.isFinite(nums[3]) ? Math.max(0, Math.min(1, nums[3]/255)) : 1;
      }
    }
  }
  return { r, g, b, a };
}

function parseVector(value) {
  return value.replace(/[<>]/g,'').split(',').map(s => s.trim()).map(Number).filter(n => !Number.isNaN(n));
}

function drawSparkline(canvas, pts) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  if (!pts.length) return;
  const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scaleX = (x)=> (W-6) * (x - minX) / (maxX - minX || 1) + 3;
  const scaleY = (y)=> (H-6) * (1 - (y - minY) / (maxY - minY || 1)) + 3;

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(scaleX(pts[0][0]), scaleY(pts[0][1]));
  for (let i=1;i<pts.length;i++) ctx.lineTo(scaleX(pts[i][0]), scaleY(pts[i][1]));
  ctx.stroke();
}

// Tiny DOM helpers with property-aware assignment.
// Exports kept for backward-compat: qs, qsa, frag, clear, h, on.

export const qs = (sel, el = document) => el.querySelector(sel);
export const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export const frag = (nodes = []) =>
  nodes.reduce((f, n) => {
    if (n == null || n === false || n === true) return f;
    if (typeof n === 'string' || typeof n === 'number') {
      f.appendChild(document.createTextNode(String(n)));
    } else if (n && n.nodeType) {
      f.appendChild(n);
    }
    return f;
  }, document.createDocumentFragment());

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;

      // Special-cases
      if (k === 'dataset' && typeof v === 'object') { Object.assign(el.dataset, v); continue; }
      if (k === 'style'   && typeof v === 'object') { Object.assign(el.style, v); continue; }
      if (k === 'aria'    && typeof v === 'object') {
        for (const [ak, av] of Object.entries(v)) el.setAttribute(`aria-${ak}`, String(av));
        continue;
      }
      if (k === 'class' || k === 'className') { el.className = String(v); continue; }
      if (k === 'innerHTML') { el.innerHTML = String(v); continue; }
      if (k === 'textContent') { el.textContent = String(v); continue; }
      if (k === 'htmlFor') { el.htmlFor = v; continue; }

      // Inline event handler convenience: oninput / onclick / etc.
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v);
        continue;
      }

      // Prefer property assignment when possible (id, role, tabIndex, etc.)
      if (k in el) {
        try { el[k] = v; } catch { try { el.setAttribute(k, v); } catch {} }
      } else {
        try { el.setAttribute(k, v); } catch {}
      }
    }
  }

  appendChildren(el, children);
  return el;
}

function appendChildren(el, kids) {
  for (const ch of kids.flat()) {
    if (ch == null || ch === false || ch === true) continue;
    if (typeof ch === 'string' || typeof ch === 'number') {
      el.appendChild(document.createTextNode(String(ch)));
    } else if (ch && ch.nodeType) {
      el.appendChild(ch);
    }
  }
}

// Delegated events (click, input, etc.)
// Usage: on(root, 'click', '.selector', (ev, matchedEl) => { ... })
export function on(root, type, selector, handler) {
  root.addEventListener(type, (ev) => {
    const path = ev.composedPath?.() || [];
    const target =
      path.find?.(n => n instanceof Element && n.matches?.(selector)) ||
      (ev.target instanceof Element && ev.target.closest(selector));
    if (target && root.contains(target)) handler(ev, target);
  });
}

import { h, clear } from '../core/dom.js';

export function createTabHost() {
  const tabbar = h('div', { class: 'tabbar', role: 'tablist' });
  const panel = h('div', { class: 'tabpanel', role: 'tabpanel', tabindex: '0' });
  const el = h('div', { class: 'tabs' }, tabbar, panel);

  const tabs = new Map();
  let currentId = null;

  function addTab(id, title, renderFn) {
    const btn = h('button', { role: 'tab', 'aria-selected': 'false' }, title);
    btn.addEventListener('click', () => select(id));
    tabbar.appendChild(btn);
    tabs.set(id, { btn, renderFn, title });
  }

  function select(id) {
    if (!tabs.has(id)) return;
    for (const { btn } of tabs.values()) btn.setAttribute('aria-selected', 'false');
    const t = tabs.get(id);
    t.btn.setAttribute('aria-selected', 'true');
    currentId = id;
    clear(panel);
    t.renderFn(panel);
  }

  function update() {
    // Re-render current tab
    if (currentId && tabs.has(currentId)) {
      tabs.get(currentId).renderFn(panel);
    }
  }

  return { el, addTab, select, update, get currentId(){return currentId;} };
}

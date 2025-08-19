// App bootstrap. Robust to missing /data/*.json so the UI always loads.

import { createStore } from './core/store.js';
import { bootExplorer } from './explorer/boot.js';
import { openDataPanel } from './explorer/dataPanel.js';

// Tiny helper to show a non-blocking banner in the app shell
function showBanner(kind, msg, cta) {
  const shell = document.getElementById('app-shell') || document.body;
  let bar = document.getElementById('banner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'banner';
    bar.style.cssText = `
      position: sticky; top: 0; z-index: 50;
      background: var(--panel); color: var(--muted-fg,#bbb);
      border-bottom: 1px solid var(--hairline,#222);
      padding: .5rem .75rem; font-size: .9rem; display: flex; gap: .75rem; align-items: center;
    `;
    shell.prepend(bar);
  }
  bar.textContent = '';
  const dot = document.createElement('span');
  dot.style.cssText = `width:.6rem;height:.6rem;border-radius:50%;background:${kind==='warn'?'#d97706':'#64748b'};display:inline-block;`;
  const txt = document.createElement('span'); txt.textContent = msg;
  bar.append(dot, txt);
  if (cta) bar.append(cta);
}

async function main() {
  const app = document.getElementById('app');
  const statusEl = document.getElementById('status');
  const dataBtn = document.getElementById('dataBtn');

  // Create store (internally loads /data/*.json with safe fallbacks)
  const store = await createStore();
  window.__store = store; // handy for debugging

  // If everything is empty, hint the user to build data, but keep the app alive
  const empty = store.size === 0;
  if (empty) {
    const cta = document.createElement('button');
    cta.textContent = 'Open Data Manager';
    cta.className = 'mini';
    cta.addEventListener('click', () => openDataPanel(store));
    showBanner('warn', 'No data JSONs were found in /data. Build them from your local RimWorld files.', cta);
  }

  // Boot the Explorer (list + details). Counts & list will show zero when empty.
  const root = document.getElementById('explorer');
    if (root && !root.classList.contains('app-shell')) {
        root.classList.add('app-shell');            // ensure grid class exists
    }
    // Fallback in case CSS didn't load for some reason
    if (root && getComputedStyle(root).display !== 'grid') {
        root.style.display = 'grid';
        root.style.gridTemplateColumns = '340px 480px 1fr';
        root.style.gap = '8px';
    }
  bootExplorer(root, store, statusEl);

  if (dataBtn) dataBtn.addEventListener('click', () => openDataPanel(store));
}

main().catch(err => {
  console.error('Fatal init error:', err);
  const cta = document.createElement('code');
  cta.textContent = String(err && err.message || err);
  showBanner('warn', 'Failed to initialize. See console for details.', cta);
});

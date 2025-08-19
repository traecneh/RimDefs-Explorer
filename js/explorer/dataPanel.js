import { h, on, clear } from '../core/dom.js';
import * as api from '../core/api.js';

const fmt = (n)=> new Intl.NumberFormat().format(n);

export async function openDataPanel(store) {
  const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const modal   = h('div', { class: 'modal' });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close(){ overlay.remove(); }
  on(overlay, 'click', '.modal-overlay', (ev, el) => { if (ev.target === el) close(); });
  on(modal, 'click', '[data-close]', close);
  window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') close(); }, { once:true });

  const head = h('div', { class: 'head' },
    h('h3', {}, 'Data Manager'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'mini', type: 'button', 'data-close': '1' }, 'Close')
  );
  const body = h('div', { class: 'body' }, h('div', { class: 'pad' }, h('div', {}, 'Loading…')));
  modal.append(head, body);

  const hasApi = await api.ping();
  if (!hasApi) {
    clear(body);
    body.append(
      h('div', { class: 'pad' },
        h('p', {}, 'The local helper API was not detected. You can still browse any JSON already in /data.'),
        h('p', {}, 'To enable builds from the UI:'),
        h('ol', {},
          h('li', {}, 'Install Python 3.10+'),
          h('li', {}, 'Run:'),
          h('pre', {}, 'python tools/helper.py'),
          h('li', {}, 'Reload this page')
        )
      )
    );
    return;
  }

  // Load config + manifest
  let cfg = await api.getConfig().catch(()=>({}));
  let man = await api.manifest().catch(()=>({ files: [] }));

  clear(body);

  // ----- Paths form -----
  const official = h('input', {
    type: 'text',
    class: 'text',
    value: cfg.official?.[0] || cfg.official || '',
    placeholder: 'C:/Program Files (x86)/Steam/steamapps/common/RimWorld/Data'
  });
  const workshop = h('input', {
    type: 'text',
    class: 'text',
    value: cfg.workshop?.[0] || cfg.workshop || '',
    placeholder: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/294100'
  });

  const devList = h('div', { class: 'dev-list' });

  function normalizeDevRows(raw) {
    const rows = Array.isArray(raw) ? raw : [];
    // Accept legacy formats: ["D:/MyMod"] or [{ path, label? }]
    return rows.map(r => {
      if (typeof r === 'string') return { path: r };
      return { path: (r?.path || '').trim() };
    });
  }

  function renderDevRows() {
    clear(devList);
    const rows = normalizeDevRows(cfg.devPaths);
    if (!rows.length) {
      devList.append(h('div', { class: 'empty' }, 'No Dev folders added.'));
      return;
    }
    rows.forEach((row, i) => {
      devList.append(
        h('div', { class: 'dev-row' },
          h('input', { type: 'text', class: 'text', value: row.path || '', placeholder: 'D:/RimMods/MyMod' }),
          h('button', { class: 'mini bad', type: 'button', dataset: { idx: i }, title: 'Remove' }, 'Remove')
        )
      );
    });
  }

  renderDevRows();

  on(devList, 'click', '.mini.bad', (ev, btn) => {
    const i = +btn.dataset.idx;
    (cfg.devPaths ||= []).splice(i,1);
    renderDevRows();
  });

  const addDevBtn  = h('button', { class: 'mini', type: 'button' }, 'Add Dev Folder');
  addDevBtn.addEventListener('click', () => {
    (cfg.devPaths ||= []).push({ path: '' });
    renderDevRows();
  });

  const saveBtn    = h('button', { class: 'mini good', type: 'button' }, 'Save Paths');
  const saveStatus = h('span', { class: 'muted' });

  saveBtn.addEventListener('click', async () => {
    cfg.official = official.value.trim() ? [official.value.trim()] : [];
    cfg.workshop = workshop.value.trim() ? [workshop.value.trim()] : [];
    // devPaths: only { path }, no label
    cfg.devPaths = Array.from(devList.querySelectorAll('.dev-row')).map(el => {
      const input = el.querySelector('input[type="text"]');
      return { path: (input?.value || '').trim() };
    }).filter(r => r.path);

    saveStatus.textContent = 'Saving…';
    try {
      cfg = await api.putConfig(cfg);
      saveStatus.textContent = 'Saved.';
    } catch (e) {
      saveStatus.textContent = `Error: ${e.message || e}`;
    }
  });

  // ----- Rebuild panel -----
  const ckOfficial = h('input', { type: 'checkbox', checked: true });
  const ckWorkshop = h('input', { type: 'checkbox', checked: true });
  const ckDev      = h('input', { type: 'checkbox', checked: true });

  const startBtn = h('button', { class: 'mini', type: 'button' }, 'Start Rebuild');
  const progBar  = h('div', { class: 'prog' }, h('div', { class: 'bar', style: { width: '0%' } }));
  const logBox   = h('pre', { class: 'log' });

  startBtn.addEventListener('click', async () => {
    const layers = [];
    if (ckOfficial.checked) layers.push('official');
    if (ckWorkshop.checked) layers.push('workshop');
    if (ckDev.checked)      layers.push('dev');
    if (!layers.length) { logBox.textContent = 'Select at least one layer.'; return; }

    // lock UI
    [ckOfficial, ckWorkshop, ckDev, startBtn].forEach(el => el.disabled = true);
    logBox.textContent = 'Starting…';

    try {
      const { jobId } = await api.rebuild({ layers });
      await poll(jobId);
    } catch (e) {
      logBox.textContent = `Error: ${e.message || e}`;
      [ckOfficial, ckWorkshop, ckDev, startBtn].forEach(el => el.disabled = false);
    }
  });

  async function poll(jobId) {
    let done = false;
    while (!done) {
      await new Promise(r => setTimeout(r, 600));
      let st;
      try { st = await api.status(jobId); }
      catch (e) { logBox.textContent = `Status error: ${e.message || e}`; break; }
      const p = Math.max(0, Math.min(1, Number(st.progress || 0)));
      progBar.firstChild.style.width = `${Math.round(p*100)}%`;
      logBox.textContent = (st.logTail || '').slice(-4000);
      if (st.state === 'done') {
        done = true;
        logBox.textContent += '\n✓ Done. Reloading…';
        // Unconditional page reload – simplest and always correct
        setTimeout(() => window.location.reload(), 150);
      } else if (st.state === 'error') {
        done = true;
        logBox.textContent += '\n✗ Build failed.';
        [ckOfficial, ckWorkshop, ckDev, startBtn].forEach(el => el.disabled = false);
      }
    }
    // Refresh manifest list after completion (best-effort)
    try { man = await api.manifest(); renderFiles(); } catch {}
  }

  // ----- Manifest list -----
  const fileList = h('div', { class: 'files' });
  function renderFiles() {
    clear(fileList);
    const files = man.files || [];
    if (!files.length) {
      fileList.append(h('div', { class: 'file empty' }, 'No artifacts found.'));
      return;
    }
    for (const f of files) {
      fileList.append(h('div', { class: 'file' }, `${f.name} — ${fmt(f.size)} bytes`));
    }
  }
  renderFiles();

  // ----- Compose modal -----
  body.append(
    h('div', { class: 'pad' },
      h('h4', {}, 'Paths'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Official'), official,
        h('label', {}, 'Workshop'), workshop
      ),
      h('div', { class: 'row' }, addDevBtn),
      devList,
      h('div', { class: 'row' }, saveBtn, h('span', { class: 'spacer' }), saveStatus)
    ),
    h('div', { class: 'pad' },
      h('h4', {}, 'Rebuild'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Official'), ckOfficial,
        h('label', {}, 'Workshop'), ckWorkshop,
        h('label', {}, 'Dev'),      ckDev
      ),
      h('div', { class: 'row' }, startBtn),
      progBar,
      logBox
    ),
    h('div', { class: 'pad' },
      h('h4', {}, 'Available artifacts'),
      fileList
    )
  );
}

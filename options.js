// options.js — load/save the tunable settings (config.js holds the defaults)
// and manage the self-learning data (learning.js).

(() => {
  const C = globalThis.RAYNA;
  const L = globalThis.RAYNA_LEARN;
  const $ = (id) => document.getElementById(id);
  const KEYS = Object.keys(C.DEFAULT_SETTINGS);

  async function load() {
    const settings = await C.getSettings();
    for (const key of KEYS) {
      const el = $(key);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
    }
  }

  async function save() {
    const out = {};
    for (const key of KEYS) {
      const el = $(key);
      if (!el) continue;
      const def = C.DEFAULT_SETTINGS[key];
      if (el.type === 'checkbox') out[key] = el.checked;
      else if (typeof def === 'number') {
        // Number() handles "2.8e4" etc. that parseInt would mangle; clamp to
        // the input's min so e.g. POLL_MS=0 can't become a hot loop.
        let n = Number(el.value);
        if (!Number.isFinite(n)) n = def;
        const min = el.min !== '' ? Number(el.min) : 0;
        out[key] = Math.max(min, Math.round(n));
      } else out[key] = el.value.trim() || def;
    }
    await chrome.storage.sync.set(out);
    flash('Saved');
    load();
  }

  async function reset() {
    await chrome.storage.sync.remove(KEYS);
    flash('Defaults restored');
    load();
  }

  function flash(text) {
    const el = $('status');
    el.textContent = text;
    setTimeout(() => { el.textContent = ''; }, 2000);
  }

  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', reset);
  load();

  // --- self-learning management ---------------------------------------------
  const REASON_LIST = Object.values(C.REASONS);

  function td(parent, content, width) {
    const cell = document.createElement('td');
    cell.style.cssText = `padding:6px 8px; border-top:1px solid #e2e6ef;${width ? `width:${width};` : ''}`;
    if (typeof content === 'string') cell.textContent = content;
    else cell.appendChild(content);
    parent.appendChild(cell);
    return cell;
  }

  function smallButton(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:4px 10px; font-size:12.5px;';
    b.addEventListener('click', onClick);
    return b;
  }

  async function renderLearning() {
    const data = await L.load();
    $('learn-enabled').checked = data.enabled !== false;

    // Ring stats + suggestion
    const stats = $('ring-stats');
    const settings = await C.getSettings();
    if (data.ringSecs.length) {
      const tip = L.ringTimeoutTip(data, settings.RING_TIMEOUT_MS);
      stats.style.display = 'block';
      stats.textContent = `${data.ringSecs.length} answered-call ring time(s) recorded. ` +
        (tip || `No change suggested for RING_TIMEOUT_MS (currently ${settings.RING_TIMEOUT_MS}).` +
          (data.ringSecs.length < 20 ? ' A suggestion appears after 20 samples.' : ''));
    } else {
      stats.style.display = 'none';
    }

    // Learned selectors
    const selTable = $('learned-selectors');
    selTable.innerHTML = '';
    const selKeys = Object.keys(data.selectors || {});
    $('no-selectors').style.display = selKeys.length ? 'none' : 'block';
    for (const key of selKeys) {
      const newest = data.selectors[key][0] || {};
      const row = document.createElement('tr');
      td(row, key, '30%');
      td(row, `"${newest.text || newest.aria || newest.css || ''}"`.slice(0, 70));
      td(row, smallButton('Forget', async () => { await L.forgetSelector(key); renderLearning(); }), '90px');
      selTable.appendChild(row);
    }

    // Unrecognized toasts awaiting mapping
    const seenTable = $('toast-seen');
    seenTable.innerHTML = '';
    $('no-toasts').style.display = data.toastSeen.length ? 'none' : 'block';
    for (const t of data.toastSeen) {
      const row = document.createElement('tr');
      td(row, `"${t.text}" (seen ${t.count}x)`);
      const select = document.createElement('select');
      select.style.cssText = 'padding:4px; font-size:12.5px;';
      select.appendChild(new Option('Map to Reason…', ''));
      for (const r of REASON_LIST) select.appendChild(new Option(r, r));
      td(row, select, '190px');
      const actions = document.createElement('span');
      actions.appendChild(smallButton('Map', async () => {
        if (!select.value) return;
        await L.approveToastMapping(t.text, select.value);
        renderLearning();
      }));
      actions.appendChild(document.createTextNode(' '));
      actions.appendChild(smallButton('Dismiss', async () => {
        await L.dismissSeenToast(t.text);
        renderLearning();
      }));
      td(row, actions, '150px');
      seenTable.appendChild(row);
    }

    // Approved mappings
    const mapTable = $('toast-map');
    mapTable.innerHTML = '';
    $('no-mappings').style.display = data.toastMap.length ? 'none' : 'block';
    for (const m of data.toastMap) {
      const row = document.createElement('tr');
      td(row, `"${m.pattern}"`);
      td(row, `→ ${m.reason}`, '190px');
      td(row, smallButton('Forget', async () => { await L.forgetToastMapping(m.pattern); renderLearning(); }), '90px');
      mapTable.appendChild(row);
    }

    // Call-listening stats: cue -> decision counts, then decision timing medians
    const cueTable = $('cue-stats');
    cueTable.innerHTML = '';
    const decisions = Object.keys(data.decisionSecs || {});
    const hasCueData = (data.cueStats || []).length || decisions.length;
    $('no-cues').style.display = hasCueData ? 'none' : 'block';
    for (const s of (data.cueStats || []).slice().sort((a, b) => b.count - a.count)) {
      const row = document.createElement('tr');
      td(row, s.tag);
      td(row, `→ ${s.decision}`, '190px');
      td(row, `${s.count}x`, '70px');
      cueTable.appendChild(row);
    }
    for (const dec of decisions) {
      const secs = (data.decisionSecs[dec] || []).slice().sort((a, b) => a - b);
      if (!secs.length) continue;
      const median = secs[Math.floor(secs.length / 2)];
      const row = document.createElement('tr');
      td(row, `typical time to "${dec}"`);
      td(row, `~${Math.floor(median / 60)}m ${median % 60}s into the call`, '190px');
      td(row, `${secs.length} calls`, '70px');
      cueTable.appendChild(row);
    }
  }

  $('learn-enabled').addEventListener('change', async (e) => {
    await L.setEnabled(e.target.checked);
    renderLearning();
  });
  $('forget-all').addEventListener('click', async () => {
    await L.forgetAll();
    renderLearning();
  });
  // --- pre-stage images ------------------------------------------------------
  const IMG_KEY = 'RAYNA_IMAGES';
  async function loadImages() {
    const o = await chrome.storage.local.get(IMG_KEY);
    return o[IMG_KEY] || {};
  }

  async function renderImages() {
    const imgs = await loadImages();
    for (const kind of ['wa', 'gmail']) {
      const info = $(`img-${kind}-info`);
      info.innerHTML = '';
      const img = imgs[kind];
      if (!img) { info.textContent = 'No image set.'; continue; }
      const thumb = document.createElement('img');
      thumb.src = img.dataUrl;
      thumb.style.cssText = 'max-height:64px; border-radius:6px; vertical-align:middle; margin-right:10px;';
      info.appendChild(thumb);
      info.appendChild(document.createTextNode(
        `${img.name} (~${Math.round(img.dataUrl.length * 3 / 4 / 1024)} KB) `));
      info.appendChild(smallButton('Remove', async () => {
        const cur = await loadImages();
        delete cur[kind];
        await chrome.storage.local.set({ [IMG_KEY]: cur });
        renderImages();
      }));
    }
  }

  for (const kind of ['wa', 'gmail']) {
    $(`img-${kind}`).addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 2.5 * 1024 * 1024) {
        flash('Image too large — keep it under 2.5 MB');
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const cur = await loadImages();
        cur[kind] = { name: file.name, dataUrl: reader.result };
        await chrome.storage.local.set({ [IMG_KEY]: cur });
        e.target.value = '';
        flash('Image saved');
        renderImages();
      };
      reader.readAsDataURL(file);
    });
  }
  renderImages();

  // Live-refresh: a teaching saved while this page is open must appear
  // immediately — a stale render otherwise reads as "nothing was learned".
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[L.STORAGE_KEY]) renderLearning();
    });
  } catch (e) { /* n/a */ }
  renderLearning();
})();

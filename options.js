// options.js — load/save the tunable settings (config.js holds the defaults).

(() => {
  const C = globalThis.RAYNA;
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
})();

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
        const n = parseInt(el.value, 10);
        out[key] = Number.isFinite(n) ? n : def;
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

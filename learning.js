// learning.js — the self-learning loop. Everything learned lives in
// chrome.storage.local on YOUR machine (view / edit / forget it on the options
// page). Three mechanisms, all driven by live actions you perform:
//
//   1. Selector healing: when a CRM selector fails and the engine pauses, the
//      click you make to do the action manually is captured and stored as a
//      learned fallback for that action.
//   2. Toast mapping: failure toasts the config doesn't recognize are
//      collected; you approve "toast text -> Reason" mappings on the options
//      page and the engine then applies them like built-in ones.
//   3. Ring tuning: seconds-to-answer of connected calls are recorded and a
//      RING_TIMEOUT_MS suggestion is surfaced once there is enough data.
//
// HARD SAFETY RULES (same as everywhere else):
//   - capture REFUSES elements whose label looks like Send/submit
//   - learning only extends the fixed set of actions the engine already
//     performs (Not Connected / Reason / Save Outcome / Next) — it can never
//     add new actions, touch judgment fields, or automate a Send.

globalThis.RAYNA_LEARN = (() => {
  const C = globalThis.RAYNA;
  const STORAGE_KEY = 'RAYNA_LEARNED';

  const EMPTY = {
    enabled: true,
    selectors: {},   // actionKey -> [descriptor, ...] newest first (max 3)
    toastSeen: [],   // [{text, count, lastAt}] unrecognized, awaiting mapping
    toastMap: [],    // [{pattern, reason, learnedAt}] approved by the user
    ringSecs: [],    // seconds-to-answer of connected calls (max 300)
  };

  function normalize(raw) {
    return { ...EMPTY, ...(raw || {}) };
  }

  async function load() {
    try {
      const o = await chrome.storage.local.get(STORAGE_KEY);
      return normalize(o[STORAGE_KEY]);
    } catch (e) {
      return normalize(null);
    }
  }

  async function mutate(fn) {
    const data = await load();
    fn(data);
    try { await chrome.storage.local.set({ [STORAGE_KEY]: data }); } catch (e) { /* best effort */ }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Element fingerprinting (done AT CLICK TIME — dropdown options leave the DOM)
  // ---------------------------------------------------------------------------
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) =>
    ((el && (el.innerText != null ? el.innerText : el.textContent)) || '').trim();

  function cssEscape(s) {
    return (globalThis.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // Framework-generated class names (css-1abc2d, jss42, sc-xyz…) churn on
  // every build — keep only human-looking ones.
  function stableClasses(el) {
    const raw = typeof el.className === 'string' ? el.className : '';
    return raw.split(/\s+/).filter((c) =>
      c && c.length <= 30 && !/\d{2,}/.test(c) && !/^(css|jss|sc|chakra|mui)-/i.test(c));
  }

  function segment(el) {
    let s = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}/.test(el.id)) return `${s}#${cssEscape(el.id)}`;
    const cls = stableClasses(el).slice(0, 2).map(cssEscape);
    if (cls.length) s += `.${cls.join('.')}`;
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
  }

  function buildCssPath(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && node !== document.body && i < 7; i++) {
      parts.unshift(segment(node));
      const path = parts.join(' > ');
      try {
        if (document.querySelectorAll(path).length === 1) return path;
      } catch (e) { /* invalid segment — keep climbing */ }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function describeElement(el) {
    return {
      tag: el.tagName.toLowerCase(),
      text: textOf(el).slice(0, 80),
      aria: el.getAttribute('aria-label') || '',
      css: buildCssPath(el),
      learnedAt: Date.now(),
    };
  }

  // Find an element again from stored descriptors: exact css path first, then
  // exact recorded text (survives DOM restructures), then aria-label.
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function locateOne(desc) {
    if (desc.css) {
      try {
        const el = document.querySelector(desc.css);
        if (el && isVisible(el) &&
            (!desc.text || textOf(el).startsWith(desc.text.slice(0, 40)))) {
          return el;
        }
      } catch (e) { /* stale path */ }
    }
    if (desc.text) {
      const re = new RegExp(`^${escapeRe(desc.text)}$`, 'i');
      let best = null;
      for (const el of document.querySelectorAll('body *')) {
        if (el.childElementCount > 2) continue;
        if (!re.test(textOf(el)) || !isVisible(el)) continue;
        if (!best || best.contains(el)) best = el;
      }
      if (best) return best;
    }
    if (desc.aria) {
      try {
        const el = document.querySelector(`[aria-label="${cssEscape(desc.aria)}"]`);
        if (el && isVisible(el)) return el;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function locate(descList) {
    for (const desc of descList || []) {
      const el = locateOne(desc);
      if (el) return el;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Mutations used by the engine and the options page
  // ---------------------------------------------------------------------------
  function recordSelector(key, desc) {
    return mutate((d) => {
      const list = d.selectors[key] || [];
      d.selectors[key] = [desc, ...list.filter((x) => x.css !== desc.css)].slice(0, 3);
    });
  }

  function forgetSelector(key) {
    return mutate((d) => { delete d.selectors[key]; });
  }

  function recordRingSec(sec) {
    return mutate((d) => {
      d.ringSecs.push(sec);
      if (d.ringSecs.length > 300) d.ringSecs.splice(0, d.ringSecs.length - 300);
    });
  }

  function recordUnmappedToast(text) {
    return mutate((d) => {
      if (d.toastMap.some((m) => text.toLowerCase().includes(m.pattern.toLowerCase()))) return;
      const hit = d.toastSeen.find((t) => t.text === text);
      if (hit) { hit.count += 1; hit.lastAt = Date.now(); }
      else d.toastSeen.push({ text: text.slice(0, 120), count: 1, lastAt: Date.now() });
      if (d.toastSeen.length > 30) d.toastSeen.splice(0, d.toastSeen.length - 30);
    });
  }

  function approveToastMapping(text, reason) {
    return mutate((d) => {
      d.toastSeen = d.toastSeen.filter((t) => t.text !== text);
      if (!d.toastMap.some((m) => m.pattern === text)) {
        d.toastMap.push({ pattern: text, reason, learnedAt: Date.now() });
      }
    });
  }

  function forgetToastMapping(pattern) {
    return mutate((d) => { d.toastMap = d.toastMap.filter((m) => m.pattern !== pattern); });
  }

  function dismissSeenToast(text) {
    return mutate((d) => { d.toastSeen = d.toastSeen.filter((t) => t.text !== text); });
  }

  function setEnabled(enabled) {
    return mutate((d) => { d.enabled = !!enabled; });
  }

  function forgetAll() {
    return mutate((d) => { Object.assign(d, JSON.parse(JSON.stringify(EMPTY))); });
  }

  // Learned toast mapping lookup (case-insensitive substring on the stored text).
  function matchLearnedToast(data, text) {
    if (!data || data.enabled === false) return null;
    const m = (data.toastMap || []).find(
      (x) => x.pattern && text.toLowerCase().includes(x.pattern.toLowerCase()));
    return m ? { reason: m.reason, text } : null;
  }

  // RING_TIMEOUT_MS suggestion once we have enough answered-call samples.
  function ringTimeoutTip(data, currentMs) {
    const s = (data.ringSecs || []).slice().sort((a, b) => a - b);
    if (s.length < 20) return null;
    const p95 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
    const suggest = (p95 + 4) * 1000;
    if (Math.abs(suggest - currentMs) < 3000) return null;
    return `Learning: 95% of your last ${s.length} answered calls connected within ${p95}s — ` +
      `consider RING_TIMEOUT_MS ≈ ${suggest} (currently ${currentMs}) on the options page.`;
  }

  return {
    STORAGE_KEY,
    normalize,
    load,
    describeElement,
    locate,
    recordSelector,
    forgetSelector,
    recordRingSec,
    recordUnmappedToast,
    approveToastMapping,
    forgetToastMapping,
    dismissSeenToast,
    setEnabled,
    forgetAll,
    matchLearnedToast,
    ringTimeoutTip,
  };
})();

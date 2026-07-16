// content-whatsapp.js — pre-stage ONLY. Opens the lead's chat and fills the
// message composer with the template. It NEVER sends:
//   - guardedClick() refuses to click anything whose label looks like Send
//   - text is inserted with execCommand('insertText') — no keyboard events, so
//     no Enter can ever be synthesized
//   - the flyer attachment stays manual by design (native file dialog anyway)
//
// A search-result row is clicked ONLY if it verifiably matches the lead (its
// text contains the trailing phone digits, or the lead's name for saved
// contacts) — never "whatever row happens to be first".

(() => {
  const C = globalThis.RAYNA;
  if (!C) return;
  if (globalThis.__RAYNA_WA_LOADED__) return; // guard against re-injection
  globalThis.__RAYNA_WA_LOADED__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) =>
    ((el && (el.innerText != null ? el.innerText : el.textContent)) || '').trim();

  function allVisible(candidates) {
    const out = [];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) out.push(el);
      }
      if (out.length) break; // first selector that yields anything wins
    }
    return out;
  }

  async function waitForAny(candidates, timeoutMs, pollMs = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const els = allVisible(candidates);
      if (els.length) return els[0];
      await sleep(pollMs);
    }
    return null;
  }

  // HARD SAFETY RULE: refuse to click anything that could send/submit.
  // Button-like elements are checked on their full label + text; container
  // rows are checked on aria-label/title only (their descendant text is
  // arbitrary message content — a chat preview saying "please send the flyer"
  // must not block opening the chat, and clicking a row can never send).
  function guardedClick(el, why) {
    const attrs = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    const buttonish = el.matches(
      'button, [role="button"], input[type="submit"], input[type="button"], a');
    const label = buttonish ? `${attrs} ${textOf(el)}` : attrs;
    if (C.FORBIDDEN_CLICK_RE.test(label.trim())) {
      throw new Error(`SAFETY: refused to click "${label.trim()}" while ${why}`);
    }
    // WhatsApp's chat rows react to real mouse-down/up sequences, not a bare
    // synthetic .click() — dispatch the full pointer sequence at the center.
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(type.startsWith('pointer')
          ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
      } catch (e) { /* PointerEvent unavailable — mouse events suffice */ }
    }
  }

  function insertText(el, text) {
    el.focus();
    // Select-all + insert replaces any stale content without keyboard events.
    document.execCommand('selectAll', false, null);
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }
  }

  // --- optional stored image (set on the options page) --------------------
  async function getStoredImage() {
    try {
      const o = await chrome.storage.local.get('RAYNA_IMAGES');
      return (o.RAYNA_IMAGES || {}).wa || null;
    } catch (e) { return null; }
  }

  function dataUrlToFile(dataUrl, name) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'image.png', { type: mime });
  }

  // Synthetic clipboard paste — identical to the user pressing Cmd+V with the
  // image on the clipboard. WhatsApp opens its media PREVIEW (composer text
  // becomes the caption); nothing is sent until the human presses Send.
  async function pasteImageInto(el) {
    const img = await getStoredImage();
    if (!img) return null;
    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(img.dataUrl, img.name));
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(1000);
    return img;
  }

  // Does this row's text verifiably belong to the lead?
  function rowMatchesLead(row, phoneDigits, leadName) {
    const text = `${row.getAttribute('aria-label') || ''} ${textOf(row)}`;
    const rowDigits = text.replace(/\D/g, '');
    const tail = phoneDigits.slice(-C.WA.ROW_MATCH_MIN_DIGITS);
    if (tail && rowDigits.includes(tail)) return true;
    if (leadName && leadName.length >= 3 &&
        text.toLowerCase().includes(leadName.toLowerCase())) return true;
    return false;
  }

  async function findMatchingRow(phoneDigits, leadName, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const row of allVisible(C.WA.RESULT_ROW)) {
        if (rowMatchesLead(row, phoneDigits, leadName)) return row;
      }
      await sleep(300);
    }
    return null;
  }

  async function fillChat(phoneDigits, text, leadName) {
    // A short digit fragment (bad extraction) would false-match timestamps in
    // chat previews — refuse to stage at all rather than risk the wrong chat.
    if (!phoneDigits || phoneDigits.length < C.WA.MIN_PHONE_DIGITS) {
      return { ok: false, detail: `lead phone "${phoneDigits || ''}" looks invalid — staging skipped` };
    }

    // 1. Search for the lead's chat by phone number.
    const search = await waitForAny(C.WA.SEARCH_BOX, C.WA.STEP_TIMEOUT_MS);
    if (!search) return { ok: false, detail: 'WhatsApp search box not found (config.js WA.SEARCH_BOX)' };
    insertText(search, phoneDigits);
    // Make sure the query actually registered before trusting any results.
    await sleep(400);
    if (!textOf(search).replace(/\D/g, '').includes(phoneDigits.slice(-6))) {
      insertText(search, phoneDigits);
      await sleep(400);
    }

    // 2. Open the row that MATCHES the lead — never just the first row.
    const row = await findMatchingRow(phoneDigits, leadName, C.WA.STEP_TIMEOUT_MS);
    if (!row) {
      return {
        ok: false,
        detail: `no WhatsApp chat matching ${phoneDigits}${leadName ? ` / "${leadName}"` : ''} — send manually`,
      };
    }
    guardedClick(row, 'opening the chat');
    await sleep(1200);

    // 3. Fill the composer. NEVER send; the human reviews and presses Send.
    const composer = await waitForAny(C.WA.COMPOSER, C.WA.STEP_TIMEOUT_MS);
    if (!composer) {
      return { ok: false, detail: 'WhatsApp composer not found (config.js WA.COMPOSER)' };
    }
    // Never overwrite something already drafted in this chat (the operator may
    // have typed there, or an earlier pre-stage already ran).
    const existing = textOf(composer);
    if (existing && existing !== text) {
      return { ok: false, detail: 'this chat already has a drafted message — review it manually, nothing overwritten' };
    }
    insertText(composer, text);
    try {
      if (await pasteImageInto(composer)) {
        return { ok: true, detail: 'message + image staged in the preview — press Send yourself' };
      }
    } catch (e) { /* image paste failed — text is still staged */ }
    return { ok: true, detail: 'message staged — attach the flyer and press Send yourself' };
  }

  // Serialize fills: two overlapping requests (e.g. back-to-back missed-call
  // pre-fills) would otherwise fight over the one search box / composer and
  // could stage lead A's text into lead B's chat.
  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === C.MSG.WA_FILL) {
      queue = queue
        .then(() => fillChat(msg.phone, msg.text, msg.leadName || ''))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
      return true; // async response
    }
    if (msg.type === C.MSG.WA_ATTACH) {
      // wa_link mode: the /send URL prefilled the text; once the composer is
      // up, paste the stored image on top (text becomes the caption).
      queue = queue.then(async () => {
        const composer = await waitForAny(C.WA.COMPOSER, 30000);
        if (!composer) return { ok: false, detail: 'composer not ready — attach the image manually' };
        const img = await pasteImageInto(composer);
        return img
          ? { ok: true, detail: 'image staged in the preview — press Send yourself' }
          : { ok: true, detail: 'no WhatsApp image configured' };
      }).then(sendResponse)
        .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
      return true; // async response
    }
    return false;
  });
})();

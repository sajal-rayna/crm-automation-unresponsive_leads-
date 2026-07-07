// content-whatsapp.js — pre-stage ONLY. Opens the lead's chat and fills the
// message composer with the template. It NEVER sends:
//   - guardedClick() refuses to click anything whose text/label looks like Send
//   - text is inserted with execCommand('insertText') — no keyboard events, so
//     no Enter can ever be synthesized
//   - the flyer attachment stays manual by design (native file dialog anyway)

(() => {
  const C = globalThis.RAYNA;
  if (!C) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) =>
    ((el && (el.innerText != null ? el.innerText : el.textContent)) || '').trim();

  function firstVisible(candidates) {
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  async function waitForAny(candidates, timeoutMs, pollMs = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const el = firstVisible(candidates);
      if (el) return el;
      await sleep(pollMs);
    }
    return null;
  }

  // HARD SAFETY RULE: refuse to click anything that could send/submit.
  function guardedClick(el, why) {
    const label = `${el.getAttribute('aria-label') || ''} ${textOf(el)}`.trim();
    if (C.FORBIDDEN_CLICK_RE.test(label)) {
      throw new Error(`SAFETY: refused to click "${label}" while ${why}`);
    }
    el.click();
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

  async function fillChat(phoneDigits, text) {
    // 1. Search for the lead's chat by phone number.
    const search = await waitForAny(C.WA.SEARCH_BOX, C.WA.STEP_TIMEOUT_MS);
    if (!search) return { ok: false, detail: 'WhatsApp search box not found (config.js WA.SEARCH_BOX)' };
    insertText(search, phoneDigits);
    await sleep(1800); // let results render

    // 2. Open the top result.
    const row = await waitForAny(C.WA.RESULT_ROW, C.WA.STEP_TIMEOUT_MS);
    if (!row) {
      return { ok: false, detail: `no WhatsApp chat found for ${phoneDigits} — send manually` };
    }
    guardedClick(row, 'opening the chat');
    await sleep(1200);

    // 3. Fill the composer. NEVER send; the human reviews and presses Send.
    const composer = await waitForAny(C.WA.COMPOSER, C.WA.STEP_TIMEOUT_MS);
    if (!composer) {
      return { ok: false, detail: 'WhatsApp composer not found (config.js WA.COMPOSER)' };
    }
    insertText(composer, text);
    return { ok: true, detail: 'message staged — attach the flyer and press Send yourself' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.WA_FILL) return false;
    fillChat(msg.phone, msg.text)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
    return true; // async response
  });
})();

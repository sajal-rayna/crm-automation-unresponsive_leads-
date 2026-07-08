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
    insertText(composer, text);
    return { ok: true, detail: 'message staged — attach the flyer and press Send yourself' };
  }

  // Serialize fills: two overlapping requests (e.g. back-to-back missed-call
  // pre-fills) would otherwise fight over the one search box / composer and
  // could stage lead A's text into lead B's chat.
  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.WA_FILL) return false;
    queue = queue
      .then(() => fillChat(msg.phone, msg.text, msg.leadName || ''))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
    return true; // async response
  });
})();

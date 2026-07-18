// content-gmail.js — one job: paste the stored schedule image (set on the
// options page) inline into the pre-filled compose window that the background
// worker opened. Everything else about the email (To / subject / body) arrives
// via the compose URL, so no Gmail DOM automation is needed for fields.
//
// It NEVER sends: the only DOM interaction is a synthetic clipboard paste into
// the compose body — identical to the user pressing Cmd+V. No clicks, no
// keyboard events, no Send.

(() => {
  const C = globalThis.RAYNA;
  if (!C) return;
  if (globalThis.__RAYNA_GMAIL_LOADED__) return; // guard against re-injection
  globalThis.__RAYNA_GMAIL_LOADED__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  function firstVisible(candidates) {
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  async function getStoredImage() {
    try {
      const o = await chrome.storage.local.get('RAYNA_IMAGES');
      return (o.RAYNA_IMAGES || {}).gmail || null;
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

  // Put the caret right after the block containing `markerRe`, so the image
  // paste lands under the "Event Schedule:" heading like the template doc.
  function placeCursorAfter(root, markerRe) {
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!markerRe.test(node.textContent)) continue;
        const block = (node.parentElement && node.parentElement.closest('p, div')) ||
          node.parentElement;
        const range = document.createRange();
        range.setStartAfter(block || node);
        range.collapse(true);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
    } catch (e) { /* caret stays put — image lands at the caret/end instead */ }
    return false;
  }

  // Upgrade the URL-filled plain body to the formatted template (bold
  // headings, bullets, numbered steps) and insert the schedule image under
  // "Event Schedule:". Everything is synthetic-paste/insertHTML — no clicks,
  // no keys, and Send remains the human's. template: 'rsvp' (Pre-stage) or
  // 'noanswer' (auto-draft invitation). ensureSaved: wait for Gmail's
  // autosave indicator and report it, so the caller can safely close the tab.
  async function stageRichBody(firstName, template, ensureSaved) {
    const t0 = Date.now();
    let body = null;
    while (Date.now() - t0 < 20000 && !body) {
      body = firstVisible(C.GMAIL.BODY_FIELD);
      if (!body) await sleep(400);
    }
    if (!body) {
      return { ok: false, detail: 'compose body not found — the plain body from the URL is still in place' };
    }

    const settings = await C.getSettings();
    const noanswer = template === 'noanswer';
    const html = C.fillTemplate(
      noanswer ? C.TEMPLATES.EMAIL_NOANSWER_HTML : C.TEMPLATES.EMAIL_BODY_HTML, firstName);
    const plain = C.fillTemplate(
      noanswer
        ? (settings.EMAIL_NOANSWER_BODY || C.TEMPLATES.EMAIL_NOANSWER_BODY)
        : (settings.EMAIL_BODY || C.TEMPLATES.EMAIL_BODY),
      firstName);

    // Replace the plain body: select-all + rich paste (Gmail's own rich-paste
    // path); if Gmail ignored the synthetic paste, fall back to insertHTML.
    body.focus();
    document.execCommand('selectAll', false, null);
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', plain);
    body.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(900);
    if ((body.innerText || '').trim().length < 40) {
      body.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertHTML', false, html);
      await sleep(500);
    }

    // Schedule image under the "Event Schedule:" heading.
    const img = await getStoredImage();
    let imgNote = 'no image configured';
    if (img) {
      placeCursorAfter(body, /Event Schedule:/i);
      const fdt = new DataTransfer();
      fdt.items.add(dataUrlToFile(img.dataUrl, img.name));
      body.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: fdt, bubbles: true, cancelable: true }));
      await sleep(1200);
      imgNote = 'schedule image inserted';
    }

    // Save verification for the auto-draft queue: only report saved=true once
    // Gmail's own indicator confirms the draft exists.
    let saved = false;
    if (ensureSaved) {
      const s0 = Date.now();
      while (Date.now() - s0 < 12000 && !saved) {
        saved = [...document.querySelectorAll('span, div')].some((el) =>
          el.childElementCount === 0 && isVisible(el) &&
          C.GMAIL.SAVED_RE.test((el.innerText || '').trim()));
        if (!saved) await sleep(500);
      }
      if (saved) await sleep(800); // let the final autosave settle
    }
    return { ok: true, saved, detail: `formatted body staged; ${imgNote}` };
  }

  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.GMAIL_RICH) return false;
    queue = queue
      .then(() => stageRichBody(msg.firstName || '', msg.template || 'rsvp', !!msg.ensureSaved))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
    return true; // async response
  });
})();

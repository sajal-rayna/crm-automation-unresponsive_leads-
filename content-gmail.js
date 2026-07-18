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

  async function attachImage() {
    const img = await getStoredImage();
    if (!img) return { ok: true, detail: 'no Gmail image configured' };
    const t0 = Date.now();
    let body = null;
    while (Date.now() - t0 < 20000 && !body) {
      body = firstVisible(C.GMAIL.BODY_FIELD);
      if (!body) await sleep(400);
    }
    if (!body) return { ok: false, detail: 'compose body not found — insert the image manually' };
    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(img.dataUrl, img.name));
    body.focus();
    body.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(1200);
    return { ok: true, detail: 'image inserted into the compose body' };
  }

  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.GMAIL_ATTACH) return false;
    queue = queue
      .then(attachImage)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
    return true; // async response
  });
})();

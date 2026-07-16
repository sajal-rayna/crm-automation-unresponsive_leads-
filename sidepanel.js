// sidepanel.js — UI only. All state lives in content-crm.js; this panel just
// renders STATUS broadcasts and relays button clicks through the background
// worker to the CRM tab.

(() => {
  const C = globalThis.RAYNA;
  const $ = (id) => document.getElementById(id);

  const els = {
    dot: $('conn-dot'), noCrm: $('no-crm'),
    name: $('lead-name'), phone: $('lead-phone'), email: $('lead-email'),
    campaign: $('lead-campaign'), counter: $('lead-counter'),
    badge: $('state-badge'), timer: $('timer'), phaseDetail: $('phase-detail'),
    start: $('btn-start'), stop: $('btn-stop'),
    voicemail: $('btn-voicemail'), live: $('btn-live'),
    prestage: $('btn-prestage'), skip: $('btn-skip'),
    notInterested: $('btn-notinterested'),
    freezeBox: $('freeze-box'), freezeMsg: $('freeze-msg'),
    callScript: $('call-script'), resume: $('btn-resume'),
    log: $('log'), listenLine: $('listen-line'),
  };

  const PHASE_STYLE = {
    idle: ['st-idle', 'idle'],
    reading: ['st-work', 'reading lead'],
    dialing: ['st-work', 'dialing'],
    ringing: ['st-ring', 'ringing…'],
    connected: ['st-conn', 'CONNECTED'],
    logging: ['st-work', 'logging'],
    advancing: ['st-work', 'next lead'],
    prestaging: ['st-work', 'pre-staging'],
    frozen_live: ['st-frozen', 'LIVE — manual'],
    frozen_prestage: ['st-frozen', 'staged — manual'],
    paused_error: ['st-err', 'PAUSED — error'],
  };

  let renderedLogKey = '';
  let lastStatusAt = 0;

  function sendCmd(cmd) {
    return chrome.runtime.sendMessage({ type: C.MSG.PANEL_CMD, cmd })
      .then((res) => {
        if (res && res.error) showNoCrm(res.error);
        return res;
      })
      .catch(() => showNoCrm());
  }

  function showNoCrm(msg) {
    els.noCrm.style.display = 'block';
    if (msg) els.noCrm.textContent = msg;
    els.dot.classList.remove('on');
  }

  function fmtMs(ms) {
    if (!ms || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function render(st) {
    lastStatusAt = Date.now();
    els.noCrm.style.display = 'none';
    els.dot.classList.add('on');

    const lead = st.lead || {};
    els.name.textContent = lead.name || '—';
    els.phone.textContent = lead.phone || '—';
    els.email.textContent = lead.email || '—';
    els.campaign.textContent = lead.campaignTag || '—';
    els.counter.textContent = lead.counter || '—';

    const [cls, label] = PHASE_STYLE[st.phase] || ['st-idle', st.phase];
    els.badge.className = cls;
    els.badge.textContent = label;
    els.timer.textContent =
      (st.phase === 'connected' || st.phase === 'ringing' || st.phase === 'dialing')
        ? fmtMs(st.callElapsedMs) : '';
    els.phaseDetail.textContent = st.phaseDetail || '';

    const li = st.listen;
    if (li && (li.active || li.suggestion)) {
      const lastCue = (li.cues || [])[li.cues.length - 1];
      els.listenLine.style.display = 'block';
      els.listenLine.textContent = li.suggestion
        ? `🎙 Sounds like: ${li.suggestion}${lastCue ? ` (at ${lastCue.at})` : ''} — your call`
        : '🎙 listening to your mic…';
    } else {
      els.listenLine.style.display = 'none';
    }

    els.start.disabled = st.running;
    els.stop.disabled = !st.running;
    for (const b of [els.voicemail, els.live, els.skip, els.notInterested]) {
      b.disabled = !st.decisionNeeded;
    }
    // Pre-stage also works DURING a live/prestage freeze (an interested turn
    // can come after the Live decision).
    els.prestage.disabled = !(st.decisionNeeded ||
      (st.frozen && (st.freezeReason === 'live' || st.freezeReason === 'prestage')));

    const frozen = st.frozen;
    els.freezeBox.style.display = frozen ? 'block' : 'none';
    els.freezeBox.classList.toggle('error', st.freezeReason === 'error');
    if (frozen) {
      els.freezeMsg.textContent = st.errorMessage || st.phaseDetail || 'Frozen — press Resume when done.';
      els.callScript.textContent = st.callScript || '';
      $('script-details').style.display = st.freezeReason === 'error' ? 'none' : 'block';
    }

    for (const k of ['dialed', 'noAnswer', 'voicemail', 'busy', 'dropped',
      'techFailure', 'invalid', 'live', 'prestaged', 'skipped',
      'notInterested', 'errors']) {
      const el = $(`t-${k}`);
      if (el) el.textContent = (st.tally && st.tally[k]) || 0;
    }

    renderLogs(st.logs || []);
  }

  function renderLogs(logs) {
    // Logs arrive as a capped slice, so length alone can't detect new lines —
    // key on the last entry's identity too.
    const last = logs[logs.length - 1];
    const key = `${logs.length}|${last ? last.t + last.text : ''}`;
    if (key === renderedLogKey) return;
    els.log.innerHTML = '';
    for (const line of logs) {
      const div = document.createElement('div');
      div.className = `log-${line.level}`;
      const t = new Date(line.t);
      const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      div.textContent = `${hh} ${line.text}`;
      els.log.appendChild(div);
    }
    renderedLogKey = key;
    els.log.scrollTop = els.log.scrollHeight;
  }

  // --- wire up -------------------------------------------------------------
  els.start.addEventListener('click', () => sendCmd(C.CMD.START));
  els.stop.addEventListener('click', () => sendCmd(C.CMD.STOP));
  els.voicemail.addEventListener('click', () => sendCmd(C.CMD.VOICEMAIL));
  els.live.addEventListener('click', () => sendCmd(C.CMD.LIVE));
  els.prestage.addEventListener('click', () => sendCmd(C.CMD.PRESTAGE));
  els.skip.addEventListener('click', () => sendCmd(C.CMD.SKIP));
  els.notInterested.addEventListener('click', () => sendCmd(C.CMD.NOT_INTERESTED));
  els.resume.addEventListener('click', () => sendCmd(C.CMD.RESUME));
  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Live status broadcasts from the CRM engine.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === C.MSG.STATUS && msg.payload) render(msg.payload);
  });

  // Initial sync (and re-sync if broadcasts go quiet, e.g. panel opened late).
  async function syncStatus() {
    const res = await sendCmd(C.CMD.GET_STATUS);
    if (res && res.ok && res.status) render(res.status);
  }
  syncStatus();
  setInterval(() => {
    if (Date.now() - lastStatusAt > 5000) syncStatus();
  }, 5000);
})();

# Rayna Auto-Dialer (Chrome Extension)

A Manifest V3 Chrome extension that automates the repetitive parts of the Rayna CRM
outbound-calling workflow: it dials each lead, waits out no-answers, auto-logs
non-connected outcomes, and pre-stages follow-up messaging — while keeping every
human-judgment step and every "Send" action manual.

> Personal, load-unpacked tool. It runs inside your own already-logged-in browser
> session. It never logs in, never creates accounts, and never sends messages/emails.

## What it does

- Reads the current lead (name, phone, email, CampaignTag, queue position) from the CRM.
- Clicks Call Now and watches the Twilio softphone state.
- If the call stays "Ringing" past the ring timeout, it hangs up and logs **No Answer**.
- On a failure toast it logs the matching Reason (Busy / Call Dropped / Technical Failure / Invalid–Not in Service).
- When a call **connects**, it stops and asks you (button or hotkey):
  - **Voicemail** -> hangs up, logs **No Answer** (operator preference, matching the
    CRM's own call status; set `CRM.VOICEMAIL_LOG_REASON` in config.js to
    `REASONS.VOICEMAIL` for "Left Voicemail"), advances.
  - **Live** -> freezes so you can run the interested branch by hand. **Pre-stage and
    Not interested stay available during the freeze** — stage drafts if the conversation
    turns interested, or log Not Interested and continue dialing if it turns out a no
    (no Resume needed).
  - **Pre-stage** -> fills the WhatsApp "If Interested" message + opens the Gmail RSVP draft (never sends), then freezes.
  - **Not interested** -> hangs up, sets the toggle to **Connected**, selects
    **"How interested?" = Not Interested** (connected outcomes use the chip row —
    the Reason dropdown only exists for Not Connected), saves, advances.
  - **Skip** -> hangs up and advances without logging.
- Advances to the next lead and repeats.

## Hard safety rules (built in, cannot be turned off)

- No code path clicks Send / Send-message / Send-email / submit on WhatsApp, Gmail, or Calendar
  (the WhatsApp/Gmail scripts route every click through a guard that refuses anything labelled like Send).
- Never creates a calendar invite programmatically (the extension has no calendar access at all).
- Never auto-sets RSVP, warmth, interested, or developer chips — logging touches only
  the Not Connected toggle, the Reason dropdown, and Save Outcome.
- Never advances past a Live or Pre-stage signal without an explicit Resume.
- Call decisions use the softphone state text + toasts only — never the manual "Did you connect?" toggle.
- On any selector failure it pauses and shows the intended action instead of continuing.

## Install (load unpacked)

1. Log into the CRM (crm.rayna-properties.com), WhatsApp Web (web.whatsapp.com), and Gmail (mail.google.com) in this browser.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension and click its icon to open the **side panel**.

## Run

1. Open the CRM lead queue so a lead detail page is showing.
2. In the side panel, confirm it shows the current lead / campaign / counter.
3. Click **Start**. Keep an earphone on to judge voicemail vs live for connected calls.
4. Click **Stop** (or press the quit hotkey) anytime; it finishes logging the current lead first.

### After Live / Pre-stage

On **Live** or **Pre-stage** the tool freezes with the call still up and shows the
call-opening script. You run the interested branch entirely by hand (warmth, RSVP,
send WhatsApp/email, calendar, **Save Outcome**, **Next**) — then press **Resume**.
Resume continues dialing **from whatever lead is on screen**; it never clicks Next
for you past a frozen lead, so click Next yourself before resuming.

The same applies to an **error pause** (red box): do the surfaced action manually,
make sure the outcome is saved, and click **Next** if that lead is finished —
*then* press Resume. Resuming with the same lead still on screen dials it again.

## Team distribution

Run `./package.sh` to build `dist/rayna-autodialer-v<version>.zip` and share it;
each teammate follows **TEAM-SETUP.md** (unzip → load unpacked → log into their
own CRM/WhatsApp/Gmail → personalize the Scripts & templates section in options
with their own name → copy the RSVP draft into their own Gmail). Everything —
settings, templates, learned selector fixes, stats — is per-browser, so
teammates don't affect each other.

For a larger rollout, the polished path is publishing to the Chrome Web Store
as **unlisted** (teammates install from a private link, and updates ship
automatically instead of everyone re-pulling) — requires a one-time $5
developer registration and a review pass. With Google Workspace, an admin can
also force-install the extension org-wide via policy.

## Configuration (options page)

| Setting | Default | Meaning |
|---|---|---|
| RING_TIMEOUT_MS | 28000 | Max wait in "Ringing" before auto-hangup as No Answer |
| POLL_MS | 500 | Softphone-state poll interval |
| MAX_LEADS | 0 | Session cap (0 = unlimited) |
| PREFILL_WHATSAPP_ON_MISS | false | Pre-fill the "If Not Answered" WhatsApp on voicemail/no-answer |
| WHATSAPP_MODE | existing_tab | existing_tab (fill your open WhatsApp Web tab) or wa_link (open a /send link) |
| GMAIL_DRAFT_SUBJECT | RSVP Confirmed: First time ever meet the TOP Developers of Dubai Virtually | Draft the pre-stage step opens |

Hotkeys — Voicemail `Alt+Shift+V`, Live `Alt+Shift+L`, Pre-stage `Alt+Shift+P`,
Skip `Alt+Shift+S` (Resume and Quit have no default) — are configurable at
`chrome://extensions/shortcuts`.

## File layout

```
rayna-autodialer/
  manifest.json          # MV3: scripting, storage, sidePanel, tabs, commands + host perms
  background.js          # service worker: cross-tab relay + hotkey commands
  content-crm.js         # the engine: state machine, polling, CRM clicks (state lives here)
  content-whatsapp.js    # pre-stage only: fill "If Interested" template, never send
  content-gmail.js       # pre-stage only: open RSVP draft, set To, personalize, never send
  sidepanel.html/.js     # UI: current lead, state+timer, buttons, tally
  options.html/.js       # config knobs above
  config.js              # SINGLE source of selectors + labels (edit here if CRM UI changes)
```

## Selectors (all live in config.js)

- Call button: `button` whose text matches `/^(Call Now|On Call|End Call)/i`
- Call state: softphone panel innerText tokens `Calling | Ringing... | Connected` + `MM:SS` timer
- Queue counter: text like `"33 of 156"`
- CampaignTag: quote-style-tolerant regex against the Raw Source Data text (the live
  CRM stores a Python-dict-style string — single-quoted keys, single/double/curly-quoted
  values, apostrophes inside values like `November'25`); also falls back to `Campaignname`
- Reason dropdown: click the "Select reason..." trigger, then click the option whose text exactly equals the target
- Reason labels (exact): No Answer, Busy, Left Voicemail, Call Dropped, Technical Failure, Wrong Number, Invalid / Not in Service
- Not Connected toggle, Save Outcome, Next: by visible text/role

## Self-learning loop

The tool learns from live actions you perform — never from guesses of its own. All
learned data stays in `chrome.storage.local` in this browser; the options page shows
everything and every item has a Forget button (plus a master on/off toggle and a
"Forget all" button).

1. **Selector healing (teach-on-pause).** When a CRM selector fails, the session pauses
   as usual — but now the click you make to perform the action manually is captured and
   learned as a *fallback* for that action (Not Connected toggle, Reason dropdown
   trigger, each Reason option, Save Outcome, Next). The original config.js selector is
   always tried first; the learned one only kicks in when config fails. For a failed
   Reason *option*, your **last** click before Resume is learned (you have to reopen the
   dropdown first); for everything else it is your **first** click.
2. **Toast → Reason mapping.** Failure toasts the config doesn't recognize are collected
   and shown on the options page with a Reason picker. Mappings you approve are applied
   like built-in ones from then on. Nothing is auto-applied without your approval.
3. **Ring-timeout tuning.** The seconds-to-answer of every connected call is recorded;
   once there are 20+ samples the session-end log and the options page suggest a tuned
   `RING_TIMEOUT_MS` (95th percentile + 4 s buffer). You apply it yourself in options.

Learning hard limits: capture refuses any element whose label looks like Send/submit;
learning only extends the fixed actions the engine already performs — it can never add
new actions, set RSVP/warmth/chips, automate the voicemail-vs-live judgment, or touch
WhatsApp/Gmail (those stay config-only by design). The call button itself is also
excluded — its labels drive the whole state machine, so a relabel there is a deliberate
one-line config.js edit.

## Call listening (beta, opt-in)

Turn on *"Listen to MY side of connected calls"* in options and, once a call connects,
the tool transcribes **your microphone side only** and matches distinctive phrases you
say against `CALL_CUES` in config.js — the RSVP close ("confirm your registration",
"calendar invite", "preferred developer"), decline wrap-ups ("not interested", "remove
my number"), voicemail messages ("leaving you a quick message"), and callback requests.
When a cue fires, the side panel shows *"🎙 Sounds like: Qualified — RSVP / next steps
(at 01:42) — your call"* and the moment is timestamped in the log. Over time the
learning layer reports which of your phrases predict which decision and how far into a
call your decisions typically happen (options page → Call-listening stats).

Two speech engines:

- **webspeech** (default, zero install): the browser's built-in recognizer. Depending on
  platform, Chrome may process this audio on the vendor's servers.
- **local_server** (fully private): 5-second mic chunks are POSTed to a Whisper server
  running **on this machine** — the background worker refuses any non-localhost URL, so
  call audio can never leave your computer. Compatible endpoints include
  [Voicebox](https://github.com/jamiepine/voicebox) (MIT) and
  [OmniVoice Studio](https://github.com/debpalash/OmniVoice-Studio) (AGPL-3.0) — both are
  desktop apps with local Whisper STT and a FastAPI backend — or a plain
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `server`. Point
  `LISTEN_STT_URL` at the endpoint (OpenAI-style `/v1/audio/transcriptions` or
  whisper.cpp `/inference`; the response just needs a `text` field).

Hard limits: it never captures the lead's audio (capturing the remote party is call
*recording* and subject to consent laws — that belongs server-side via Twilio AMD/Media
Streams, Section 6 of the handoff doc, with proper consent handling); suggestions never
trigger actions — voicemail/live/RSVP decisions stay yours; nothing is stored except
cue tags, decisions, and timings (no transcripts, no audio).

## Known live-CRM fixes (v1.2.1)

- **Hang-up now targets the real "End Call" control.** On this CRM, the top toggle
  only ever shows status text ("Call Now" / "On Call...") — the actual hang-up button
  is a separate "End Call" control inside an "Active Call" panel that appears once
  connected. Clicking the top toggle to hang up did nothing, which is why almost every
  call that needed to end (Voicemail, Skip, and the outcome-logging that follows) was
  pausing with a selector error. Fixed to look for the exact "End Call" button first.
- **Stop now always works, even mid-call.** Previously, pressing Stop while a call was
  connected and awaiting your Voicemail/Live/Pre-stage/Skip decision only set a flag —
  if you never pressed one of those four buttons (e.g. you hung up from the CRM's own
  controls instead), the session would wait forever. Stop now hangs up immediately and
  ends the session with no outcome logged, if pressed while a decision is pending.
- **Campaign tag capture hardened.** The Raw Source Data toggle search no longer skips
  a "Show" control that wraps an icon, and now logs a warning if it still can't find the
  toggle or the tag — so a future miss will say exactly why instead of failing silently.

## Behaviour notes

- Softphone state/timer are read only inside the softphone panel (found by climbing up
  from the call button, stopping before the Log Call Outcome panel) — never from the
  whole page, so the outcome toggle's own labels can never masquerade as call state.
  If auto-detection struggles, pin it with `CRM.SOFTPHONE_CONTAINER` in config.js.
- Failure toasts already on screen when a call starts are ignored (a leftover toast from
  the previous lead cannot be attributed to the next call).
- A call that ends while still ringing with no failure toast (e.g. declined) is logged
  with `CRM.RING_ENDED_EARLY_REASON` (default **No Answer**) — change it in config.js.
- After Save Outcome the tool waits up to 8 s for a *fresh* confirmation toast and
  **pauses** if none appears (a failing save can never silently skip leads). If your CRM
  saves without any toast, set `CRM.REQUIRE_SAVE_CONFIRM = false` or fix
  `CRM.SAVE_CONFIRM_RE` in config.js.
- If the softphone never leaves idle after Call Now, or a hang-up doesn't take, the tool
  pauses (it will not mis-log a lead that was never dialed or still on the line).
- WhatsApp pre-stage only opens a search result that verifiably matches the lead (trailing
  phone digits or the lead's name in the row) — never "the first row".
- Gmail pre-stage only edits the compose window whose Subject matches
  `GMAIL_DRAFT_SUBJECT`; a pre-existing unrelated compose window is never touched.

## Troubleshooting

- **CRM tab / lead not found** — open a `crm.rayna-properties.com/lead/` page and reload it.
- **Selector failed** (usually Reason dropdown or Gmail draft) — the UI changed a label; edit that one entry in `config.js`. These two are the most fragile.
- **Nothing happens after connect** — MV3 worker suspended; reload the extension and reopen the side panel. Refreshing the CRM tab re-syncs the state (which lives in content-crm.js).

## Known-manual by design

The WhatsApp flyer attachment, all Send buttons, and the calendar invite are intentionally
manual — for safety and because file/attachment dialogs are native. The tool stages up to,
but never past, the Send.

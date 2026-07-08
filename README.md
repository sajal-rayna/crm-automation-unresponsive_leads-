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
  - **Voicemail** -> hangs up, logs **Left Voicemail**, advances.
  - **Live** -> freezes so you can run the interested branch by hand.
  - **Pre-stage** -> fills the WhatsApp "If Interested" message + opens the Gmail RSVP draft (never sends), then freezes.
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
- CampaignTag: regex `CampaignTag"?\s*[:=]\s*"([^"]+)"` against Source JSON text
- Reason dropdown: click the "Select reason..." trigger, then click the option whose text exactly equals the target
- Reason labels (exact): No Answer, Busy, Left Voicemail, Call Dropped, Technical Failure, Wrong Number, Invalid / Not in Service
- Not Connected toggle, Save Outcome, Next: by visible text/role

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

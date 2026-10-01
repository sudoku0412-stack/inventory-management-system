# Bugfix plan

## Guiding principles

- Prefer observed behavior and captured evidence over plausible theories.
- Make one narrowly scoped, reversible fix at a time.
- Preserve user data and avoid changing authentication, DNS, or deployment state while diagnosing.
- Every fix ends with a regression test and an independently reviewable checkpoint.

## Triage phases

1. **Identify the production version.** Record the deployed Worker/version, commit or PR, browser/device, and timestamp.
2. **Reproduce.** Write exact steps, expected behavior, actual behavior, frequency, and whether a clean session changes it.
3. **Capture request/response evidence.** Record URLs, status codes, relevant headers, console errors, and response/body differences. Remove secrets and personal data.
4. **Compare deployed vs source.** Inspect the deployed asset/API and the corresponding source, including generated output and configuration.
5. **Apply one evidence-backed fix.** Keep the change limited to the confirmed cause; document rejected hypotheses when useful.
6. **Add a regression test.** Prefer a deterministic test at the failing boundary; include accessibility and browser behavior where relevant.
7. **Review and deliver.** Update `HANDOVER.md`, have the change reviewed, commit with a descriptive message, open/attach the PR, deploy only after merge, and run an end-to-end production check.

## Incident log template

```text
Date / reporter:
Production version:
Symptom and impact:
Browser/device:
Reproduction steps:
Expected / actual:
Request/response evidence:
Source-vs-deployed comparison:
Confirmed root cause:
Fix and regression test:
Review / PR / deployment:
End-to-end verification:
Follow-up:
```

## Communication expectations

Report the current hypothesis separately from confirmed facts. Give the user the smallest useful next action when more evidence is needed. At each checkpoint state what changed, what was tested, what remains uncertain, and any pending user or console action. Do not claim production resolution until the deployed version is verified end to end.

## Incident: invitation overlay remained visible

- **Initial hypotheses:** stale Cloudflare/Safari cache or an old bootstrap bundle appeared plausible because the issue followed deployment. Cache headers were hardened as a separate defensive improvement, but this did not establish the UI cause.
- **Decisive evidence:** `showApp()` set `#inviteGate.hidden = true`, while `public/styles.css` set `.invite-gate { display: grid; }`. The author rule overrode the browser’s hidden presentation rule, so the gate remained visible.
- **Permanent prevention:** add `.invite-gate[hidden] { display: none; }` and a regression assertion. Keep the production-version, evidence, source-vs-deployed, and end-to-end checks above as required steps for future incidents.

## Incident: verified user greeted as legacy profile name

- **Report:** `kmaz285@gmail.com` saw `Sudoku` in Profile and the greeting rather than the name derived from their verified Cloudflare Access identity.
- **Confirmed root cause:** legacy bootstrap copied the old profile row into tenant settings. Migration 0008 labelled every pre-existing row `user`, so the verified-identity seed deliberately skipped that inherited row.
- **Resolution:** the user explicitly accepted a one-time global compatibility reseed. Migration 0009 reclassifies every pre-0009 `user` marker to `default`, including `Sudoku`, because the prior schema has no audit marker separating inherited/default rows from historical explicit saves. Each household receives at most one verified-identity seed when its settings are next read; the cloud store then records `identity_seed`. Bootstrap copies are also marked `default`. A subsequent settings PATCH records `user` and is preserved.
- **Safety boundary:** no edge email header or browser identity value is used. The seed comes only from a validated Access JWT claim, with its sanitized verified-email local-part as fallback.
- **Regression coverage:** tenant tests cover `Sudoku` to `Kaushik Sudesna`, future explicit-edit preservation across a later identity change, and another household retaining its selected name. Apply 0009 before the Worker and perform an authenticated production Profile/greeting check.

## Incident: mobile medicine form jumps on open

- **Report:** the Add medicine and Edit medicine form could jump outside the phone viewport, then snap back.
- **Confirmed root cause:** the mobile dialog was bottom-sheet styled with `max-height: 92vh` and `margin: auto 0 0`; changing mobile browser chrome could recalculate that legacy viewport height and auto placement. A delayed name-field focus then initiated a second scroll. Dynamic photo preview changes were also eligible for scroll anchoring.
- **Resolution:** use explicit fixed bottom placement and dynamic viewport sizing, contain dialog overscroll, disable scroll anchoring, reset the dialog’s scroll position after opening, and focus the name field with `preventScroll`.
- **Regression coverage:** `test/mobile-medicine-dialog.test.js`; the expiry-date row is intentionally asserted unchanged in this narrowly scoped fix.

## Incident: expiry-date row was unclear on mobile

- **Report:** the expiry-date row did not match the intended medicine form on a phone and gave no clear way to record an unknown expiry.
- **Confirmed source cause:** the form exposed only a bare optional date input. It omitted the product’s supported unknown-expiry choice and its explanatory text; the general form input rule would also make a later checkbox render at full field dimensions unless it was explicitly scoped.
- **Resolution:** give the date input an explicit label and help text, pair it with a native labelled unknown-expiry checkbox, and scope checkbox dimensions independently from date fields. Selecting unknown clears and disables the date; edit, reset, and package-suggestion paths keep that state in sync. The existing form/unit choices and mobile dialog viewport rules remain in place.
- **Regression coverage:** `test/expiry-date-field.test.js` asserts the state transitions; `test/mobile-medicine-dialog.test.js` now asserts the intended mobile expiry markup and checkbox sizing instead of the stale unchanged-row expectation.

## Incident: iPhone Safari expiry control remained oversized

- **Production evidence:** PR #34 and Worker `dd57709e-00d9-4295-9c6e-b77d3b06e56e` removed the visible calendar indicator, but the reporter’s iPhone screenshot still showed a blank date field roughly twice the height of adjacent 44px controls.
- **Why the first attempt was insufficient:** `.expiry-date-input` only set `min-height: 44px`. That establishes a floor, not a ceiling, so iOS Safari’s intrinsic native date-control size could remain larger. The source assertion passed without testing the actual sizing constraint.
- **Follow-up fix:** keep the labelled native `type="date"`, reset its scoped iOS appearance, and set explicit 44px physical and logical height/min/max bounds with border-box sizing and compact padding/line-height. The calendar-indicator rule remains scoped to this field.
- **Acceptance gate:** automated tests must assert the native input, strict sizing bounds, and appearance reset; a rendered mobile check must confirm the computed 44px height. Because local browser emulation is not iOS Safari, the incident remains open until the reporter confirms the deployed result on the original device.

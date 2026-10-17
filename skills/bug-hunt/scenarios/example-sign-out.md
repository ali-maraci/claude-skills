---
id: example-sign-out
area: account
persona: finished-member
start: /
modes: [happy, fuzz]
budget: { max_turns: 30 }
---
## Goal
Sign out of the app and make sure the pages that need an account are closed to you afterwards.

## Success criteria
- A "Sign out" control is easy to find while signed in. Using it signs you out and lands you on the
  sign-in page.
- After signing out, opening a signed-in page directly (type its address, or use a bookmark) sends you
  to the sign-in page every time.
- After signing out, the browser Back button never brings back a working signed-in page: either you
  land on the sign-in page, or a stale copy shows and the first click on it sends you to sign-in.
  Account data visible after sign-out is a bug.
- A cookie or consent banner may show; dismissing it is not a bug.

## Fuzz twists
- Double-click "Sign out".
- Open a signed-in page in a second tab, sign out in the first tab, then click around in the second tab.
- After signing out, press Back several times, then Forward.
- Start something unfinished (open a dialog or a half-filled form), then sign out.
- After signing out, open any API address you saw in the page or console: it must not return
  account data (an "unauthenticated" answer is correct).

## Out of bounds
- No real personal data — type only obviously fictional text.
- Upload only files from `scenarios/fixtures/`, if the scenario needs any (none are needed here).
- Staging only — never open any other host.
- Do not sign back in and do not type any address into the sign-in page; the orchestrator signs the
  member in for the next scenario.
- Do not quote names or email addresses from the page in findings.

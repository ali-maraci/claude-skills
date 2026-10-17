# Review checklist — what reviewers keep catching after the first review passed

Apply each item to the diff; skip an item that does not apply to this repo. Add a line here when
a reviewer catches a new class — this file is read by the lifecycle correctness reviewer, so one edit
reaches every run.

## Any repo
1. **Comments tell the truth.** Every comment, docstring, runbook line and SQL `COMMENT ON` the diff adds or touches matches the code at HEAD — not an earlier commit of this branch. Tell: words like "guarantees", "always", "only", "exactly one place", "already guarded upstream", or a name/path that no longer exists.
2. **Siblings updated together.** For each changed function signature, rule, constant, template or contract, grep for the other places that must change with it (wrappers, sibling routes/macros, web vs mobile, deploy scripts, seed data) and confirm each is updated or not applicable. Bounded: grep the changed names only, not a repo sweep.
3. **Tests can fail.** Each new test would go red if the code it protects were removed. Tell: a fixture default that already produces the expected outcome, an assertion on an empty list, or a test that encodes the current (buggy) behaviour instead of the ticket's rule.
4. **Failure is not success.** Every external call/helper whose result is falsy, empty or raises is handled — no ignored return value, no failure reported as a clean skip, no `or default` that clobbers a legitimate `0`/`""`.
5. **Retries and races.** Every write/claim: what if it is retried, run concurrently, or half-fails? Stale responses must not overwrite newer state.
6. **Reuse before adding.** A new helper is checked against existing ones by BEHAVIOUR (grep the SQL/logic), not by name.
7. **Names don't lie.** A function, param or test factory whose name contradicts what the code path does.

## Backend (examples)
8. **No personal data in error text.** No new `{e}` / `str(e)` / `repr(e)` / row or request object on any log, print, exception detail, SMS/email error or API error field — DB-driver errors embed row values. Use a static message + `type(e).__name__`.
9. **LLM inputs are bounded.** Free text flowing into a prompt or PDF has server-side length caps and passes any de-identification the spec requires.
10. **Language-to-database boundary.** Validated text can still hold NUL; a parser (`fromisoformat`, regex) can accept more than the column; text vs int keys; `CURRENT_TIMESTAMP` is frozen per transaction; `timestamptz` vs naive `timestamp` compares in the session TimeZone.
11. **Declared ≠ live.** An event, flag, queue or env var the change relies on has a real emit/read call site, not only a declaration and a test.

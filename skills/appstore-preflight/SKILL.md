---
name: appstore-preflight
description: Use when preparing an Expo iOS build for App Store or external TestFlight submission, when asked whether the app would pass App Review, when an ITMS-91053 or other App Store Connect processing error appears, or after adding a native dependency, permission, config plugin, or privacy-manifest change.
---

# App Store preflight

Checks the mobile app against the pre-submit checklist from
<https://appcompliance.io/blog/ios-app-submission-checklist/>, adapted to an Expo repo.

**Core rule: inspect a BUILT Release app, never the prebuild `ios/` source tree.** Expo plugins
edit the plist at build time. For example, expo-dev-launcher's "Strip Local Network Keys for
Release" phase deletes the `NSLocalNetworkUsageDescription` and `_expo._tcp` entries that the
source Info.plist still shows.

## Run it

Run it from inside your Expo app repo (any checkout or worktree; it finds the repo root
with git), or pass `--repo PATH`. That checkout needs its dependencies installed. The script lives in
this skill's `scripts/` folder, `~/.claude/skills/appstore-preflight/scripts/` when installed.

Options:

| Flag | Default | Purpose |
|---|---|---|
| `--mobile-dir DIR` | `apps/mobile` | Expo app directory relative to the repo root (holds `eas.json`) |
| `--clear-env NAMES` | none | Comma-separated env vars to blank before prebuild. Use it for variables your `.env` sets for local development (a dev flavor, an analytics key) that must not leak into the release build, e.g. `--clear-env MY_FLAVOR,SENTRY_DSN` |
| `--guardrail-cmd CMD` | unset | A source check to run in the mobile dir, e.g. `--guardrail-cmd "npx vitest run"`. Non-zero exit is a FAIL; unset prints `INFO Guardrails skipped` |
| `--api-base-env NAME` | `EXPO_PUBLIC_API_BASE_URL` | EAS profile env var holding the API base URL. If no profile sets it, the dev-host check is skipped with a WARN |
| `--src-dirs a,b,c` | `app,modules,shared` | Source dirs (relative to the Expo app dir) scanned for dev hosts. If none exist, a WARN names this flag |
| `--sdk-key SDK=ENV` | none, repeatable | Maps an SDK framework name to the profile env var that enables it. An SDK whose var is unset is reported dormant. `--sdk-key PostHog=ENV` also turns on the PostHog key-leak check |

`preflight.sh` passes `--api-base-env`, `--sdk-key` and `--src-dirs` through to `scripts/check_app.py`.

| Mode | Command | Checks signing | Checks Pods/native sources |
|---|---|---|---|
| Local Release build, production profile (10–20 min) | `bash ~/.claude/skills/appstore-preflight/scripts/preflight.sh` | No | Yes |
| **The EAS IPA that will ship** (preferred before submitting) | `… preflight.sh --ipa build.ipa` | Yes | No (bundle only) |
| An existing `.app` | `… preflight.sh --app path/YourApp.app` | If signed | No |

One run checks one binary against one profile. Pick the mode from what the user gave:
no path means the default local build; a `.ipa` path means `--ipa`; a `.app` path means `--app`.
If they ask for several targets, run the script once per target.

- Add `--profile staging` for the staging identity. The profile must match the binary: checking a
  production IPA with `--profile staging` FAILs on "profile API base not in bundle", as intended.
  If you can't tell which profile a supplied IPA was built with, ask.
- Typical release flow is two runs: the default local build before starting the EAS build, then
  `--ipa` on the downloaded build right before submitting (the only run that checks signing).
- Get the IPA from the build's page on expo.dev, or with `eas build:download` if eas-cli is installed.
- Run the local build with `run_in_background`. It regenerates the gitignored `<mobile-dir>/ios/`; say so.
- The script exits 1 on any FAIL, including a failing `--guardrail-cmd`.

## Verdict

- Any FAIL: **not ready**; list the FAILs.
- 0 FAIL: **no blockers found in the binary**, never "will pass review". State what wasn't
  checked (signing, unless `--ipa`) and list the manual items below.
- A non-production profile (`INFO Identity` line): the verdict covers TestFlight or that profile's own
  App Store Connect app only. It ships staging URLs by design, so public release needs a separate
  run on the production IPA.

FAIL means fix before submitting. WARN means fix or justify. INFO means a human decision or App Store Connect input.

## Interpreting findings

- **Leave these INFO lines alone:**
  - `NSAllowsLocalNetworking`: from Expo's template, covers the local network only
  - the `exp+<slug>` dev-client URL scheme
  - `localhost:8081` and `:3000` marked "library dev default"
  - `MinimumOSVersion 16.0` on Xcode 27 local builds: forced for the build. The real target is the `INFO Target app project` line.
- **Privacy reason-code gaps:** add them under `ios.privacyManifests` in your `app.config.ts`.
  Pods are linked as static frameworks, so Apple may read only the app-level manifest.
- **`collected by …` / `declared by …` lines** come from SDK manifests, which say what an SDK *can*
  collect. "Active in this profile" means the label must declare that data type. "Dormant" means
  the profile sets no key for the SDK, so it collects nothing and the label doesn't need it.
- **Permission strings:** changing one also means updating any tests that pin your purpose strings.
- **`DeepLinks` lines** list what to test on a device. The binary can't prove a link works.
- **`Login` WARN (4.8):** the app has no Sign in with Apple entitlement. If it offers any third-party sign-in, 4.8 needs an equivalent login.
- **`Privacy` WARNs for file sharing or iCloud:** these entitlements expose the app's documents
  outside the app. Make sure nothing sensitive is stored there.
- **`Signing` certificate line (5.1.1(ix)):** the certificate should name the company that provides the service, not a person.
- **Example of a known WARN:**
  - a sharing library's UserDefaults reason code (local-build mode only): expected. It needs reason `1C8F.1` only if an App Group entitlement is added.

## Privacy label

The label is the **App Privacy** questionnaire in App Store Connect (app → App Privacy). It isn't in
code, and it isn't the privacy policy, which is only a URL entered on the same page. It is set per
App Store Connect app, not per build. If production and staging are separate apps (`ascAppId` in
`eas.json`), each has its own label. App Review judges the label.

- An empty app-level `NSPrivacyCollectedDataTypes` is fine. Apple's upload checks (ITMS-91053,
  91056, 91061, 91064) don't compare it with anything, so don't add it just to silence a report.
- The binary can't show the app's **own** collection. List each SDK and vendor that processes user
  data (analytics, crash reporting, AI or speech providers, backend services), and what they receive
  (for example contact info, user content, audio, identifiers). Data a vendor processes on your
  behalf still counts as collected. The project owner signs off the answers.

## Manual items (list these for the user every run)

- **App Store Connect:**
  - screenshots match the build at the required device sizes (the `Metadata` line says whether iPad applies)
  - privacy policy URL is live
  - the App Privacy answers are current (see "Privacy label")
  - age rating is current (post-January 2026 questionnaire)
  - description matches the binary; contact details are current
  - export compliance is answered
- **Review notes (2.1, 2.3.1(a)):**
  - a working demo account. If sign-in uses email OTP or a third-party provider, the reviewer needs a way in that doesn't depend on your own inbox.
  - every new feature described specifically; generic notes are rejected
  - account deletion (5.1.1(v)): say how deletion works and how long it takes, especially if it is a request flow rather than self-serve.
- **Guidelines to confirm.** Record where your evidence lives: the consent text shown to users and the privacy notice (and where each is hosted).
  - 5.1.2(i) third-party AI: if user data goes to a third-party AI service, the consent text must
    disclose it and users must agree. Re-check when the vendor or the consent text changes.
  - 1.4.1 medical: if the app touches health, confirm any "not medical advice" acknowledgement is
    still present, and add no medical claims in metadata. Attach regulatory clearance only if the
    project owner confirms there is one.
  - 5.1.1(i): privacy policy reachable in the app and in App Store Connect.
  - 5.1.1(ii): before analytics ships in production, users need consent and a way to withdraw it.
  - 2.5.14: a clear on-screen indicator while a feature uses the mic or camera (device test).
  - 2.1: no placeholder or "coming soon" screens.
- **Guidelines that may not apply (check before flagging them):**
  - 4.7 covers software the app hosts but doesn't ship in the binary, such as mini apps and plug-ins. A feature the app ships itself is out of scope.
  - 1.2 covers content users share with other users. Private content isn't user-generated content
    in this sense. If the app shows generative-AI output, a "report this response" control is still cheap goodwill.
  - 3.1.3(d): real-time one-to-one services between two people (e.g. live tutoring) may be sold outside in-app purchase.
- **Physical-device smoke test:** camera, voice, push, Face ID, and every `DeepLinks` line
  (OAuth callbacks, links in emails).
- **Toolchain:** `--ipa` checks the SDK itself (`Toolchain` PASS/FAIL). Local-build mode can't, because
  `eas.json` may pin no EAS build image, so confirm the default image is Xcode 26 / iOS 26 SDK or newer.
- **Expo SDK:** the `Framework` line shows the checkout's version. Confirm it's still supported.
- **Not covered by the script:** verbose logging and test-only feature flags. Check these in the diff.

## Common mistakes

| Mistake | Fix |
|---|---|
| Grepping `ios/*/Info.plist` after prebuild | Inspect the built `.app`'s Info.plist |
| Blanket `IPHONEOS_DEPLOYMENT_TARGET=15.1` on Xcode 27 | ExpoRouter needs 16.0; the script uses 16.0 |
| Treating every `localhost` in the Hermes bundle as a leak | Libraries embed dev defaults. Proof of the right profile is the "bundle uses this profile's API base" PASS |
| Saying "passes App Review" from a simulator build | Signing and provisioning are only checked with `--ipa` |

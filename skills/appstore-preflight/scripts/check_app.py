#!/usr/bin/env python3
"""App Store preflight checks against a BUILT iOS .app (never the prebuild source tree).

Usage: python3 check_app.py --app PATH.app --profile production [--eas apps/mobile/eas.json]
       [--pods apps/mobile/ios/Pods] [--node-modules apps/mobile/node_modules]
       [--api-base-env EXPO_PUBLIC_API_BASE_URL] [--src-dirs app,modules,shared] [--sdk-key PostHog=EXPO_PUBLIC_POSTHOG_KEY ...]

Prints one line per finding (FAIL / WARN / INFO / PASS) and exits 1 if any FAIL.
"""
import argparse
import json
import os
import plistlib
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse

results = []


def report(level, check, msg):
    results.append((level, check, msg))


def load_plist(path):
    with open(path, "rb") as f:
        return plistlib.load(f)


# Symbols Apple treats as required-reason APIs (ITMS-91053), per category.
RR_SYMBOLS = {
    "UserDefaults": r"\b(NS)?UserDefaults\b",
    "SystemBootTime": r"\b(systemUptime|mach_absolute_time)\b",
    "FileTimestamp": r"\b(creationDate|modificationDate|NSFileCreationDate|NSFileModificationDate)\b",
    "DiskSpace": r"\b(NSFileSystemFreeSize|volumeAvailableCapacity\w*)\b",
    "ActiveKeyboards": r"\bactiveInputModes\b",
}

GENERIC_PURPOSE = re.compile(
    r"\$\(PRODUCT_NAME\)|^Allow \S+ to (access|use)|app functionality|Expo Dev Launcher",
    re.IGNORECASE,
)
SUSPICIOUS_HOST = re.compile(r"localhost|127\.0\.0\.1|staging|\.dev\.|ngrok|\.local$", re.I)

# App Store Connect has required the iOS 26 SDK (Xcode 26) since 2026-04-28.
# Raise this when Apple announces the next minimum.
MIN_IOS_SDK = 26

# SDKs whose manifest only describes real collection when the profile switches them on.
# Filled from repeated --sdk-key SDK=ENV_NAME arguments: SDK is the framework/bundle name
# (as in Pods or Frameworks/), ENV_NAME the EAS profile env var that enables it. Empty by default.
SDK_ENABLE_KEY = {}

# EAS profile env var that holds the API base URL baked into the JS bundle (--api-base-env).
API_BASE_ENV = "EXPO_PUBLIC_API_BASE_URL"

# Class and selector names survive symbol stripping, so their absence is meaningful.
IDFA_SYMBOLS = (b"ASIdentifierManager", b"advertisingIdentifier")


def manifest_types(plist):
    out = {}
    for t in plist.get("NSPrivacyAccessedAPITypes", []):
        cat = t.get("NSPrivacyAccessedAPIType", "").replace("NSPrivacyAccessedAPICategory", "")
        out.setdefault(cat, set()).update(t.get("NSPrivacyAccessedAPITypeReasons", []))
    return out


def check_info_plist(info):
    ats = info.get("NSAppTransportSecurity", {})
    if ats.get("NSAllowsArbitraryLoads"):
        report("FAIL", "ATS", "NSAllowsArbitraryLoads is YES (global ATS exception)")
    else:
        report("PASS", "ATS", "NSAllowsArbitraryLoads is not YES")
    for key in ("NSAllowsArbitraryLoadsInWebContent", "NSAllowsArbitraryLoadsForMedia"):
        if ats.get(key):
            report("WARN", "ATS", f"{key} is YES; justify it in review notes")
    for domain in ats.get("NSExceptionDomains", {}):
        report("WARN", "ATS", f"exception domain {domain}: confirm it is narrow and needed")
    if ats.get("NSAllowsLocalNetworking"):
        report("INFO", "ATS", "NSAllowsLocalNetworking is YES (Expo template default; local-only, accepted)")

    purposes = {k: v for k, v in info.items() if k.endswith("UsageDescription")}
    for key, text in sorted(purposes.items()):
        if GENERIC_PURPOSE.search(text) or len(text.strip()) < 20:
            report("FAIL", "Permissions", f"{key} is generic or dev text: {text!r}")
        else:
            report("INFO", "Permissions", f"{key}: {text!r} (confirm a feature really uses it)")
    if "_expo._tcp" in info.get("NSBonjourServices", []):
        report("FAIL", "Debug", "NSBonjourServices still lists _expo._tcp (dev launcher not stripped)")
    for mode in info.get("UIBackgroundModes", []):
        report("INFO", "Permissions", f"background mode {mode}: needs a user-visible reason")

    schemes = [s for t in info.get("CFBundleURLTypes", []) for s in t.get("CFBundleURLSchemes", [])]
    for s in schemes:
        if s.startswith("exp+"):
            report("INFO", "Debug", f"URL scheme {s} is expo-dev-client's generated scheme (harmless)")
        else:
            report("INFO", "DeepLinks", f"URL scheme {s}: test that its links open the app on a device")

    if 2 in info.get("UIDeviceFamily", []):
        report("INFO", "Metadata", "UIDeviceFamily includes iPad: ASC needs iPad screenshots too")
    else:
        report("INFO", "Metadata", "iPhone only (no iPad in UIDeviceFamily): iPad screenshots not needed")

    # File sharing exposes the app's Documents folder in the Files app and Finder.
    for key in ("UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace"):
        if info.get(key):
            report("WARN", "Privacy", f"{key} is YES: app Documents are visible outside the app; keep anything sensitive out of Documents")

    if "ITSAppUsesNonExemptEncryption" in info:
        report("PASS", "Export", f"ITSAppUsesNonExemptEncryption = {info['ITSAppUsesNonExemptEncryption']}")
    else:
        report("WARN", "Export", "ITSAppUsesNonExemptEncryption missing; ASC will ask on every build")
    report("INFO", "Target", f"MinimumOSVersion {info.get('MinimumOSVersion')} (overridden builds differ; see SKILL.md)")


def check_toolchain(info):
    sdk = info.get("DTSDKName", "")
    xcode = info.get("DTXcode", "?")
    m = re.match(r"(iphoneos|iphonesimulator)(\d+)", sdk)
    if not m:
        report("WARN", "Toolchain", f"no usable DTSDKName in Info.plist ({sdk!r}); cannot confirm the build SDK")
    elif m.group(1) == "iphonesimulator":
        # A local simulator build uses this Mac's Xcode, not the EAS image that ships.
        report("INFO", "Toolchain", f"local build with {sdk} (DTXcode {xcode}); the EAS image decides the shipping SDK")
    elif int(m.group(2)) < MIN_IOS_SDK:
        report("FAIL", "Toolchain", f"built with {sdk} (DTXcode {xcode}); ASC requires the iOS {MIN_IOS_SDK} SDK or newer")
    else:
        report("PASS", "Toolchain", f"built with {sdk} (DTXcode {xcode}); meets the iOS {MIN_IOS_SDK} SDK minimum")


def check_updates(app):
    """Guideline 2.5.2: downloaded code must not add or change features."""
    path = os.path.join(app, "Expo.plist")
    # expo-updates treats a missing EXUpdatesEnabled key as enabled (UpdatesConfig.swift: `?? true`).
    enabled = os.path.exists(path) and load_plist(path).get("EXUpdatesEnabled", True)
    if enabled:
        report("INFO", "Updates", "expo-updates is enabled: OTA updates must not change features (2.5.2)")
    else:
        report("PASS", "Updates", "no over-the-air updates (EXUpdatesEnabled false or no Expo.plist)")


def check_privacy(app, info, profile_env, pods, node_modules):
    app_manifest_path = os.path.join(app, "PrivacyInfo.xcprivacy")
    if not os.path.exists(app_manifest_path):
        report("FAIL", "Privacy", "no PrivacyInfo.xcprivacy at the app bundle root")
        return
    app_m = load_plist(app_manifest_path)
    app_types = manifest_types(app_m)
    report("PASS", "Privacy", "app manifest present: " + (", ".join(sorted(app_types)) or "no API types"))

    tracking = app_m.get("NSPrivacyTracking")
    if tracking is True:
        if "NSUserTrackingUsageDescription" not in info:
            report("FAIL", "Tracking", "NSPrivacyTracking true but no NSUserTrackingUsageDescription (ATT)")
        else:
            report("WARN", "Tracking", "app declares tracking; ATT prompt must run before any tracking")
    elif tracking is False:
        report("PASS", "Tracking", "NSPrivacyTracking = false")
    else:
        report("WARN", "Tracking", "NSPrivacyTracking not set; set it explicitly")

    # Every dependency manifest embedded in the binary (plus Pods, for static frameworks
    # whose manifests Apple may not read — the reason declarations must reach the app manifest).
    roots = [app] + ([pods] if pods and os.path.isdir(pods) else [])
    seen = set()
    collected = []
    for root in roots:
        for dirpath, _, files in os.walk(root, followlinks=True):
            if "PrivacyInfo.xcprivacy" not in files:
                continue
            path = os.path.join(dirpath, "PrivacyInfo.xcprivacy")
            if os.path.samefile(path, app_manifest_path):
                continue
            # Pods xcframeworks ship tvOS/macOS/visionOS slices too; only iOS slices matter.
            if re.search(r"/(tvos|macos|xros|watchos)[-_a-z0-9]*/", path):
                continue
            try:
                dep = load_plist(path)
            except Exception as e:  # malformed manifest is itself a finding
                report("WARN", "Privacy", f"unreadable manifest {path}: {e}")
                continue
            rel = os.path.relpath(dirpath, root).split(os.sep)
            owner = rel[1] if rel[0] == "Frameworks" and len(rel) > 1 else rel[0]
            for cat, reasons in manifest_types(dep).items():
                if cat not in app_types:
                    key = ("cat", cat)
                    if key not in seen:
                        seen.add(key)
                        report("FAIL", "Privacy", f"{owner} declares {cat} but app manifest lacks the category (ITMS-91053 risk)")
                for r in sorted(reasons - app_types.get(cat, set())):
                    key = ("reason", cat, r)
                    if key not in seen:
                        seen.add(key)
                        report("WARN", "Privacy", f"{owner} declares {cat} reason {r} missing from app manifest; add via ios.privacyManifests")
            for c in dep.get("NSPrivacyCollectedDataTypes", []):
                collected.append((owner, c.get("NSPrivacyCollectedDataType", "").replace("NSPrivacyCollectedDataType", "")))
    by_type = {}
    for owner, dtype in collected:
        by_type.setdefault(dtype, set()).add(owner)
    # A manifest says what an SDK CAN collect. The ASC label covers what actually leaves the
    # device, so an SDK this profile never starts (no key) collects nothing.
    for dtype, owners in sorted(by_type.items()):
        active, dormant = [], []
        for owner in sorted(owners):
            sdk = re.sub(r"\.(bundle|framework)$", "", owner)
            key = SDK_ENABLE_KEY.get(sdk)
            if key and not profile_env.get(key):
                dormant.append(f"{owner} ({key} unset)")
            else:
                active.append(owner)
        if active:
            report("INFO", "Privacy", f"{dtype} collected by {', '.join(active)}: active in this profile, ASC privacy label must cover it")
        if dormant:
            report("INFO", "Privacy", f"{dtype} declared by {', '.join(dormant)}: dormant in this profile, label need not cover it")

    if node_modules and os.path.isdir(node_modules):
        scan_unmanifested(node_modules, app_types)


def scan_unmanifested(node_modules, app_types):
    """Native packages that call required-reason APIs but ship no manifest of their own."""
    pkgs = []
    for name in os.listdir(node_modules):
        path = os.path.join(node_modules, name)
        if name.startswith("@") and os.path.isdir(path):
            pkgs += [os.path.join(path, sub) for sub in os.listdir(path)]
        else:
            pkgs.append(path)
    for pkg in pkgs:
        ios = os.path.join(pkg, "ios")
        if not os.path.isdir(ios):
            continue
        has_manifest = False
        used = set()
        for dirpath, _, files in os.walk(ios, followlinks=True):
            if "node_modules" in os.path.relpath(dirpath, ios):
                continue
            if "PrivacyInfo.xcprivacy" in files:
                has_manifest = True
            for f in files:
                if not f.endswith((".swift", ".m", ".mm")):
                    continue
                try:
                    src = open(os.path.join(dirpath, f), encoding="utf-8", errors="ignore").read()
                except OSError:
                    continue
                used.update(cat for cat, rx in RR_SYMBOLS.items() if re.search(rx, src))
        if has_manifest or not used:
            continue
        name = os.path.relpath(pkg, node_modules)
        missing = sorted(used - set(app_types))
        level = "FAIL" if missing else "WARN"
        detail = f"missing categories {missing}" if missing else "categories covered by app manifest; check reason codes"
        report(level, "Privacy", f"{name} uses {sorted(used)} without its own manifest: {detail}")


def app_source_text(src_dirs):
    chunks = []
    for d in src_dirs:
        for dirpath, _, files in os.walk(d):
            for f in files:
                if f.endswith((".ts", ".tsx", ".js")) and ".test." not in f:
                    chunks.append(open(os.path.join(dirpath, f), encoding="utf-8", errors="ignore").read())
    return "\n".join(chunks)


def known_host(host, known):
    """Hermes stores strings back to back, so `strings` can glue the next string onto a URL
    (`…example.com.android.voicemail…`). A known host therefore also matches as a
    dotted prefix. Unknown hosts are left as found, so they still get flagged."""
    for h in known:
        if h and (host == h or host.startswith(h + ".")):
            return h
    return None


def check_bundle(app, profile_env, other_hosts, src_dirs):
    bundle = os.path.join(app, "main.jsbundle")
    if not os.path.exists(bundle):
        report("WARN", "Debug", "no main.jsbundle in app (dev build? bundle not embedded)")
        return
    text = subprocess.run(["strings", "-n", "6", bundle], capture_output=True, text=True).stdout

    # The API base is baked at build time, so its presence proves which profile was built.
    # This is the only guard against a dev base (localhost:3000) that is indistinguishable
    # from expo-router's own localhost:3000 default below.
    base = profile_env.get(API_BASE_ENV)
    own_host = urlparse(base).netloc if base else None
    if not own_host:
        report("WARN", "Debug", f"no {API_BASE_ENV} in any EAS profile — dev-host check skipped (pass --api-base-env)")
    if own_host and own_host not in text:
        report("FAIL", "Debug", f"profile API base {base} not in bundle; built with another profile/env?")
    elif own_host:
        report("PASS", "Debug", f"bundle uses this profile's API base {base}")

    hosts = {}
    for url in re.findall(r"https?://[A-Za-z0-9.\-]+(?::\d+)?", text):
        u = urlparse(url)
        if known_host(u.netloc, [own_host]):
            continue
        other = known_host(u.netloc, other_hosts)
        if other:
            hosts[other] = f"{u.scheme}://{other}"
        elif SUSPICIOUS_HOST.search(u.netloc):
            hosts[u.netloc] = url
    # Libraries embed their own dev defaults (react-native's getDevServer -> localhost:8081,
    # expo-router's head/url -> localhost:3000). Unreachable in release, so a localhost host
    # is only a finding when the APP's own source mentions it.
    source = app_source_text(src_dirs)
    leaked = False
    for host, url in sorted(hosts.items()):
        if host in source:
            report("FAIL", "Debug", f"app source ships non-production host {url}")
            leaked = True
        elif re.search(r"localhost|127\.0\.0\.1", host):
            report("INFO", "Debug", f"{url} in bundle is a library dev default (not in app source)")
        else:
            src = "another EAS profile's API base" if host in other_hosts else "non-production host"
            report("FAIL", "Debug", f"bundle references {src} {url}")
            leaked = True
    if not leaked:
        report("PASS", "Debug", "no app-owned localhost/staging/dev hosts in the JS bundle")
    posthog_env = SDK_ENABLE_KEY.get("PostHog")
    if posthog_env and not profile_env.get(posthog_env) and re.search(r"phc_[A-Za-z0-9]{20,}", text):
        report("FAIL", "Debug", f"PostHog key baked into a profile that sets no {posthog_env}")


def check_signed(app):
    """Only meaningful for a signed IPA payload."""
    ent = subprocess.run(["codesign", "-d", "--entitlements", ":-", app], capture_output=True)
    if ent.returncode != 0 or not ent.stdout.strip():
        report("INFO", "Signing", "app is unsigned (simulator build); signing checks skipped")
        return
    e = plistlib.loads(ent.stdout)
    if e.get("get-task-allow"):
        report("FAIL", "Signing", "get-task-allow is true (development-signed)")
    else:
        report("PASS", "Signing", "get-task-allow is false")
    aps = e.get("aps-environment")
    if aps and aps != "production":
        report("FAIL", "Signing", f"aps-environment is {aps}")
    elif aps:
        report("PASS", "Signing", "aps-environment is production")
    report("INFO", "Signing", "entitlements: " + ", ".join(sorted(e)))
    if "com.apple.developer.applesignin" in e:
        report("PASS", "Login", "Sign in with Apple entitlement present (4.8 equivalent login)")
    else:
        report("WARN", "Login", "no Sign in with Apple entitlement: if the app offers any third-party sign-in, 4.8 needs an equivalent login")
    icloud = [k for k in e if k.startswith("com.apple.developer.icloud") or k.startswith("com.apple.developer.ubiquity")]
    if icloud:
        report("WARN", "Privacy", f"iCloud entitlements {', '.join(icloud)}: keep sensitive data out of iCloud")
    domains = e.get("com.apple.developer.associated-domains", [])
    for d in domains:
        report("INFO", "DeepLinks", f"associated domain {d}: test universal links on a device")
    if not domains:
        report("INFO", "DeepLinks", "no associated domains: deep links are custom URL schemes only")
    prof = os.path.join(app, "embedded.mobileprovision")
    if os.path.exists(prof):
        raw = subprocess.run(["security", "cms", "-D", "-i", prof], capture_output=True).stdout
        p = plistlib.loads(raw)
        report("INFO", "Signing", f"profile {p.get('Name')} expires {p.get('ExpirationDate')}")
        if p.get("ProvisionsAllDevices") or p.get("ProvisionedDevices"):
            report("FAIL", "Signing", "profile is ad hoc / development, not App Store distribution")
        else:
            report("PASS", "Signing", "profile is App Store distribution (no device list)")
        # plistlib returns a naive UTC datetime.
        expires = p.get("ExpirationDate")
        if expires and expires < datetime.now(timezone.utc).replace(tzinfo=None):
            report("FAIL", "Signing", f"provisioning profile expired {expires}")
        for der in p.get("DeveloperCertificates", []):
            cert = subprocess.run(["openssl", "x509", "-inform", "DER", "-noout", "-enddate", "-subject"],
                                  input=der, capture_output=True).stdout.decode()
            end = re.search(r"notAfter=(.+)", cert)
            org = re.search(r"\bO\s*=\s*([^,/\n]+)", cert)
            if end:
                when = datetime.strptime(end.group(1).strip(), "%b %d %H:%M:%S %Y %Z")
                if when < datetime.now(timezone.utc).replace(tzinfo=None):
                    report("FAIL", "Signing", f"distribution certificate expired {when}")
                else:
                    report("PASS", "Signing", f"distribution certificate valid until {when}")
            if org:
                # 5.1.1(ix): apps in regulated fields must come from the legal entity providing the service.
                report("INFO", "Signing", f"certificate issued to {org.group(1).strip()}: confirm it is the entity providing the service (5.1.1(ix))")


def check_tracking_symbols(app, info):
    """IDFA use needs an ATT prompt. Look in the binaries, not the manifest."""
    exe = os.path.join(app, info.get("CFBundleExecutable", ""))
    binaries = [exe] if os.path.isfile(exe) else []
    fw = os.path.join(app, "Frameworks")
    if os.path.isdir(fw):
        for name in sorted(os.listdir(fw)):
            if name.endswith(".framework"):
                b = os.path.join(fw, name, name[: -len(".framework")])
                if os.path.isfile(b):
                    binaries.append(b)
    hits = []
    for b in binaries:
        with open(b, "rb") as f:
            data = f.read()
        found = [s.decode() for s in IDFA_SYMBOLS if s in data]
        links = subprocess.run(["otool", "-L", b], capture_output=True, text=True).stdout
        found += [fwk for fwk in ("AdSupport", "AppTrackingTransparency") if f"/{fwk}.framework/" in links]
        if found:
            hits.append(f"{os.path.relpath(b, app)}: {', '.join(found)}")
    if not hits:
        report("PASS", "Tracking", "no IDFA / AdSupport / ATT references in the app binaries")
    elif "NSUserTrackingUsageDescription" not in info:
        # Some SDKs carry the class name without calling it, so this is a WARN, not a FAIL.
        report("WARN", "Tracking", "IDFA references but no NSUserTrackingUsageDescription: " + "; ".join(hits))
    else:
        report("INFO", "Tracking", "IDFA references with an ATT string: " + "; ".join(hits))


def main():
    global API_BASE_ENV
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True)
    ap.add_argument("--profile", default="production")
    ap.add_argument("--eas", default="apps/mobile/eas.json")
    ap.add_argument("--pods")
    ap.add_argument("--node-modules")
    ap.add_argument("--api-base-env", default=API_BASE_ENV,
                    help="EAS profile env var holding the API base URL (default %(default)s)")
    ap.add_argument("--sdk-key", action="append", default=[], metavar="SDK=ENV",
                    help="SDK framework name and the profile env var that enables it; repeatable. "
                         "An SDK whose var is unset in the profile is reported dormant. "
                         "PostHog=ENV also turns on the PostHog key-leak check.")
    ap.add_argument("--src-dirs", default="app,modules,shared",
                    help="comma-separated source dirs (relative to the Expo app dir) scanned for dev hosts (default %(default)s)")
    a = ap.parse_args()
    API_BASE_ENV = a.api_base_env
    for item in a.sdk_key:
        sdk, sep, env = item.partition("=")
        if not sep or not sdk.strip() or not env.strip():
            ap.error(f"--sdk-key expects SDK=ENV_NAME, got {item!r}")
        SDK_ENABLE_KEY[sdk.strip()] = env.strip()

    profiles = json.load(open(a.eas))["build"]
    profile_env = profiles[a.profile].get("env", {})
    own = urlparse(profile_env.get(API_BASE_ENV, "")).netloc
    other_hosts = {
        urlparse(p.get("env", {}).get(API_BASE_ENV, "")).netloc
        for p in profiles.values()
    } - {own, ""}
    info = load_plist(os.path.join(a.app, "Info.plist"))
    if a.profile != "production":
        report("INFO", "Identity", f"'{a.profile}' identity: TestFlight or its own ASC app only, never public release")
    check_toolchain(info)
    check_info_plist(info)
    check_privacy(a.app, info, profile_env, a.pods, a.node_modules)
    mobile = os.path.dirname(os.path.abspath(a.eas))
    src_dirs = [os.path.join(mobile, d.strip()) for d in a.src_dirs.split(",") if d.strip()]
    if not any(os.path.isdir(d) for d in src_dirs):
        report("WARN", "Debug", f"none of the source dirs exist ({', '.join(src_dirs)}); source dev-host scan has nothing to check (pass --src-dirs)")
    check_bundle(a.app, profile_env, other_hosts, src_dirs)
    check_tracking_symbols(a.app, info)
    check_updates(a.app)
    check_signed(a.app)
    deps = json.load(open(os.path.join(mobile, "package.json"))).get("dependencies", {})
    # Read from the checkout, not the binary: for --ipa, make sure they match.
    report("INFO", "Framework", f"checkout has expo {deps.get('expo')}, react-native {deps.get('react-native')}: confirm a supported Expo SDK")

    order = {"FAIL": 0, "WARN": 1, "INFO": 2, "PASS": 3}
    for level, check, msg in sorted(results, key=lambda r: (order[r[0]], r[1])):
        print(f"{level:5} {check:12} {msg}")
    fails = sum(1 for r in results if r[0] == "FAIL")
    warns = sum(1 for r in results if r[0] == "WARN")
    print(f"\n{fails} FAIL, {warns} WARN")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()

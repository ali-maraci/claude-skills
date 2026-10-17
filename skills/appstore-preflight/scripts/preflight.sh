#!/bin/bash
# App Store preflight for an Expo iOS app. Builds (or unpacks) a RELEASE app, then runs check_app.py on it.
#
#   bash preflight.sh                       # prebuild + Release simulator build of the production profile
#   bash preflight.sh --profile staging     # same, staging identity
#   bash preflight.sh --ipa path/to.ipa     # scan a downloaded EAS IPA (adds signing checks)
#   bash preflight.sh --app path/to.app     # scan an already-built .app
#   --out DIR                               # work dir (default: $TMPDIR/appstore-preflight)
#   --repo DIR                              # your Expo app repo (default: the git repo you run it from)
#   --mobile-dir DIR                        # Expo app dir relative to the repo (default: apps/mobile)
#   --clear-env NAMES                       # comma-separated env vars to blank before prebuild
#                                           #   (e.g. MY_FLAVOR,SENTRY_DSN; default: none)
#   --guardrail-cmd CMD                     # command run in the mobile dir as a source check
#                                           #   (e.g. "npx vitest run"); FAILs on non-zero exit.
#                                           #   Default: skipped.
#   --api-base-env NAME                     # EAS profile env var holding the API base URL
#                                           #   (default: EXPO_PUBLIC_API_BASE_URL); passed to check_app.py
#   --src-dirs a,b,c                        # source dirs (relative to the Expo app dir) scanned for dev hosts
#                                           #   (default: app,modules,shared); passed to check_app.py
#   --sdk-key SDK=ENV                       # SDK framework name and the profile env var that enables it;
#                                           #   repeatable; passed to check_app.py
#
# macOS /bin/bash is 3.2: under `set -u` an empty array expansion aborts, so every
# optional array is expanded as ${A[@]+"${A[@]}"}.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=""
PROFILE=production
APP=""
IPA=""
OUT="${TMPDIR:-/tmp}/appstore-preflight"
FAILED=0
MOBILE_DIR="apps/mobile"
CLEAR_ENV=""
GUARDRAIL_CMD=""
CHECK_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --ipa) IPA="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --mobile-dir) MOBILE_DIR="$2"; shift 2 ;;
    --clear-env) CLEAR_ENV="$2"; shift 2 ;;
    --guardrail-cmd) GUARDRAIL_CMD="$2"; shift 2 ;;
    --api-base-env|--sdk-key|--src-dirs) [ $# -ge 2 ] || { echo "$1 needs a value"; exit 2; }; CHECK_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n '2,/^# macOS/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
# The skill is installed under ~/.claude/skills, so the app repo is found from the
# working directory, not from where this script lives.
[ -n "$REPO" ] || REPO="$(git rev-parse --show-toplevel 2>/dev/null)"
MOBILE="$REPO/$MOBILE_DIR"
if [ -z "$REPO" ] || [ ! -f "$MOBILE/eas.json" ]; then
  echo "FAIL  Setup        no $MOBILE_DIR/eas.json under '${REPO:-$PWD}': run from inside your Expo app repo or pass --repo / --mobile-dir"
  exit 1
fi
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"  # absolute: the guardrail command runs in another directory
# Fail before a 20-minute build, not after it.
python3 -c 'import json,sys; sys.exit(sys.argv[2] not in json.load(open(sys.argv[1]))["build"])' "$MOBILE/eas.json" "$PROFILE" \
  || { echo "FAIL  Setup        no build profile '$PROFILE' in eas.json"; exit 1; }
MODE=build
[ -n "$APP" ] && MODE=app
[ -n "$IPA" ] && MODE=ipa

echo "== toolchain"
xcodebuild -version | head -1
XCODE_MAJOR=$(xcodebuild -version | head -1 | sed -E 's/Xcode ([0-9]+).*/\1/')

echo "== source guardrails"
if [ ! -d "$MOBILE/node_modules" ]; then
  echo "FAIL  Setup        no node_modules in $MOBILE: install dependencies first"; exit 1
fi
if [ -z "$GUARDRAIL_CMD" ]; then
  echo "INFO  Guardrails   skipped (no --guardrail-cmd)"
else
  (cd "$MOBILE" && bash -c "$GUARDRAIL_CMD" > "$OUT/guardrails.log" 2>&1)
  if [ $? -ne 0 ]; then
    echo "FAIL  Guardrails   source guardrail command failed (log: $OUT/guardrails.log)"
    grep -E "FAIL|AssertionError|Expected|Received" "$OUT/guardrails.log" | head -8
    FAILED=1
  else
    echo "PASS  Guardrails   '$GUARDRAIL_CMD' exited 0 (log: $OUT/guardrails.log)"
  fi
fi

if [ "$MODE" = ipa ]; then
  rm -rf "$OUT/ipa" && mkdir -p "$OUT/ipa"
  unzip -q "$IPA" -d "$OUT/ipa" || { echo "FAIL  Setup        could not unzip $IPA"; exit 1; }
  APP=$(find "$OUT/ipa/Payload" -maxdepth 1 -name "*.app" 2>/dev/null | head -1)
  # Never fall through to a local build: that would report on a different binary.
  [ -n "$APP" ] || { echo "FAIL  Setup        no Payload/*.app inside $IPA"; exit 1; }
fi

if [ "$MODE" = build ]; then
  # Define (empty) rather than unset: Expo's dotenv loading never overrides a defined
  # variable, so blanking a name here stops a value your .env sets for local development
  # (a dev flavor, an analytics key) leaking into the release build. Pass the names with
  # --clear-env. Done BEFORE the profile export so an ambient shell value can't survive either.
  if [ -n "$CLEAR_ENV" ]; then
    IFS=',' read -r -a CLEAR_NAMES <<< "$CLEAR_ENV"
    for n in ${CLEAR_NAMES[@]+"${CLEAR_NAMES[@]}"}; do
      [ -n "$n" ] && export "$n="
    done
  fi
  # Export the chosen EAS profile's env so prebuild resolves the same identity EAS would.
  while IFS='=' read -r k v; do export "$k=$v"; done < <(
    python3 -c 'import json,sys; e=json.load(open(sys.argv[1]))["build"][sys.argv[2]].get("env",{}); print("\n".join(f"{k}={v}" for k,v in e.items()))' \
      "$MOBILE/eas.json" "$PROFILE")

  echo "== prebuild ($PROFILE) into gitignored $MOBILE_DIR/ios"
  (cd "$MOBILE" && npx expo prebuild --platform ios --clean --no-install 2>&1 | tail -2) || exit 1
  (cd "$MOBILE/ios" && pod install 2>&1 | tail -1) || exit 1
  grep -o "IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*" "$MOBILE"/ios/*.xcodeproj/project.pbxproj | sort -u | sed 's/^/INFO  Target       app project /'

  EXTRA=()
  if [ "$XCODE_MAJOR" -ge 27 ]; then
    # Xcode 27 rejects pod resource bundles with targets < 15.0, and ExpoRouter needs 16.0.
    # Only MinimumOSVersion in the built plist changes; the real target is the line above.
    EXTRA=(IPHONEOS_DEPLOYMENT_TARGET=16.0)
    echo "WARN  Target       Xcode $XCODE_MAJOR: forcing deployment target 16.0 for the local build only"
  fi

  WS=$(ls -d "$MOBILE"/ios/*.xcworkspace | head -1)
  SCHEME=$(basename "$WS" .xcworkspace)
  echo "== Release simulator build of $SCHEME (10-20 min; log: $OUT/build.log)"
  xcodebuild -workspace "$WS" -scheme "$SCHEME" -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$OUT/dd" \
    CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES ${EXTRA[@]+"${EXTRA[@]}"} build > "$OUT/build.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "FAIL  Build        Release build failed. First errors:"
    grep -E "error:" "$OUT/build.log" | sort -u | head -10
    exit 1
  fi
  APP=$(find "$OUT/dd/Build/Products/Release-iphonesimulator" -maxdepth 1 -name "*.app" | head -1)
fi

echo "== checks on $APP"
# Pods and native sources describe the LOCAL tree, so they are only evidence for a binary
# this run just built from it. For --ipa/--app, only what is inside the bundle counts.
LOCAL_ARGS=()
if [ "$MODE" = build ]; then
  LOCAL_ARGS=(--pods "$MOBILE/ios/Pods" --node-modules "$MOBILE/node_modules")
fi
python3 "$HERE/check_app.py" --app "$APP" --profile "$PROFILE" --eas "$MOBILE/eas.json" \
  ${LOCAL_ARGS[@]+"${LOCAL_ARGS[@]}"} ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"} || FAILED=1
exit $FAILED

#!/usr/bin/env bash
# Build the Xum iOS app for a connected iPhone and install it.
#
#   ios/scripts/install-on-device.sh                # team read from your signing certificate
#   TEAM_ID=ABCDE12345 ios/scripts/install-on-device.sh
#
# TEAM_ID is your Apple developer team (a free Personal Team works; its installs expire after
# 7 days). BUNDLE_ID defaults to one derived from the team, because a free team cannot register
# com.coder.* identifiers. Xcode must be signed in to that Apple ID (Settings > Accounts), and the
# phone must be paired, unlocked and in Developer Mode.
set -euo pipefail

# Without TEAM_ID, use the team (the OU field) of the first Apple Development certificate in the
# keychain; Xcode creates one when you add your Apple ID and click Manage Certificates > +.
if [ -z "${TEAM_ID:-}" ]; then
  TEAM_ID="$(security find-certificate -c "Apple Development" -p 2>/dev/null |
    openssl x509 -noout -subject -nameopt multiline 2>/dev/null |
    awk -F' = ' '/organizationalUnitName/ {print $2; exit}' || true)"
fi
: "${TEAM_ID:?no Apple Development certificate found: add your Apple ID in Xcode > Settings > Accounts, or set TEAM_ID}"
BUNDLE_ID="${BUNDLE_ID:-dev.${TEAM_ID}.xum}"
CONFIGURATION="${CONFIGURATION:-Debug}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DERIVED="${DERIVED_DATA:-${TMPDIR:-/tmp}/xum-ios-device}"

devices_json="$(mktemp "${TMPDIR:-/tmp}/xum-devices.XXXXXX")"
xcrun devicectl list devices --json-output "$devices_json" >/dev/null
read -r DEVICE_ID DEVICE_UDID DEVICE_NAME < <(python3 - "$devices_json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
phones = [d for d in devices
          if d.get("hardwareProperties", {}).get("reality") == "physical"
          and d.get("hardwareProperties", {}).get("deviceType") == "iPhone"]
if not phones:
    sys.exit("no physical iPhone found: plug it in, unlock it and tap Trust")
d = phones[0]
print(d["identifier"], d["hardwareProperties"]["udid"], d["deviceProperties"]["name"].replace(" ", "_"))
PY
)
rm -f "$devices_json"
echo "Installing on ${DEVICE_NAME//_/ } as $BUNDLE_ID"

xcodebuild -project "$ROOT/ios/Xum.xcodeproj" -scheme Xum -configuration "$CONFIGURATION" \
  -destination "platform=iOS,id=$DEVICE_UDID" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  build | grep -E "error:|BUILD" || true

APP="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/Xum.app"
[ -d "$APP" ] || { echo "build failed: no $APP" >&2; exit 1; }
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" ||
  echo "Installed. If iOS says the developer is untrusted: Settings > General > VPN & Device Management > trust your Apple ID, then open Xum."

#!/usr/bin/env sh
# A tour of the runner API with curl. Usage: RUNNER_TOKEN=... sh examples/curl.sh app.apk
set -eu
APK=${1:?usage: curl.sh app.apk}
RUNNER=${RUNNER:-http://127.0.0.1:8081}
AUTH="Authorization: Bearer ${RUNNER_TOKEN:?set RUNNER_TOKEN}"
JSON="content-type: application/json"
id() { node -pe 'JSON.parse(require("fs").readFileSync(0)).session.id'; }

echo "== health"; curl -s "$RUNNER/health"; echo
echo "== create a session with a mocked endpoint, launched"
SESSION=$(curl -s -H "$AUTH" -F "apk=@$APK" -F 'config={"launch":true,"endpointMocks":[{"name":"perfil","method":"GET","url":"https://api.exemplo.com/v1/perfil","headers":[{"name":"Content-Type","value":"application/json"}],"body":"{\"nome\":\"Maria\"}"}]}' "$RUNNER/sessions" | id)
echo "session $SESSION"
echo "== screen"; curl -s -H "$AUTH" "$RUNNER/sessions/$SESSION" ; echo
echo "== layout bounds (names, keys, testTags)"; curl -s -H "$AUTH" "$RUNNER/sessions/$SESSION/layout-bounds?names=0" | head -c 1200; echo
echo "== screenshot"; curl -s -H "$AUTH" -o screen.png "$RUNNER/sessions/$SESSION/screenshot.png"; echo "saved screen.png"
echo "== live config: landscape, dark theme"; curl -s -X PATCH -H "$AUTH" -H "$JSON" -d '{"device":{"orientation":"landscape","darkTheme":true}}' "$RUNNER/sessions/$SESSION/config" | head -c 400; echo
echo "== network log"; curl -s -H "$AUTH" "$RUNNER/sessions/$SESSION/network" | head -c 800; echo
echo "== logcat"; curl -s -H "$AUTH" "$RUNNER/sessions/$SESSION/logcat?limit=20" | head -c 800; echo
echo "== diagnostic"; curl -s -H "$AUTH" "$RUNNER/sessions/$SESSION/diagnostic" | head -c 800; echo
echo "== close"; curl -s -X DELETE -H "$AUTH" "$RUNNER/sessions/$SESSION"; echo

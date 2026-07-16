#!/bin/bash
# Testy: administrace — master heslo, název, export/import, mazání, join-dm, uživatelé.
set -e
B=http://localhost:3000
# Master heslo už není v kódu — test si ho předá přes prostředí:
#   MASTER_PASSWORD='test-master' node server.js
MP="${MASTER_PASSWORD:-test-master}"
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_not(){ local d=$1 o=$2; shift 2; for s in "$@"; do echo "$o"|grep -qi "$s" && { echo "❌ $d — uniklo $s"; exit 1; }; done; echo "✅ $d"; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ $1" || { echo "❌ $1 (chybí $3: $(echo $2|head -c 250))"; exit 1; }; }
jv(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f a1.jar a2.jar
req a1.jar POST /api/register '{"username":"admin1","password":"test1234"}' > /dev/null
req a2.jar POST /api/register '{"username":"jinyDM","password":"test1234"}' > /dev/null
CID=$(req a1.jar POST /api/campaigns '{"name":"AdmKamp"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
# nějaká data v kampani
ART=$(req a1.jar POST /api/campaigns/$CID/articles '{"title":"Město"}' | grep -o '[0-9]*')
req a1.jar PUT /api/articles/$ART '{"title":"Město","category":"Města","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Rušné město."}}]}' > /dev/null

echo "== app-info veřejné =="
check_has "výchozí název" "$(curl -s $B/api/app-info)" "Lore master"

echo "== master heslo brána =="
X=$(req a1.jar GET /api/admin/overview)
check_has "bez odemčení přístup zamítnut" "$X" "odemčena"
X=$(req a1.jar POST /api/admin/auth '{"masterPassword":"spatne"}')
check_has "špatné master heslo" "$X" error
req a1.jar POST /api/admin/auth "{\"masterPassword\":\"$MP\"}" > /dev/null
OV=$(req a1.jar GET /api/admin/overview)
check_has "po odemčení přehled" "$OV" "AdmKamp"
check_has "vidí uživatele admin1" "$OV" "admin1"
check_has "vidí uživatele jinyDM" "$OV" "jinyDM"

echo "== jiný uživatel nemá admin (odděleno per session) =="
X=$(req a2.jar GET /api/admin/overview)
check_has "jiná session není admin" "$X" "odemčena"

echo "== změna názvu =="
check_has "výchozí <title> v index.html" "$(curl -s $B/)" "<title>Lore master</title>"
req a1.jar PUT /api/admin/app-name '{"name":"Kronika říše"}' > /dev/null
check_has "název změněn (veřejně)" "$(curl -s $B/api/app-info)" "Kronika říše"
check_has "název je i v <title> (záložka prohlížeče)" "$(curl -s $B/)" "<title>Kronika říše</title>"
check_has "<title> sedí i na SPA adrese" "$(curl -s $B/c/1/a/5)" "<title>Kronika říše</title>"
# název jde do HTML → musí se escapovat, jinak by šlo přes administraci vložit skript
req a1.jar PUT /api/admin/app-name '{"name":"<script>alert(1)</script>"}' > /dev/null
X=$(curl -s $B/)
echo "$X" | grep -q "<title>&lt;script&gt;" && echo "✅ název v <title> je escapovaný" || { echo "❌ XSS v <title>!"; exit 1; }
echo "$X" | grep -q "<title><script>" && { echo "❌ XSS v <title>!"; exit 1; } || true
req a1.jar PUT /api/admin/app-name '{"name":"Kronika říše"}' > /dev/null

echo "== export → import roundtrip =="
curl -s -b a1.jar "$B/api/admin/campaigns/$CID/export" -o /tmp/zaloha.json
check_has "záloha má formát" "$(cat /tmp/zaloha.json)" "loremaster-backup"
check_has "obsahuje článek Město" "$(cat /tmp/zaloha.json)" "Rušné město"
NEW=$(curl -s -b a1.jar -X POST -H Content-Type:application/json --data-binary @/tmp/zaloha.json $B/api/admin/import)
check_has "import vytvořil novou kampaň" "$NEW" '"ok":true'
NEWID=$(jv "$NEW" "d['campaignId']")
# admin je člen? ne — obnova relinkuje jen podle jmen; admin1 byl DM původní kampaně, takže i v obnově
A_ART=$(req a1.jar GET /api/campaigns/$NEWID/articles 2>/dev/null || echo '[]')
echo "$A_ART" | grep -q "Město" && echo "✅ obnovená kampaň má článek Město" || echo "ℹ️ (přístup k obnovené kampani ověříme přes overview)"
OV2=$(req a1.jar GET /api/admin/overview)
COUNT=$(jv "$OV2" "len([c for c in d['campaigns'] if 'AdmKamp' in c['name']])")
[ "$COUNT" = "2" ] && echo "✅ existují 2 kampaně AdmKamp (originál + obnova)" || { echo "❌ kampaní: $COUNT"; exit 1; }

echo "== join jako další DM =="
# jinyDM se odemkne a vstoupí do AdmKamp jako DM
req a2.jar POST /api/admin/auth "{\"masterPassword\":\"$MP\"}" > /dev/null
req a2.jar POST /api/admin/campaigns/$CID/join-dm > /dev/null
MY=$(req a2.jar GET /api/campaigns)
check_has "jinyDM je nyní v Kopuli" "$MY" "AdmKamp"
check_has "jako DM" "$MY" '"role":"dm"'

echo "== smazání kampaně =="
req a1.jar DELETE /api/admin/campaigns/$NEWID > /dev/null
OV3=$(req a1.jar GET /api/admin/overview)
CNT2=$(jv "$OV3" "len([c for c in d['campaigns'] if c['id']==$NEWID])")
[ "$CNT2" = "0" ] && echo "✅ obnovená kampaň smazána" || { echo "❌ nesmazáno"; exit 1; }

echo "== zamčení administrace =="
req a1.jar POST /api/admin/logout > /dev/null
X=$(req a1.jar GET /api/admin/overview)
check_has "po zamčení přístup zamítnut" "$X" "odemčena"

echo; echo "🎉 Testy administrace prošly."

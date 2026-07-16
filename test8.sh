#!/bin/bash
# Testy: sezení vidí jen účastníci; editace zápisu DM přes API.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_not() { local desc=$1 out=$2; shift 2
  for s in "$@"; do if echo "$out" | grep -qi "$s"; then echo "❌ FAIL: $desc — uniklo: $s"; exit 1; fi; done
  echo "✅ OK: $desc"; }
check_has() { local desc=$1 out=$2 s=$3
  if echo "$out" | grep -q "$s"; then echo "✅ OK: $desc"; else echo "❌ FAIL: $desc — chybí: $s ($(echo $out | head -c 250))"; exit 1; fi; }
jv() { python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f d8.jar k8.jar p8.jar

echo "== příprava: sezení jen s Kubíkem =="
req d8.jar POST /api/register '{"username":"dm8","password":"test1234"}' > /dev/null
CID=$(req d8.jar POST /api/campaigns '{"name":"Test8"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d8.jar POST /api/campaigns/$CID/users '{"username":"kubik8","password":"heslo123","characterName":"Kubirik"}' > /dev/null
req d8.jar POST /api/campaigns/$CID/users '{"username":"pauli8","password":"heslo123","characterName":"Toruk"}' > /dev/null
req k8.jar POST /api/login '{"username":"kubik8","password":"heslo123"}' > /dev/null
req p8.jar POST /api/login '{"username":"pauli8","password":"heslo123"}' > /dev/null
CHARS=$(req d8.jar GET /api/campaigns/$CID/characters)
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")
PUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Toruk'][0]")
SID=$(req d8.jar POST /api/campaigns/$CID/sessions "{\"title\":\"TajnéSezení\",\"date\":\"2026-07-13\",\"players\":[$KUID]}" | grep -o '[0-9]*')

echo "== přístup jen pro účastníky =="
K_L=$(req k8.jar GET /api/campaigns/$CID/sessions)
check_has "účastník sezení v seznamu vidí" "$K_L" "TajnéSezení"
P_L=$(req p8.jar GET /api/campaigns/$CID/sessions)
check_not "ne-účastník sezení v seznamu nevidí" "$P_L" "TajnéSezení"
P_D=$(req p8.jar GET /api/sessions/$SID)
check_has "ne-účastník detail neotevře (404)" "$P_D" "nenalezeno"
check_not "nic z obsahu neuniklo" "$P_D" "players" "reportArticleId"
VA=$(req d8.jar GET "/api/campaigns/$CID/sessions?viewAs=$PUID")
check_not "view-as ne-účastníka sezení nevidí" "$VA" "TajnéSezení"
K_D=$(req k8.jar GET /api/sessions/$SID)
check_has "účastník detail otevře" "$K_D" "TajnéSezení"

echo "== zápis DM viditelný jen účastníkům =="
RID=$(jv "$K_D" "d['reportArticleId']")
req d8.jar PUT /api/articles/$RID '{"title":"Zápis: TajnéSezení","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Veřejný souhrn sezení."}}]}' > /dev/null
K_R=$(req k8.jar GET /api/articles/$RID)
check_has "účastník zápis přečte" "$K_R" "souhrn"
P_R=$(req p8.jar GET /api/articles/$RID)
check_not "ne-účastník zápis nepřečte ani s bloky pro všechny" "$P_R" "souhrn"
check_has "dostane 404" "$P_R" "nenalezen"
S=$(req p8.jar GET "/api/campaigns/$CID/search?q=souhrn")
check_not "zápis nenajde ani vyhledáváním" "$S" "souhrn"

echo "== po přidání účastníka se přístup otevře =="
req d8.jar PUT /api/sessions/$SID "{\"players\":[$KUID,$PUID]}" > /dev/null
P_D2=$(req p8.jar GET /api/sessions/$SID)
check_has "nově přidaný účastník sezení vidí" "$P_D2" "TajnéSezení"
P_R2=$(req p8.jar GET /api/articles/$RID)
check_has "a přečte i zápis" "$P_R2" "souhrn"

echo; echo "🎉 Všechny testy osmé verze prošly."

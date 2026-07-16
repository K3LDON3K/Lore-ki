#!/bin/bash
# Testy: vlastnictví článku postavy (nepřiřazené, nastavení, změna, odebrání).
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_not(){ local d=$1 o=$2; shift 2; for s in "$@"; do echo "$o"|grep -qi "$s" && { echo "❌ $d — uniklo $s"; exit 1; }; done; echo "✅ $d"; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ $1" || { echo "❌ $1 (chybí $3: $(echo $2|head -c 200))"; exit 1; }; }
jv(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f d13.jar k13.jar
req d13.jar POST /api/register '{"username":"dm13","password":"test1234"}' > /dev/null
CID=$(req d13.jar POST /api/campaigns '{"name":"T13"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d13.jar POST /api/campaigns/$CID/users '{"username":"hrac13","password":"heslo123"}' > /dev/null
req k13.jar POST /api/login '{"username":"hrac13","password":"heslo123"}' > /dev/null
HUID=$(jv "$(req d13.jar GET /api/campaigns/$CID/players)" "[p['id'] for p in d if p['role']=='player'][0]")

echo "== ručně vytvořený článek postavy = nepřiřazený =="
ART=$(req d13.jar POST /api/campaigns/$CID/articles '{"title":"Nalezenec"}' | grep -o '[0-9]*')
req d13.jar PUT /api/articles/$ART '{"title":"Nalezenec","category":"Hráčské postavy","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Postava bez pána."}}]}' > /dev/null
UN=$(req d13.jar GET /api/campaigns/$CID/unassigned-characters)
check_has "je mezi nepřiřazenými" "$UN" "Nalezenec"
A=$(req d13.jar GET /api/articles/$ART)
check_has "zatím bez vlastníka (character null)" "$A" '"character":null'

echo "== nastavení vlastníka =="
X=$(req k13.jar POST /api/articles/$ART/owner "{\"userId\":$HUID}")
check_has "hráč vlastníka nastavit nesmí" "$X" error
req d13.jar POST /api/articles/$ART/owner "{\"userId\":$HUID}" > /dev/null
CH=$(req d13.jar GET /api/campaigns/$CID/characters)
check_has "vznikla postava Nalezenec pro hráče" "$CH" "Nalezenec"
UN2=$(req d13.jar GET /api/campaigns/$CID/unassigned-characters)
check_not "už není mezi nepřiřazenými" "$UN2" "Nalezenec"
# hráč teď článek vlastní
NAL=$(jv "$CH" "[c['id'] for c in d if c['name']=='Nalezenec'][0]")
A_K=$(req k13.jar GET "/api/articles/$ART?viewChar=$NAL")
check_has "hráč za tuto postavu článek vlastní" "$A_K" '"owned":true'

echo "== odebrání vlastníka (článek zůstane) =="
req d13.jar POST /api/articles/$ART/owner '{"userId":null}' > /dev/null
A2=$(req d13.jar GET /api/articles/$ART)
check_has "článek existuje dál" "$A2" "Nalezenec"
check_has "je opět bez vlastníka" "$A2" '"character":null'
UN3=$(req d13.jar GET /api/campaigns/$CID/unassigned-characters)
check_has "vrátil se mezi nepřiřazené" "$UN3" "Nalezenec"

echo "== vlastníka nelze nastavit u ne-postavy =="
OTHER=$(req d13.jar POST /api/campaigns/$CID/articles '{"title":"Hrad"}' | grep -o '[0-9]*')
req d13.jar PUT /api/articles/$OTHER '{"title":"Hrad","category":"Lokace","blocks":[]}' > /dev/null
X=$(req d13.jar POST /api/articles/$OTHER/owner "{\"userId\":$HUID}")
check_has "u lokace vlastníka nastavit nelze" "$X" error

echo; echo "🎉 Testy vlastnictví postav prošly."

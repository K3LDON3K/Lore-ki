#!/bin/bash
# Testy: správa kategorií, preview referencí s kontrolou oprávnění.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_not() { local desc=$1 out=$2; shift 2
  for s in "$@"; do if echo "$out" | grep -qi "$s"; then echo "❌ FAIL: $desc — uniklo: $s"; exit 1; fi; done
  echo "✅ OK: $desc"; }
check_has() { local desc=$1 out=$2 s=$3
  if echo "$out" | grep -q "$s"; then echo "✅ OK: $desc"; else echo "❌ FAIL: $desc — chybí: $s ($(echo $out | head -c 200))"; exit 1; fi; }

cd /tmp && rm -f c_dm.jar c_hrac.jar

echo "== příprava =="
req c_dm.jar POST /api/register '{"username":"dm3","password":"test1234"}' > /dev/null
CID=$(req c_dm.jar POST /api/campaigns '{"name":"Test3"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
H=$(req c_dm.jar POST /api/campaigns/$CID/users '{"username":"hrac3","password":"heslo123","characterName":"Hráč"}')
HID=$(echo "$H" | grep -o '"id":[0-9]*' | cut -d: -f2)
req c_hrac.jar POST /api/login '{"username":"hrac3","password":"heslo123"}' > /dev/null

echo "== kategorie =="
req c_dm.jar POST /api/campaigns/$CID/category-list '{"name":"Města"}' > /dev/null
req c_dm.jar POST /api/campaigns/$CID/category-list '{"name":"Frakce"}' > /dev/null
CL=$(req c_dm.jar GET /api/campaigns/$CID/category-list)
check_has "kategorie přidány" "$CL" "Města"
X=$(req c_hrac.jar GET /api/campaigns/$CID/category-list)
check_has "hráč seznam spravovat nesmí" "$X" error
X=$(req c_hrac.jar POST /api/campaigns/$CID/category-list '{"name":"Hack"}')
check_has "hráč kategorii nepřidá" "$X" error

# článek v kategorii, pak odebrání kategorie
AID=$(req c_dm.jar POST /api/campaigns/$CID/articles '{"title":"Přístav"}' | grep -o '[0-9]*')
req c_dm.jar PUT /api/articles/$AID '{"title":"Přístav","category":"Města","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Rušný přístav."}}]}' > /dev/null
DMCATS=$(req c_dm.jar GET /api/campaigns/$CID/categories)
check_has "DM vidí i prázdnou kategorii Frakce" "$DMCATS" "Frakce"
HCATS=$(req c_hrac.jar GET /api/campaigns/$CID/categories)
check_not "hráč prázdnou kategorii nevidí" "$HCATS" "Frakce"
req c_dm.jar POST /api/campaigns/$CID/category-list/remove '{"name":"Města"}' > /dev/null
ART=$(req c_dm.jar GET /api/articles/$AID)
check_has "po odebrání kategorie je článek nezařazený" "$ART" '"category":""'
CL2=$(req c_dm.jar GET /api/campaigns/$CID/category-list)
check_not "kategorie zmizela ze seznamu" "$CL2" "Města"

# auto-přidání nové kategorie při uložení článku
req c_dm.jar PUT /api/articles/$AID '{"title":"Přístav","category":"Lokace","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Rušný přístav."}}]}' > /dev/null
CL3=$(req c_dm.jar GET /api/campaigns/$CID/category-list)
check_has "nová kategorie z editoru se přidala automaticky" "$CL3" "Lokace"

echo "== preview referencí =="
SEC=$(req c_dm.jar POST /api/campaigns/$CID/articles '{"title":"Skrytá pevnost"}' | grep -o '[0-9]*')
req c_dm.jar PUT /api/articles/$SEC '{"title":"Skrytá pevnost","description":"Popis pevnosti","blocks":[{"type":"paragraph","visibility":"dm","content":{"text":"Tajemství pevnosti."}}]}' > /dev/null
DMP=$(req c_dm.jar GET /api/articles/$SEC/preview)
check_has "DM preview obsahuje úryvek" "$DMP" "Tajemství"
HP=$(req c_hrac.jar GET /api/articles/$SEC/preview)
check_has "hráč dostane hlášku o právech" "$HP" "nemáte přístup"
check_not "hráči nic neuniklo" "$HP" "Tajemství" "pevnost" "Popis"
VP=$(req c_dm.jar GET "/api/articles/$SEC/preview?viewAs=$HID")
check_has "view-as: DM vidí hlášku jako hráč" "$VP" "nemáte přístup"
PP=$(req c_hrac.jar GET /api/articles/$AID/preview)
check_has "viditelný článek má preview" "$PP" "Rušný přístav"

echo; echo "🎉 Všechny testy kategorií a preview prošly."

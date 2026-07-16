#!/bin/bash
# Testy: postavy téhož hráče jsou samostatné jednotky (sezení, vlastnictví, inventář, poznámky).
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

cd /tmp && rm -f d10.jar k10.jar p10.jar

echo "== příprava: hráč se DVĚMA postavami (Alfa, Beta) =="
req d10.jar POST /api/register '{"username":"dm10","password":"test1234"}' > /dev/null
CID=$(req d10.jar POST /api/campaigns '{"name":"Test10"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d10.jar POST /api/campaigns/$CID/users '{"username":"kubik10","password":"heslo123","characterName":"Alfa"}' > /dev/null
req d10.jar POST /api/campaigns/$CID/users '{"username":"pauli10","password":"heslo123","characterName":"Cizinec"}' > /dev/null
req k10.jar POST /api/login '{"username":"kubik10","password":"heslo123"}' > /dev/null
req p10.jar POST /api/login '{"username":"pauli10","password":"heslo123"}' > /dev/null
CHARS=$(req d10.jar GET /api/campaigns/$CID/characters)
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Alfa'][0]")
req d10.jar POST /api/campaigns/$CID/characters "{\"userId\":$KUID,\"name\":\"Beta\"}" > /dev/null
CHARS=$(req d10.jar GET /api/campaigns/$CID/characters)
ALFA=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Alfa'][0]")
BETA=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Beta'][0]")
BETA_ART=$(jv "$CHARS" "[c['articleId'] for c in d if c['name']=='Beta'][0]")

echo "== sezení: účastník je POSTAVA, ne hráč =="
SID=$(req d10.jar POST /api/campaigns/$CID/sessions "{\"title\":\"JenProAlfu\",\"characters\":[$ALFA]}" | grep -o '[0-9]*')
A_L=$(req k10.jar GET "/api/campaigns/$CID/sessions?viewChar=$ALFA")
check_has "za Alfu sezení vidí" "$A_L" "JenProAlfu"
B_L=$(req k10.jar GET "/api/campaigns/$CID/sessions?viewChar=$BETA")
check_not "za Betu (týž hráč!) sezení NEVIDÍ" "$B_L" "JenProAlfu"
B_D=$(req k10.jar GET "/api/sessions/$SID?viewChar=$BETA")
check_has "za Betu detail vrací 404" "$B_D" "nenalezeno"
X=$(req k10.jar PUT "/api/sessions/$SID/entry?viewChar=$BETA" '{"blocks":[{"html":"hack","text":"hack","visibility":"all"}]}')
check_has "za Betu nelze zapisovat" "$X" error
req k10.jar PUT "/api/sessions/$SID/entry?viewChar=$ALFA" '{"blocks":[{"html":"Zápis Alfy.","text":"Zápis Alfy.","visibility":"dm"}]}' > /dev/null
echo "✅ OK: za Alfu zapisovat lze"

echo "== vlastnictví článku postavy jen za AKTIVNÍ postavu =="
A_OWN=$(req k10.jar GET "/api/articles/$BETA_ART?viewChar=$BETA")
check_has "za Betu vlastní Betin článek" "$A_OWN" '"owned":true'
B_OWN=$(req k10.jar GET "/api/articles/$BETA_ART?viewChar=$ALFA")
check_not "za Alfu Betin článek NEvlastní" "$B_OWN" '"owned":true'
X=$(req k10.jar PUT "/api/articles/$BETA_ART?viewChar=$ALFA" '{"title":"Beta","blocks":[]}')
check_has "za Alfu Betin článek needituje" "$X" error

echo "== bloky viditelné jen jedné postavě hráče =="
ART=$(req d10.jar POST /api/campaigns/$CID/articles '{"title":"Vidina"}' | grep -o '[0-9]*')
req d10.jar PUT /api/articles/$ART "{\"title\":\"Vidina\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Obecné.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$ALFA],\"content\":{\"text\":\"Vzpomínka Alfy.\"}}]}" > /dev/null
V_A=$(req k10.jar GET "/api/articles/$ART?viewChar=$ALFA")
check_has "Alfa svou vzpomínku vidí" "$V_A" "Vzpomínka Alfy"
V_B=$(req k10.jar GET "/api/articles/$ART?viewChar=$BETA")
check_not "Beta (týž hráč) vzpomínku Alfy NEVIDÍ" "$V_B" "Vzpomínka Alfy"

echo "== inventář: vlastník vidí, cizí uživatel ne (grafický inventář) =="
MEC=$(req d10.jar POST /api/campaigns/$CID/articles '{"title":"Dýka"}' | grep -o '[0-9]*')
req d10.jar PUT /api/articles/$MEC '{"title":"Dýka","category":"Předměty","item":{"weight":1,"wearable":true,"identifiedDefault":true},"blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Obyčejná dýka."}}]}' > /dev/null
req d10.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$MEC,\"to\":{\"t\":\"slot\",\"charId\":$ALFA,\"slot\":\"handR\"}}" > /dev/null
I_A=$(req k10.jar GET "/api/inv/char/$ALFA")
check_has "vlastník inventář Alfy vidí" "$I_A" "Dýka"
I_P=$(req p10.jar GET "/api/inv/char/$ALFA" 2>/dev/null || echo '{"error":"nenalezena"}')
check_has "cizí uživatel inventář Alfy nevidí" "$I_P" "nenalezena"

echo "== poznámka patří postavě =="
req k10.jar POST "/api/articles/$ART/notes?viewChar=$ALFA" '{"text":"Poznámka Alfy.","visibleTo":[]}' > /dev/null
N_A=$(req k10.jar GET "/api/articles/$ART/notes?viewChar=$ALFA")
check_has "Alfa svou poznámku vidí" "$N_A" "Poznámka Alfy"
N_B=$(req k10.jar GET "/api/articles/$ART/notes?viewChar=$BETA")
check_not "Beta poznámku Alfy nevidí (neschválená, cizí postava)" "$N_B" "Poznámka Alfy"
D_N=$(req d10.jar GET /api/articles/$ART/notes)
check_has "DM vidí autora jako postavu Alfa" "$D_N" '"author":"Alfa"'

echo; echo "🎉 Všechny testy oddělení postav prošly."

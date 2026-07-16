#!/bin/bash
# Testy: „prozradit informaci“ — žádosti, schválení DM, zamítnutí, automatika, žádné úniky.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ OK: $1" || { echo "❌ FAIL: $1 (chybí $3: $(echo $2|head -c 250))"; exit 1; }; }
check_not(){ echo "$2"|grep -qi "$3" && { echo "❌ FAIL: $1 — uniklo: $3"; exit 1; } || echo "✅ OK: $1"; }
jv(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f r_d.jar r_a.jar r_b.jar
req r_d.jar POST /api/register '{"username":"revdm","password":"test1234"}' > /dev/null
CID=$(req r_d.jar POST /api/campaigns '{"name":"Rev20"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req r_d.jar POST /api/campaigns/$CID/users '{"username":"revh1","password":"heslo123","characterName":"Anira"}' > /dev/null
req r_d.jar POST /api/campaigns/$CID/users '{"username":"revh2","password":"heslo123","characterName":"Borek"}' > /dev/null
req r_a.jar POST /api/login '{"username":"revh1","password":"heslo123"}' > /dev/null
req r_b.jar POST /api/login '{"username":"revh2","password":"heslo123"}' > /dev/null
CHARS=$(req r_d.jar GET /api/campaigns/$CID/characters)
ANI=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Anira'][0]")
BOR=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Borek'][0]")

echo "== příprava: blok jen pro Aniru =="
ART=$(req r_d.jar POST /api/campaigns/$CID/articles '{"title":"Prokletá dýka"}' | grep -o '[0-9]*')
req r_d.jar PUT /api/articles/$ART "{\"title\":\"Prokletá dýka\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Stará dýka.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$ANI],\"content\":{\"text\":\"TajemstviRuny na čepeli.\"}}]}" > /dev/null
V_A=$(req r_a.jar GET /api/articles/$ART)
check_has "Anira tajný blok vidí" "$V_A" "TajemstviRuny"
check_has "Anira má na bloku canReveal" "$V_A" '"canReveal":true'
BID=$(jv "$V_A" "[b['id'] for b in d['blocks'] if b.get('canReveal')][0]")
V_B=$(req r_b.jar GET /api/articles/$ART)
check_not "Borek tajný blok nevidí" "$V_B" "TajemstviRuny"

echo "== žádost o prozrazení (ruční schvalování) =="
X=$(req r_a.jar POST /api/blocks/$BID/reveal "{\"toCharId\":$BOR}")
check_has "žádost přijata jako čekající" "$X" '"pending":true'
V_B=$(req r_b.jar GET /api/articles/$ART)
check_not "před schválením Borek stále nevidí" "$V_B" "TajemstviRuny"
V_A=$(req r_a.jar GET /api/articles/$ART)
check_has "žadatel u bloku vidí podanou žádost (jméno cíle)" "$V_A" '"pendingReveals":\["Borek"\]'
X=$(req r_a.jar POST /api/blocks/$BID/reveal "{\"toCharId\":$BOR}")
check_has "duplicitní žádost je idempotentní (pending)" "$X" '"pending":true'
X=$(req r_a.jar POST /api/blocks/$BID/reveal "{\"toCharId\":$ANI}")
check_has "prozrazení sám sobě odmítnuto" "$X" "error"

echo "== práva: seznam a schvalování jen DM =="
X=$(req r_a.jar GET /api/campaigns/$CID/reveals)
check_has "hráč seznam žádostí nevidí" "$X" "error"
L=$(req r_d.jar GET /api/campaigns/$CID/reveals)
check_has "DM vidí od koho" "$L" "Anira"
check_has "DM vidí komu" "$L" "Borek"
check_has "DM vidí úryvek" "$L" "TajemstviRuny"
RID=$(jv "$L" "d['requests'][0]['id']")
X=$(req r_a.jar PUT /api/reveals/$RID '{"action":"approve"}')
check_has "hráč schválit nemůže" "$X" "error"

echo "== schválení: Borek informaci uvidí =="
req r_d.jar PUT /api/reveals/$RID '{"action":"approve"}' > /dev/null
V_B=$(req r_b.jar GET /api/articles/$ART)
check_has "po schválení Borek tajemství vidí" "$V_B" "TajemstviRuny"
L=$(req r_d.jar GET /api/campaigns/$CID/reveals)
check_has "žádost zmizela ze seznamu" "$L" '"requests":\[\]'
X=$(req r_a.jar POST /api/blocks/$BID/reveal "{\"toCharId\":$BOR}")
check_has "cíl už informaci ví → schváleno automaticky" "$X" '"approved":true'
L=$(req r_d.jar GET /api/campaigns/$CID/reveals)
check_has "automatické schválení nezanechá žádost" "$L" '"requests":\[\]'

echo "== zamítnutí =="
req r_d.jar PUT /api/articles/$ART "{\"title\":\"Prokletá dýka\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$ANI],\"content\":{\"text\":\"DruheTajemstvi dýky.\"}}]}" > /dev/null
V_A=$(req r_a.jar GET /api/articles/$ART)
B2=$(jv "$V_A" "[b['id'] for b in d['blocks'] if b.get('canReveal')][0]")
req r_a.jar POST /api/blocks/$B2/reveal "{\"toCharId\":$BOR}" > /dev/null
L=$(req r_d.jar GET /api/campaigns/$CID/reveals)
R2=$(jv "$L" "d['requests'][0]['id']")
req r_d.jar PUT /api/reveals/$R2 '{"action":"reject"}' > /dev/null
V_B=$(req r_b.jar GET /api/articles/$ART)
check_not "po zamítnutí Borek nevidí" "$V_B" "DruheTajemstvi"

echo "== fail closed: nelze prozradit blok, který postava nevidí =="
X=$(req r_b.jar POST /api/blocks/$B2/reveal "{\"toCharId\":$BOR}")
check_has "cizí blok vrací 404 bez prozrazení existence" "$X" "nenalezen"

echo "== automatické schvalování =="
X=$(req r_a.jar PUT /api/campaigns/$CID/settings '{"autoReveal":true}')
check_has "hráč automatiku nezapne" "$X" "error"
req r_d.jar PUT /api/campaigns/$CID/settings '{"autoReveal":true}' > /dev/null
L=$(req r_d.jar GET /api/campaigns/$CID/reveals)
check_has "automatika je zapnutá" "$L" '"auto":true'
X=$(req r_a.jar POST /api/blocks/$B2/reveal "{\"toCharId\":$BOR}")
check_has "s automatikou schváleno hned" "$X" '"approved":true'
V_B=$(req r_b.jar GET /api/articles/$ART)
check_has "Borek vidí okamžitě" "$V_B" "DruheTajemstvi"

echo "== úklid: přepsané bloky žádost zruší =="
req r_d.jar PUT /api/campaigns/$CID/settings '{"autoReveal":false}' > /dev/null
req r_d.jar PUT /api/articles/$ART "{\"title\":\"Prokletá dýka\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$ANI],\"content\":{\"text\":\"TretiTajemstvi.\"}}]}" > /dev/null
V_A=$(req r_a.jar GET /api/articles/$ART)
B3=$(jv "$V_A" "[b['id'] for b in d['blocks'] if b.get('canReveal')][0]")
req r_a.jar POST /api/blocks/$B3/reveal "{\"toCharId\":$BOR}" > /dev/null
req r_d.jar PUT /api/articles/$ART "{\"title\":\"Prokletá dýka\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Uz nic tajneho.\"}}]}" > /dev/null
L=$(req r_d.jar GET /api/campaigns/$CID/reveals)
check_has "visící žádost se uklidila" "$L" '"requests":\[\]'

echo; echo "🎉 Testy prozrazování informací prošly."

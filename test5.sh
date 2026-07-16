#!/bin/bash
# Testy: metadata předmětu, instance v grafickém inventáři, změna vlastníka postavy.
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

cd /tmp && rm -f d5.jar k5.jar p5.jar

echo "== příprava =="
req d5.jar POST /api/register '{"username":"dm5","password":"test1234"}' > /dev/null
CID=$(req d5.jar POST /api/campaigns '{"name":"Test5"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d5.jar POST /api/campaigns/$CID/users '{"username":"kubik5","password":"heslo123","characterName":"Kubirik"}' > /dev/null
req d5.jar POST /api/campaigns/$CID/users '{"username":"pauli5","password":"heslo123","characterName":"Toruk"}' > /dev/null
req k5.jar POST /api/login '{"username":"kubik5","password":"heslo123"}' > /dev/null
req p5.jar POST /api/login '{"username":"pauli5","password":"heslo123"}' > /dev/null
CHARS=$(req d5.jar GET /api/campaigns/$CID/characters)
KUBIRIK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Kubirik'][0]")
TORUK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")
PAULI_UID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Toruk'][0]")

echo "== předmět s metadaty =="
MEC=$(req d5.jar POST /api/campaigns/$CID/articles '{"title":"Plamenný meč"}' | grep -o '[0-9]*')
req d5.jar PUT /api/articles/$MEC '{"title":"Plamenný meč","description":"Meč sálající žárem","category":"Předměty","item":{"weight":3,"price":"5000 zl","rarity":"Velmi vzácný","wearable":true},"blocks":[{"type":"paragraph","visibility":"dm","content":{"text":"Ve skutečnosti je prokletý."}}]}' > /dev/null
M=$(req d5.jar GET /api/articles/$MEC)
check_has "metadata předmětu uložena" "$M" '"rarity":"Velmi vzácný"'

echo "== instance předmětu (grafický inventář) =="
Z=$(req d5.jar POST /api/campaigns/$CID/inv/zones '{"name":"Zeme"}' | grep -o '[0-9]*')
X=$(req k5.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$MEC,\"to\":{\"t\":\"zone\",\"zId\":$Z}}")
check_has "hráč předmět vytvořit nemůže" "$X" error
NEPREDMET=$(req d5.jar POST /api/campaigns/$CID/articles '{"title":"Hospoda"}' | grep -o '[0-9]*')
X=$(req d5.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$NEPREDMET,\"to\":{\"t\":\"zone\",\"zId\":$Z}}")
check_has "vytvořit lze jen kategorii Předměty" "$X" error
req d5.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$MEC,\"identified\":true,\"to\":{\"t\":\"slot\",\"charId\":$KUBIRIK,\"slot\":\"handR\"}}" > /dev/null
INV=$(req k5.jar GET /api/inv/char/$KUBIRIK)
check_has "vlastník vidí předmět v inventáři" "$INV" "Plamenný meč"
X=$(req p5.jar GET /api/inv/char/$KUBIRIK)
check_has "cizí hráč inventář nevidí" "$X" "nenalezena"
VA=$(req d5.jar GET "/api/inv/char/$KUBIRIK?viewAs=$PAULI_UID")
check_has "view-as: DM jako Paulí inventář Kubirika nevidí" "$VA" "nenalezena"
check_not "obsah skrytého článku předmětu neunikl do inventáře" "$INV" "prokletý"

echo "== změna vlastníka postavy =="
X=$(req k5.jar PUT /api/characters/$KUBIRIK "{\"userId\":$PAULI_UID}")
check_has "hráč vlastníka měnit nesmí" "$X" error
req d5.jar PUT /api/characters/$KUBIRIK "{\"userId\":$PAULI_UID}" > /dev/null
CH2=$(req d5.jar GET /api/campaigns/$CID/characters)
NEWOWNER=$(jv "$CH2" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")
[ "$NEWOWNER" = "$PAULI_UID" ] && echo "✅ OK: postava předána Paulímu" || { echo "❌ FAIL: vlastník nezměněn"; exit 1; }
KART=$(jv "$CH2" "[c['articleId'] for c in d if c['name']=='Kubirik'][0]")
A_P=$(req p5.jar GET /api/articles/$KART)
check_has "nový vlastník má owned=true" "$A_P" '"owned":true'
A_K=$(req k5.jar GET /api/articles/$KART)
check_not "původní hráč už vlastníkem není" "$A_K" '"owned":true'

echo "== coverWidth =="
req d5.jar PUT /api/articles/$MEC '{"title":"Plamenný meč","coverWidth":50,"blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Čepel plane ohněm."}}]}' > /dev/null
CW=$(req d5.jar GET /api/articles/$MEC)
check_has "coverWidth uložen" "$CW" '"coverWidth":50'

echo; echo "🎉 Všechny testy inventáře prošly."

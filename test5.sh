#!/bin/bash
# Testy: inventář, poznámky k předmětům, změna vlastníka postavy, metadata předmětu.
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
req d5.jar PUT /api/articles/$MEC '{"title":"Plamenný meč","description":"Meč sálající žárem","category":"Předměty","item":{"weight":3,"price":"5000 zl","rarity":"Velmi vzácný"},"blocks":[{"type":"paragraph","visibility":"dm","content":{"text":"Ve skutečnosti je prokletý."}}]}' > /dev/null
M=$(req d5.jar GET /api/articles/$MEC)
check_has "metadata předmětu uložena" "$M" '"rarity":"Velmi vzácný"'

echo "== vložení do inventáře =="
X=$(req k5.jar POST /api/characters/$KUBIRIK/inventory "{\"itemArticleId\":$MEC,\"qty\":1}")
check_has "hráč předmět vložit nemůže" "$X" error
NEPREDMET=$(req d5.jar POST /api/campaigns/$CID/articles '{"title":"Hospoda"}' | grep -o '[0-9]*')
X=$(req d5.jar POST /api/characters/$KUBIRIK/inventory "{\"itemArticleId\":$NEPREDMET,\"qty\":1}")
check_has "vložit lze jen kategorii Předměty" "$X" error
req d5.jar POST /api/characters/$KUBIRIK/inventory "{\"itemArticleId\":$MEC,\"qty\":1}" > /dev/null
INV=$(req k5.jar GET /api/characters/$KUBIRIK/inventory)
check_has "vlastník vidí předmět v inventáři" "$INV" "Plamenný meč"
check_has "vč. vzácnosti" "$INV" "Velmi vzácný"
IID=$(jv "$INV" "d['entries'][0]['id']")
X=$(req p5.jar GET /api/characters/$KUBIRIK/inventory)
check_has "cizí hráč inventář nevidí" "$X" error
VA=$(req d5.jar GET "/api/characters/$KUBIRIK/inventory?viewAs=$PAULI_UID")
check_has "view-as: DM jako Paulí inventář Kubirika nevidí" "$VA" error
# skrytý článek předmětu: linkable=false, ale předmět v inventáři vidět je
check_has "skrytý článek předmětu → linkable false" "$INV" '"linkable":false'
check_not "obsah článku předmětu neunikl do inventáře" "$INV" "prokletý"

echo "== poznámky k předmětu v inventáři =="
req k5.jar POST /api/inventory/$IID/notes '{"text":"Hráčova tajná zpráva DM o meči.","visibility":"dm"}' > /dev/null
req d5.jar POST /api/inventory/$IID/notes '{"text":"DM info jen pro sebe.","visibility":"dm"}' > /dev/null
req d5.jar POST /api/inventory/$IID/notes '{"text":"DM vzkaz hráči: meč občas šeptá.","visibility":"dm_owner"}' > /dev/null
K_INV=$(req k5.jar GET /api/characters/$KUBIRIK/inventory)
check_has "hráč vidí svou dm-poznámku (autor)" "$K_INV" "tajná zpráva"
check_has "hráč vidí dm_owner poznámku od DM" "$K_INV" "šeptá"
check_not "hráč nevidí čistě DM poznámku" "$K_INV" "jen pro sebe"
D_INV=$(req d5.jar GET /api/characters/$KUBIRIK/inventory)
check_has "DM vidí vše" "$D_INV" "jen pro sebe"

echo "== poznámky na článku předmětu dle oprávnění =="
# zviditelnit článek předmětu, aby ho hráči viděli
req d5.jar PUT /api/articles/$MEC '{"title":"Plamenný meč","description":"Meč sálající žárem","category":"Předměty","item":{"weight":3,"price":"5000 zl","rarity":"Velmi vzácný"},"blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Čepel plane ohněm."}}]}' > /dev/null
K_IN=$(req k5.jar GET /api/articles/$MEC/inventory-notes)
check_has "hráč na článku předmětu vidí výskyt u své postavy" "$K_IN" "Kubirik"
check_has "vidí dm_owner poznámku" "$K_IN" "šeptá"
check_not "nevidí DM-only poznámku (cizí)" "$K_IN" "jen pro sebe"
P_IN=$(req p5.jar GET /api/articles/$MEC/inventory-notes)
check_not "cizí hráč nevidí žádný výskyt" "$P_IN" "Kubirik" "šeptá"
D_IN=$(req d5.jar GET /api/articles/$MEC/inventory-notes)
check_has "DM vidí všechny výskyty a poznámky" "$D_IN" "jen pro sebe"

echo "== množství =="
req d5.jar POST /api/characters/$KUBIRIK/inventory "{\"itemArticleId\":$MEC,\"qty\":2}" > /dev/null
Q=$(req d5.jar GET /api/characters/$KUBIRIK/inventory)
check_has "duplicitní vložení navýší množství (1+2=3)" "$Q" '"qty":3'
req d5.jar PUT /api/inventory/$IID '{"qty":0}' > /dev/null
Q2=$(req d5.jar GET /api/characters/$KUBIRIK/inventory)
check_not "qty 0 položku odstraní" "$Q2" "Plamenný meč"

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

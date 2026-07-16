#!/bin/bash
# Testy: sezení, emulace viewAs, systémové kategorie, náhledy, backlinks, spoiler.
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

cd /tmp && rm -f d6.jar k6.jar p6.jar

echo "== příprava =="
req d6.jar POST /api/register '{"username":"dm6","password":"test1234"}' > /dev/null
CID=$(req d6.jar POST /api/campaigns '{"name":"Test6"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d6.jar POST /api/campaigns/$CID/users '{"username":"kubik6","password":"heslo123","characterName":"Kubirik"}' > /dev/null
req d6.jar POST /api/campaigns/$CID/users '{"username":"pauli6","password":"heslo123","characterName":"Toruk"}' > /dev/null
req k6.jar POST /api/login '{"username":"kubik6","password":"heslo123"}' > /dev/null
req p6.jar POST /api/login '{"username":"pauli6","password":"heslo123"}' > /dev/null
CHARS=$(req d6.jar GET /api/campaigns/$CID/characters)
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")
PUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Toruk'][0]")
TORUK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")

echo "== systémové kategorie =="
CL=$(req d6.jar GET /api/campaigns/$CID/category-list)
check_has "Předměty existují automaticky" "$CL" "Předměty"
check_has "Hráčské postavy existují automaticky" "$CL" "Hráčské postavy"
X=$(req d6.jar POST /api/campaigns/$CID/category-list/remove '{"name":"Předměty"}')
check_has "systémovou kategorii nelze odebrat" "$X" error

echo "== sezení =="
SID=$(req d6.jar POST /api/campaigns/$CID/sessions "{\"title\":\"Katakomby\",\"date\":\"2026-07-10\",\"players\":[$KUID,$PUID]}" | grep -o '[0-9]*')
X=$(req k6.jar POST /api/campaigns/$CID/sessions '{"title":"Hack","players":[]}')
check_has "sezení zakládá jen DM" "$X" error
req d6.jar PUT /api/sessions/$SID '{"scenario":{"left":"<b>Plán</b>: přepadení u brány. Tajný boss: lich.","right":"Hráči šli jinudy."}}' > /dev/null
D_S=$(req d6.jar GET /api/sessions/$SID)
check_has "DM vidí scénář" "$D_S" "lich"
K_S=$(req k6.jar GET /api/sessions/$SID)
check_not "hráč scénář NIKDY nedostane" "$K_S" "lich" "Plán" "jinudy" "scenario"
VA_S=$(req d6.jar GET "/api/sessions/$SID?viewAs=$KUID")
check_not "ani DM v náhledu hráče scénář nedostane" "$VA_S" "lich"

echo "== zápis DM (článek s bloky) =="
RID=$(jv "$D_S" "d['reportArticleId']")
req d6.jar PUT /api/articles/$RID "{\"title\":\"Zápis: Katakomby\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Družina vstoupila do katakomb.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"dm\",\"content\":{\"text\":\"Boss je stále naživu.\"}}]}" > /dev/null
K_R=$(req k6.jar GET /api/articles/$RID)
check_has "hráč vidí veřejnou část zápisu" "$K_R" "vstoupila"
check_not "tajná část zápisu hráči unikla" "$K_R" "naživu"
LIST=$(req k6.jar GET /api/campaigns/$CID/articles)
check_not "zápis sezení není v seznamu článků" "$LIST" "Katakomby"

echo "== zápisy hráčů + viditelnost =="
req k6.jar PUT /api/sessions/$SID/entry "{\"blocks\":[{\"html\":\"Viděl jsem stín bosse.\",\"text\":\"Viděl jsem stín bosse.\",\"visibility\":\"custom\",\"visibleTo\":[$TORUK]}]}" > /dev/null
P_S=$(req p6.jar GET /api/sessions/$SID)
check_has "Toruk vidí zápis určený jemu" "$P_S" "stín bosse"
req k6.jar PUT /api/sessions/$SID/entry '{"blocks":[{"html":"Jen pro DM: bojím se.","text":"Jen pro DM: bojím se.","visibility":"dm","visibleTo":[]}]}' > /dev/null
P_S2=$(req p6.jar GET /api/sessions/$SID)
check_not "zápis jen pro DM ostatní nevidí" "$P_S2" "bojím se"
D_S2=$(req d6.jar GET /api/sessions/$SID)
check_has "DM vidí vše" "$D_S2" "bojím se"

echo "== EMULACE: DM zapíše jako hráč =="
req d6.jar PUT "/api/sessions/$SID/entry?viewAs=$PUID" '{"blocks":[{"html":"Zápis Paulího rukou DM.","text":"Zápis Paulího rukou DM.","visibility":"all","visibleTo":[]}]}' > /dev/null
P_S3=$(req p6.jar GET /api/sessions/$SID)
check_has "zápis se uložil pod Paulího (mine=true)" "$P_S3" '"mine":true'
check_has "obsah souhlasí" "$P_S3" "rukou DM"
# emulovaná poznámka u článku
ART=$(req d6.jar POST /api/campaigns/$CID/articles '{"title":"Brána"}' | grep -o '[0-9]*')
req d6.jar PUT /api/articles/$ART '{"title":"Brána","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Stará brána."}}]}' > /dev/null
N=$(req d6.jar POST "/api/articles/$ART/notes?viewAs=$KUID" '{"text":"Emulovaná poznámka.","visibleTo":[]}')
check_has "poznámka přes viewAs čeká na schválení (autor=hráč)" "$N" '"approved":false'
K_N=$(req k6.jar GET /api/articles/$ART/notes)
check_has "hráč vidí poznámku jako svou" "$K_N" '"mine":true'

echo "== náhledy (preview obrázky dle práv) =="
printf 'x' > /tmp/t6.png
IMG1=$(curl -s -b d6.jar -F "file=@/tmp/t6.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
IMG2=$(curl -s -b d6.jar -F "file=@/tmp/t6.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
req d6.jar PUT /api/articles/$ART "{\"title\":\"Brána\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Stará brána.\"}},
  {\"type\":\"image\",\"visibility\":\"all\",\"content\":{\"imageId\":$IMG1,\"preview\":true}},
  {\"type\":\"image\",\"visibility\":\"dm\",\"content\":{\"imageId\":$IMG2,\"preview\":true}}]}" > /dev/null
D_L=$(req d6.jar GET /api/campaigns/$CID/articles)
check_has "DM má oba náhledy" "$D_L" "\"thumbs\":\[$IMG1,$IMG2\]"
K_L=$(req k6.jar GET /api/campaigns/$CID/articles)
check_not "hráč nemá skrytý náhled" "$K_L" ",$IMG2\]"

echo "== backlinks dle práv =="
SRC=$(req d6.jar POST /api/campaigns/$CID/articles '{"title":"Kronika"}' | grep -o '[0-9]*')
req d6.jar PUT /api/articles/$SRC "{\"title\":\"Kronika\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"dm\",\"content\":{\"text\":\"Tajně odkazuje na [[$ART|bránu]].\"}}]}" > /dev/null
D_A=$(req d6.jar GET /api/articles/$ART)
check_has "DM vidí backlink z Kroniky" "$D_A" "Kronika"
K_A=$(req k6.jar GET /api/articles/$ART)
check_not "hráč backlink ze skrytého bloku nevidí" "$K_A" "Kronika"

echo "== spoiler sanitizace =="
req d6.jar PUT /api/articles/$ART "{\"title\":\"Brána\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"spoiler test\",\"html\":\"Text <span class=\\\"spoiler\\\">tajemství</span> a <span class=\\\"hack\\\" onclick=\\\"x()\\\">útok</span>\"}}]}" > /dev/null
K_SP=$(req k6.jar GET /api/articles/$ART)
check_has "spoiler class prošel sanitizací" "$K_SP" 'class=\\"spoiler\\"'
check_not "cizí class a onclick odstraněny" "$K_SP" "hack" "onclick"

echo "== stažení přílohy =="
DL=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" -b d6.jar "$B/api/images/$IMG1?download=1")
echo "$DL" | grep -q "200" && echo "✅ OK: download endpoint funguje" || { echo "❌ FAIL: download"; exit 1; }

echo; echo "🎉 Všechny testy šesté verze prošly."

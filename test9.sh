#!/bin/bash
# Testy: jazyky (barvy, scramble), běžný jazyk, viewChar.
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

cd /tmp && rm -f d9.jar k9.jar p9.jar

echo "== příprava =="
req d9.jar POST /api/register '{"username":"dm9","password":"test1234"}' > /dev/null
CID=$(req d9.jar POST /api/campaigns '{"name":"Test9"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d9.jar POST /api/campaigns/$CID/users '{"username":"kubik9","password":"heslo123","characterName":"Kubirik"}' > /dev/null
req d9.jar POST /api/campaigns/$CID/users '{"username":"pauli9","password":"heslo123","characterName":"Toruk"}' > /dev/null
req k9.jar POST /api/login '{"username":"kubik9","password":"heslo123"}' > /dev/null
req p9.jar POST /api/login '{"username":"pauli9","password":"heslo123"}' > /dev/null
CHARS=$(req d9.jar GET /api/campaigns/$CID/characters)
KUBIRIK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Kubirik'][0]")
TORUK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")

echo "== běžný jazyk existuje automaticky =="
L=$(req d9.jar GET /api/campaigns/$CID/languages)
check_has "Běžný jazyk vytvořen" "$L" "Běžný jazyk"
X=$(req d9.jar POST /api/campaigns/$CID/category-list/remove '{"name":"Jazyk"}')
check_has "kategorie Jazyk je systémová" "$X" error

echo "== jazyk s unikátní barvou =="
ELF=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Elfština"}' | grep -o '[0-9]*')
X=$(req d9.jar PUT /api/articles/$ELF '{"title":"Elfština","category":"Jazyk","blocks":[]}')
check_has "jazyk bez barvy odmítnut" "$X" "barvu"
req d9.jar PUT /api/articles/$ELF '{"title":"Elfština","category":"Jazyk","langColor":"#3b82f6","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Jazyk elfů."}}]}' > /dev/null
ORK=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Orkština"}' | grep -o '[0-9]*')
X=$(req d9.jar PUT /api/articles/$ORK '{"title":"Orkština","category":"Jazyk","langColor":"#3b82f6","blocks":[]}')
check_has "duplicitní barva odmítnuta" "$X" "použita"
req d9.jar PUT /api/articles/$ORK '{"title":"Orkština","category":"Jazyk","langColor":"#2e9e5b","blocks":[]}' > /dev/null
L2=$(req d9.jar GET /api/campaigns/$CID/languages)
check_has "oba jazyky v seznamu" "$L2" "Orkština"

echo "== přiřazení jazyků: Kubirik umí elfsky =="
req d9.jar PUT /api/characters/$KUBIRIK "{\"languages\":[$ELF]}" > /dev/null
X=$(req k9.jar PUT /api/characters/$TORUK "{\"languages\":[$ELF]}")
check_has "cizí postavě hráč jazyky nenastaví" "$X" error

echo "== text v cizím jazyce: scramble pro neznalé =="
ART=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Nápis na bráně"}' | grep -o '[0-9]*')
req d9.jar PUT /api/articles/$ART "{\"title\":\"Nápis na bráně\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Na bráně stojí: Mellon znamená přítel\",\"html\":\"Na bráně stojí: <span class=\\\"lang\\\" data-lang=\\\"$ELF\\\">Mellon znamená přítel</span>\"}}]}" > /dev/null
D_A=$(req d9.jar GET /api/articles/$ART)
check_has "DM vidí originál" "$D_A" "Mellon znamená přítel"
check_has "DM dostává surové označení (data-lang) pro editaci" "$D_A" "data-lang"
K_A=$(req k9.jar GET /api/articles/$ART)
check_has "znalec (Kubirik) vidí originál" "$K_A" "Mellon znamená přítel"
P_A=$(req p9.jar GET /api/articles/$ART)
check_not "neznalec (Toruk) originál NEDOSTANE" "$P_A" "Mellon"
check_has "neznalec vidí barvu jazyka" "$P_A" "#3b82f6"
check_has "neznalec vidí 'Neznámá řeč'" "$P_A" "Neznámá řeč"
# scramble zachovává délku a mezery (dvě mezery ve větě)
SCR=$(echo "$P_A" | python3 -c "
import sys,json,re
d=json.load(sys.stdin)
h=d['blocks'][0]['content']['html']
m=re.search(r'<span class=\"lang\"[^>]*>([^<]*)</span>', h)
t=m.group(1)
orig='Mellon znamená přítel'
assert len(t)==len(orig), (t, len(t), len(orig))
assert t.count(' ')==2, t
assert t!=orig
print('OK délka i mezery zachovány:', t)")
echo "✅ $SCR"
# označení PŘESNĚ jak ho ukládá editor (style + class + data-lang v tomto pořadí)
ED=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Dopis"}' | grep -o '[0-9]*')
req d9.jar PUT /api/articles/$ED "{\"title\":\"Dopis\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"x\",\"html\":\"Píše se tu: <span class=\\\"lang\\\" data-lang=\\\"$ELF\\\" style=\\\"color:#3b82f6\\\">Tajne heslo brany</span> konec\"}}]}" > /dev/null
P_ED=$(req p9.jar GET /api/articles/$ED)
check_not "editorový formát: neznalec originál nedostane" "$P_ED" "Tajne heslo"
check_has "editorový formát: scramble proběhl (Neznámá řeč)" "$P_ED" "Neznámá řeč"
K_ED=$(req k9.jar GET /api/articles/$ED)
check_has "editorový formát: znalec originál vidí" "$K_ED" "Tajne heslo brany"
# běžný jazyk zná každý
NAP=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Vývěska"}' | grep -o '[0-9]*')
COMMON=$(jv "$L2" "[l['id'] for l in d if l['common']][0]")
req d9.jar PUT /api/articles/$NAP "{\"title\":\"Vývěska\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"x\",\"html\":\"<span class=\\\"lang\\\" data-lang=\\\"$COMMON\\\">Hledá se kovář</span>\"}}]}" > /dev/null
P_N=$(req p9.jar GET /api/articles/$NAP)
check_has "běžný jazyk zná každý (bez přiřazení)" "$P_N" "Hledá se kovář"

echo "== poškozené označení (rgb barva, BEZ data-lang) je fail-closed =="
BR2=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Útržek"}' | grep -o '[0-9]*')
req d9.jar PUT /api/articles/$BR2 "{\"title\":\"Útržek\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"x\",\"html\":\"Stojí tu: <span class=\\\"lang\\\" style=\\\"color: rgb(59, 130, 246)\\\">Skryte elfske slovo</span> a <span class=\\\"lang\\\" style=\\\"color: rgb(1, 2, 3)\\\">Uplne nezname</span>\"}}]}" > /dev/null
P_BR=$(req p9.jar GET /api/articles/$BR2)
check_not "neznalec nevidí originál (rgb dohledáno na elfštinu)" "$P_BR" "Skryte elfske slovo"
check_not "neidentifikovatelný jazyk fail-closed (šifra)" "$P_BR" "Uplne nezname"
K_BR=$(req k9.jar GET /api/articles/$BR2)
check_has "znalec elfštiny originál vidí (rgb dohledáno)" "$K_BR" "Skryte elfske slovo"
check_not "ani znalec nevidí neidentifikovatelné" "$K_BR" "Uplne nezname"
D_BR=$(req d9.jar GET /api/articles/$BR2)
check_has "DM vidí vše" "$D_BR" "Uplne nezname"

echo "== vlastník ČTE podle znalostí postavy, edituje přes ?edit=1 =="
KART9=$(jv "$CHARS" "[c['articleId'] for c in d if c['name']=='Kubirik'][0]")
req d9.jar PUT /api/articles/$KART9 "{\"title\":\"Kubirik\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"x\",\"html\":\"Vzkaz: <span class=\\\"lang\\\" data-lang=\\\"$ORK\\\">orkske tajemstvi</span>\"}}]}" > /dev/null
O_READ=$(req k9.jar GET "/api/articles/$KART9?viewChar=$KUBIRIK")
check_not "vlastník bez orkštiny při ČTENÍ vidí šifru" "$O_READ" "orkske tajemstvi"
O_EDIT=$(req k9.jar GET "/api/articles/$KART9?viewChar=$KUBIRIK&edit=1")
check_has "při editaci (?edit=1) dostává surová data" "$O_EDIT" "orkske tajemstvi"

echo "== uložení editorem označení NEZNIČÍ (GET → PUT roundtrip jako inline editace) =="
D_ED=$(req d9.jar GET /api/articles/$ED)
check_has "DM dostává surová data s data-lang" "$D_ED" "data-lang"
ROUND=$(python3 - "$D_ED" <<'EOF'
import sys, json
a = json.loads(sys.argv[1])
print(json.dumps({"title": a['title'], "description": a['description'], "category": a['category'], "tags": a['tags'], "blocks": a['blocks']}))
EOF
)
curl -s -b d9.jar -X PUT -H Content-Type:application/json -d "$ROUND" $B/api/articles/$ED > /dev/null
P_ED2=$(req p9.jar GET /api/articles/$ED)
check_not "po DM uložení neznalec stále NEVIDÍ originál" "$P_ED2" "Tajne heslo"
check_has "označení přežilo (Neznámá řeč)" "$P_ED2" "Neznámá řeč"
K_ED2=$(req k9.jar GET /api/articles/$ED)
check_has "znalec po uložení stále vidí originál" "$K_ED2" "Tajne heslo brany"

echo "== vyhledávání a preview neprozradí cizí jazyk =="
P_S=$(req p9.jar GET "/api/campaigns/$CID/search?q=Tajne")
check_not "neznalec hledáním originál nenajde" "$P_S" "Dopis" "Tajne"
K_S=$(req k9.jar GET "/api/campaigns/$CID/search?q=Tajne")
check_has "znalec hledáním najde" "$K_S" "Dopis"
P_PV=$(req p9.jar GET /api/articles/$ED/preview)
check_not "preview neznalci originál neprozradí" "$P_PV" "Tajne heslo"
D_S=$(req d9.jar GET "/api/campaigns/$CID/search?q=Tajne")
check_has "DM hledáním najde" "$D_S" "Dopis"

echo "== viewChar: svět očima konkrétní postavy =="
# druhá postava Kubíka bez elfštiny
req d9.jar POST /api/campaigns/$CID/characters "{\"userId\":$KUID,\"name\":\"Bruk\"}" > /dev/null
CH2=$(req d9.jar GET /api/campaigns/$CID/characters)
BRUK=$(jv "$CH2" "[c['id'] for c in d if c['name']=='Bruk'][0]")
K_ELF=$(req k9.jar GET "/api/articles/$ART?viewChar=$KUBIRIK")
check_has "za Kubirika elfsky rozumí" "$K_ELF" "Mellon"
K_BRUK=$(req k9.jar GET "/api/articles/$ART?viewChar=$BRUK")
check_not "za Bruka elfsky nerozumí" "$K_BRUK" "Mellon"
# viewChar mění i viditelnost bloků cílených na postavu
SEC=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"Vzkaz"}' | grep -o '[0-9]*')
req d9.jar PUT /api/articles/$SEC "{\"title\":\"Vzkaz\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Obecný úvod.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$KUBIRIK],\"content\":{\"text\":\"Jen pro Kubirika.\"}}]}" > /dev/null
V1=$(req k9.jar GET "/api/articles/$SEC?viewChar=$KUBIRIK")
check_has "za Kubirika blok vidí" "$V1" "Jen pro Kubirika"
V2=$(req k9.jar GET "/api/articles/$SEC?viewChar=$BRUK")
check_not "za Bruka blok nevidí" "$V2" "Jen pro Kubirika"
# cizí viewChar se ignoruje (nesmí rozšířit práva)
V3=$(req p9.jar GET "/api/articles/$SEC?viewChar=$KUBIRIK")
check_not "cizí viewChar hráči nic nepřidá" "$V3" "Jen pro Kubirika"

echo "== jazyky nastavuje POUZE DM =="
X=$(req k9.jar PUT /api/characters/$KUBIRIK "{\"languages\":[$ELF,$ORK]}")
check_has "vlastník si jazyky nastavit nesmí" "$X" error
req d9.jar PUT /api/characters/$KUBIRIK "{\"languages\":[$ELF]}" > /dev/null
echo "✅ OK: DM jazyky nastavit může"

echo "== hráč se dívá VŽDY za jednu postavu (výchozí = první) =="
# blok jen pro Bruka (druhou postavu Kubíka)
BR=$(req d9.jar POST /api/campaigns/$CID/articles '{"title":"ProBruka"}' | grep -o '[0-9]*')
req d9.jar PUT /api/articles/$BR "{\"title\":\"ProBruka\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Úvod.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$BRUK],\"content\":{\"text\":\"Tajemství pro Bruka.\"}}]}" > /dev/null
DEF=$(req k9.jar GET /api/articles/$BR)
check_not "bez viewChar platí PRVNÍ postava (Kubirik) → Brukův blok nevidí" "$DEF" "Tajemství pro Bruka"
EXP=$(req k9.jar GET "/api/articles/$BR?viewChar=$BRUK")
check_has "s viewChar=Bruk blok vidí" "$EXP" "Tajemství pro Bruka"

echo "== DM emuluje konkrétní postavu =="
DM_EMU=$(req d9.jar GET "/api/articles/$BR?viewAs=$KUID&viewChar=$BRUK")
check_has "DM za Bruka blok vidí" "$DM_EMU" "Tajemství pro Bruka"
DM_EMU2=$(req d9.jar GET "/api/articles/$BR?viewAs=$KUID&viewChar=$KUBIRIK")
check_not "DM za Kubirika Brukův blok nevidí" "$DM_EMU2" "Tajemství pro Bruka"
DM_LANG=$(req d9.jar GET "/api/articles/$ART?viewAs=$KUID&viewChar=$BRUK")
check_not "DM za Bruka elfsky nerozumí" "$DM_LANG" "Mellon"

echo; echo "🎉 Všechny testy jazyků prošly."

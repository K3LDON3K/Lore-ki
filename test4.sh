#!/bin/bash
# Testy: postavy, vlastnictví článku postavy, scénář Kubík/Kubirik/Toruk.
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
jsonval() { python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f d4.jar k4.jar p4.jar s4.jar

echo "== příprava: DM, Kubík(Kubirik), Paulí(Toruk), Slavex =="
req d4.jar POST /api/register '{"username":"dm4","password":"test1234"}' > /dev/null
CID=$(req d4.jar POST /api/campaigns '{"name":"Test4"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d4.jar POST /api/campaigns/$CID/users '{"username":"kubik4","password":"heslo123","characterName":"Kubirik"}' > /dev/null
req d4.jar POST /api/campaigns/$CID/users '{"username":"pauli4","password":"heslo123","characterName":"Toruk"}' > /dev/null
req d4.jar POST /api/campaigns/$CID/users '{"username":"slavex4","password":"heslo123","characterName":"Slavex"}' > /dev/null
req k4.jar POST /api/login '{"username":"kubik4","password":"heslo123"}' > /dev/null
req p4.jar POST /api/login '{"username":"pauli4","password":"heslo123"}' > /dev/null
req s4.jar POST /api/login '{"username":"slavex4","password":"heslo123"}' > /dev/null

CHARS=$(req d4.jar GET /api/campaigns/$CID/characters)
KUBIRIK=$(jsonval "$CHARS" "[c['id'] for c in d if c['name']=='Kubirik'][0]")
TORUK=$(jsonval "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")
KUBIK_UID=$(jsonval "$CHARS" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")
KART=$(jsonval "$CHARS" "[c['articleId'] for c in d if c['name']=='Kubirik'][0]")
echo "postavy: Kubirik=$KUBIRIK Toruk=$TORUK, článek Kubirika=$KART"

echo "== více postav jednoho hráče =="
req d4.jar POST /api/campaigns/$CID/characters "{\"userId\":$KUBIK_UID,\"name\":\"Bruk\"}" > /dev/null
CHARS2=$(req d4.jar GET /api/campaigns/$CID/characters)
check_has "hráč má dvě postavy" "$CHARS2" "Bruk"

echo "== vlastník píše backstory + temné tajemství jen pro Toruka =="
K_EDIT=$(req k4.jar PUT /api/articles/$KART "{\"title\":\"Kubirik\",\"description\":\"Bojovník ze severu\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Backstory: Kubirik vyrostl v horách.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$TORUK],\"content\":{\"text\":\"Temné tajemství: Kubirik zradil svůj klan.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[],\"content\":{\"text\":\"Jen pro mě a DM: skrytá slabina.\"}}
]}")
check_has "vlastník může článek uložit" "$K_EDIT" '"ok":true'

P_ART=$(req p4.jar GET /api/articles/$KART)
check_has "Toruk (Paulí) vidí backstory" "$P_ART" "vyrostl v horách"
check_has "Toruk vidí temné tajemství" "$P_ART" "zradil svůj klan"
check_not "Toruk nevidí blok jen-vlastník+DM ani metadata" "$P_ART" "skrytá slabina" "visibleTo"
S_ART=$(req s4.jar GET /api/articles/$KART)
check_has "Slavex vidí backstory" "$S_ART" "vyrostl v horách"
check_not "Slavex temné tajemství nevidí" "$S_ART" "zradil svůj klan" "skrytá slabina"
D_ART=$(req d4.jar GET /api/articles/$KART)
check_has "DM vidí vše" "$D_ART" "skrytá slabina"
K_ART=$(req k4.jar GET /api/articles/$KART)
check_has "vlastník vidí svůj skrytý blok" "$K_ART" "skrytá slabina"
check_has "vlastník má owned=true" "$K_ART" '"owned":true'

echo "== DM blok se vlastníkovi nezobrazí a jeho uložení ho nesmaže =="
# DM přidá tajný blok (visibility dm) do článku Kubirika
D_BLOCKS=$(python3 - "$D_ART" <<'EOF'
import sys, json
a = json.loads(sys.argv[1])
blocks = a['blocks']
blocks.append({"type":"paragraph","visibility":"dm","content":{"text":"DM tajnost o Kubirikovi."}})
print(json.dumps({"title":a['title'],"description":a['description'],"category":a['category'],"tags":a['tags'],"blocks":blocks}))
EOF
)
curl -s -b d4.jar -X PUT -H Content-Type:application/json -d "$D_BLOCKS" $B/api/articles/$KART > /dev/null
K_ART2=$(req k4.jar GET /api/articles/$KART)
check_not "vlastník DM blok nevidí" "$K_ART2" "DM tajnost"
# vlastník uloží svou verzi (bez DM bloku) — DM blok musí přežít
K_SAVE=$(python3 - "$K_ART2" <<'EOF'
import sys, json
a = json.loads(sys.argv[1])
print(json.dumps({"title":a['title'],"description":a['description'],"tags":a['tags'],"blocks":a['blocks']}))
EOF
)
curl -s -b k4.jar -X PUT -H Content-Type:application/json -d "$K_SAVE" $B/api/articles/$KART > /dev/null
D_ART2=$(req d4.jar GET /api/articles/$KART)
check_has "DM blok přežil uložení vlastníkem" "$D_ART2" "DM tajnost"
check_has "obsah vlastníka zachován" "$D_ART2" "zradil svůj klan"

echo "== vlastník nemůže editovat cizí článek =="
CIZI=$(req d4.jar POST /api/campaigns/$CID/articles '{"title":"Hrad"}' | grep -o '[0-9]*')
X=$(req k4.jar PUT /api/articles/$CIZI '{"title":"Hack","blocks":[]}')
check_has "cizí článek hráč needituje" "$X" error

echo "== poznámky: schvaluje vlastník postavy =="
N=$(req p4.jar POST /api/articles/$KART/notes "{\"text\":\"Toruk: Kubirik mi něco tají.\",\"visibleTo\":[]}")
NID=$(echo "$N" | grep -o '"id":[0-9]*' | cut -d: -f2)
check_has "poznámka hráče čeká na schválení" "$N" '"approved":false'
K_N=$(req k4.jar GET /api/articles/$KART/notes)
check_has "vlastník vidí neschválenou poznámku" "$K_N" "něco tají"
APR=$(req k4.jar POST /api/notes/$NID/approve)
check_has "vlastník poznámku schválí" "$APR" '"ok":true'
X=$(req s4.jar POST /api/notes/$NID/approve)
check_has "cizí hráč schvalovat nesmí" "$X" error
OWN_N=$(req k4.jar POST /api/articles/$KART/notes '{"text":"Pozn. vlastníka.","visibleTo":[]}')
check_has "poznámka vlastníka je schválená automaticky" "$OWN_N" '"approved":true'

echo "== viditelnost cílená na postavu (DM blok pro Toruka) =="
NAM=$(req d4.jar POST /api/campaigns/$CID/articles '{"title":"Náměstí4"}' | grep -o '[0-9]*')
req d4.jar PUT /api/articles/$NAM "{\"title\":\"Náměstí4\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Kašna uprostřed.\"}},
  {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$TORUK],\"content\":{\"text\":\"Toruk cítí stopu magie.\"}}
]}" > /dev/null
P_N2=$(req p4.jar GET /api/articles/$NAM)
check_has "Paulí (Toruk) blok vidí" "$P_N2" "stopu magie"
K_N2=$(req k4.jar GET /api/articles/$NAM)
check_not "Kubík blok pro Toruka nevidí" "$K_N2" "stopu magie"

echo; echo "🎉 Všechny testy postav a vlastnictví prošly."

#!/bin/bash
# End-to-end test scénáře ze zadání: Hlavní město + bloky pro Kubíka/Paulího/DM.
# Ověřuje, že skrytý obsah NEUNIKÁ v API odpovědích.
set -e
B=http://localhost:3000
J="curl -s -H Content-Type:application/json"

req() { # req <cookiejar> <method> <path> [data]
  local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then
    curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else
    curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"
  fi
}

cd /tmp && rm -f dm.jar kubik.jar pauli.jar cizi.jar

echo "== registrace =="
req dm.jar POST /api/register '{"username":"dm","password":"test1234"}'; echo
req kubik.jar POST /api/register '{"username":"kubik","password":"test1234"}'; echo
req pauli.jar POST /api/register '{"username":"pauli","password":"test1234"}'; echo
req cizi.jar POST /api/register '{"username":"cizi","password":"test1234"}'; echo

echo "== kampaň + hráči =="
CAMP=$(req dm.jar POST /api/campaigns '{"name":"Kopule"}')
echo "$CAMP"
CID=$(echo "$CAMP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
req dm.jar POST /api/campaigns/$CID/players '{"username":"kubik","characterName":"Kubík"}'; echo
req dm.jar POST /api/campaigns/$CID/players '{"username":"pauli","characterName":"Paulí"}'; echo
PLAYERS=$(req dm.jar GET /api/campaigns/$CID/players)
echo "$PLAYERS"
KID=$(echo "$PLAYERS" | python3 -c "import sys,json; d=json.load(sys.stdin); print([p['id'] for p in d if p['username']=='kubik'][0])")
PID=$(echo "$PLAYERS" | python3 -c "import sys,json; d=json.load(sys.stdin); print([p['id'] for p in d if p['username']=='pauli'][0])")

echo "== článek Hlavní město =="
AID=$(req dm.jar POST /api/campaigns/$CID/articles '{"title":"Hlavní město"}' | grep -o '[0-9]*')
req dm.jar PUT /api/articles/$AID "{
  \"title\":\"Hlavní město\",\"description\":\"Sídlo královské rodiny\",\"category\":\"Města\",\"tags\":\"město,koruna\",
  \"blocks\":[
    {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Hlavní město se nachází uprostřed kopule a je sídlem královské rodiny.\"}},
    {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$KID],\"content\":{\"text\":\"Kubík poznává symbol vyrytý na podstavci sochy.\"}},
    {\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$PID],\"content\":{\"text\":\"Paulí ví o vstupu do starých katakomb.\"}},
    {\"type\":\"dm_note\",\"content\":{\"text\":\"Pod městem je tajná laboratoř zakladatelů.\"}}
  ]}"; echo

echo "== tajný článek (jen DM) =="
SID=$(req dm.jar POST /api/campaigns/$CID/articles '{"title":"Tajná laboratoř"}' | grep -o '[0-9]*')
req dm.jar PUT /api/articles/$SID '{"title":"Tajná laboratoř","blocks":[{"type":"paragraph","visibility":"dm","content":{"text":"Zakladatelé zde prováděli experimenty."}}]}'; echo

check() { # check <popis> <výstup> <nesmí obsahovat...>
  local desc=$1 out=$2; shift 2
  for s in "$@"; do
    if echo "$out" | grep -qi "$s"; then echo "❌ FAIL: $desc — uniklo: $s"; exit 1; fi
  done
  echo "✅ OK: $desc"
}

echo; echo "== TESTY ÚNIKU =="
K_ART=$(req kubik.jar GET /api/articles/$AID)
echo "Kubík vidí: $K_ART" | head -c 400; echo
check "Kubík nevidí blok Paulího ani DM poznámku" "$K_ART" "katakomb" "laboratoř" "visibility" "visibleTo"
echo "$K_ART" | grep -q "symbol vyrytý" && echo "✅ OK: Kubík vidí svůj blok"
echo "$K_ART" | grep -q "kopule" && echo "✅ OK: Kubík vidí společný blok"

P_ART=$(req pauli.jar GET /api/articles/$AID)
check "Paulí nevidí blok Kubíka ani DM poznámku" "$P_ART" "symbol vyrytý" "laboratoř"
echo "$P_ART" | grep -q "katakomb" && echo "✅ OK: Paulí vidí svůj blok"

S_ART=$(req kubik.jar GET /api/articles/$SID)
check "Tajný článek vrací hráči 404 bez obsahu" "$S_ART" "experimenty" "Zakladatelé"
echo "   odpověď: $S_ART"

K_LIST=$(req kubik.jar GET /api/campaigns/$CID/articles)
check "Tajný článek není v seznamu hráče" "$K_LIST" "laboratoř"

K_SEARCH=$(req kubik.jar GET "/api/campaigns/$CID/search?q=katakomb")
check "Vyhledávání: Kubík nenajde Paulího obsah" "$K_SEARCH" "katakomb"
P_SEARCH=$(req pauli.jar GET "/api/campaigns/$CID/search?q=katakomb")
echo "$P_SEARCH" | grep -q "katakomb" && echo "✅ OK: Paulí svůj obsah najde"
DM_SEARCH=$(req dm.jar GET "/api/campaigns/$CID/search?q=laboratoř")
echo "$DM_SEARCH" | grep -q "laboratoř" && echo "✅ OK: DM najde vše"

echo; echo "== VIEW-AS =="
VA=$(req dm.jar GET "/api/articles/$AID?viewAs=$KID")
check "DM v náhledu Kubíka nevidí skryté" "$VA" "katakomb" "laboratoř"
echo "$VA" | grep -q "symbol vyrytý" && echo "✅ OK: view-as ukazuje obsah Kubíka"
VA2=$(req kubik.jar GET "/api/articles/$AID?viewAs=$PID")
check "Hráč nemůže zneužít viewAs" "$VA2" "katakomb"

echo; echo "== CIZÍ UŽIVATEL =="
C_ART=$(req cizi.jar GET /api/articles/$AID)
check "Nečlen kampaně nic nevidí" "$C_ART" "kopule" "symbol"
echo "   odpověď: $C_ART"

echo; echo "== ODEMČENÍ INFORMACE (změna viditelnosti) =="
req dm.jar PUT /api/articles/$SID "{\"title\":\"Tajná laboratoř\",\"blocks\":[{\"type\":\"paragraph\",\"visibility\":\"custom\",\"visibleTo\":[$KID],\"content\":{\"text\":\"Zakladatelé zde prováděli experimenty.\"}}]}" > /dev/null
S2=$(req kubik.jar GET /api/articles/$SID)
echo "$S2" | grep -q "experimenty" && echo "✅ OK: po odemčení Kubík článek vidí"
S3=$(req pauli.jar GET /api/articles/$SID)
check "Paulí odemčený obsah stále nevidí" "$S3" "experimenty"

echo; echo "🎉 Všechny testy prošly."

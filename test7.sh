#!/bin/bash
# Testy: zápisy hráčů po blocích, obrázky v rich textu, migrace starých zápisů.
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

cd /tmp && rm -f d7.jar k7.jar p7.jar

echo "== příprava =="
req d7.jar POST /api/register '{"username":"dm7","password":"test1234"}' > /dev/null
CID=$(req d7.jar POST /api/campaigns '{"name":"Test7"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d7.jar POST /api/campaigns/$CID/users '{"username":"kubik7","password":"heslo123","characterName":"Kubirik"}' > /dev/null
req d7.jar POST /api/campaigns/$CID/users '{"username":"pauli7","password":"heslo123","characterName":"Toruk"}' > /dev/null
req k7.jar POST /api/login '{"username":"kubik7","password":"heslo123"}' > /dev/null
req p7.jar POST /api/login '{"username":"pauli7","password":"heslo123"}' > /dev/null
CHARS=$(req d7.jar GET /api/campaigns/$CID/characters)
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")
PUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Toruk'][0]")
TORUK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")
SID=$(req d7.jar POST /api/campaigns/$CID/sessions "{\"title\":\"Bloky\",\"date\":\"2026-07-12\",\"players\":[$KUID,$PUID]}" | grep -o '[0-9]*')

echo "== více bloků zápisu s různou viditelností =="
req k7.jar PUT /api/sessions/$SID/entry "{\"blocks\":[
  {\"html\":\"Veřejný blok jedna.\",\"text\":\"Veřejný blok jedna.\",\"visibility\":\"all\"},
  {\"html\":\"Tajně pro DM: blok dvě.\",\"text\":\"Tajně pro DM: blok dvě.\",\"visibility\":\"dm\"},
  {\"html\":\"Jen pro Toruka: blok tři.\",\"text\":\"Jen pro Toruka: blok tři.\",\"visibility\":\"custom\",\"visibleTo\":[$TORUK]}
]}" > /dev/null
P_S=$(req p7.jar GET /api/sessions/$SID)
check_has "Toruk vidí veřejný blok" "$P_S" "blok jedna"
check_has "Toruk vidí blok určený jemu" "$P_S" "blok tři"
check_not "Toruk nevidí DM blok ani metadata" "$P_S" "blok dvě" "visibleTo"
D_S=$(req d7.jar GET /api/sessions/$SID)
check_has "DM vidí všechny tři bloky" "$D_S" "blok dvě"
K_S=$(req k7.jar GET /api/sessions/$SID)
check_has "autor vidí své bloky vč. metadat" "$K_S" '"visibility":"custom"'
# přidání dalšího hráče, který nemá custom blok
S2=$(req d7.jar POST /api/campaigns/$CID/users '{"username":"slavex7","password":"heslo123","characterName":"Slavex"}')
SUID=$(echo "$S2" | grep -o '"id":[0-9]*' | cut -d: -f2)
req d7.jar PUT /api/sessions/$SID "{\"players\":[$KUID,$PUID,$SUID]}" > /dev/null
rm -f s7.jar; req s7.jar POST /api/login '{"username":"slavex7","password":"heslo123"}' > /dev/null
S_S=$(req s7.jar GET /api/sessions/$SID)
check_has "Slavex vidí veřejný blok" "$S_S" "blok jedna"
check_not "Slavex nevidí cizí ani DM bloky" "$S_S" "blok dvě" "blok tři"

echo "== obrázek v rich textu dle oprávnění =="
printf 'x' > /tmp/t7.png
IMG=$(curl -s -b d7.jar -F "file=@/tmp/t7.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
ART=$(req d7.jar POST /api/campaigns/$CID/articles '{"title":"Galerie"}' | grep -o '[0-9]*')
req d7.jar PUT /api/articles/$ART "{\"title\":\"Galerie\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"dm\",\"content\":{\"text\":\"tajný\",\"html\":\"Tajný obrázek <img src=\\\"/api/images/$IMG\\\">\"}}]}" > /dev/null
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b k7.jar $B/api/images/$IMG)
[ "$CODE" = "404" ] && echo "✅ OK: obrázek ze skrytého textu hráč nestáhne ($CODE)" || { echo "❌ FAIL: $CODE"; exit 1; }
req d7.jar PUT /api/articles/$ART "{\"title\":\"Galerie\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"veřejný\",\"html\":\"Obrázek <img src=\\\"/api/images/$IMG\\\">\"}}]}" > /dev/null
CODE2=$(curl -s -o /dev/null -w "%{http_code}" -b k7.jar $B/api/images/$IMG)
[ "$CODE2" = "200" ] && echo "✅ OK: po zveřejnění bloku obrázek dostupný ($CODE2)" || { echo "❌ FAIL: $CODE2"; exit 1; }
A=$(req k7.jar GET /api/articles/$ART)
check_has "img tag prošel sanitizací" "$A" 'src=\\"/api/images/'
X=$(req d7.jar PUT /api/articles/$ART "{\"title\":\"Galerie\",\"blocks\":[{\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"x\",\"html\":\"<img src=\\\"https://evil.com/x.png\\\" onerror=\\\"h()\\\">\"}}]}")
A2=$(req d7.jar GET /api/articles/$ART)
check_not "externí obrázek sanitizace odstraní" "$A2" "evil.com" "onerror"

echo; echo "🎉 Všechny testy sedmé verze prošly (migrace se ověří po restartu)."

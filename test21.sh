#!/bin/bash
# Testy: obrázky a reference v chatu — práva na obrázky ze zpráv (i šeptaných).
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ OK: $1" || { echo "❌ FAIL: $1 (chybí $3: $(echo $2|head -c 250))"; exit 1; }; }
check_not(){ echo "$2"|grep -qi "$3" && { echo "❌ FAIL: $1 — uniklo: $3"; exit 1; } || echo "✅ OK: $1"; }
jv(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f c_d.jar c_a.jar c_b.jar
req c_d.jar POST /api/register '{"username":"chdm","password":"test1234"}' > /dev/null
CID=$(req c_d.jar POST /api/campaigns '{"name":"Chat21"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req c_d.jar POST /api/campaigns/$CID/users '{"username":"chh1","password":"heslo123","characterName":"Ada"}' > /dev/null
req c_d.jar POST /api/campaigns/$CID/users '{"username":"chh2","password":"heslo123","characterName":"Bob"}' > /dev/null
req c_a.jar POST /api/login '{"username":"chh1","password":"heslo123"}' > /dev/null
req c_b.jar POST /api/login '{"username":"chh2","password":"heslo123"}' > /dev/null
CHARS=$(req c_d.jar GET /api/campaigns/$CID/characters)
ADA=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Ada'][0]")
BOB=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Bob'][0]")
ROOM=$(req c_d.jar POST /api/campaigns/$CID/chat/rooms "{\"name\":\"Sál\",\"characters\":[$ADA,$BOB]}" | grep -o '[0-9]*' | head -1)

echo "== nahrání obrázku a zpráva s ním =="
printf '\x89PNG\r\n\x1a\n' > /tmp/ch21.png
IMG=$(curl -s -b c_a.jar -F "file=@/tmp/ch21.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
[ -n "$IMG" ] && echo "✅ OK: obrázek nahrán ($IMG)" || { echo "❌ FAIL: upload"; exit 1; }
X=$(req c_a.jar POST /api/chat/rooms/$ROOM/messages "{\"text\":\"\",\"imageId\":$IMG}")
check_has "zpráva jen s obrázkem projde" "$X" '"id"'
M=$(req c_b.jar GET /api/chat/rooms/$ROOM/messages)
check_has "druhý hráč vidí imageId" "$M" "\"imageId\":$IMG"
S=$(curl -s -o /dev/null -w '%{http_code}' -b c_b.jar $B/api/images/$IMG)
[ "$S" = 200 ] && echo "✅ OK: účastník chatu obrázek stáhne" || { echo "❌ FAIL: obrázek nedostupný ($S)"; exit 1; }

echo "== prázdná zpráva bez obrázku neprojde =="
X=$(req c_a.jar POST /api/chat/rooms/$ROOM/messages '{"text":""}')
check_has "prázdná zpráva odmítnuta" "$X" "error"
X=$(req c_a.jar POST /api/chat/rooms/$ROOM/messages '{"text":"","imageId":99999}')
check_has "cizí/neexistující obrázek odmítnut" "$X" "error"

echo "== obrázek v šeptané zprávě: nezúčastněný ho nedostane =="
IMG2=$(curl -s -b c_a.jar -F "file=@/tmp/ch21.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
req c_a.jar POST /api/chat/rooms/$ROOM/messages "{\"text\":\"tajný plán\",\"imageId\":$IMG2,\"secretTo\":\"dm\"}" > /dev/null
M=$(req c_b.jar GET /api/chat/rooms/$ROOM/messages)
check_not "Bob šeptanou zprávu nevidí" "$M" "tajný plán"
S=$(curl -s -o /dev/null -w '%{http_code}' -b c_b.jar $B/api/images/$IMG2)
[ "$S" = 404 ] && echo "✅ OK: obrázek ze šeptané zprávy Bob nedostane (404)" || { echo "❌ FAIL: unikl obrázek ($S)"; exit 1; }
S=$(curl -s -o /dev/null -w '%{http_code}' -b c_d.jar $B/api/images/$IMG2)
[ "$S" = 200 ] && echo "✅ OK: DM obrázek vidí" || { echo "❌ FAIL: DM nevidí ($S)"; exit 1; }

echo "== reference v textu zprávy se přenáší beze změny =="
ART=$(req c_d.jar POST /api/campaigns/$CID/articles '{"title":"Mapa dolu"}' | grep -o '[0-9]*')
req c_a.jar POST /api/chat/rooms/$ROOM/messages "{\"text\":\"mrkni na [[$ART|Mapa dolu]]\"}" > /dev/null
M=$(req c_b.jar GET /api/chat/rooms/$ROOM/messages)
check_has "reference dorazila" "$M" "\\[\\[$ART|Mapa dolu\\]\\]"

echo; echo "🎉 Testy chatu s obrázky prošly."

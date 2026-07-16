#!/bin/bash
# Testy: chat — místnosti, šeptání, jazyky, unread, SSE, emulace.
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

cd /tmp && rm -f d11.jar k11.jar p11.jar s11.jar

echo "== příprava: DM + Kubirik(elfsky), Toruk, Slavex =="
req d11.jar POST /api/register '{"username":"dm11","password":"test1234"}' > /dev/null
CID=$(req d11.jar POST /api/campaigns '{"name":"Test11"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
for u in kubik11:Kubirik pauli11:Toruk slavex11:Slavex; do
  req d11.jar POST /api/campaigns/$CID/users "{\"username\":\"${u%%:*}\",\"password\":\"heslo123\",\"characterName\":\"${u##*:}\"}" > /dev/null
done
req k11.jar POST /api/login '{"username":"kubik11","password":"heslo123"}' > /dev/null
req p11.jar POST /api/login '{"username":"pauli11","password":"heslo123"}' > /dev/null
req s11.jar POST /api/login '{"username":"slavex11","password":"heslo123"}' > /dev/null
CHARS=$(req d11.jar GET /api/campaigns/$CID/characters)
KUBIRIK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Kubirik'][0]")
TORUK=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")
SLAVEX=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Slavex'][0]")
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Kubirik'][0]")
ELF=$(req d11.jar POST /api/campaigns/$CID/articles '{"title":"Elfština"}' | grep -o '[0-9]*')
req d11.jar PUT /api/articles/$ELF '{"title":"Elfština","category":"Jazyk","langColor":"#3b82f6","blocks":[]}' > /dev/null
req d11.jar PUT /api/characters/$KUBIRIK "{\"languages\":[$ELF]}" > /dev/null

echo "== místnost + členství =="
X=$(req k11.jar POST /api/campaigns/$CID/chat/rooms '{"name":"Hack"}')
check_has "místnost zakládá jen DM" "$X" error
RID=$(req d11.jar POST /api/campaigns/$CID/chat/rooms "{\"name\":\"U táboráku\",\"characters\":[$KUBIRIK,$TORUK]}" | grep -o '[0-9]*')
K_R=$(req k11.jar GET /api/campaigns/$CID/chat/rooms)
check_has "člen místnost vidí" "$K_R" "táboráku"
S_R=$(req s11.jar GET /api/campaigns/$CID/chat/rooms)
check_not "nepozvaný místnost nevidí" "$S_R" "táboráku"
X=$(req s11.jar GET /api/chat/rooms/$RID/messages)
check_has "nepozvaný zprávy nedostane (404)" "$X" "nenalezena"

echo "== veřejné zprávy + šeptání =="
req k11.jar POST /api/chat/rooms/$RID/messages '{"text":"Ahoj všichni u ohně!"}' > /dev/null
req k11.jar POST /api/chat/rooms/$RID/messages '{"text":"Tajný vzkaz DM: nevěřím Torukovi.","secretTo":"dm"}' > /dev/null
P_M=$(req p11.jar GET /api/chat/rooms/$RID/messages)
check_has "Toruk vidí veřejnou zprávu" "$P_M" "u ohně"
check_not "šeptání DM je pro Toruka zcela neviditelné" "$P_M" "nevěřím" "secret"
D_M=$(req d11.jar GET /api/chat/rooms/$RID/messages)
check_has "DM šeptání vidí" "$D_M" "nevěřím Torukovi"
check_has "se štítkem jen pro DM" "$D_M" "jen pro DM"
K_M=$(req k11.jar GET /api/chat/rooms/$RID/messages)
check_has "autor své šeptání vidí" "$K_M" "nevěřím Torukovi"

echo "== DM šeptá VÍCE postavám =="
req d11.jar POST /api/chat/rooms/$RID/messages "{\"text\":\"Jen pro vybrané: heslo je Mellon.\",\"secretTo\":[$TORUK]}" > /dev/null
P_M2=$(req p11.jar GET /api/chat/rooms/$RID/messages)
check_has "adresát tajnou zprávu DM vidí" "$P_M2" "heslo je Mellon"
K_M2=$(req k11.jar GET "/api/chat/rooms/$RID/messages")
check_not "neadresovaná postava ji nevidí vůbec" "$K_M2" "Mellon"
echo "== hráč šeptá jiné postavě — DM to vidí vždy =="
# do místnosti přidáme Slavexe, ať máme i NEadresovanou postavu
req d11.jar PUT /api/chat/rooms/$RID "{\"name\":\"U táboráku\",\"characters\":[$KUBIRIK,$TORUK,$SLAVEX]}" > /dev/null
req k11.jar POST /api/chat/rooms/$RID/messages "{\"text\":\"Toruku, kryj mi záda.\",\"secretTo\":[$TORUK]}" > /dev/null
P_W=$(req p11.jar GET /api/chat/rooms/$RID/messages)
check_has "adresovaná postava šeptání hráče vidí" "$P_W" "kryj mi záda"
check_has "štítek přiznává, že to vidí i DM" "$P_W" "(+ DM)"
S_W=$(req s11.jar GET /api/chat/rooms/$RID/messages)
check_not "neadresovaná postava šeptání hráče NEVIDÍ" "$S_W" "kryj mi záda"
D_W=$(req d11.jar GET /api/chat/rooms/$RID/messages)
check_has "DM vidí i šeptání mezi hráči" "$D_W" "kryj mi záda"
K_W=$(req k11.jar GET /api/chat/rooms/$RID/messages)
check_has "autor své šeptání vidí" "$K_W" "kryj mi záda"
X=$(req k11.jar POST /api/chat/rooms/$RID/messages '{"text":"x","secretTo":[999999]}')
check_has "šeptat postavě mimo místnost nelze" "$X" error
X=$(req k11.jar POST /api/chat/rooms/$RID/messages "{\"text\":\"x\",\"secretTo\":[$KUBIRIK]}")
check_has "sám sobě šeptat nelze" "$X" error

echo "== jazyk zprávy: znalec čte, neznalec šifru =="
req k11.jar POST /api/chat/rooms/$RID/messages "{\"text\":\"Elen sila lumenn omentielvo\",\"langId\":$ELF}" > /dev/null
D_L=$(req d11.jar GET /api/chat/rooms/$RID/messages)
check_has "DM vidí originál elfsky" "$D_L" "Elen sila lumenn"
P_L=$(req p11.jar GET /api/chat/rooms/$RID/messages)
check_not "neznalec originál NEDOSTANE" "$P_L" "Elen sila lumenn"
check_has "vidí Neznámá řeč + barvu" "$P_L" "Neznámá řeč"
check_has "barva jazyka zachována" "$P_L" "#3b82f6"
LEN=$(echo "$P_L" | python3 -c "
import sys,json
d=json.load(sys.stdin)
m=[x for x in d if x.get('lang')][-1]
orig='Elen sila lumenn omentielvo'
assert len(m['text'])==len(orig) and m['text']!=orig, m['text']
print('šifra má správnou délku:', m['text'])")
echo "✅ OK: $LEN"

echo "== psát lze jen jazykem, který postava OVLÁDÁ =="
X=$(req p11.jar POST /api/chat/rooms/$RID/messages "{\"text\":\"pokus o elfštinu\",\"langId\":$ELF}")
check_has "Toruk (neumí elfsky) elfsky psát nemůže" "$X" "neovládá"
D_OK=$(req d11.jar POST /api/chat/rooms/$RID/messages "{\"text\":\"DM píše elfsky.\",\"langId\":$ELF}")
check_has "DM může psát jakýmkoli jazykem" "$D_OK" '"id"'
req p11.jar GET /api/chat/rooms/$RID/messages > /dev/null # přečteno před testem unread

echo "== unread + přečtení =="
U=$(req p11.jar GET /api/campaigns/$CID/chat/rooms)
UN=$(jv "$U" "d[0]['unread']")
[ "$UN" = "0" ] && echo "✅ OK: po přečtení unread=0" || { echo "❌ FAIL: unread=$UN"; exit 1; }
req d11.jar POST /api/chat/rooms/$RID/messages '{"text":"Nová zpráva pro všechny."}' > /dev/null
U2=$(req p11.jar GET /api/campaigns/$CID/chat/rooms)
UN2=$(jv "$U2" "d[0]['unread']")
[ "$UN2" = "1" ] && echo "✅ OK: nová zpráva → unread=1" || { echo "❌ FAIL: unread=$UN2"; exit 1; }

echo "== SSE push =="
timeout 3 curl -s -N -b p11.jar "$B/api/campaigns/$CID/chat/events" > /tmp/sse11.log 2>&1 &
SSEPID=$!
sleep 0.5
req d11.jar POST /api/chat/rooms/$RID/messages '{"text":"Ping přes SSE."}' > /dev/null
wait $SSEPID 2>/dev/null || true
check_has "SSE doručilo událost s roomId" "$(cat /tmp/sse11.log)" "\"roomId\":$RID"

echo "== emulace: DM píše ZA postavu =="
req d11.jar POST "/api/chat/rooms/$RID/messages?viewAs=$KUID&viewChar=$KUBIRIK" '{"text":"Píšu jako Kubirik rukou DM."}' > /dev/null
P_E=$(req p11.jar GET /api/chat/rooms/$RID/messages)
check_has "zpráva je od postavy Kubirik" "$P_E" '"author":"Kubirik"'

echo "== mazání jen DM =="
MID=$(req d11.jar GET /api/chat/rooms/$RID/messages | python3 -c "import sys,json;print(json.load(sys.stdin)[-1]['id'])")
X=$(req k11.jar DELETE /api/chat/messages/$MID)
check_has "hráč mazat nesmí" "$X" error
req d11.jar DELETE /api/chat/messages/$MID > /dev/null
echo "✅ OK: DM smazal zprávu"

echo; echo "🎉 Všechny testy chatu prošly."

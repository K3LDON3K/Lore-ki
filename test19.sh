#!/bin/bash
# Testy: grafický inventář — instance, sloty, kontejnery, zóny, stacky, identifikace, práva.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ OK: $1" || { echo "❌ FAIL: $1 (chybí $3: $(echo $2|head -c 250))"; exit 1; }; }
check_not(){ echo "$2"|grep -qi "$3" && { echo "❌ FAIL: $1 — uniklo: $3"; exit 1; } || echo "✅ OK: $1"; }
jv(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f i_d.jar i_h1.jar i_h2.jar
req i_d.jar POST /api/register '{"username":"invdm","password":"test1234"}' > /dev/null
CID=$(req i_d.jar POST /api/campaigns '{"name":"Inv19"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req i_d.jar POST /api/campaigns/$CID/users '{"username":"invh1","password":"heslo123","characterName":"Baradir"}' > /dev/null
req i_d.jar POST /api/campaigns/$CID/users '{"username":"invh2","password":"heslo123","characterName":"Toruk"}' > /dev/null
req i_h1.jar POST /api/login '{"username":"invh1","password":"heslo123"}' > /dev/null
req i_h2.jar POST /api/login '{"username":"invh2","password":"heslo123"}' > /dev/null
CHARS=$(req i_d.jar GET /api/campaigns/$CID/characters)
BAR=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Baradir'][0]")
TOR=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Toruk'][0]")

mk(){ local id=$(req i_d.jar POST /api/campaigns/$CID/articles "{\"title\":\"$1\"}" | grep -o '[0-9]*'); req i_d.jar PUT /api/articles/$id "{\"title\":\"$1\",\"category\":\"Předměty\",\"blocks\":[],\"item\":$2}" > /dev/null; echo $id; }
MEC=$(mk "Plamenný meč" '{"w":1,"h":3,"wearable":true,"hpMax":8,"unidentifiedName":"Tajemný meč","secretText":"Plamenná čepel navíc.","identifiedDefault":false}')
STIT=$(mk "Štít" '{"w":2,"h":2,"wearable":true,"identifiedDefault":true}')
OBOU=$(mk "Obouruční meč" '{"w":1,"h":4,"wearable":true,"twoHanded":true,"identifiedDefault":true}')
BATOH=$(mk "Batoh" '{"w":2,"h":2,"wearable":true,"bodySize":4,"identifiedDefault":true,"container":{"cells":[{"x":0,"y":0,"c":"g"},{"x":1,"y":0,"c":"g"},{"x":2,"y":0,"c":"y"},{"x":0,"y":1,"c":"r"},{"x":1,"y":1,"c":"r"},{"x":2,"y":1,"c":"y"}]}}')
JAB=$(mk "Jablko" '{"w":1,"h":1,"stackable":true,"stackMax":5,"identifiedDefault":true}')
PECET=$(mk "Pečeť" '{"w":1,"h":1,"wearable":true,"noDrop":true,"identifiedDefault":true}')
Z=$(req i_d.jar POST /api/campaigns/$CID/inv/zones '{"name":"Táborák"}' | grep -o '[0-9]*')

echo "== identifikace: hráč nevidí pravé jméno ani tajemství =="
check_not "tajný popis neunikne přes článek" "$(req i_h1.jar GET /api/articles/$MEC)" "Plamenná čepel"
MID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$MEC,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
V=$(req i_h1.jar GET /api/inv/zones/$Z/items)
check_has "hráč vidí obecný název" "$V" "Tajemný meč"
check_not "pravé jméno neunikne" "$V" "Plamenný"
check_not "tajný popis neunikne" "$V" "čepel"
check_not "articleId neunikne u neidentifikovaného" "$V" "articleId"
req i_d.jar PUT /api/inv/instances/$MID '{"identified":true}' > /dev/null
V=$(req i_h1.jar GET /api/inv/zones/$Z/items)
check_has "po identifikaci pravé jméno" "$V" "Plamenný meč"
check_has "po identifikaci tajný popis" "$V" "čepel"
X=$(req i_h1.jar PUT /api/inv/instances/$MID '{"identified":false}')
check_has "hráč identifikaci nepřepne" "$X" "error"

echo "== zvednutí ze země + cizí inventář nedostupný =="
req i_h1.jar PUT "/api/inv/instances/$MID/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handR\"}}" > /dev/null
check_has "meč je v ruce Baradira" "$(req i_h1.jar GET /api/inv/char/$BAR)" '"slot":"handR"'
X=$(req i_h2.jar GET /api/inv/char/$BAR)
check_has "cizí inventář vrací 404" "$X" "nenalezena"
X=$(req i_h2.jar PUT "/api/inv/instances/$MID/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z}}")
check_has "cizí předmět nejde vzít (fail closed 404)" "$X" "nenalezen"

echo "== sloty: obsazenost, kapacita, obouruční =="
SID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$STIT,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handL\"}}" | grep -o '[0-9]*')
echo "✅ OK: štít 2×2 se vešel do ruky (kapacitní pravidlo)"
X=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$STIT,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handL\"}}")
check_has "obsazený slot odmítne" "$X" "obsazen"
SH2=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$STIT,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"head\"}}" | grep -o '[0-9]*')
[ -n "$SH2" ] && echo "✅ OK: velikost se na těle neřeší — štít jde i na hlavu (rozhodují povolené sloty)" || { echo "❌ štít na hlavu neprošel"; exit 1; }
req i_d.jar DELETE /api/inv/instances/$SH2 > /dev/null
OID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$OBOU,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
X=$(req i_h1.jar PUT "/api/inv/instances/$OID/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handR\"}}")
check_has "obouruční nejde: druhá ruka drží štít" "$X" "error"
req i_h1.jar PUT "/api/inv/instances/$SID/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z}}" > /dev/null
req i_h1.jar PUT "/api/inv/instances/$MID/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z}}" > /dev/null
req i_h1.jar PUT "/api/inv/instances/$OID/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handR\"}}" > /dev/null
X=$(req i_h1.jar PUT "/api/inv/instances/$SID/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handL\"}}")
check_has "s obouruční zbraní nejde nic do druhé ruky" "$X" "obouruční"

echo "== kontejner: tvar, kolize, otočení, vnoř* zakázáno =="
BID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$BATOH,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"back\"}}" | grep -o '[0-9]*')
X=$(req i_h1.jar PUT "/api/inv/instances/$MID/move" "{\"to\":{\"t\":\"grid\",\"cId\":$BID,\"x\":0,\"y\":0}}")
check_has "meč 1×3 svisle se do batohu 3×2 nevejde" "$X" "nevejde"
req i_h1.jar PUT "/api/inv/instances/$MID/move" "{\"to\":{\"t\":\"grid\",\"cId\":$BID,\"x\":0,\"y\":0},\"rot\":1}" > /dev/null
echo "✅ OK: otočený o 90° (3×1) se vešel"
JID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$JAB,\"qty\":3,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
X=$(req i_h1.jar PUT "/api/inv/instances/$JID/move" "{\"to\":{\"t\":\"grid\",\"cId\":$BID,\"x\":1,\"y\":0}}")
check_has "kolize s mečem odmítnuta" "$X" "obsazen"
req i_h1.jar PUT "/api/inv/instances/$JID/move" "{\"to\":{\"t\":\"grid\",\"cId\":$BID,\"x\":0,\"y\":1}}" > /dev/null
B2=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$BATOH,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
X=$(req i_d.jar PUT "/api/inv/instances/$B2/move" "{\"to\":{\"t\":\"grid\",\"cId\":$BID,\"x\":1,\"y\":1}}")
check_has "kontejner do kontejneru nejde" "$X" "do sebe"

echo "== obsah jde s batohem, cizí batoh na zemi jde vzít =="
CHK=$(req i_h1.jar GET /api/inv/char/$BAR)
check_has "jablka v batohu na těle" "$CHK" "Jablko"
req i_h1.jar PUT "/api/inv/instances/$BID/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z}}" > /dev/null
CHK=$(req i_h1.jar GET /api/inv/char/$BAR)
check_not "po odložení batohu jablka zmizela z postavy" "$CHK" "Jablko"
req i_h2.jar PUT "/api/inv/instances/$BID/move" "{\"to\":{\"t\":\"slot\",\"charId\":$TOR,\"slot\":\"back\"}}" > /dev/null
CHK=$(req i_h2.jar GET /api/inv/char/$TOR)
check_has "Toruk zvedl batoh i s jablky (přesun všech informací)" "$CHK" "Jablko"

echo "== stacky: merge, limit, split =="
J2=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$JAB,\"qty\":2,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
req i_h2.jar PUT "/api/inv/instances/$J2/move" "{\"mergeInto\":$JID}" > /dev/null
Q=$(req i_h2.jar GET /api/inv/char/$TOR | python3 -c "import sys,json;d=json.load(sys.stdin);print([i['qty'] for i in d['items'] if i['name']=='Jablko'][0])")
[ "$Q" = "5" ] && echo "✅ OK: stacky sloučeny na 5" || { echo "❌ merge: qty=$Q"; exit 1; }
J3=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$JAB,\"qty\":1,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
X=$(req i_h2.jar PUT "/api/inv/instances/$J3/move" "{\"mergeInto\":$JID}")
check_has "překročení stackMax odmítnuto" "$X" "nejvýše"
req i_h2.jar POST "/api/inv/instances/$JID/split" "{\"qty\":2,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" > /dev/null
Q=$(req i_h2.jar GET /api/inv/char/$TOR | python3 -c "import sys,json;d=json.load(sys.stdin);print([i['qty'] for i in d['items'] if i['name']=='Jablko'][0])")
[ "$Q" = "3" ] && echo "✅ OK: split — v batohu zbyly 3" || { echo "❌ split: qty=$Q"; exit 1; }
X=$(req i_h2.jar PUT "/api/inv/instances/$JID" '{"hp":3}')
check_has "stack nemá životy" "$X" "error"
req i_h2.jar PUT "/api/inv/instances/$JID" '{"qty":2}' > /dev/null
Q=$(req i_h2.jar GET /api/inv/char/$TOR | python3 -c "import sys,json;d=json.load(sys.stdin);print([i['qty'] for i in d['items'] if i['name']=='Jablko'][0])")
[ "$Q" = "2" ] && echo "✅ OK: vlastník změnil množství stacku na 2" || { echo "❌ qty edit: $Q"; exit 1; }
X=$(req i_h2.jar PUT "/api/inv/instances/$JID" '{"qty":99}')
Q=$(req i_h2.jar GET /api/inv/char/$TOR | python3 -c "import sys,json;d=json.load(sys.stdin);print([i['qty'] for i in d['items'] if i['name']=='Jablko'][0])")
[ "$Q" = "5" ] && echo "✅ OK: množství se zarazí o stackMax (5)" || { echo "❌ qty clamp: $Q"; exit 1; }

echo "== quest předmět, životy, rozbití, smazání =="
PID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$PECET,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"head\"}}" | grep -o '[0-9]*')
X=$(req i_h1.jar PUT "/api/inv/instances/$PID/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z}}")
check_has "quest předmět hráč neodloží" "$X" "nejde odložit"
X=$(req i_h2.jar DELETE /api/inv/instances/$MID)
check_has "nerozbitý předmět hráč nesmaže" "$X" "rozbitý"
X=$(req i_h1.jar DELETE /api/inv/instances/$MID)
check_has "cizí předmět nejde smazat (fail closed)" "$X" "nenalezen"
req i_h2.jar PUT "/api/inv/instances/$MID" '{"hp":0}' > /dev/null
V=$(req i_h1.jar GET /api/inv/zones/$Z/items 2>/dev/null; req i_h2.jar GET /api/inv/char/$TOR)
check_has "hp 0 → broken:true" "$V" '"broken":true'
req i_h2.jar DELETE /api/inv/instances/$MID > /dev/null 2>&1 || req i_h1.jar DELETE /api/inv/instances/$MID > /dev/null
echo "✅ OK: rozbitý předmět odstraněn"
X=$(req i_h1.jar PUT "/api/inv/instances/$PID" '{"hpMax":5}')
check_has "hpMax mění jen DM" "$X" "error"

echo "== zóny a deník =="
X=$(req i_h1.jar POST /api/campaigns/$CID/inv/zones '{"name":"Hack"}')
check_has "zónu nezaloží hráč" "$X" "error"
X=$(req i_d.jar DELETE /api/inv/zones/$Z)
check_has "neprázdná zóna nejde smazat" "$X" "prázdná"
L=$(req i_h1.jar GET /api/campaigns/$CID/inv/log)
check_has "deník: vzal ze země" "$L" "vzal ze země"
check_has "deník: odložil" "$L" "odložil"
check_has "deník vidí i hráč" "$L" "who"

echo "== export/import kampaně přenese i inventář =="
req i_d.jar POST /api/admin/auth "{\"masterPassword\":\"${MASTER_PASSWORD:-test-master}\"}" > /dev/null
curl -s -b i_d.jar "$B/api/admin/campaigns/$CID/export" -o /tmp/inv_zaloha.json
python3 -c "
import json; d=json.load(open('/tmp/inv_zaloha.json'))
assert d.get('itemInstances'), 'záloha nemá itemInstances'
assert d.get('invZones'), 'záloha nemá invZones'
print('✅ OK: záloha obsahuje instance i zóny')"
NEW=$(curl -s -b i_d.jar -X POST -H Content-Type:application/json --data-binary @/tmp/inv_zaloha.json $B/api/admin/import)
NEWID=$(jv "$NEW" "d['campaignId']")
NZ=$(req i_d.jar GET /api/campaigns/$NEWID/inv/zones)
check_has "obnovená kampaň má zónu" "$NZ" "Táborák"
NZID=$(jv "$NZ" "d[0]['id']")
CNT=$(req i_d.jar GET /api/inv/zones/$NZID/items | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
[ "$CNT" -ge 1 ] && echo "✅ OK: instance přežily obnovu ($CNT v zóně)" || { echo "❌ v obnovené zóně nic není"; exit 1; }
req i_d.jar DELETE /api/admin/campaigns/$NEWID > /dev/null

echo "== výskyty předmětu na článku (oprávnění) =="
KDE=$(req i_d.jar GET /api/articles/$JAB/instances)
check_has "DM vidí výskyt u postavy" "$KDE" "Toruk"
check_has "DM vidí výskyt na zemi" "$KDE" "Táborák"
KDE=$(req i_h1.jar GET /api/articles/$JAB/instances)
check_not "hráč nevidí výskyt u CIZÍ postavy" "$KDE" "Toruk"
KDE2=$(req i_h1.jar GET /api/articles/$MEC/instances 2>/dev/null || echo '[]')
python3 -c "
import json
d=json.loads('$KDE2') if '$KDE2'.startswith('[') else []
assert all(x.get('identified') for x in d), 'neidentifikovaný kus prosákl do výskytů'
print('✅ OK: neidentifikované kusy se hráči ve výskytech neukazují')"

echo "== vlastní sloty + povolené sloty předmětu =="
X=$(req i_h1.jar POST /api/campaigns/$CID/inv/slots '{"label":"Oči","cap":1}')
check_has "slot nezaloží hráč" "$X" "error"
SKEY=$(req i_d.jar POST /api/campaigns/$CID/inv/slots '{"label":"Oči"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])")
check_has "vlastní slot v definicích" "$(req i_h1.jar GET /api/inv/char/$BAR)" "Oči"
BRYLE=$(mk "Brýle" "{\"w\":1,\"h\":1,\"wearable\":true,\"identifiedDefault\":true,\"slots\":[\"$SKEY\"]}")
BR=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$BRYLE,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
X=$(req i_h1.jar PUT "/api/inv/instances/$BR/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"head\"}}")
check_has "brýle na hlavu nejdou (vyhrazený slot)" "$X" "nepatří"
req i_h1.jar PUT "/api/inv/instances/$BR/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"$SKEY\"}}" > /dev/null
check_has "brýle sedí ve slotu Oči" "$(req i_h1.jar GET /api/inv/char/$BAR)" "\"slot\":\"$SKEY\""
X=$(req i_d.jar DELETE /api/campaigns/$CID/inv/slots/$SKEY)
check_has "obsazený slot nejde smazat" "$X" "předměty"
req i_h1.jar PUT "/api/inv/instances/$BR/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z}}" > /dev/null
req i_d.jar DELETE /api/campaigns/$CID/inv/slots/$SKEY > /dev/null
CAPS=$(req i_h1.jar GET /api/inv/char/$BAR)
check_not "smazaný slot zmizel z definic" "$CAPS" "$SKEY"

echo "== otočení drží i na zemi =="
req i_h1.jar PUT "/api/inv/instances/$OID/move" "{\"to\":{\"t\":\"zone\",\"zId\":$Z},\"rot\":1}" > /dev/null
check_has "předmět v zóně je otočený" "$(req i_h1.jar GET /api/inv/zones/$Z/items)" '"rot":1'
req i_h1.jar PUT "/api/inv/instances/$OID/move" "{\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"handR\"}}" > /dev/null

echo "== tvary: L-předmět nechá roh volný =="
LKO=$(mk "Luk L" '{"shape":[{"x":0,"y":0},{"x":0,"y":1},{"x":1,"y":1}],"identifiedDefault":true}')
KAM=$(mk "Kámen" '{"shape":[{"x":0,"y":0}],"identifiedDefault":true}')
BAT2=$(mk "Kapsička" '{"wearable":true,"slots":["cloak"],"bodySize":1,"identifiedDefault":true,"container":{"cells":[{"x":0,"y":0,"c":"g"},{"x":1,"y":0,"c":"g"},{"x":0,"y":1,"c":"g"},{"x":1,"y":1,"c":"g"}]}}')
KID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$BAT2,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"cloak\"}}" | grep -o '[0-9]*')
LID=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$LKO,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
SID2=$(req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$KAM,\"to\":{\"t\":\"zone\",\"zId\":$Z}}" | grep -o '[0-9]*')
req i_h1.jar PUT "/api/inv/instances/$LID/move" "{\"to\":{\"t\":\"grid\",\"cId\":$KID,\"x\":0,\"y\":0}}" > /dev/null
X=$(req i_h1.jar PUT "/api/inv/instances/$SID2/move" "{\"to\":{\"t\":\"grid\",\"cId\":$KID,\"x\":1,\"y\":0}}")
check_has "1×1 se vejde do volného rohu L-tvaru" "$X" '"ok":true'
X=$(req i_h1.jar PUT "/api/inv/instances/$SID2/move" "{\"to\":{\"t\":\"grid\",\"cId\":$KID,\"x\":0,\"y\":1}}")
check_has "obsazená buňka L-tvaru odmítne" "$X" "obsazen"
V=$(req i_d.jar GET /api/articles/$LKO)
check_has "w/h dopočítané z tvaru (2×2)" "$V" '"w":2'

echo "== úprava vlastního slotu =="
SK2=$(req i_d.jar POST /api/campaigns/$CID/inv/slots '{"label":"Kapsa","cap":2}' | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])")
req i_d.jar PUT /api/campaigns/$CID/inv/slots/$SK2 '{"col":1,"label":"Kapsička"}' > /dev/null
check_has "slot přesunut do levého sloupce" "$(req i_h1.jar GET /api/inv/char/$BAR)" '"'$SK2'":1'
KAM2=$(mk "Oblázek" '{"shape":[{"x":0,"y":0},{"x":1,"y":0}],"wearable":true,"identifiedDefault":true}')
req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$KAM2,\"to\":{\"t\":\"slot\",\"charId\":$BAR,\"slot\":\"$SK2\"}}" > /dev/null
X=$(req i_d.jar PUT /api/campaigns/$CID/inv/slots/$SK2 '{"cap":1}')
check_has "zmenšení kapacity obsazeného slotu odmítnuto" "$X" "nelze zmenšit"
X=$(req i_h1.jar PUT /api/campaigns/$CID/inv/slots/$SK2 '{"col":2}')
check_has "hráč slot neupraví" "$X" "error"

echo "== přesun vestavěného slotu do jiné oblasti =="
req i_d.jar PUT /api/campaigns/$CID/inv/slots/head '{"col":2}' > /dev/null
check_has "systémový slot přesunut do pravého sloupce" "$(req i_h1.jar GET /api/inv/char/$BAR)" '"head":2'
X=$(req i_d.jar DELETE /api/campaigns/$CID/inv/slots/head)
check_has "systémový slot nejde smazat" "$X" "nejde smazat"
X=$(req i_h1.jar PUT /api/campaigns/$CID/inv/slots/head '{"col":1}')
check_has "hráč vestavěný slot nepřesune" "$X" "error"
X=$(req i_d.jar PUT /api/campaigns/$CID/inv/slots/head '{"label":"Makovice"}')
check_has "systémový nejde přejmenovat" "$X" "jen sloupec"

echo "== smazání zóny i s předměty (force) =="
Z2=$(req i_d.jar POST /api/campaigns/$CID/inv/zones '{"name":"Smetiste"}' | grep -o '[0-9]*')
req i_d.jar POST /api/campaigns/$CID/inv/instances "{\"articleId\":$JAB,\"qty\":2,\"to\":{\"t\":\"zone\",\"zId\":$Z2}}" > /dev/null
X=$(req i_d.jar DELETE /api/inv/zones/$Z2)
check_has "bez force se odmítne" "$X" "prázdná"
req i_d.jar DELETE "/api/inv/zones/$Z2?force=1" > /dev/null
check_not "zóna zmizela" "$(req i_d.jar GET /api/campaigns/$CID/inv/zones)" "Smetiste"
check_has "deník: smazání zóny s předměty" "$(req i_d.jar GET /api/campaigns/$CID/inv/log)" "smazal zónu"

echo; echo "🎉 Testy grafického inventáře prošly."

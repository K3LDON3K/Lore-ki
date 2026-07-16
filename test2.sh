#!/bin/bash
# Testy nových funkcí: účty, hesla, poznámky se schvalováním, reference, náhledy, sanitizace.
set -e
B=http://localhost:3000

req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }

check_not() { local desc=$1 out=$2; shift 2
  for s in "$@"; do if echo "$out" | grep -qi "$s"; then echo "❌ FAIL: $desc — uniklo: $s"; exit 1; fi; done
  echo "✅ OK: $desc"; }
check_has() { local desc=$1 out=$2 s=$3
  if echo "$out" | grep -q "$s"; then echo "✅ OK: $desc"; else echo "❌ FAIL: $desc — chybí: $s (výstup: $(echo $out | head -c 200))"; exit 1; fi; }

cd /tmp && rm -f t_dm.jar t_kubik.jar t_pauli.jar

echo "== příprava =="
req t_dm.jar POST /api/register '{"username":"dm2","password":"test1234"}' > /dev/null
CID=$(req t_dm.jar POST /api/campaigns '{"name":"Test2"}' | grep -o '"id":[0-9]*' | cut -d: -f2)

echo "== DM vytvoří účet hráče ručně =="
K=$(req t_dm.jar POST /api/campaigns/$CID/users '{"username":"kubik2","password":"heslo123","characterName":"Kubík"}')
check_has "účet vytvořen" "$K" '"id"'
KID=$(echo "$K" | grep -o '"id":[0-9]*' | cut -d: -f2)
P=$(req t_dm.jar POST /api/campaigns/$CID/users '{"username":"pauli2","password":"heslo123","characterName":"Paulí"}')
PID=$(echo "$P" | grep -o '"id":[0-9]*' | cut -d: -f2)
L=$(req t_kubik.jar POST /api/login '{"username":"kubik2","password":"heslo123"}')
check_has "hráč se přihlásí předaným heslem" "$L" kubik2
req t_pauli.jar POST /api/login '{"username":"pauli2","password":"heslo123"}' > /dev/null

echo "== DM změní heslo =="
req t_dm.jar PUT /api/campaigns/$CID/players/$KID/password '{"password":"nove456"}' > /dev/null
L2=$(curl -s -H Content-Type:application/json -d '{"username":"kubik2","password":"nove456"}' $B/api/login)
check_has "nové heslo funguje" "$L2" kubik2
L3=$(curl -s -H Content-Type:application/json -d '{"username":"kubik2","password":"heslo123"}' $B/api/login)
check_has "staré heslo už ne" "$L3" error
X=$(req t_kubik.jar PUT /api/campaigns/$CID/players/$PID/password '{"password":"hack"}')
check_has "hráč heslo měnit nesmí" "$X" error

echo "== články: tajný, veřejný, reference =="
SECRET=$(req t_dm.jar POST /api/campaigns/$CID/articles '{"title":"Tajný chrám"}' | grep -o '[0-9]*')
req t_dm.jar PUT /api/articles/$SECRET '{"title":"Tajný chrám","blocks":[{"type":"paragraph","visibility":"dm","content":{"text":"Skrytý obsah chrámu."}}]}' > /dev/null
PUB=$(req t_dm.jar POST /api/campaigns/$CID/articles '{"title":"Náměstí"}' | grep -o '[0-9]*')
req t_dm.jar PUT /api/articles/$PUB "{\"title\":\"Náměstí\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Ze severu vede cesta ke stavbě [[$SECRET|starobylá svatyně]] u lesa.\",\"html\":\"Ze severu vede cesta ke stavbě [[$SECRET|starobylá svatyně]] u lesa. <b>Tučný</b> <font color=\\\"#ff0000\\\">červený</font> <script>alert(1)</script><img src=x onerror=alert(2)>\"}}
]}" > /dev/null

DM_ART=$(req t_dm.jar GET /api/articles/$PUB)
check_has "DM: reference zachována s id" "$DM_ART" "\[\[$SECRET|starobylá svatyně\]\]"
K_ART=$(req t_kubik.jar GET /api/articles/$PUB)
check_not "hráč: skrytá reference bez id a odkazu" "$K_ART" "\[\["
check_has "hráč: popisek reference zůstal jako text" "$K_ART" "starobylá svatyně"
check_not "sanitizace: script/img odstraněny" "$K_ART" "<script" "onerror" "<img"
check_has "sanitizace: povolené formátování zůstalo" "$K_ART" "<b>Tučný</b>"

echo "== odemčení cíle reference =="
req t_dm.jar PUT /api/articles/$SECRET '{"title":"Tajný chrám","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Skrytý obsah chrámu."}}]}' > /dev/null
K_ART2=$(req t_kubik.jar GET /api/articles/$PUB)
check_has "po odemčení hráč referenci vidí jako odkaz" "$K_ART2" "\[\[$SECRET|starobylá svatyně\]\]"

echo "== náhledy v seznamu (thumb podle oprávnění) =="
# obrázek nahraje DM
printf 'fakepngdata' > /tmp/t.png
IMG=$(curl -s -b t_dm.jar -F "file=@/tmp/t.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '[0-9]*')
req t_dm.jar PUT /api/articles/$PUB "{\"title\":\"Náměstí\",\"blocks\":[
  {\"type\":\"image\",\"visibility\":\"dm\",\"content\":{\"imageId\":$IMG,\"width\":50,\"preview\":true}},
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"text\":\"Popis náměstí.\"}}
]}" > /dev/null
# bez zaškrtnutí "zobrazit v náhledu" se obrázek v seznamu NESMÍ objevit (vlastní obrázek, aby neovlivnil další testy)
IMGNP=$(curl -s -b t_dm.jar -F "file=@/tmp/t.png;type=image/png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
NOPREV=$(req t_dm.jar POST /api/campaigns/$CID/articles '{"title":"BezNahledu"}' | grep -o '[0-9]*')
req t_dm.jar PUT /api/articles/$NOPREV "{\"title\":\"BezNahledu\",\"blocks\":[
  {\"type\":\"image\",\"visibility\":\"all\",\"content\":{\"imageId\":$IMGNP}}]}" > /dev/null
NP=$(req t_dm.jar GET /api/campaigns/$CID/articles)
echo "$NP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=[x for x in d if x['title']=='BezNahledu'][0]
assert a['thumb_id'] is None and a['thumbs']==[], a
print('✅ OK: nezaškrtnutý obrázek se v náhledu neukáže')"
DM_LIST=$(req t_dm.jar GET /api/campaigns/$CID/articles)
check_has "DM v seznamu náhled vidí" "$DM_LIST" "\"thumb_id\":$IMG"
K_LIST=$(req t_kubik.jar GET /api/campaigns/$CID/articles)
check_not "hráč náhled DM-only obrázku nevidí" "$K_LIST" "\"thumb_id\":$IMG"
KIMG=$(curl -s -o /dev/null -w "%{http_code}" -b t_kubik.jar $B/api/images/$IMG)
[ "$KIMG" = "404" ] && echo "✅ OK: hráč obrázek nestáhne ($KIMG)" || { echo "❌ FAIL: obrázek dostupný ($KIMG)"; exit 1; }

echo "== poznámky se schvalováním =="
# viditelnost poznámek se cílí na POSTAVY
CHARS=$(req t_dm.jar GET /api/campaigns/$CID/characters)
PCHAR=$(echo "$CHARS" | python3 -c "import sys,json; d=json.load(sys.stdin); print([c['id'] for c in d if c['name']=='Paulí'][0])")
N=$(req t_kubik.jar POST /api/articles/$PUB/notes "{\"text\":\"Viděl jsem tu podezřelého kupce.\",\"visibleTo\":[$PCHAR]}")
NID=$(echo "$N" | grep -o '"id":[0-9]*' | cut -d: -f2)
check_has "poznámka vytvořena neschválená" "$N" '"approved":false'
K_N=$(req t_kubik.jar GET /api/articles/$PUB/notes)
check_has "autor svou poznámku vidí (pending)" "$K_N" "podezřelého kupce"
P_N=$(req t_pauli.jar GET /api/articles/$PUB/notes)
check_not "adresát NEVIDÍ neschválenou poznámku" "$P_N" "podezřelého kupce"
DM_N=$(req t_dm.jar GET /api/articles/$PUB/notes)
check_has "DM vidí neschválenou poznámku" "$DM_N" "podezřelého kupce"
req t_dm.jar POST /api/notes/$NID/approve > /dev/null
P_N2=$(req t_pauli.jar GET /api/articles/$PUB/notes)
check_has "po schválení adresát poznámku vidí" "$P_N2" "podezřelého kupce"
DM_VA=$(req t_dm.jar GET "/api/articles/$PUB/notes?viewAs=$PID")
check_has "view-as: DM vidí poznámky jako Paulí" "$DM_VA" "podezřelého kupce"
# nezaškrtnutý hráč (nový) poznámku nevidí
S=$(req t_dm.jar POST /api/campaigns/$CID/users '{"username":"slavex2","password":"heslo123","characterName":"Slavex"}')
SID=$(echo "$S" | grep -o '"id":[0-9]*' | cut -d: -f2)
rm -f t_slavex.jar; req t_slavex.jar POST /api/login '{"username":"slavex2","password":"heslo123"}' > /dev/null
S_N=$(req t_slavex.jar GET /api/articles/$PUB/notes)
check_not "nezaškrtnutý hráč poznámku nevidí ani po schválení" "$S_N" "podezřelého kupce"

echo; echo "🎉 Všechny testy nových funkcí prošly."

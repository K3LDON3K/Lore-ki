#!/bin/bash
# Testy: pořadí navigace (navOrder) — ukládá jen DM, platí pro hráče, odolá nesmyslům.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_has() { echo "$2" | grep -q "$3" && echo "✅ OK: $1" || { echo "❌ FAIL: $1 (chybí $3: $(echo $2|head -c 200))"; exit 1; }; }
jv() { python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f d17.jar h17.jar
req d17.jar POST /api/register '{"username":"dm17","password":"test1234"}' > /dev/null
CID=$(req d17.jar POST /api/campaigns '{"name":"Nav17"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d17.jar POST /api/campaigns/$CID/users '{"username":"hrac17","password":"heslo123","characterName":"Baradir"}' > /dev/null
req h17.jar POST /api/login '{"username":"hrac17","password":"heslo123"}' > /dev/null

echo "== výchozí pořadí je kompletní =="
req d17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
exp=['campaigns','home','articles','sessions','inventory','settings']
assert c['navOrder']==exp, c['navOrder']
print('✅ OK: výchozí navOrder =', c['navOrder'])"

echo "== hráč pořadí měnit nesmí =="
X=$(req h17.jar PUT /api/campaigns/$CID/settings '{"navOrder":["settings","articles"]}')
check_has "hráč dostane chybu" "$X" error

echo "== DM uloží nové pořadí =="
req d17.jar PUT /api/campaigns/$CID/settings '{"navOrder":["sessions","articles","home","campaigns","inventory","settings"]}' > /dev/null
req d17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
exp=['sessions','articles','home','campaigns','inventory','settings']
assert c['navOrder']==exp, c['navOrder']
print('✅ OK: uloženo =', c['navOrder'])"

echo "== pořadí vidí i hráč =="
req h17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
assert c['navOrder'][0]=='sessions', c['navOrder']
print('✅ OK: hráč dostal stejné pořadí =', c['navOrder'])"

echo "== neúplné pořadí se doplní (položka nikdy nezmizí) =="
req d17.jar PUT /api/campaigns/$CID/settings '{"navOrder":["settings"]}' > /dev/null
req d17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
o=c['navOrder']
assert o[0]=='settings', o
assert sorted(o)==sorted(['campaigns','home','articles','sessions','inventory','settings']), o
print('✅ OK: doplněno na plný seznam =', o)"

echo "== nesmysly se zahodí =="
req d17.jar PUT /api/campaigns/$CID/settings '{"navOrder":["hack","<script>","articles","articles"]}' > /dev/null
req d17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
o=c['navOrder']
assert 'hack' not in o and '<script>' not in o, o
assert len(o)==len(set(o))==6, o
assert o[0]=='articles', o
print('✅ OK: neznámé klíče pryč, bez duplicit =', o)"
X=$(req d17.jar PUT /api/campaigns/$CID/settings '{"navOrder":"neco"}')
check_has "navOrder musí být pole" "$X" error

echo "== staré klíče (players/categories) se zahodí — jsou to záložky nastavení =="
req d17.jar PUT /api/campaigns/$CID/settings '{"navOrder":["players","categories","home","campaigns","articles","sessions","settings"]}' > /dev/null
req d17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
o=c['navOrder']
assert 'players' not in o and 'categories' not in o, o
assert sorted(o)==sorted(['campaigns','home','articles','sessions','inventory','settings']), o
print('✅ OK: players/categories z pořadí pryč =', o)"

echo "== uložení pořadí nesmí přepsat název/popis =="
req d17.jar PUT /api/campaigns/$CID/settings '{"name":"Nav17","description":"Popisek"}' > /dev/null
req d17.jar PUT /api/campaigns/$CID/settings '{"navOrder":["home","campaigns","articles","sessions","inventory","settings"]}' > /dev/null
req d17.jar GET /api/campaigns | python3 -c "
import sys,json; d=json.load(sys.stdin); c=[x for x in d if x['name']=='Nav17'][0]
assert c['description']=='Popisek', c
assert c['navOrder'][0]=='home', c['navOrder']
print('✅ OK: název i popis zůstaly, pořadí se změnilo')"

echo; echo "🎉 Testy pořadí navigace prošly."

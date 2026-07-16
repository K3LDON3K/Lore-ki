#!/bin/bash
# Testy: řazení vyhledávání (název před textem) a čistota úryvků.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }

cd /tmp && rm -f d18.jar h18.jar
req d18.jar POST /api/register '{"username":"dm18","password":"test1234"}' > /dev/null
CID=$(req d18.jar POST /api/campaigns '{"name":"Hledani18"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d18.jar POST /api/campaigns/$CID/users '{"username":"hrac18","password":"heslo123","characterName":"Baradir"}' > /dev/null
req h18.jar POST /api/login '{"username":"hrac18","password":"heslo123"}' > /dev/null

mk() { # název kategorie popis html [visibility]
  local id=$(req d18.jar POST /api/campaigns/$CID/articles "{\"title\":\"$1\"}" | grep -o '[0-9]*')
  req d18.jar PUT /api/articles/$id "{\"title\":\"$1\",\"category\":\"$2\",\"description\":\"$3\",\"blocks\":[{\"type\":\"paragraph\",\"visibility\":\"${5:-all}\",\"content\":{\"html\":\"$4\"}}]}" > /dev/null
  echo $id
}
mk "Luriel" "NPC" "" "Luriel jako malá holka" > /dev/null
mk "Lurielina věž" "Města" "" "Text bez shody." > /dev/null
mk "Zápisky" "Historie" "O Luriel a jiných" "Nic tu není." > /dev/null
mk "Kubirik" "Hráčské postavy" "" "bratr&nbsp;a dle všeho Luriel je žena &amp; sestra &quot;x&quot;" > /dev/null
TAJ=$(mk "Tajemství" "Monstra" "" "Luriel je ve skutečnosti drak." "dm")

echo "== název má přednost před textem =="
req d18.jar GET "/api/campaigns/$CID/search?q=luriel" | python3 -c "
import sys,json
d=json.load(sys.stdin); t=[r['title'] for r in d]
assert t[0]=='Luriel', f'❌ přesná shoda názvu není první: {t}'
assert t[1]=='Lurielina věž', f'❌ název začínající dotazem není druhý: {t}'
assert t.index('Zápisky') < t.index('Kubirik'), f'❌ popis má být před shodou v textu: {t}'
print('✅ OK: pořadí =', t)"

echo "== článek se shodou v názvu I v textu má úryvek a je první =="
req d18.jar GET "/api/campaigns/$CID/search?q=luriel" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d[0]['title']=='Luriel' and d[0]['snippet'], '❌ první výsledek nemá úryvek'
print('✅ OK: shoda v názvu si nese úryvek z textu =', repr(d[0]['snippet'][:40]))"

echo "== úryvek neobsahuje HTML entity =="
req d18.jar GET "/api/campaigns/$CID/search?q=bratr" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=' '.join(r['snippet'] for r in d)
for e in ['&nbsp;','&amp;','&quot;','&#39;','&lt;','&gt;']:
    assert e not in s, f'❌ v úryvku zůstalo {e}: {s!r}'
assert '&' in s and '\"' in s, f'❌ entity se měly rozkódovat na znaky: {s!r}'
print('✅ OK: entity rozkódovány =', repr(s[:60]))"

echo "== úryvek nemá řady mezer =="
req d18.jar GET "/api/campaigns/$CID/search?q=luriel" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d:
    assert '  ' not in r['snippet'], f'❌ dvojité mezery v úryvku: {r[\"snippet\"]!r}'
print('✅ OK: úryvky bez zdvojených mezer')"

echo "== řazení neprozradí skrytý článek =="
req h18.jar GET "/api/campaigns/$CID/search?q=luriel" | python3 -c "
import sys,json
d=json.load(sys.stdin); t=[r['title'] for r in d]
assert 'Tajemství' not in t, f'❌ ÚNIK: skrytý článek ve výsledcích: {t}'
assert 'Luriel' in t, f'❌ veřejný článek chybí: {t}'
print('✅ OK: hráč vidí jen povolené =', t)"
req h18.jar GET "/api/campaigns/$CID/search?q=drak" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d==[], f'❌ ÚNIK: hledání textu ze skrytého bloku vrátilo {d}'
print('✅ OK: text ze skrytého bloku se nedá vyhledat')"

echo "== 'rank' se ven neposílá =="
req d18.jar GET "/api/campaigns/$CID/search?q=luriel" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert all('rank' not in r for r in d), '❌ rank prosakuje do odpovědi'
assert all(set(r)=={'articleId','title','category','snippet'} for r in d), f'❌ jiná pole: {d[0].keys()}'
print('✅ OK: odpověď má jen articleId, title, category, snippet')"

echo; echo "🎉 Testy řazení vyhledávání prošly."

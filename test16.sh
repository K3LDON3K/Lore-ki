#!/bin/bash
# Testy: obrázek vložený do textu s příznakem „zobrazit v náhledech“ (data-preview).
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }

cd /tmp && rm -f d16.jar h16.jar
req d16.jar POST /api/register '{"username":"dm16","password":"test1234"}' > /dev/null
CID=$(req d16.jar POST /api/campaigns '{"name":"Nahledy16"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d16.jar POST /api/campaigns/$CID/users '{"username":"hrac16","password":"heslo123","characterName":"Baradir"}' > /dev/null
req h16.jar POST /api/login '{"username":"hrac16","password":"heslo123"}' > /dev/null

printf '\x89PNG\r\n\x1a\n' > /tmp/i16a.png; printf '\x89PNG\r\n\x1a\nxx' > /tmp/i16b.png; printf '\x89PNG\r\n\x1a\nyy' > /tmp/i16c.png
IMG_PUB=$(curl -s -b d16.jar -F "file=@/tmp/i16a.png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
IMG_DM=$(curl -s -b d16.jar -F "file=@/tmp/i16b.png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)
IMG_OFF=$(curl -s -b d16.jar -F "file=@/tmp/i16c.png" $B/api/campaigns/$CID/images | grep -o '"id":[0-9]*' | cut -d: -f2)

ART=$(req d16.jar POST /api/campaigns/$CID/articles '{"title":"Obrazky v textu"}' | grep -o '[0-9]*')
req d16.jar PUT /api/articles/$ART "{\"title\":\"Obrazky v textu\",\"category\":\"Města\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"html\":\"A <img src=\\\"/api/images/$IMG_PUB\\\" style=\\\"width:50%\\\" data-preview=\\\"1\\\" onerror=\\\"alert(1)\\\"> B\"}},
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"html\":\"Bez priznaku <img src=\\\"/api/images/$IMG_OFF\\\"> konec\"}},
  {\"type\":\"paragraph\",\"visibility\":\"dm\",\"content\":{\"html\":\"Tajne <img src=\\\"/api/images/$IMG_DM\\\" data-preview=\\\"1\\\"> konec\"}}
]}" > /dev/null

echo "== sanitizer: příznak projde, XSS ne =="
req d16.jar GET /api/articles/$ART | python3 -c "
import sys,json; d=json.load(sys.stdin)
h=d['blocks'][0]['content']['html']
assert 'data-preview=\"1\"' in h, 'FAIL: data-preview se ztratil'
assert 'onerror' not in h and 'alert' not in h, 'FAIL: XSS prolezl'
print('✅ OK: data-preview zachován, onerror odstraněn')"
X=$(req d16.jar PUT /api/articles/$ART "{\"title\":\"Obrazky v textu\",\"category\":\"Města\",\"blocks\":[{\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"html\":\"<img src=\\\"/api/images/$IMG_PUB\\\" data-preview=\\\"haha\\\">\"}}]}")
req d16.jar GET /api/articles/$ART | python3 -c "
import sys,json; d=json.load(sys.stdin)
h=d['blocks'][0]['content']['html']
assert 'haha' not in h, 'FAIL: propašována cizí hodnota data-preview'
print('✅ OK: jiná hodnota než \"1\" se zahodí')"

# obnovíme plný obsah
req d16.jar PUT /api/articles/$ART "{\"title\":\"Obrazky v textu\",\"category\":\"Města\",\"blocks\":[
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"html\":\"A <img src=\\\"/api/images/$IMG_PUB\\\" data-preview=\\\"1\\\"> B\"}},
  {\"type\":\"paragraph\",\"visibility\":\"all\",\"content\":{\"html\":\"Bez priznaku <img src=\\\"/api/images/$IMG_OFF\\\"> konec\"}},
  {\"type\":\"paragraph\",\"visibility\":\"dm\",\"content\":{\"html\":\"Tajne <img src=\\\"/api/images/$IMG_DM\\\" data-preview=\\\"1\\\"> konec\"}}
]}" > /dev/null

echo "== náhled článku bere označený obrázek z textu =="
req d16.jar GET /api/articles/$ART/preview | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['thumbId']==$IMG_PUB, f'FAIL: thumbId={d[\"thumbId\"]}'
print('✅ OK: thumbId = obrázek vložený v textu')"

echo "== neoznačený obrázek se v náhledech NEobjeví =="
req d16.jar GET /api/campaigns/$CID/articles | python3 -c "
import sys,json; d=json.load(sys.stdin)
a=[x for x in d if x['title']=='Obrazky v textu'][0]
th=a.get('thumbs') or [a.get('thumbId')]
assert $IMG_OFF not in th, 'FAIL: neoznačený obrázek se dostal do náhledů'
print('✅ OK: bez příznaku se do náhledů nedostane')"

echo "== ÚNIK: obrázek ze skrytého bloku se hráči nesmí ukázat =="
req h16.jar GET /api/campaigns/$CID/articles | python3 -c "
import sys,json; d=json.load(sys.stdin)
a=[x for x in d if x['title']=='Obrazky v textu'][0]
th=a.get('thumbs') or [a.get('thumbId')]
assert $IMG_DM not in th, 'FAIL: ÚNIK — obrázek z DM bloku v náhledu hráče!'
assert $IMG_PUB in th, 'FAIL: veřejný obrázek v náhledu chybí'
print('✅ OK: hráč vidí jen veřejný obrázek, tajný neunikl')"
req h16.jar GET /api/articles/$ART/preview | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['thumbId']!=$IMG_DM, 'FAIL: ÚNIK přes /preview'
print('✅ OK: ani /preview tajný obrázek neprozradí')"
req h16.jar GET /api/articles/$ART | python3 -c "
import sys,json; d=json.load(sys.stdin)
h=json.dumps(d)
assert str($IMG_DM) not in [str(b['content'].get('imageId')) for b in d['blocks']], 'FAIL'
assert 'Tajne' not in h, 'FAIL: skrytý blok unikl hráči'
print('✅ OK: skrytý blok se hráči vůbec neodešle')"

echo; echo "🎉 Testy náhledových obrázků v textu prošly."

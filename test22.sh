#!/bin/bash
# Testy: sjednocený textový blok — sanitizace nových tagů (nadpisy, seznamy, audio, YouTube, přílohy).
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ OK: $1" || { echo "❌ FAIL: $1 (chybí $3: $(echo $2|head -c 250))"; exit 1; }; }
check_not(){ echo "$2"|grep -qi "$3" && { echo "❌ FAIL: $1 — uniklo: $3"; exit 1; } || echo "✅ OK: $1"; }

cd /tmp && rm -f s_d.jar
req s_d.jar POST /api/register '{"username":"sandm","password":"test1234"}' > /dev/null
CID=$(req s_d.jar POST /api/campaigns '{"name":"San22"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
ART=$(req s_d.jar POST /api/campaigns/$CID/articles '{"title":"Sanitizace"}' | grep -o '[0-9]*')

echo "== nové tagy v textovém bloku projdou =="
req s_d.jar PUT /api/articles/$ART '{"title":"Sanitizace","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"x","html":"<h2>Kapitola</h2><ul><li>bod</li></ul><hr><blockquote>citace</blockquote><div class=\"callout\">pozor</div><audio controls src=\"/api/images/1\"></audio><iframe class=\"yt\" src=\"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ\" allowfullscreen></iframe><a class=\"att\" href=\"/api/images/1\" data-att=\"plan.pdf\" data-mime=\"application/pdf\">p</a>"}}]}' > /dev/null
V=$(req s_d.jar GET /api/articles/$ART)
check_has "nadpis h2 projde" "$V" "<h2>Kapitola</h2>"
check_has "seznam projde" "$V" "<li>bod</li>"
check_has "oddělovač projde" "$V" "<hr>"
check_has "citace projde" "$V" "<blockquote>"
check_has "callout projde" "$V" 'class=\\"callout\\"'
check_has "audio projde" "$V" 'audio controls src=\\"/api/images/1\\"'
check_has "YouTube embed projde" "$V" "youtube-nocookie.com/embed/dQw4w9WgXcQ"
check_has "příloha projde" "$V" 'data-att=\\"plan.pdf\\"'

echo "== nebezpečné věci neprojdou =="
req s_d.jar PUT /api/articles/$ART '{"title":"Sanitizace","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"x","html":"<script>alert(1)</script><iframe src=\"https://evil.com/x\"></iframe><audio src=\"https://evil.com/a.mp3\"></audio><a href=\"https://evil.com\">ven</a><h2 onclick=\"alert(1)\">n</h2>"}}]}' > /dev/null
V=$(req s_d.jar GET /api/articles/$ART)
check_not "script neprojde" "$V" "<script"
check_not "cizí iframe neprojde" "$V" "evil.com"
check_not "onclick neprojde" "$V" "onclick"
check_has "nadpis zůstal bez atributů" "$V" "<h2>n</h2>"

echo; echo "🎉 Testy sanitizace textového bloku prošly."

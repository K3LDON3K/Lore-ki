#!/bin/bash
# Testy: domovský článek kampaně, nastavení (ikonka/popis), kategorie Kampaň.
set -e
B=http://localhost:3000
req(){ local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_has(){ echo "$2"|grep -q "$3" && echo "✅ $1" || { echo "❌ $1 (chybí $3: $(echo $2|head -c 250))"; exit 1; }; }
jv(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f d15.jar k15.jar
req d15.jar POST /api/register '{"username":"dm15","password":"test1234"}' > /dev/null
req k15.jar POST /api/register '{"username":"hrac15","password":"heslo123"}' > /dev/null

echo "== nová kampaň má domovský článek + popis =="
C=$(req d15.jar POST /api/campaigns '{"name":"Kopule","description":"Svět pod kupolí"}')
CID=$(echo "$C" | grep -o '"id":[0-9]*' | cut -d: -f2)
LIST=$(req d15.jar GET /api/campaigns)
HOME=$(jv "$LIST" "[c['homeArticleId'] for c in d if c['id']==$CID][0]")
check_has "kampaň má popis" "$LIST" "Svět pod kupolí"
[ -n "$HOME" ] && [ "$HOME" != "None" ] && echo "✅ má domovský článek ($HOME)" || { echo "❌ chybí home"; exit 1; }
HA=$(req d15.jar GET /api/articles/$HOME)
check_has "domovský článek v kategorii Kampaň" "$HA" '"category":"Kampaň"'
check_has "isHome=true" "$HA" '"isHome":true'

echo "== domovský článek nelze smazat, lze editovat =="
X=$(req d15.jar DELETE /api/articles/$HOME)
check_has "smazání odmítnuto" "$X" "nelze smazat"
req d15.jar PUT /api/articles/$HOME '{"title":"O Kopuli","category":"Kampaň","blocks":[{"type":"paragraph","visibility":"all","content":{"text":"Vítejte pod kupolí."}}]}' > /dev/null
HA2=$(req d15.jar GET /api/articles/$HOME)
check_has "editace prošla" "$HA2" "Vítejte pod kupolí"
check_has "stále isHome" "$HA2" '"isHome":true'

echo "== kategorie Kampaň je systémová =="
CL=$(req d15.jar GET /api/campaigns/$CID/category-list)
check_has "Kampaň v systémových" "$CL" "Kampaň"
X=$(req d15.jar POST /api/campaigns/$CID/category-list/remove '{"name":"Kampaň"}')
check_has "nelze odebrat" "$X" error

echo "== nastavení kampaně (DM), hráč nesmí =="
req d15.jar POST /api/campaigns/$CID/players '{"username":"hrac15"}' > /dev/null
X=$(req k15.jar PUT /api/campaigns/$CID/settings '{"description":"hack"}')
check_has "hráč nastavení nezmění" "$X" error
req d15.jar PUT /api/campaigns/$CID/settings '{"name":"Kopule 2","description":"Nový popis"}' > /dev/null
L2=$(req d15.jar GET /api/campaigns)
check_has "název změněn" "$L2" "Kopule 2"
check_has "popis změněn" "$L2" "Nový popis"

echo "== hráč vidí domovský článek (blok pro všechny) =="
HP=$(req k15.jar GET /api/articles/$HOME)
check_has "hráč domovský článek přečte" "$HP" "Vítejte pod kupolí"

echo; echo "🎉 Testy domovského článku prošly."

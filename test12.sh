#!/bin/bash
# Testy: import DnDBeyond (parser), systémové kategorie, výchozí postava, online presence.
set -e
B=http://localhost:3000
req() { local jar=$1 method=$2 path=$3 data=$4
  if [ -n "$data" ]; then curl -s -b "$jar" -c "$jar" -X "$method" -H Content-Type:application/json -d "$data" "$B$path"
  else curl -s -b "$jar" -c "$jar" -X "$method" "$B$path"; fi; }
check_not() { local desc=$1 out=$2; shift 2
  for s in "$@"; do if echo "$out" | grep -qi "$s"; then echo "❌ FAIL: $desc — uniklo: $s"; exit 1; fi; done
  echo "✅ OK: $desc"; }
check_has() { local desc=$1 out=$2 s=$3
  if echo "$out" | grep -q "$s"; then echo "✅ OK: $desc"; else echo "❌ FAIL: $desc — chybí: $s ($(echo $out | head -c 300))"; exit 1; fi; }
jv() { python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" <<< "$1"; }

cd /tmp && rm -f d12.jar k12.jar

echo "== příprava =="
req d12.jar POST /api/register '{"username":"dm12","password":"test1234"}' > /dev/null
CID=$(req d12.jar POST /api/campaigns '{"name":"Test12"}' | grep -o '"id":[0-9]*' | cut -d: -f2)
req d12.jar POST /api/campaigns/$CID/users '{"username":"kubik12","password":"heslo123","characterName":"Alfa"}' > /dev/null
req k12.jar POST /api/login '{"username":"kubik12","password":"heslo123"}' > /dev/null
CHARS=$(req d12.jar GET /api/campaigns/$CID/characters)
KUID=$(jv "$CHARS" "[c['userId'] for c in d if c['name']=='Alfa'][0]")
ALFA=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Alfa'][0]")
req d12.jar POST /api/campaigns/$CID/characters "{\"userId\":$KUID,\"name\":\"Beta\"}" > /dev/null
CHARS=$(req d12.jar GET /api/campaigns/$CID/characters)
BETA=$(jv "$CHARS" "[c['id'] for c in d if c['name']=='Beta'][0]")

echo "== systémové kategorie NPC + Monstra =="
CL=$(req d12.jar GET /api/campaigns/$CID/category-list)
check_has "NPC existuje" "$CL" "NPC"
check_has "Monstra existují" "$CL" "Monstra"
X=$(req d12.jar POST /api/campaigns/$CID/category-list/remove '{"name":"Monstra"}')
check_has "Monstra nelze odebrat" "$X" error

echo "== import z textu (formát DnDBeyond 2024) =="
IMP=$(python3 - <<'EOF'
import json, urllib.request
text = """Beholder
Large Aberration, Lawful Evil
AC 18 Initiative +12 (22)
HP 190 (20d10 + 80)
Speed 5 ft., Fly 40 ft. (hover)
MOD SAVE
STR 16 +3 +3
DEX 14 +2 +2
CON 18 +4 +9
MOD SAVE
INT 17 +3 +3
WIS 15 +2 +7
CHA 17 +3 +3
Skills Perception +12
Immunities Prone
Senses Darkvision 120 ft.; Passive Perception 22
Languages Deep Speech, Undercommon
CR 13 (XP 10,000, or 11,500 in lair; PB +5)
Traits
Legendary Resistance (3/Day, or 4/Day in Lair). If the beholder fails a saving throw, it can choose to succeed instead.
Actions
Multiattack. The beholder uses Eye Rays three times.
Bite. Melee Attack Roll: +8, reach 5 ft. Hit: 13 (3d6 + 3) Piercing damage.
Bonus Actions
Antimagic Cone. The beholder's central eye emits an antimagic wave in a 150-foot Cone.
Legendary Actions
Chomp. The beholder makes two Bite attacks.
Glare. The beholder uses Eye Rays.
Habitat: Underdark, Urban
Environment
14 Comments
Posted by SomeUser
Great monster, love the eye rays!
Reply
© 2025 Wizards of the Coast"""
print(json.dumps({"text": text}))
EOF
)
R=$(curl -s -b d12.jar -X POST -H Content-Type:application/json -d "$IMP" $B/api/campaigns/$CID/import-dndbeyond)
check_has "jméno" "$R" '"name":"Beholder"'
check_has "meta" "$R" "Large Aberration"
check_has "AC" "$R" '"ac":"18"'
check_has "iniciativa" "$R" '"initiative":"+12 (22)"'
check_has "HP" "$R" "20d10"
check_has "speed s Fly" "$R" "Fly 40 ft"
CONSAVE=$(jv "$R" "d['saves']['con']")
[ "$CONSAVE" = "+9" ] && echo "✅ OK: CON save +9 (≠ mod +4)" || { echo "❌ FAIL: con save $CONSAVE"; exit 1; }
STRV=$(jv "$R" "d['str']")
[ "$STRV" = "16" ] && echo "✅ OK: STR 16" || { echo "❌ FAIL: str $STRV"; exit 1; }
check_has "skills" "$R" "Perception +12"
check_has "immunities" "$R" "Prone"
check_has "senses" "$R" "Darkvision 120"
check_has "languages" "$R" "Deep Speech"
check_has "CR vč. laboratoře" "$R" "11,500 in lair"
check_has "traits" "$R" "Legendary Resistance"
check_has "actions obsahují Bite" "$R" "Melee Attack Roll"
check_not "actions NEobsahují bonus/legendary" "$(jv "$R" "d['actions']")" "Antimagic" "Chomp"
check_has "bonusActions" "$R" "Antimagic Cone"
check_has "legendaryActions" "$R" "Chomp"
check_not "komentáře a patička ořezány" "$R" "Habitat" "Comments" "Wizards of the Coast" "Reply"
X=$(curl -s -b k12.jar -X POST -H Content-Type:application/json -d "$IMP" $B/api/campaigns/$CID/import-dndbeyond)
check_has "import je jen pro DM" "$X" error
X=$(req d12.jar POST /api/campaigns/$CID/import-dndbeyond '{"url":"https://evil.com/x"}')
check_has "cizí doména odmítnuta" "$X" "dndbeyond"

echo "== výchozí postava =="
req k12.jar PUT /api/campaigns/$CID/default-char "{\"charId\":$BETA}" > /dev/null
CAMPS=$(req k12.jar GET /api/campaigns)
DEF=$(jv "$CAMPS" "[c['defaultCharId'] for c in d if c['id']==$CID][0]")
[ "$DEF" = "$BETA" ] && echo "✅ OK: výchozí postava = Beta" || { echo "❌ FAIL: default $DEF"; exit 1; }
X=$(req d12.jar PUT /api/campaigns/$CID/default-char "{\"charId\":$ALFA}")
check_has "cizí postavu jako výchozí nelze" "$X" "vaše"

echo "== online presence přes SSE =="
timeout 3 curl -s -N -b k12.jar "$B/api/campaigns/$CID/chat/events" > /dev/null 2>&1 &
sleep 0.6
ON=$(req d12.jar GET /api/campaigns/$CID/online)
check_has "kubik12 je online" "$ON" "kubik12"
wait 2>/dev/null || true
sleep 0.5
ON2=$(req d12.jar GET /api/campaigns/$CID/online)
check_not "po odpojení už online není" "$ON2" "kubik12"

echo; echo "🎉 Všechny testy dvanácté verze prošly."

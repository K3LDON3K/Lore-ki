# Lore master — prototyp
*od Sklípky a ještěrky*

Sedmá verze přidává: blok **YouTube video** (vložení odkazu, volba velikosti okna, přehrání přímo v článku) místo nahrávání video souborů, vkládání obrázků přímo do textu tlačítkem 🖼 (i v kontextovém menu — funguje ve scénáři, zápisech i běžných blocích), v herních sezeních automatické ukládání každou minutu, ruční uložení nahoře i dole, klávesovou zkratku Ctrl+S a upozornění při odchodu s neuloženými změnami, zápisy hráčů složené z **více bloků s vlastní viditelností každého bloku** (staré zápisy se převedou automaticky) a v seznamu článků jsou informace vlevo a obrázky vpravo.

Šestá verze přidává: přejmenování na **Lore master**, systémové kategorie „Předměty“ a „Hráčské postavy“ (nelze odebrat), dvojí ořez hlavního obrázku (16:9 pro článek + 1:1 pro seznam), zaškrtávátko „zobrazit v náhledu“ u obrázků a volbu počtu náhledů v seznamu článků, šablony obsahových bloků (🖫 uložit / 📋 vložit), stat blok s vlastními položkami, bloky **audio**, **video** a **příloha** (bublina s náhledem + stažení), GIF bez ořezu, spoilery v textu (začerněný text, odkrytí po potvrzení), přehlednější přepínač „Pohled: DM / hráč“, **herní sezení** (datum, účastníci, tajný dvousloupcový Scénář jen pro DM, zápis DM s bloky a viditelností, zápisy hráčů s vlastní viditelností, sbalitelné segmenty s filtry), emulaci při „zobrazit jako“ (poznámky a zápisy se ukládají pod emulovaného hráče) a seznam zpětných referencí na konci každého článku.

Znalostní wiki pro DnD kampaň s viditelností nastavitelnou **na úrovni jednotlivých bloků**. Každý hráč vidí stejný článek, ale jen obsah určený jemu; DM spravuje vše v jediném článku.

## Spuštění

Vyžaduje pouze Node.js 18+ — **žádné závislosti, žádný npm install**.

```bash
cd dnd-wiki
node server.js
```

Aplikace poběží na http://localhost:3000. Data se ukládají do `data/db.json` a obrázky do `data/uploads/`.

## Master heslo

Master heslo odemyká **administraci aplikace** a **reset zapomenutých hesel**. Záměrně **není v kódu** (kód jde do gitu, odkud by se tajemství už nedalo vymazat). Bere se v tomto pořadí:

1. proměnná prostředí `MASTER_PASSWORD`
2. soubor `data/master-password.txt` (mimo git, práva 600)
3. při prvním spuštění se vygeneruje náhodné, uloží do souboru a **vypíše do konzole**

Vlastní heslo nastavíš buď takto:

```bash
echo 'moje-dlouhe-heslo' > data/master-password.txt
```

nebo jednorázově při spuštění: `MASTER_PASSWORD='moje-heslo' node server.js`

## Zálohy a git

`data/` je v `.gitignore` — obsahuje hashe hesel hráčů, obsah kampaní a master heslo, do gitu nepatří.
Zálohu obsahu dělej **exportem kampaně** v Administraci (JSON včetně obrázků), ne commitem.

## První kroky

1. Zaregistrujte se — první účet bude váš DM účet.
2. Vytvořte kampaň (tvůrce se automaticky stává DM).
3. Hráči se zaregistrují sami; poté je přidejte v **Správa hráčů** podle uživatelského jména (+ jméno postavy).
4. Vytvořte článek a v blokovém editoru nastavte u každého bloku viditelnost: **Všichni hráči / Pouze DM / Vybraní hráči**.
5. Náhled z pohledu hráče: rozbalovací menu **„Zobrazit jako…“** v horní liště — platí pro články, seznamy, kategorie, vyhledávání i obrázky.

## Co je hotové

Registrace a přihlášení, role DM/hráč, kampaně, přidávání hráčů, články s kategoriemi a štítky, blokový editor (nadpis, odstavec, seznam, citace, upozornění, oddělovač, obrázek, odkaz na článek, poznámka DM), viditelnost každého bloku, odemykání informací změnou viditelnosti, fulltextové vyhledávání respektující oprávnění, upload obrázků s kontrolou oprávnění, náhled z pohledu hráče, responzivní rozhraní.

Chat: plovoucí panel 💬 vlevo dole (přes celou aplikaci, s počtem nepřečtených). DM zakládá místnosti, zve/odebírá postavy a může místnost přiřadit k sezením (odkaz se objeví na stránce sezení). Postava píše za sebe všem, nebo šeptá jen DM; DM píše všem, nebo tajně vybraným postavám — šeptání je pro ostatní zcela neviditelné. Zpráva může být v libovolném jazyce kampaně: znalci ji vidí barevně a čitelně, neznalci dostanou ze serveru náhodné znaky stejné délky. Doručování v reálném čase přes SSE, mazat zprávy smí jen DM, emulace píše za postavu.

Pátá verze přidává: editor ořezu a posunu při nahrávání obrázků (poměry 1:1, 16:9, 4:3, 3:4 — náhledy pak vypadají dobře), u hlavního obrázku článku odebrání a volbu velikosti, blok **Stat blok (5e)** s předpřipravenými šablonami tvorů z D&D (Goblin, Vlk, Kostlivec, Bandita, Zlobr, Mág) v klasickém vzhledu stat bloku, předání postavy jinému hráči (⇄ ve Správě hráčů) a **inventář postav**: články v kategorii „Předměty“ mají váhu, cenu a vzácnost (barevně dle D&D); DM vkládá předměty do inventáře postavy (množství, součet váhy), inventář vidí jen vlastník a DM. K předmětu v inventáři píše hráč či DM poznámky s viditelností „DM + hráč“ nebo „Pouze DM“ a tytéž poznámky se dle oprávnění zobrazují i na článku předmětu v sekci „V inventářích“.

Čtvrtá verze přidává: hráč může mít více postav (viditelnost bloků i poznámek se nově cílí na konkrétní postavy — stará data se převedou automaticky), filtry v seznamu článků (text, kategorie, štítek) a hráčské postavy s vlastnictvím: DM vytvoří hráči postavu (ve Správě hráčů), tím vznikne článek v kategorii „Hráčské postavy“, který hráč plně vlastní — píše backstory, nahrává obrázky a sám nastavuje viditelnost bloků (všem / vybraným postavám / jen sobě a DM). DM vidí vše; bloky, které do článku vloží DM jako „Pouze DM“, vlastník nevidí a jeho úpravy je nesmažou. Poznámky ostatních hráčů u článku postavy schvaluje její vlastník nebo DM.

Třetí verze přidává: správu kategorií (DM přidává a odebírá, odebráním se články přesunou do „Nezařazeno“, nová kategorie z editoru se přidá automaticky), úpravy článku přímo z jeho zobrazení (najetím na segment se objeví ✏️ ↑ ↓ ✕, dvojklik segment rovnou otevře k úpravě, tlačítko + mezi segmenty vloží nový blok), jemné grafické oddělení segmentů a náhledové bubliny u referencí — po najetí myší se zobrazí náhled cílového článku, bez oprávnění hláška „K tomuto článku nemáte přístup“ (server ani v tom případě nic neprozradí).

Druhá verze přidává: náhledové obrázky v seznamu článků (titulní obrázek, jinak první obrázek viditelný danému uživateli), ruční vytváření hráčských účtů DM-em (včetně předání hesla) a změnu hesla hráčům, trvalou levou navigaci, tlačítko zpět, světlý/tmavý režim, rich-text editaci (tučně, kurzíva, podtržení, velikost a barva písma), nastavení velikosti obrázků, inline reference na jiné články `[[…]]` s prokliky (hráči se odkaz zobrazí jen u viditelného cíle), kontextovou nabídku pravým tlačítkem i dlouhým dotykem a poznámky uživatelů ke článkům — autor zvolí, kteří hráči je uvidí, DM je vidí vždy a ostatním se zobrazí až po schválení DM-em.

## Bezpečnostní princip

Filtrování probíhá výhradně na serveru — hráči se skrytý obsah vůbec neodešle (není v API, HTML ani ve vyhledávání). Skrytý článek vrací hráči 404, skryté bloky prostě v odpovědi nejsou, obrázek se vydá jen tomu, kdo smí vidět blok, který jej používá. Poznámka DM je vždy jen pro DM (vynuceno serverem).

## Co zatím není (další verze)

Skupiny hráčů, historie změn a verze článků, evidence odemčení (datum/důvod), galerie a tabulky, přílohy (PDF), osobní poznámky hráčů, více DM v kampani.

## Poznámka k prototypu

Úložiště je JSON soubor (žádná databáze), sessions jsou v paměti (restart serveru odhlásí uživatele) a ukládání článku přepisuje bloky celé. Pro reálný provoz by se doplnila skutečná databáze (SQLite/PostgreSQL), trvalý session store a HTTPS.

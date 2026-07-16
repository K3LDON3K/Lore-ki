# Lore-ki

*od Sklípky a ještěrky*

Znalostní wiki pro stolní RPG kampaně. Zvláštností je **viditelnost nastavovaná po jednotlivých blocích textu**: všichni hráči otevřou tentýž článek, ale každý v něm vidí jen to, co má vědět jeho postava. DM spravuje všechny varianty na jednom místě, nemusí udržovat dvě verze světa.

Filtrování probíhá **výhradně na serveru** — hráči se skrytý obsah vůbec neodešle. Není v API odpovědi, není v HTML, nenajde se přes vyhledávání. Nejde odhalit ani zdrojovým kódem stránky.

## Spuštění

Vyžaduje **Node.js 18+**. Žádné závislosti, žádný `npm install`.

```bash
cd lore-ki
node server.js
```

Poběží na http://localhost:3000. Data se ukládají do `data/db.json`, obrázky do `data/uploads/`.

Port se dá změnit: `PORT=8080 node server.js`

## Master heslo

Odemyká **administraci aplikace** a **obnovu zapomenutých hesel**. Záměrně není v kódu — kód jde do gitu, odkud by se tajemství už nedalo vymazat. Bere se v tomto pořadí:

1. proměnná prostředí `MASTER_PASSWORD`
2. soubor `data/master-password.txt` (mimo git, práva 600)
3. při prvním spuštění se vygeneruje náhodné, uloží do souboru a vypíše do konzole

Vlastní heslo nastavíš takto:

```bash
echo 'moje-dlouhe-heslo' > data/master-password.txt
chmod 600 data/master-password.txt
```

## První kroky

1. **Zaregistruj se** — první účet je tvůj.
2. **Vytvoř kampaň** (nepovinně ikonka a popis). Tvůrce se stává jejím DM. Vznikne i domovský článek „O kampani“, který nejde smazat.
3. **Přidej hráče** v ⚙️ Nastavení kampaně → 👥 Hráči a postavy. Buď jim rovnou vytvoříš účet (jméno + heslo k předání), nebo přidáš už zaregistrovaného uživatele.
4. **Vytvoř postavy.** S postavou vzniká i její článek v kategorii „Hráčské postavy“, který postava vlastní — hráč si do něj píše sám.
5. **Piš články** a u každého bloku nastav viditelnost: *Všichni hráči / Pouze DM / Vybrané postavy*.
6. **Zkontroluj se** přepínačem **Pohled** v horní liště — uvidíš svět očima kterékoli postavy.

## Jak to funguje

### Postava je jednotka oprávnění

Ne uživatel, ale **postava**. Jeden hráč může mít postav víc a každá ví něco jiného; přepíná mezi nimi tlačítkem **Za** v liště a hvězdičkou si určí výchozí. Co ví Baradir, neví Toruk — i když je hraje tentýž člověk.

### Články a bloky

Článek má název, popis, kategorii, štítky, hlavní obrázek a obsah složený z bloků. Typy bloků: nadpis, odstavec, seznam, citace, upozornění, oddělovač, obrázek, audio, YouTube video, příloha, odkaz na článek, stat blok (5e) a poznámka DM.

Hráč vidí článek, jen když v něm má aspoň jeden viditelný blok. Jinak pro něj článek neexistuje — ani ve výpisu, ani ve vyhledávání.

### Prozrazení informace

Postava, která vidí blok určený jen vybraným postavám, ho může **prozradit jiné postavě** — tlačítkem 🤫 přímo pod blokem. Informace se cílové postavě zpřístupní až po schválení DM; žádosti čekají v **Nastavení kampaně → 📄 Články**, kde jde zapnout i **automatické schvalování** (pak se prozrazení projeví okamžitě). Do té doby cílová postava nic nevidí a o zamítnuté žádosti se nikdo nedozví.

### Systémové kategorie

`Kampaň`, `Hráčské postavy`, `Předměty`, `Jazyk`, `NPC` a `Monstra` mají zvláštní chování a nejdou odebrat. Ostatní kategorie si DM spravuje sám včetně barev.

### Jazyky

Jazyk je článek v kategorii `Jazyk` s unikátní barvou. Text označený jazykem uvidí čitelně jen postava, která ho ovládá — ostatním server pošle **náhodné znaky stejné délky**. Nejde o skrytí v prohlížeči; původní text se k nim vůbec nedostane. Jazyky přiděluje postavám DM.

### Chat

Plovoucí panel s místnostmi, doručování v reálném čase přes SSE. Zprávy jdou psát libovolným jazykem kampaně a šeptat vybraným postavám — pro ostatní jsou tajné zprávy zcela neviditelné. DM vidí i šeptání mezi hráči (u zprávy je značka „+ DM“, ať o tom všichni vědí).

### Herní sezení

Datum, účastníci, dvousloupcový **scénář jen pro DM**, zápis DM složený z bloků s viditelností a zápisy hráčů. Automatické ukládání každou minutu, Ctrl+S, varování při odchodu s neuloženými změnami.

### Grafický inventář

Mřížkový inventář ve stylu PC her. Postava má **nákres se sloty** — šest systémových (hlava, trup, plášť/toulec, záda/batoh, obě ruce) plus vlastní sloty, které si DM založí (prsten, přívěsek…). Kontejnery (batohy, brašny) mají **vlastní mřížky** s barevnými zónami dostupnosti (volná akce / akce / celé kolo), které si DM nakliká v editoru předmětu. Předměty se přetahují myší i prstem, tokeny jdou otáčet o 90°.

Každý předmět existuje jako **instance** — konkrétní kus s vlastními životy (1–10, na 0 je rozbitý), stavem identifikace a pozicí. Neidentifikovaný kus ukazuje jen obecný název a veřejný popis; pravé jméno a tajný popis odhalí až DM identifikací. **Zóny podlahy** jsou společné odkládací plochy kampaně — předání předmětu jinému hráči jde přes ně, změny se všem projeví okamžitě (SSE) a deník přesunů zaznamenává, kdo co vzal a odložil.

### Import z D&D Beyond

Monstra z odkazu nebo ze zkopírovaného textu stat bloku (funguje i pro placený obsah). Postavy z odkazu — postava musí být na D&D Beyond nastavená jako **veřejná**.

### Administrace aplikace

Za master heslem. Název a logo aplikace, přehled kampaní a uživatelů, **export zálohy kampaně** do JSON (včetně obrázků), obnovení ze zálohy jako nová kampaň, smazání kampaně, vstup do kampaně jako další DM.

## Zálohy a git

`data/` je v `.gitignore` — obsahuje hashe hesel hráčů, obsah kampaní i master heslo. **Do gitu to nepatří.**

Zálohu obsahu dělej **exportem kampaně** v Administraci: JSON včetně obrázků, kdykoli naimportovatelný zpět. Případně zkopíruj celou složku `data/`.

## Testy

Regresní sady v `test*.sh`. Vyžadují běžící server se známým master heslem:

```bash
MASTER_PASSWORD='test-master' node server.js &
MASTER_PASSWORD='test-master' bash test.sh
```

Většina kontrol ověřuje, že **skrytý obsah neuniká** — skrytý článek, blok, obrázek, cizí jazyk, šeptání v chatu ani cizí sezení se nesmí dostat k nepovolanému. Testy počítají s čistou databází (`rm -rf data` před během).

## Bezpečnost

- Hesla se ukládají jako **scrypt** hash se solí, nikdy čitelně.
- Rich text z editoru prochází **whitelistem** tagů a atributů (ochrana proti XSS).
- Obrázek se vydá jen tomu, kdo smí vidět blok, který ho používá.
- Poznámka DM je vždy jen pro DM, vynuceno serverem.
- Skrytý článek vrací hráči 404 — server neprozradí ani to, že existuje.

## Známá omezení

Úložiště je JSON soubor, ne databáze. Sessions jsou v paměti — **restart serveru odhlásí přihlášené**. Uložení článku přepisuje bloky celé, takže současná editace téhož článku dvěma lidmi si navzájem přepíše změny. Historie změn článků se nevede. Pro provoz s desítkami hráčů by se hodila skutečná databáze (SQLite/PostgreSQL) a trvalý session store.

/**
 * DnD znalostní wiki — prototyp (bez závislostí, čisté Node.js 18+)
 * Spuštění: node server.js
 *
 * Klíčový princip: veškeré filtrování viditelnosti probíhá NA SERVERU.
 * Hráči se nikdy neodešle blok, který nemá právo vidět — ani v API,
 * ani v HTML, ani ve vyhledávání.
 *
 * Úložiště: JSON soubor data/db.json + obrázky v data/uploads/.
 * (Prototyp — pro reálný provoz nahradit databází.)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ================================================================ "DB"
let db = {
  seq: 1,
  users: [],        // {id, username, passwordHash}
  campaigns: [],    // {id, name}
  memberships: [],  // {campaignId, userId, role:'dm'|'player', characterName}
  articles: [],     // {id, campaignId, title, description, category, tags, coverImageId, createdAt, updatedAt}
  blocks: [],       // {id, articleId, position, type, content{}, visibility:'all'|'dm'|'custom', visibleTo:[userId]}
  images: [],       // {id, campaignId, filename, originalName, mime}
  notes: [],        // {id, articleId, authorId, text, visibleTo:[characterId], approved, createdAt}
  characters: [],   // {id, campaignId, userId, name, articleId} — hráč může mít více postav
  itemInstances: [],// {id, campaignId, articleId, qty, hp, hpMax, identified, rot, loc{t,…}}
  invZones: [],     // {id, campaignId, name} — zóny podlahy (sdílené odkládání)
  invLog: [],       // {id, campaignId, ts, who, text} — deník přesunů
  sessions: [],     // {id, campaignId, title, date, players:[userId], scenario:{left,right}, reportArticleId, entries:[{userId,html,text,visibility,visibleTo,updatedAt}]}
  templates: [],    // {id, campaignId, name, type, content} — šablony obsahových bloků
  chatRooms: [],    // {id, campaignId, name, sessionIds:[], characters:[charId], createdAt}
  chatMessages: [], // {id, roomId, authorId, authorCharId(null=DM), langId, secretTo: null|'dm'|[charId], text, createdAt}
  chatReads: [],    // {roomId, key('u<uid>'|'c<charId>'), lastRead}
};
const APP_NAME_DEFAULT = 'Lore-ki'; // výchozí název; v provozu ho přebíjí db.settings.appName
// Formát zálohy: nové se píší jako 'loreki-backup', ale importovat jde i starší
// 'loremaster-backup' — jinak by přestaly fungovat dřív vyexportované soubory.
const BACKUP_FORMAT = 'loreki-backup';
const BACKUP_FORMATS_IN = ['loreki-backup', 'loremaster-backup'];

const SYSTEM_CATEGORIES = ['Kampaň', 'Předměty', 'Hráčské postavy', 'Jazyk', 'NPC', 'Monstra']; // nelze odebrat (mají vlastní formuláře a funkce)
// Položky navigace, jejichž pořadí si DM může přerovnat (klíče musí znát i frontend).
// Správa hráčů a Kategorie v menu nejsou — jsou to záložky uvnitř Nastavení kampaně.
const NAV_KEYS = ['campaigns', 'home', 'articles', 'sessions', 'inventory', 'settings'];
/** Uložené pořadí doplněné o případné nové/chybějící položky — nikdy nevrátí neúplný seznam. */
function navOrderOf(c) {
  const saved = Array.isArray(c && c.navOrder) ? c.navOrder.filter(k => NAV_KEYS.includes(k)) : [];
  return [...new Set([...saved, ...NAV_KEYS])];
}
let CURRENT_VIEWCHAR = null; // ?viewChar=<id> — aktivní postava pro tento požadavek
/**
 * Master heslo (reset zapomenutých hesel + administrace).
 * V KÓDU NESMÍ BÝT — kód jde do gitu a z historie by se už nedalo vymazat.
 * Pořadí: proměnná prostředí → soubor data/master-password.txt (mimo git) →
 * při prvním spuštění se vygeneruje náhodné a vypíše do konzole.
 */
const MASTER_FILE = path.join(DATA_DIR, 'master-password.txt');
const MASTER_PASSWORD = (() => {
  if (process.env.MASTER_PASSWORD) return process.env.MASTER_PASSWORD;
  try {
    const fromFile = fs.readFileSync(MASTER_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* soubor zatím není */ }
  const gen = crypto.randomBytes(12).toString('base64url');
  try {
    fs.writeFileSync(MASTER_FILE, gen + '\n', { mode: 0o600 });
    console.log(`\n⚠️  Vygenerováno nové master heslo: ${gen}\n    Uloženo v ${MASTER_FILE} — heslo si přepiš na vlastní a soubor nikdy nedávej do gitu.\n`);
  } catch (e) {
    console.log(`\n⚠️  Master heslo pro toto spuštění: ${gen} (nepodařilo se uložit: ${e.message})\n`);
  }
  return gen;
})();
// Systémové sloty: nejdou smazat, jdou jen přesouvat mezi sloupci. Vše ostatní si DM dotvoří.
const BODY_SLOTS = { head: 1, torso: 1, cloak: 1, back: 1, handL: 1, handR: 1 };
const SYSTEM_SLOT_LABELS = { head: 'Hlava', torso: 'Trup', cloak: 'Plášť / toulec', back: 'Záda / batoh', handL: 'Levá ruka', handR: 'Pravá ruka' };
// dřívější vestavěné sloty — u existujících kampaní se převedou na vlastní (mazatelné)
const LEGACY_SLOTS = {
  neck: 'Krk', belt: 'Opasek', gloves: 'Rukavice', wristR: 'Zápěstí (pravé)', wristL: 'Zápěstí (levé)',
  forearm: 'Předloktí', ring1: 'Prsten 1', ring2: 'Prsten 2', ring3: 'Prsten 3', ring4: 'Prsten 4',
  pants: 'Kalhoty', boots: 'Boty'
};
/** Pořadí slotů kampaně (systémové + vlastní; uložené pořadí se doplní o chybějící). */
function slotOrderOf(camp) {
  const all = [...Object.keys(BODY_SLOTS), ...((camp && camp.customSlots) || []).map(s => s.key)];
  const saved = Array.isArray(camp && camp.slotOrder) ? camp.slotOrder.filter(k => all.includes(k)) : [];
  return [...new Set([...saved, ...all])];
}
/** Sloupec slotu: 1 = levý (výchozí pro systémové), 2 = pravý (výchozí pro vlastní). */
function slotColOf(camp, key) {
  const c = camp && camp.slotCols && camp.slotCols[key];
  return c === 1 || c === 2 ? c : (BODY_SLOTS[key] ? 1 : 2);
}

if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
db.settings = db.settings || { appName: APP_NAME_DEFAULT }; // nastavení aplikace
db.notes = db.notes || []; // migrace starších dat
db.itemInstances = db.itemInstances || []; // grafický inventář: konkrétní kusy
// migrace: dřívější vestavěné sloty existujících kampaní → vlastní sloty (nic nezmizí, jdou mazat)
db.campaigns.forEach(c => {
  c.customSlots = c.customSlots || [];
  for (const [k, label] of Object.entries(LEGACY_SLOTS))
    if (!c.customSlots.some(s => s.key === k)) c.customSlots.push({ key: k, label, cap: 1 });
});
// migrace: mřížky kontejnerů uložené před normalizací posunout k počátku
db.articles.forEach(a => {
  const c = a.item && a.item.container;
  if (!c || !Array.isArray(c.cells) || !c.cells.length) return;
  const mx = Math.min(...c.cells.map(x => x.x)), my = Math.min(...c.cells.map(x => x.y));
  if (mx || my) c.cells.forEach(x => { x.x -= mx; x.y -= my; });
});
db.invZones = db.invZones || [];           // zóny podlahy
db.invLog = db.invLog || [];               // deník přesunů
delete db.inventory; delete db.invNotes;   // starý seznamový inventář zrušen
db.sessions = db.sessions || [];
db.templates = db.templates || [];
db.chatRooms = db.chatRooms || [];
db.chatMessages = db.chatMessages || [];
db.chatReads = db.chatReads || [];
// systémové kategorie musí existovat v každé kampani
db.campaigns.forEach(c => {
  c.categories = c.categories || [];
  for (const s of SYSTEM_CATEGORIES) if (!c.categories.includes(s)) c.categories.push(s);
});
// migrace: každá kampaň má výchozí „Běžný jazyk“ (funkce je hoistovaná)
db.campaigns.forEach(c => ensureCommonLanguage(c));
// migrace: každá kampaň má domovský článek (v kategorii „Kampaň“, nelze smazat)
db.campaigns.forEach(c => ensureHomeArticle(c));
// migrace: spravovaný seznam kategorií kampaně (odvozen z existujících článků)
db.campaigns.forEach(c => {
  if (!Array.isArray(c.categories)) {
    c.categories = [...new Set(db.articles.filter(a => a.campaignId === c.id).map(a => a.category).filter(Boolean))];
  }
});
// migrace: postavy jako samostatné entity; viditelnost bloků/poznámek se převádí
// z userId na characterId (každému hráči vznikne výchozí postava)
if (!Array.isArray(db.characters)) {
  db.characters = [];
  const charOf = {}; // "campaignId:userId" -> character
  for (const m of db.memberships.filter(m => m.role === 'player')) {
    const u = db.users.find(u => u.id === m.userId);
    const ch = { id: db.seq++, campaignId: m.campaignId, userId: m.userId, name: m.characterName || (u ? u.username : 'Postava'), articleId: null };
    db.characters.push(ch);
    charOf[`${m.campaignId}:${m.userId}`] = ch;
  }
  const mapVis = (campaignId, arr) => (arr || [])
    .map(uid => { const ch = charOf[`${campaignId}:${uid}`]; return ch ? ch.id : null; })
    .filter(Boolean);
  for (const b of db.blocks) {
    if (b.visibility === 'custom') {
      const a = db.articles.find(a => a.id === b.articleId);
      if (a) b.visibleTo = mapVis(a.campaignId, b.visibleTo);
    }
  }
  for (const n of db.notes) {
    const a = db.articles.find(a => a.id === n.articleId);
    if (a) n.visibleTo = mapVis(a.campaignId, n.visibleTo);
  }
}
// migrace: zápisy hráčů v sezeních — z jednoho textu na pole bloků s viditelností
db.sessions.forEach(s => {
  s.entries = (s.entries || []).map(e => {
    if (Array.isArray(e.blocks)) return e;
    const blocks = (e.html || e.text) ? [{
      id: db.seq++, html: e.html || '', text: e.text || '',
      visibility: e.visibility || 'all', visibleTo: e.visibleTo || [], updatedAt: e.updatedAt
    }] : [];
    return { userId: e.userId, blocks };
  });
});
// migrace: účastníci sezení jsou POSTAVY (dříve hráči) a zápisy patří postavám
db.sessions.forEach(s => {
  if (!Array.isArray(s.characters)) {
    s.characters = (s.players || []).flatMap(uid =>
      db.characters.filter(c => c.campaignId === s.campaignId && c.userId === uid).map(c => c.id));
  }
  s.entries = (s.entries || []).map(e => {
    if (e.charId) return e;
    const ch = db.characters.find(c => c.campaignId === s.campaignId && c.userId === e.userId);
    return ch ? { charId: ch.id, blocks: e.blocks || [] } : null;
  }).filter(Boolean);
});
// migrace: poznámky dostávají autorskou POSTAVU (první postava autora)
db.notes.forEach(n => {
  if (n.authorCharId !== undefined) return;
  const a = db.articles.find(a => a.id === n.articleId);
  const m = a && getMembership(a.campaignId, n.authorId);
  const ch = a && db.characters.find(c => c.campaignId === a.campaignId && c.userId === n.authorId);
  n.authorCharId = (m && m.role === 'dm') ? null : (ch ? ch.id : null);
});
// oprava dat: dřívější verze mohla při uložení editorem ztratit data-lang
// u označení jazyka — zrekonstruuje se podle barvy jazyka
function repairLangSpans(html, campaignId) {
  if (typeof html !== 'string' || !html.includes('class="lang"')) return html;
  return html.replace(/<span\b([^>]*)>/g, (m, attrs) => {
    if (!/class="lang"/.test(attrs) || /data-lang=/.test(attrs)) return m;
    const col = /color:\s*(#[0-9a-fA-F]{6}|rgba?\([^)]+\))/i.exec(attrs);
    const hex = col && colorToHex(col[1]);
    if (!hex) return m;
    const lang = campaignLanguages(campaignId).find(l => (l.langColor || '').toLowerCase() === hex);
    return lang ? `<span${attrs} data-lang="${lang.id}">` : m;
  });
}
db.blocks.forEach(b => {
  const a = db.articles.find(a => a.id === b.articleId);
  if (a && b.content && typeof b.content.html === 'string') b.content.html = repairLangSpans(b.content.html, a.campaignId);
});
db.sessions.forEach(s => (s.entries || []).forEach(e => (e.blocks || []).forEach(bl => { bl.html = repairLangSpans(bl.html, s.campaignId); })));
// migrace se ihned uloží na disk
fs.writeFileSync(DB_FILE, JSON.stringify(db));
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db)); // synchronně — data jsou malá, prototyp
}
function nextId() { const id = db.seq++; save(); return id; }

// ================================================================ hesla + sessions
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
const sessions = new Map(); // token -> userId (v paměti; restart odhlásí)
const adminTokens = new Set(); // sid tokeny s odemčenou administrací
function getSid(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}
function getSessionUser(req) {
  const s = getSid(req);
  return s ? sessions.get(s) || null : null;
}
function isAdmin(req) { const s = getSid(req); return !!(s && adminTokens.has(s)); }
function checkMaster(pwd) {
  const a = Buffer.from(String(pwd || '')), b = Buffer.from(MASTER_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ================================================================ oprávnění
function getMembership(campaignId, userId) {
  return db.memberships.find(m => m.campaignId === campaignId && m.userId === userId);
}

/**
 * Určí "efektivního diváka".
 * - hráč: vždy on sám
 * - DM bez viewAs: plný přístup (isDM=true)
 * - DM s ?viewAs=<userId>: server aplikuje filtr daného hráče
 */
function resolveViewer(userId, campaignId, viewAsRaw) {
  const m = getMembership(campaignId, userId);
  if (!m) return null;
  if (m.role === 'dm') {
    const viewAs = parseInt(viewAsRaw, 10);
    if (viewAs) {
      const target = getMembership(campaignId, viewAs);
      if (target && target.role === 'player') return { userId: viewAs, isDM: false, realDM: true };
    }
    return { userId, isDM: true, realDM: true };
  }
  return { userId, isDM: false, realDM: false };
}

/** AKTIVNÍ postava hráče. Hráč se na svět VŽDY dívá právě za jednu postavu:
    platný ?viewChar vyhrává, jinak první postava hráče. Cizí viewChar se ignoruje. */
function userCharIds(campaignId, userId) {
  const ids = db.characters.filter(ch => ch.campaignId === campaignId && ch.userId === userId).map(ch => ch.id);
  if (!ids.length) return [];
  if (CURRENT_VIEWCHAR && ids.includes(CURRENT_VIEWCHAR)) return [CURRENT_VIEWCHAR];
  return [ids[0]]; // výchozí = první postava, nikdy „všechny najednou“
}

// ================================================================ JAZYKY
function campaignLanguages(campaignId) {
  return db.articles.filter(a => a.campaignId === campaignId && a.category === 'Jazyk' && !a.sessionId);
}
/** Zajistí existenci výchozího „Běžného jazyka“ kampaně. */
function ensureCommonLanguage(camp) {
  let common = db.articles.find(a => a.id === camp.commonLangId);
  if (common) return common;
  common = campaignLanguages(camp.id).find(a => a.title === 'Běžný jazyk');
  if (!common) {
    const now = new Date().toISOString();
    common = {
      id: db.seq++, campaignId: camp.id, title: 'Běžný jazyk', description: 'Řeč, kterou zná každý.',
      category: 'Jazyk', tags: '', coverImageId: null, langColor: '#9aa0a6', createdAt: now, updatedAt: now
    };
    db.articles.push(common);
    db.blocks.push({ id: db.seq++, articleId: common.id, position: 0, type: 'paragraph', content: { text: 'Společná řeč, kterou ovládá každá postava.' }, visibility: 'all', visibleTo: [] });
  }
  camp.commonLangId = common.id;
  return common;
}
/** Jazyky, kterým postava rozumí. Běžný jazyk zná KAŽDÁ postava vždy. */
function charLangIds(ch) {
  const camp = db.campaigns.find(c => c.id === ch.campaignId);
  const common = camp ? camp.commonLangId : null;
  const ls = Array.isArray(ch.languages) ? ch.languages.filter(id => db.articles.some(a => a.id === id)) : [];
  return [...new Set([common, ...ls].filter(Boolean))];
}
function viewerKnowsLang(viewer, campaignId, langId) {
  if (viewer.isDM) return true;
  // vždy jen aktivní postava (stejné pravidlo jako userCharIds)
  const activeIds = userCharIds(campaignId, viewer.userId);
  if (!activeIds.length) { const camp = db.campaigns.find(c => c.id === campaignId); return camp && camp.commonLangId === langId; }
  const chars = db.characters.filter(ch => activeIds.includes(ch.id));
  return chars.some(ch => charLangIds(ch).includes(langId));
}
/** Deterministicky „zašifruje“ text neznámého jazyka — náhodná písmena stejné délky. */
function scrambleText(text, seedStr) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let hh = 2166136261;
  for (const ch of String(seedStr)) { hh = (hh ^ ch.charCodeAt(0)) * 16777619 >>> 0; }
  let out = '';
  for (const c of String(text)) {
    if (/[\s.,!?;:„“"'()\-–—…]/.test(c)) { out += c; continue; }
    hh = (hh * 1103515245 + 12345) >>> 0;
    const L = letters[hh % 26];
    out += c === c.toUpperCase() && c !== c.toLowerCase() ? L.toUpperCase() : L;
  }
  return out;
}
/** Převod barvy na #hex — prohlížeče při editaci přepisují hex na rgb(...). */
function colorToHex(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
  return null;
}
/**
 * Nahradí označení <span class="lang" data-lang="ID"> podle znalostí diváka:
 * znalec vidí text barevně podtržený, neznalec dostane MÍSTO textu náhodná
 * písmena (originál mu server vůbec neodešle).
 * FAIL CLOSED: označení bez data-lang (poškozené starší verzí) se pokusí
 * dohledat podle barvy; když se to nepovede, hráči se text VŽDY zašifruje.
 */
function processLangs(html, viewer, campaignId) {
  const render = (lang, inner) => {
    const color = lang.langColor || '#9aa0a6';
    const knows = viewerKnowsLang(viewer, campaignId, lang.id);
    const shown = knows ? inner : scrambleText(inner.replace(/<[^>]*>/g, ''), inner + lang.id).replace(/"/g, '&quot;');
    const title = knows ? `Jazyk: ${lang.title}` : 'Neznámá řeč';
    return `<span class="lang" style="color:${color}" title="${title.replace(/"/g, '&quot;')}">${shown}</span>`;
  };
  // 1) označení s data-lang (atributy v libovolném pořadí)
  let out = String(html).replace(/<span\b(?=[^>]*\bclass="lang")(?=[^>]*\bdata-lang="(\d+)")[^>]*>([\s\S]*?)<\/span>/g, (m, idStr, inner) => {
    const lang = db.articles.find(a => a.id === parseInt(idStr, 10) && a.campaignId === campaignId && a.category === 'Jazyk');
    return lang ? render(lang, inner) : inner;
  });
  // 2) poškozená označení BEZ data-lang — dohledání podle barvy, jinak fail closed
  out = out.replace(/<span\b(?![^>]*\bdata-lang=)(?=[^>]*\bclass="lang")([^>]*)>([\s\S]*?)<\/span>/g, (m, attrs, inner) => {
    const col = /color:\s*(#[0-9a-fA-F]{6}|rgba?\([^)]+\))/i.exec(attrs);
    const hex = col && colorToHex(col[1]);
    const lang = hex && campaignLanguages(campaignId).find(l => (l.langColor || '').toLowerCase() === hex);
    if (lang) return render(lang, inner);
    if (viewer.isDM) return m; // DM vidí vše
    const plain = inner.replace(/<[^>]*>/g, '');
    return `<span class="lang" style="color:#9aa0a6" title="Neznámá řeč">${scrambleText(plain, plain).replace(/"/g, '&quot;')}</span>`;
  });
  return out;
}
/** Vlastnictví článku postavy platí JEN pro aktivní postavu — postavy téhož
    hráče jsou samostatné jednotky, každá má svoje vědomosti. */
function isArticleOwner(articleId, userId) {
  const ch = db.characters.find(ch => ch.articleId === articleId);
  if (!ch || ch.userId !== userId) return false;
  return userCharIds(ch.campaignId, userId).includes(ch.id);
}

function blockVisibleToPlayer(b, playerId) {
  if (b.type === 'dm_note') return false;
  // Vlastník článku své postavy vidí vše kromě bloků "pouze DM"
  if (isArticleOwner(b.articleId, playerId)) return b.visibility !== 'dm';
  if (b.visibility === 'all') return true;
  if (b.visibility === 'custom') {
    const a = db.articles.find(a => a.id === b.articleId);
    if (!a) return false;
    const mine = userCharIds(a.campaignId, playerId);
    return (b.visibleTo || []).some(id => mine.includes(id));
  }
  return false; // 'dm'
}

/** Odkazový blok hráč vidí, jen když smí vidět cílový článek. */
function blockAllowedForPlayer(b, playerId) {
  if (!blockVisibleToPlayer(b, playerId)) return false;
  if (b.type === 'link' && b.content.articleId) {
    return articleVisibleToPlayer(b.content.articleId, playerId);
  }
  return true;
}

/** Článek je pro hráče viditelný, pokud ho vlastní nebo obsahuje aspoň jeden viditelný blok.
    Zápis ze sezení navíc vidí JEN účastníci daného sezení. */
function articleVisibleToPlayer(articleId, playerId) {
  const a = db.articles.find(x => x.id === articleId);
  if (!a) return false;
  if (a.sessionId) { // zápis ze sezení vidí jen ÚČASTNÍCÍ SE POSTAVA
    const s = db.sessions.find(x => x.id === a.sessionId);
    if (!s) return false;
    const active = userCharIds(a.campaignId, playerId);
    if (!(s.characters || []).some(id => active.includes(id))) return false;
  }
  if (isArticleOwner(articleId, playerId)) return true;
  return db.blocks.some(b => b.articleId === articleId && blockVisibleToPlayer(b, playerId));
}

function articleBlocks(articleId) {
  return db.blocks.filter(b => b.articleId === articleId).sort((a, b) => a.position - b.position);
}

function visibleBlocksForViewer(articleId, viewer) {
  const blocks = articleBlocks(articleId);
  if (viewer.isDM) {
    return blocks.map(b => ({ id: b.id, type: b.type, content: b.content, visibility: b.visibility, visibleTo: b.visibleTo || [] }));
  }
  const owned = isArticleOwner(articleId, viewer.userId);
  return blocks
    .filter(b => blockAllowedForPlayer(b, viewer.userId))
    .map(b => owned
      ? { id: b.id, type: b.type, content: b.content, visibility: b.visibility, visibleTo: b.visibleTo || [] } // vlastník metadata potřebuje k editaci
      : { id: b.id, type: b.type, content: b.content }); // ostatním hráčům se metadata neposílají
}

function blockText(b) {
  const c = b.content || {};
  const raw = [c.text, c.caption, c.name, c.meta, c.traits, c.actions, ...(c.items || [])].filter(Boolean).join(' ');
  return raw.replace(/\[\[(\d+)(?:\|([^\]]*))?\]\]/g, '$2'); // reference → jen popisek
}

/** Text bloku PRO KONKRÉTNÍHO DIVÁKA — cizí jazyky, kterým nerozumí, jsou
    zašifrované i ve vyhledávání a náhledech (jinak by je našel hledáním). */
/** Základní HTML entity → čitelný text (&amp; až nakonec, jinak by rozbil ostatní). */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
function searchableBlockText(b, viewer, campaignId) {
  const c = b.content || {};
  if (typeof c.html === 'string' && c.html.trim()) {
    const base = processLangs(c.html, viewer, campaignId).replace(/<[^>]*>/g, ' ');
    const extra = [c.caption, c.name, c.meta, c.traits, c.actions, ...(c.items || [])].filter(Boolean).join(' ');
    // entity dekódovat a stlačit mezery — jinak by v úryvku svítilo „bratr&nbsp;“ a řady mezer po tazích
    return decodeEntities((base + ' ' + extra).replace(/\[\[(\d+)(?:\|([^\]]*))?\]\]/g, '$2'))
      .replace(/\s+/g, ' ').trim();
  }
  return blockText(b);
}

/**
 * Sanitizace rich-text HTML z editoru (whitelist tagů a atributů).
 * Vše ostatní se zahodí — obrana proti XSS.
 */
function sanitizeHTML(html) {
  return String(html).replace(/<[^>]*>?/g, tag => {
    const m = /^<(\/?)(b|strong|i|em|u|s|strike|br|font|span|div|p|img)\b([^>]*?)\/?>$/i.exec(tag);
    if (!m) return '';
    const name = m[2].toLowerCase();
    if (m[1]) return name === 'img' ? '' : `</${name}>`;
    if (name === 'img') { // jen interní obrázky, žádné externí URL
      const src = /src="(\/api\/images\/\d+)(?:\?[^"]*)?"/i.exec(m[3]);
      if (!src) return '';
      const st = /style="([^"]*)"/i.exec(m[3]);
      let styleAttr = '';
      if (st) {
        const safe = st[1].split(';').map(s => s.trim())
          .filter(s => /^(width|max-width)\s*:\s*[\d.]{1,6}(%|px)$/i.test(s)).join('; ');
        if (safe) styleAttr = ` style="${safe}"`;
      }
      // příznak „zobrazit i v náhledech“ — povolena jediná hodnota, nic jiného neprojde
      const prev = /data-preview="1"/i.test(m[3]) ? ' data-preview="1"' : '';
      return `<img src="${src[1]}"${styleAttr}${prev}>`;
    }
    let attrs = '';
    if (name === 'font') {
      const color = /color="([#\w(),.\s%-]{1,40})"/i.exec(m[3]);
      const size = /size="([1-7])"/i.exec(m[3]);
      if (color) attrs += ` color="${color[1]}"`;
      if (size) attrs += ` size="${size[1]}"`;
    } else if (name === 'span' || name === 'div' || name === 'p') {
      const st = /style="([^"]*)"/i.exec(m[3]);
      if (st) {
        const safe = st[1].split(';').map(s => s.trim())
          .filter(s => /^(color|font-size|font-weight|font-style|text-decoration(-line)?)\s*:\s*[#\w(),.\s%-]{1,60}$/i.test(s))
          .join('; ');
        if (safe) attrs = ` style="${safe}"`;
      }
      const cls = /class="([^"]*)"/i.exec(m[3]);
      if (cls && cls[1].trim() === 'spoiler') attrs += ' class="spoiler"'; // označení spoileru
      if (cls && cls[1].trim() === 'lang') { // označení cizím jazykem
        const dl = /data-lang="(\d+)"/i.exec(m[3]);
        // class="lang" se zachovává i BEZ data-lang — jinak by se označení ztratilo
        // a jazykový filtr by text propustil (dohledá se podle barvy, jinak fail-closed)
        attrs += dl ? ` class="lang" data-lang="${dl[1]}"` : ' class="lang"';
      }
    }
    return `<${name}${attrs}>`;
  });
}

/**
 * Inline reference [[id|popisek]] — server je před odesláním vyhodnotí:
 * viditelný cíl → reference zůstane (s doplněným popiskem),
 * skrytý cíl → zbyde jen prostý text popisku (id se hráči vůbec neodešle).
 */
function processRefs(str, viewer, campaignId) {
  return String(str).replace(/\[\[(\d+)(?:\|([^\]]*))?\]\]/g, (_, idStr, label) => {
    const id = parseInt(idStr, 10);
    const target = db.articles.find(a => a.id === id && a.campaignId === campaignId);
    if (!target) return label || '';
    const name = label || target.title;
    const visible = viewer.isDM || articleVisibleToPlayer(id, viewer.userId);
    return visible ? `[[${id}|${name}]]` : name;
  });
}

/** ID obrázků vložených PŘÍMO do rich textu a označených „zobrazit v náhledech“. */
function inlinePreviewImgs(b) {
  const html = (b.content || {}).html;
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  const rx = /<img\b(?=[^>]*\bdata-preview="1")[^>]*\bsrc="\/api\/images\/(\d+)"[^>]*>/gi;
  let m;
  while ((m = rx.exec(html))) out.push(parseInt(m[1], 10));
  return out;
}

/** Náhledové obrázky bloku (dle typu) — obrázkový blok se zaškrtnutým „zobrazit v náhledu“
    i obrázky vložené do textu s příznakem data-preview. Nezaškrtnuté se nikdy neukazují. */
function blockPreviewImgs(b) {
  const out = [];
  if (b.type === 'image' && (b.content || {}).imageId && b.content.preview) out.push(b.content.imageId);
  out.push(...inlinePreviewImgs(b));
  return out;
}

/** Náhledový obrázek pro seznam: čtvercový ořez titulního obrázku, titulní obrázek,
    jinak PRVNÍ viditelný náhledový obrázek v pořadí bloků.
    Skrytý blok svůj obrázek do náhledu nepustí — jinak by prozradil obsah. */
function thumbFor(a, viewer) {
  if (a.coverThumbId) return a.coverThumbId;
  if (a.coverImageId) return a.coverImageId;
  for (const b of articleBlocks(a.id)) {
    if (!viewer.isDM && !blockAllowedForPlayer(b, viewer.userId)) continue;
    const ids = blockPreviewImgs(b);
    if (ids.length) return ids[0];
  }
  return null;
}

/** Všechny náhledy pro seznam: titulní + označené obrázky z bloků (dle oprávnění). */
function thumbsFor(a, viewer) {
  const out = [];
  const main = thumbFor(a, viewer);
  if (main) out.push(main);
  for (const b of articleBlocks(a.id)) {
    if (!viewer.isDM && !blockAllowedForPlayer(b, viewer.userId)) continue; // skrytý obrázek se v náhledu neobjeví
    for (const id of blockPreviewImgs(b)) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Zpětné reference: seznam článků, které na daný článek odkazují
 * (blokem „odkaz“ nebo inline referencí [[id]]). Hráč vidí jen odkazující
 * články, které smí vidět, a jen pokud je odkazující BLOK viditelný.
 */
function backlinksFor(a, viewer) {
  const marker = new RegExp(`\\[\\[${a.id}(\\||\\])`);
  const found = new Map();
  for (const b of db.blocks) {
    if (b.articleId === a.id) continue;
    const src = db.articles.find(x => x.id === b.articleId);
    if (!src || src.campaignId !== a.campaignId || src.sessionId) continue;
    if (found.has(src.id)) continue;
    const c = b.content || {};
    const refs = (b.type === 'link' && c.articleId === a.id)
      || marker.test(c.html || '') || marker.test(c.text || '')
      || (Array.isArray(c.items) && c.items.some(i => marker.test(i)));
    if (!refs) continue;
    if (!viewer.isDM) {
      if (!blockAllowedForPlayer(b, viewer.userId)) continue;
      if (!articleVisibleToPlayer(src.id, viewer.userId)) continue;
    }
    found.set(src.id, { id: src.id, title: src.title });
  }
  return [...found.values()].sort((x, y) => x.title.localeCompare(y.title, 'cs'));
}

function memberDisplayName(campaignId, userId) {
  const chars = db.characters.filter(c => c.campaignId === campaignId && c.userId === userId).map(c => c.name);
  if (chars.length) return chars.join(' / ');
  const m = getMembership(campaignId, userId);
  const u = db.users.find(u => u.id === userId);
  return (m && m.characterName) || (u ? u.username : '?');
}

/** Zajistí domovský článek kampaně (kategorie „Kampaň“, nelze smazat). */
function ensureHomeArticle(camp) {
  let home = db.articles.find(a => a.id === camp.homeArticleId);
  if (home) return home;
  const now = new Date().toISOString();
  home = {
    id: db.seq++, campaignId: camp.id, title: camp.name || 'O kampani',
    description: 'Domovská stránka kampaně', category: 'Kampaň', tags: '', coverImageId: null,
    isHome: true, createdAt: now, updatedAt: now
  };
  db.articles.push(home);
  db.blocks.push({ id: db.seq++, articleId: home.id, position: 0, type: 'paragraph', content: { text: 'Vítejte v kampani! Sem může DM zapsat úvod do světa, pravidla stolu a důležité odkazy.' }, visibility: 'all', visibleTo: [] });
  const camp2 = db.campaigns.find(c => c.id === camp.id); if (camp2) camp2.categories = [...new Set([...(camp2.categories || []), 'Kampaň'])];
  camp.homeArticleId = home.id;
  return home;
}

/** Vytvoří postavu a k ní propojený článek v kategorii „Hráčské postavy“. */
function createCharacter(campaignId, userId, name) {
  const now = new Date().toISOString();
  const art = {
    id: nextId(), campaignId, title: name, description: 'Hráčská postava',
    category: 'Hráčské postavy', tags: '', coverImageId: null, createdAt: now, updatedAt: now
  };
  db.articles.push(art);
  const camp = db.campaigns.find(c => c.id === campaignId);
  camp.categories = camp.categories || [];
  if (!camp.categories.includes('Hráčské postavy')) camp.categories.push('Hráčské postavy');
  const ch = { id: nextId(), campaignId, userId, name, articleId: art.id };
  db.characters.push(ch);
  save();
  return ch;
}

// ================================================================ HTTP helpery
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', ch => { size += ch.length; if (size > limit) { reject(new Error('Příliš velký požadavek')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch { return {}; }
}

/** Miniparser multipart/form-data pro jeden soubor (pole "file"). */
function parseMultipartFile(buffer, contentType) {
  const m = /boundary=(.+)$/.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1].replace(/^"|"$/g, ''));
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const headStart = start + boundary.length + 2; // \r\n
    const headEnd = buffer.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) break;
    const headers = buffer.slice(headStart, headEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headEnd);
    if (next === -1) break;
    if (/name="file"/.test(headers) && /filename="/.test(headers)) {
      const filename = (/filename="([^"]*)"/.exec(headers) || [])[1] || 'soubor';
      const mime = (/Content-Type:\s*([^\r\n]+)/i.exec(headers) || [])[1] || 'application/octet-stream';
      const data = buffer.slice(headEnd + 4, next - 2); // odečti \r\n před boundary
      return { filename, mime, data };
    }
    start = next;
  }
  return null;
}

/** Escape pro vložení textu do HTML (název aplikace v <title>). */
function escHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ================================================================ API routy
const routes = [];
function route(method, pattern, handler) {
  // pattern např. '/api/articles/:id'
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, k => { keys.push(k.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

// veřejné info aplikace (název pro přihlašovací obrazovku a lištu)
route('GET', '/api/app-info', async (req, res) => {
  sendJSON(res, 200, { name: (db.settings && db.settings.appName) || APP_NAME_DEFAULT });
});

// ================================================================ ADMINISTRACE (za master heslem)
route('POST', '/api/admin/auth', async (req, res, params, userId) => {
  if (!userId) return sendJSON(res, 401, { error: 'Nejdřív se přihlaste.' });
  const { masterPassword } = await readJSONBody(req);
  if (!checkMaster(masterPassword)) return sendJSON(res, 403, { error: 'Nesprávné master heslo.' });
  const sid = getSid(req);
  if (sid) adminTokens.add(sid);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/admin/logout', async (req, res) => {
  const sid = getSid(req); if (sid) adminTokens.delete(sid);
  sendJSON(res, 200, { ok: true });
});

function requireAdmin(req, res) {
  if (!isAdmin(req)) { sendJSON(res, 403, { error: 'Administrace není odemčena.' }); return false; }
  return true;
}

// přehled pro administraci: kampaně + uživatelé
route('GET', '/api/admin/overview', async (req, res, params, userId) => {
  if (!requireAdmin(req, res)) return;
  const campaigns = db.campaigns.map(c => {
    const mems = db.memberships.filter(m => m.campaignId === c.id);
    return {
      id: c.id, name: c.name,
      dms: mems.filter(m => m.role === 'dm').map(m => (db.users.find(u => u.id === m.userId) || {}).username).filter(Boolean),
      players: mems.filter(m => m.role === 'player').length,
      articles: db.articles.filter(a => a.campaignId === c.id).length,
      amIdm: !!getMembership(c.id, userId) && getMembership(c.id, userId).role === 'dm'
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  const users = db.users.map(u => ({
    id: u.id, username: u.username,
    memberships: db.memberships.filter(m => m.userId === u.id).map(m => ({
      campaign: (db.campaigns.find(c => c.id === m.campaignId) || {}).name || '?', role: m.role
    }))
  })).sort((a, b) => a.username.localeCompare(b.username, 'cs'));
  sendJSON(res, 200, { appName: (db.settings || {}).appName || APP_NAME_DEFAULT, campaigns, users });
});

// změna názvu aplikace
route('PUT', '/api/admin/app-name', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name } = await readJSONBody(req);
  if (!name || !String(name).trim()) return sendJSON(res, 400, { error: 'Zadejte název.' });
  db.settings.appName = String(name).trim().slice(0, 60);
  save();
  sendJSON(res, 200, { ok: true, name: db.settings.appName });
});

// export zálohy kampaně (JSON s obrázky v base64)
route('GET', '/api/admin/campaigns/:cid/export', async (req, res, params, userId, query) => {
  if (!requireAdmin(req, res)) return;
  const cid = parseInt(params.cid, 10);
  const camp = db.campaigns.find(c => c.id === cid);
  if (!camp) return sendJSON(res, 404, { error: 'Kampaň nenalezena.' });
  const artIds = new Set(db.articles.filter(a => a.campaignId === cid).map(a => a.id));
  const charIds = new Set(db.characters.filter(c => c.campaignId === cid).map(c => c.id));
  const roomIds = new Set(db.chatRooms.filter(r => r.campaignId === cid).map(r => r.id));
  const backup = {
    format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    campaign: { name: camp.name, categories: camp.categories, commonLangId: camp.commonLangId, description: camp.description || '', iconImageId: camp.iconImageId || null, homeArticleId: camp.homeArticleId || null, customSlots: camp.customSlots || [], slotCols: camp.slotCols || {}, slotOrder: camp.slotOrder || [] },
    users: [...new Set(db.memberships.filter(m => m.campaignId === cid).map(m => m.userId))]
      .map(uid => { const u = db.users.find(u => u.id === uid); return u ? { id: u.id, username: u.username } : null; }).filter(Boolean),
    memberships: db.memberships.filter(m => m.campaignId === cid),
    articles: db.articles.filter(a => a.campaignId === cid),
    blocks: db.blocks.filter(b => artIds.has(b.articleId)),
    characters: db.characters.filter(c => c.campaignId === cid),
    itemInstances: db.itemInstances.filter(i => i.campaignId === cid),
    invZones: db.invZones.filter(z => z.campaignId === cid),
    notes: db.notes.filter(n => artIds.has(n.articleId)),
    sessions: db.sessions.filter(s => s.campaignId === cid),
    templates: db.templates.filter(t => t.campaignId === cid),
    chatRooms: db.chatRooms.filter(r => r.campaignId === cid),
    chatMessages: db.chatMessages.filter(m => roomIds.has(m.roomId)),
    images: db.images.filter(i => i.campaignId === cid).map(i => {
      let b64 = '';
      try { b64 = fs.readFileSync(path.join(UPLOAD_DIR, i.filename)).toString('base64'); } catch { }
      return { id: i.id, originalName: i.originalName, mime: i.mime, data: b64 };
    })
  };
  const body = JSON.stringify(backup);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('zaloha-' + camp.name.replace(/[^\w-]+/g, '_') + '.json')}`
  });
  res.end(body);
});

// obnovení zálohy — vytvoří NOVOU kampaň (přemapuje ID, uživatele spojí podle jména)
route('POST', '/api/admin/import', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const buf = await readBody(req, 80 * 1024 * 1024);
  let backup;
  try { backup = JSON.parse(buf.toString('utf8')); } catch { return sendJSON(res, 400, { error: 'Soubor není platná záloha (JSON).' }); }
  if (!BACKUP_FORMATS_IN.includes(backup.format)) return sendJSON(res, 400, { error: 'Neznámý formát zálohy.' });
  const idMap = new Map(); // staré id -> nové id
  const remap = old => { if (old == null) return null; if (!idMap.has(old)) idMap.set(old, nextId()); return idMap.get(old); };
  // uživatelé: spoj podle uživatelského jména (ti, co existují); ostatní se vynechají
  const userMap = new Map();
  (backup.users || []).forEach(bu => { const u = db.users.find(x => x.username.toLowerCase() === String(bu.username).toLowerCase()); if (u) userMap.set(bu.id, u.id); });
  const mu = old => userMap.has(old) ? userMap.get(old) : null;

  const camp = { id: nextId(), name: (backup.campaign && backup.campaign.name || 'Obnovená kampaň') + ' (obnova)', categories: (backup.campaign && backup.campaign.categories) || [...SYSTEM_CATEGORIES], customSlots: (backup.campaign && backup.campaign.customSlots) || [], slotCols: (backup.campaign && backup.campaign.slotCols) || {}, slotOrder: (backup.campaign && backup.campaign.slotOrder) || [] };
  db.campaigns.push(camp);
  for (const s of SYSTEM_CATEGORIES) if (!camp.categories.includes(s)) camp.categories.push(s);

  // obrázky
  (backup.images || []).forEach(bi => {
    const nid = remap(bi.id);
    const filename = crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(bi.data || '', 'base64')); } catch { }
    db.images.push({ id: nid, campaignId: camp.id, filename, originalName: bi.originalName, mime: bi.mime });
  });
  // články
  (backup.articles || []).forEach(a => {
    const na = { ...a, id: remap(a.id), campaignId: camp.id };
    if (a.coverImageId) na.coverImageId = remap(a.coverImageId);
    if (a.coverThumbId) na.coverThumbId = remap(a.coverThumbId);
    if (a.sessionId) na.sessionId = remap(a.sessionId);
    db.articles.push(na);
  });
  // společný jazyk, domovský článek, ikonka, popis
  if (backup.campaign && backup.campaign.commonLangId) camp.commonLangId = remap(backup.campaign.commonLangId);
  else ensureCommonLanguage(camp);
  if (backup.campaign) {
    camp.description = backup.campaign.description || '';
    if (backup.campaign.iconImageId) camp.iconImageId = remap(backup.campaign.iconImageId);
    if (backup.campaign.homeArticleId) camp.homeArticleId = remap(backup.campaign.homeArticleId);
  }
  if (!db.articles.some(a => a.id === camp.homeArticleId)) ensureHomeArticle(camp);
  // bloky (přemapovat imageId a viditelnosti postav)
  (backup.blocks || []).forEach(b => {
    const nb = { ...b, id: remap(b.id), articleId: remap(b.articleId) };
    if (b.content && b.content.imageId) nb.content = { ...b.content, imageId: remap(b.content.imageId) };
    if (Array.isArray(b.visibleTo)) nb.visibleTo = b.visibleTo.map(remap);
    db.blocks.push(nb);
  });
  // postavy
  (backup.characters || []).forEach(c => {
    db.characters.push({ ...c, id: remap(c.id), campaignId: camp.id, userId: mu(c.userId), articleId: remap(c.articleId), languages: (c.languages || []).map(remap) });
  });
  // členství (jen pro existující uživatele)
  (backup.memberships || []).forEach(m => {
    const uid = mu(m.userId); if (!uid) return;
    if (!getMembership(camp.id, uid)) db.memberships.push({ campaignId: camp.id, userId: uid, role: m.role, characterName: m.characterName, defaultCharId: m.defaultCharId ? remap(m.defaultCharId) : null });
  });
  // inventář, poznámky, sezení, šablony, chat
  (backup.itemInstances || []).forEach(i => {
    const l = i.loc || {};
    const nl = l.t === 'slot' ? { t: 'slot', charId: remap(l.charId), slot: l.slot }
      : l.t === 'grid' ? { t: 'grid', cId: remap(l.cId), x: l.x, y: l.y }
        : { t: 'zone', zId: remap(l.zId) };
    db.itemInstances.push({ ...i, id: remap(i.id), campaignId: camp.id, articleId: remap(i.articleId), loc: nl });
  });
  (backup.invZones || []).forEach(z => db.invZones.push({ ...z, id: remap(z.id), campaignId: camp.id }));
  (backup.notes || []).forEach(n => db.notes.push({ ...n, id: remap(n.id), articleId: remap(n.articleId), authorId: mu(n.authorId), authorCharId: n.authorCharId ? remap(n.authorCharId) : null, visibleTo: (n.visibleTo || []).map(remap) }));
  (backup.sessions || []).forEach(s => {
    db.sessions.push({
      ...s, id: remap(s.id), campaignId: camp.id, reportArticleId: remap(s.reportArticleId),
      characters: (s.characters || []).map(remap),
      entries: (s.entries || []).map(e => ({ charId: remap(e.charId), blocks: (e.blocks || []).map(bl => ({ ...bl, id: remap(bl.id), visibleTo: (bl.visibleTo || []).map(remap) })) }))
    });
  });
  (backup.templates || []).forEach(t => db.templates.push({ ...t, id: remap(t.id), campaignId: camp.id }));
  (backup.chatRooms || []).forEach(r => db.chatRooms.push({ ...r, id: remap(r.id), campaignId: camp.id, characters: (r.characters || []).map(remap), sessionIds: (r.sessionIds || []).map(remap) }));
  (backup.chatMessages || []).forEach(m => db.chatMessages.push({ ...m, id: remap(m.id), roomId: remap(m.roomId), authorId: mu(m.authorId), authorCharId: m.authorCharId ? remap(m.authorCharId) : null, langId: m.langId ? remap(m.langId) : null, secretTo: Array.isArray(m.secretTo) ? m.secretTo.map(remap) : m.secretTo }));
  save();
  sendJSON(res, 200, { ok: true, campaignId: camp.id, name: camp.name });
});

// smazání kampaně se všemi daty
route('DELETE', '/api/admin/campaigns/:cid', async (req, res, params) => {
  if (!requireAdmin(req, res)) return;
  const cid = parseInt(params.cid, 10);
  if (!db.campaigns.some(c => c.id === cid)) return sendJSON(res, 404, { error: 'Kampaň nenalezena.' });
  const artIds = new Set(db.articles.filter(a => a.campaignId === cid).map(a => a.id));
  const charIds = new Set(db.characters.filter(c => c.campaignId === cid).map(c => c.id));
  const roomIds = new Set(db.chatRooms.filter(r => r.campaignId === cid).map(r => r.id));
  db.images.filter(i => i.campaignId === cid).forEach(i => { try { fs.unlinkSync(path.join(UPLOAD_DIR, i.filename)); } catch { } });
  db.images = db.images.filter(i => i.campaignId !== cid);
  db.blocks = db.blocks.filter(b => !artIds.has(b.articleId));
  db.notes = db.notes.filter(n => !artIds.has(n.articleId));
  db.articles = db.articles.filter(a => a.campaignId !== cid);
  db.itemInstances = db.itemInstances.filter(i => i.campaignId !== cid);
  db.invZones = db.invZones.filter(z => z.campaignId !== cid);
  db.invLog = db.invLog.filter(l => l.campaignId !== cid);
  db.characters = db.characters.filter(c => c.campaignId !== cid);
  db.sessions = db.sessions.filter(s => s.campaignId !== cid);
  db.templates = db.templates.filter(t => t.campaignId !== cid);
  db.chatMessages = db.chatMessages.filter(m => !roomIds.has(m.roomId));
  db.chatReads = db.chatReads.filter(r => !roomIds.has(r.roomId));
  db.chatRooms = db.chatRooms.filter(r => r.campaignId !== cid);
  db.memberships = db.memberships.filter(m => m.campaignId !== cid);
  db.campaigns = db.campaigns.filter(c => c.id !== cid);
  save();
  sendJSON(res, 200, { ok: true });
});

// vstup do kampaně jako další DM
route('POST', '/api/admin/campaigns/:cid/join-dm', async (req, res, params, userId) => {
  if (!requireAdmin(req, res)) return;
  if (!userId) return sendJSON(res, 401, { error: 'Nepřihlášen' });
  const cid = parseInt(params.cid, 10);
  if (!db.campaigns.some(c => c.id === cid)) return sendJSON(res, 404, { error: 'Kampaň nenalezena.' });
  const existing = getMembership(cid, userId);
  if (existing) { existing.role = 'dm'; } else db.memberships.push({ campaignId: cid, userId, role: 'dm', characterName: null });
  save();
  sendJSON(res, 200, { ok: true });
});

// ---------- auth
route('POST', '/api/register', async (req, res) => {
  const { username, password } = await readJSONBody(req);
  if (!username || !password || password.length < 4) return sendJSON(res, 400, { error: 'Zadejte jméno a heslo (min. 4 znaky).' });
  const uname = username.trim();
  if (db.users.some(u => u.username.toLowerCase() === uname.toLowerCase())) return sendJSON(res, 400, { error: 'Uživatelské jméno je již obsazené.' });
  const user = { id: nextId(), username: uname, passwordHash: hashPassword(password) };
  db.users.push(user); save();
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, user.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  sendJSON(res, 200, { id: user.id, username: user.username });
});

route('POST', '/api/login', async (req, res) => {
  const { username, password } = await readJSONBody(req);
  const user = db.users.find(u => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user || !verifyPassword(password || '', user.passwordHash)) return sendJSON(res, 401, { error: 'Nesprávné jméno nebo heslo.' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, user.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  sendJSON(res, 200, { id: user.id, username: user.username });
});

// Reset hesla pomocí master hesla (pro případ zapomenutého hesla)
route('POST', '/api/reset-password', async (req, res) => {
  const { username, masterPassword, newPassword } = await readJSONBody(req);
  const a = Buffer.from(String(masterPassword || ''));
  const b = Buffer.from(MASTER_PASSWORD);
  const masterOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!masterOk) return sendJSON(res, 403, { error: 'Nesprávné master heslo.' });
  const user = db.users.find(u => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user) return sendJSON(res, 404, { error: 'Uživatel neexistuje.' });
  if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: 'Nové heslo musí mít min. 4 znaky.' });
  user.passwordHash = hashPassword(newPassword);
  save();
  sendJSON(res, 200, { ok: true, username: user.username });
});

route('POST', '/api/logout', async (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  if (m) sessions.delete(m[1]);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  sendJSON(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res, params, userId) => {
  if (!userId) return sendJSON(res, 200, null);
  const u = db.users.find(u => u.id === userId);
  sendJSON(res, 200, u ? { id: u.id, username: u.username } : null);
});

// ---------- kampaně
route('GET', '/api/campaigns', async (req, res, params, userId) => {
  if (!userId) return sendJSON(res, 401, { error: 'Nepřihlášen' });
  const rows = db.memberships.filter(m => m.userId === userId).map(m => {
    const c = db.campaigns.find(c => c.id === m.campaignId);
    return c ? { id: c.id, name: c.name, role: m.role, defaultCharId: m.defaultCharId || null, description: c.description || '', iconImageId: c.iconImageId || null, homeArticleId: c.homeArticleId || null, navOrder: navOrderOf(c), customSlots: c.customSlots || [] } : null;
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  sendJSON(res, 200, rows);
});

// Výchozí postava hráče v kampani (uloženo k účtu — platí na všech zařízeních)
route('PUT', '/api/campaigns/:cid/default-char', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const m = userId && getMembership(cid, userId);
  if (!m) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const { charId } = await readJSONBody(req);
  const ch = db.characters.find(c => c.id === parseInt(charId, 10));
  if (!ch || ch.campaignId !== cid || ch.userId !== userId) return sendJSON(res, 404, { error: 'To není vaše postava.' });
  m.defaultCharId = ch.id;
  save();
  sendJSON(res, 200, { ok: true });
});

// Kdo je právě online v kampani (podle živých SSE spojení)
route('GET', '/api/campaigns/:cid/online', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  if (!userId || !getMembership(cid, userId)) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const set = sseClients.get(cid) || new Set();
  const ids = [...new Set([...set].map(c => c.userId))];
  const rows = ids.map(uid => {
    const u = db.users.find(u => u.id === uid);
    const m = getMembership(cid, uid);
    return u && m ? { username: u.username, dm: m.role === 'dm' } : null;
  }).filter(Boolean).sort((a, b) => (a.dm === b.dm ? a.username.localeCompare(b.username, 'cs') : a.dm ? -1 : 1));
  sendJSON(res, 200, rows);
});

route('POST', '/api/campaigns', async (req, res, params, userId) => {
  if (!userId) return sendJSON(res, 401, { error: 'Nepřihlášen' });
  const { name, description, iconImageId } = await readJSONBody(req);
  if (!name) return sendJSON(res, 400, { error: 'Zadejte název kampaně.' });
  const c = {
    id: nextId(), name: name.trim(), categories: [...SYSTEM_CATEGORIES],
    description: String(description || '').slice(0, 400),
    iconImageId: parseInt(iconImageId, 10) || null
  };
  db.campaigns.push(c);
  db.memberships.push({ campaignId: c.id, userId, role: 'dm', characterName: null });
  ensureCommonLanguage(c);
  ensureHomeArticle(c);
  save();
  sendJSON(res, 200, { id: c.id, name: c.name, role: 'dm' });
});

// nastavení kampaně (ikonka + popis) — smí kterýkoli DM kampaně
route('PUT', '/api/campaigns/:cid/settings', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const c = db.campaigns.find(c => c.id === cid);
  const body = await readJSONBody(req);
  if (body.name !== undefined && String(body.name).trim()) c.name = String(body.name).trim().slice(0, 80);
  if (body.description !== undefined) c.description = String(body.description || '').slice(0, 400);
  if (body.iconImageId !== undefined) c.iconImageId = parseInt(body.iconImageId, 10) || null;
  // pořadí navigace: bereme jen známé klíče, chybějící se doplní na konec (navOrderOf)
  if (body.navOrder !== undefined) {
    if (!Array.isArray(body.navOrder)) return sendJSON(res, 400, { error: 'Neplatné pořadí navigace.' });
    c.navOrder = navOrderOf({ navOrder: body.navOrder });
  }
  save();
  sendJSON(res, 200, { ok: true, navOrder: navOrderOf(c) });
});

route('GET', '/api/campaigns/:cid/players', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const rows = db.memberships.filter(m => m.campaignId === cid).map(m => {
    const u = db.users.find(u => u.id === m.userId);
    return { id: m.userId, username: u ? u.username : '?', character_name: m.characterName, role: m.role };
  }).sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username, 'cs') : a.role === 'dm' ? -1 : 1));
  sendJSON(res, 200, rows);
});

route('POST', '/api/campaigns/:cid/players', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { username, characterName } = await readJSONBody(req);
  const user = db.users.find(u => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user) return sendJSON(res, 404, { error: 'Uživatel neexistuje. Musí se nejprve zaregistrovat.' });
  if (getMembership(cid, user.id)) return sendJSON(res, 400, { error: 'Uživatel už je členem kampaně.' });
  db.memberships.push({ campaignId: cid, userId: user.id, role: 'player', characterName: characterName || null });
  if (characterName) createCharacter(cid, user.id, String(characterName).trim());
  save();
  sendJSON(res, 200, { ok: true });
});

// Seznam členů (jména) — pro všechny členy kampaně (kvůli poznámkám: komu zpřístupnit)
route('GET', '/api/campaigns/:cid/members', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  if (!userId || !getMembership(cid, userId)) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const rows = db.memberships.filter(m => m.campaignId === cid).map(m => ({
    id: m.userId, name: memberDisplayName(cid, m.userId), role: m.role
  })).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, 'cs') : a.role === 'dm' ? -1 : 1));
  sendJSON(res, 200, rows);
});

// Seznam postav kampaně — pro všechny členy (viditelnost a poznámky se cílí na postavy)
route('GET', '/api/campaigns/:cid/characters', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  if (!userId || !getMembership(cid, userId)) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const rows = db.characters.filter(ch => ch.campaignId === cid).map(ch => {
    const u = db.users.find(u => u.id === ch.userId);
    return { id: ch.id, userId: ch.userId, name: ch.name, articleId: ch.articleId, username: u ? u.username : '?', languages: charLangIds(ch) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  sendJSON(res, 200, rows);
});

// Seznam jazyků kampaně (články kategorie „Jazyk“) — jména a barvy vidí všichni členové
route('GET', '/api/campaigns/:cid/languages', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  if (!userId || !getMembership(cid, userId)) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const camp = db.campaigns.find(c => c.id === cid);
  sendJSON(res, 200, campaignLanguages(cid).map(a => ({
    id: a.id, title: a.title, color: a.langColor || '#9aa0a6', common: a.id === camp.commonLangId
  })).sort((a, b) => a.title.localeCompare(b.title, 'cs')));
});

// DM vytvoří hráči (další) postavu — vznikne i propojený článek, který hráč vlastní
route('POST', '/api/campaigns/:cid/characters', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { userId: targetId, name } = await readJSONBody(req);
  const m = getMembership(cid, parseInt(targetId, 10));
  if (!m || m.role !== 'player') return sendJSON(res, 404, { error: 'Hráč nenalezen.' });
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return sendJSON(res, 400, { error: 'Zadejte jméno postavy.' });
  const ch = createCharacter(cid, m.userId, clean);
  sendJSON(res, 200, { id: ch.id, articleId: ch.articleId });
});

// Nepřiřazené články hráčských postav (bez vlastníka) — pro DM
route('GET', '/api/campaigns/:cid/unassigned-characters', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const rows = db.articles
    .filter(a => a.campaignId === cid && a.category === 'Hráčské postavy' && !a.sessionId && !db.characters.some(c => c.articleId === a.id))
    .map(a => ({ id: a.id, title: a.title }))
    .sort((a, b) => a.title.localeCompare(b.title, 'cs'));
  sendJSON(res, 200, rows);
});

// DM nastaví/změní/odebere vlastníka článku hráčské postavy
route('POST', '/api/articles/:id/owner', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  if (a.category !== 'Hráčské postavy') return sendJSON(res, 400, { error: 'Vlastníka lze nastavit jen u hráčské postavy.' });
  const { userId: newOwner } = await readJSONBody(req);
  const existing = db.characters.find(c => c.articleId === a.id);
  if (newOwner) {
    const m = getMembership(a.campaignId, parseInt(newOwner, 10));
    if (!m || m.role !== 'player') return sendJSON(res, 404, { error: 'Hráč nenalezen.' });
    if (existing) { existing.userId = m.userId; existing.name = a.title; }
    else db.characters.push({ id: nextId(), campaignId: a.campaignId, userId: m.userId, name: a.title, articleId: a.id });
  } else if (existing) {
    db.characters = db.characters.filter(c => c.id !== existing.id); // článek zůstává, ztratí vlastníka
  }
  save();
  sendJSON(res, 200, { ok: true });
});

// DM změní vlastníka/jméno postavy; jazyky smí nastavit DM i vlastník postavy
route('PUT', '/api/characters/:id', async (req, res, params, userId, query) => {
  const ch = db.characters.find(c => c.id === parseInt(params.id, 10));
  if (!ch) return sendJSON(res, 404, { error: 'Postava nenalezena.' });
  const viewer = userId && resolveViewer(userId, ch.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const body = await readJSONBody(req);
  if (Array.isArray(body.languages)) {
    if (!viewer.realDM) return sendJSON(res, 403, { error: 'Jazyky postav nastavuje pouze DM.' });
    const langIds = campaignLanguages(ch.campaignId).map(a => a.id);
    ch.languages = body.languages.filter(id => langIds.includes(id));
  }
  if (body.userId || body.name) {
    if (!viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
    if (body.userId) {
      const m = getMembership(ch.campaignId, parseInt(body.userId, 10));
      if (!m || m.role !== 'player') return sendJSON(res, 404, { error: 'Cílový hráč nenalezen.' });
      ch.userId = m.userId;
    }
    if (body.name && String(body.name).trim()) ch.name = String(body.name).trim().slice(0, 60);
  }
  save();
  sendJSON(res, 200, { ok: true });
});

route('DELETE', '/api/characters/:id', async (req, res, params, userId, query) => {
  const ch = db.characters.find(c => c.id === parseInt(params.id, 10));
  if (!ch) return sendJSON(res, 404, { error: 'Postava nenalezena.' });
  const viewer = userId && resolveViewer(userId, ch.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  // inventář postavy: předměty na těle (a v nasazených kontejnerech) se smažou s ní
  const onChar = db.itemInstances.filter(i => { const r = rootLoc(i); return r.t === 'slot' && r.charId === ch.id; }).map(i => i.id);
  if (onChar.length) {
    db.itemInstances = db.itemInstances.filter(i => !onChar.includes(i.id));
    invLogAdd(ch.campaignId, viewer, `smazal postavu ${ch.name} včetně ${onChar.length} předmětů`);
  }
  db.characters = db.characters.filter(c => c.id !== ch.id);
  // odkazy na postavu ve viditelnosti se uklidí
  db.blocks.forEach(b => { if (Array.isArray(b.visibleTo)) b.visibleTo = b.visibleTo.filter(id => id !== ch.id); });
  db.notes.forEach(n => { if (Array.isArray(n.visibleTo)) n.visibleTo = n.visibleTo.filter(id => id !== ch.id); });
  save();
  sendJSON(res, 200, { ok: true }); // článek postavy zůstává, jen ztratí vlastníka
});

// Všichni registrovaní uživatelé, kteří ještě NEJSOU členy této kampaně —
// DM je odtud může přiřadit (jeden uživatel může být ve více kampaních)
route('GET', '/api/campaigns/:cid/available-users', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const rows = db.users
    .filter(u => !getMembership(cid, u.id))
    .map(u => ({
      id: u.id, username: u.username,
      // orientačně: v kolika kampaních už uživatel je
      campaigns: db.memberships.filter(m => m.userId === u.id).length
    }))
    .sort((a, b) => a.username.localeCompare(b.username, 'cs'));
  sendJSON(res, 200, rows);
});

// DM ručně vytvoří účet hráče (a rovnou ho přidá do kampaně)
route('POST', '/api/campaigns/:cid/users', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { username, password, characterName } = await readJSONBody(req);
  if (!username || !password || password.length < 4) return sendJSON(res, 400, { error: 'Zadejte jméno a heslo (min. 4 znaky).' });
  const uname = String(username).trim();
  if (db.users.some(u => u.username.toLowerCase() === uname.toLowerCase())) return sendJSON(res, 400, { error: 'Uživatelské jméno je již obsazené.' });
  const user = { id: nextId(), username: uname, passwordHash: hashPassword(password) };
  db.users.push(user);
  db.memberships.push({ campaignId: cid, userId: user.id, role: 'player', characterName: characterName || null });
  if (characterName) createCharacter(cid, user.id, String(characterName).trim());
  save();
  sendJSON(res, 200, { id: user.id, username: user.username });
});

// DM změní heslo hráči své kampaně
route('PUT', '/api/campaigns/:cid/players/:uid/password', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const uid = parseInt(params.uid, 10);
  const m = getMembership(cid, uid);
  if (!m || m.role !== 'player') return sendJSON(res, 404, { error: 'Hráč nenalezen.' });
  const { password } = await readJSONBody(req);
  if (!password || password.length < 4) return sendJSON(res, 400, { error: 'Heslo musí mít min. 4 znaky.' });
  const user = db.users.find(u => u.id === uid);
  user.passwordHash = hashPassword(password);
  save();
  sendJSON(res, 200, { ok: true });
});

route('DELETE', '/api/campaigns/:cid/players/:uid', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const uid = parseInt(params.uid, 10);
  db.memberships = db.memberships.filter(m => !(m.campaignId === cid && m.userId === uid && m.role === 'player'));
  save();
  sendJSON(res, 200, { ok: true });
});

// ---------- články
function articleListItem(a, viewer) {
  const thumbs = thumbsFor(a, viewer);
  return {
    id: a.id, title: a.title, description: a.description, category: a.category,
    tags: a.tags, cover_image_id: a.coverImageId, thumb_id: thumbs[0] || null, thumbs, updated_at: a.updatedAt
  };
}

route('GET', '/api/campaigns/:cid/articles', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  let rows = db.articles.filter(a => a.campaignId === cid && !a.sessionId); // zápisy ze sezení se v seznamech neukazují
  if (!viewer.isDM) rows = rows.filter(a => articleVisibleToPlayer(a.id, viewer.userId));
  if (query.category !== undefined) rows = rows.filter(a => (a.category || '') === query.category);
  rows = rows.slice().sort((a, b) => a.title.localeCompare(b.title, 'cs'));
  sendJSON(res, 200, rows.map(a => articleListItem(a, viewer)));
});

route('GET', '/api/campaigns/:cid/categories', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  let rows = db.articles.filter(a => a.campaignId === cid && !a.sessionId);
  if (!viewer.isDM) rows = rows.filter(a => articleVisibleToPlayer(a.id, viewer.userId));
  const counts = {};
  for (const a of rows) { const c = a.category || 'Nezařazeno'; counts[c] = (counts[c] || 0) + 1; }
  if (viewer.isDM) { // DM vidí i prázdné spravované kategorie
    const camp = db.campaigns.find(c => c.id === cid);
    for (const name of (camp.categories || [])) counts[name] = counts[name] || 0;
  }
  sendJSON(res, 200, Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'cs')));
});

// ---------- správa seznamu kategorií (DM)
route('GET', '/api/campaigns/:cid/category-list', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const camp = db.campaigns.find(c => c.id === cid);
  sendJSON(res, 200, {
    categories: (camp.categories || []).slice().sort((a, b) => a.localeCompare(b, 'cs')),
    system: SYSTEM_CATEGORIES // systémové kategorie nelze odebrat
  });
});

route('POST', '/api/campaigns/:cid/category-list', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { name, color } = await readJSONBody(req);
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return sendJSON(res, 400, { error: 'Zadejte název kategorie.' });
  const camp = db.campaigns.find(c => c.id === cid);
  camp.categories = camp.categories || [];
  if (!camp.categories.includes(clean)) camp.categories.push(clean);
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) { camp.catColors = camp.catColors || {}; camp.catColors[clean] = color; }
  save();
  sendJSON(res, 200, { ok: true });
});

// barvy kategorií (nádech v seznamu). Systémové mají pevné, ostatní volitelné.
route('GET', '/api/campaigns/:cid/category-colors', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  if (!userId || !getMembership(cid, userId)) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const camp = db.campaigns.find(c => c.id === cid);
  sendJSON(res, 200, { colors: (camp && camp.catColors) || {} });
});

route('PUT', '/api/campaigns/:cid/category-color', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { name, color } = await readJSONBody(req);
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return sendJSON(res, 400, { error: 'Neplatná barva.' });
  const camp = db.campaigns.find(c => c.id === cid);
  camp.catColors = camp.catColors || {};
  camp.catColors[String(name)] = color;
  save();
  sendJSON(res, 200, { ok: true });
});

route('POST', '/api/campaigns/:cid/category-list/remove', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { name } = await readJSONBody(req);
  if (SYSTEM_CATEGORIES.includes(name)) return sendJSON(res, 400, { error: 'Systémovou kategorii nelze odebrat.' });
  const camp = db.campaigns.find(c => c.id === cid);
  camp.categories = (camp.categories || []).filter(c => c !== name);
  // články z odebrané kategorie → Nezařazeno
  db.articles.forEach(a => { if (a.campaignId === cid && a.category === name) a.category = ''; });
  save();
  sendJSON(res, 200, { ok: true });
});

route('POST', '/api/campaigns/:cid/articles', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { title } = await readJSONBody(req);
  if (!title) return sendJSON(res, 400, { error: 'Zadejte název článku.' });
  const now = new Date().toISOString();
  const a = { id: nextId(), campaignId: cid, title: title.trim(), description: '', category: '', tags: '', coverImageId: null, createdAt: now, updatedAt: now };
  db.articles.push(a); save();
  sendJSON(res, 200, { id: a.id });
});

route('GET', '/api/articles/:id', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  // Hráč se nesmí dozvědět, že skrytý článek existuje → stejná 404 jako u neexistujícího.
  if (!viewer.isDM && !articleVisibleToPlayer(a.id, viewer.userId)) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const blocks = visibleBlocksForViewer(a.id, viewer);
  // Surová data (bez jazykové transformace) dostane jen DM, nebo vlastník
  // při EXPLICITNÍ editaci (?edit=1). Při čtení platí znalosti postavy i pro vlastníka.
  const rawForEditor = viewer.isDM || (String(query.edit || '') === '1' && isArticleOwner(a.id, viewer.userId));
  for (const b of blocks) {
    b.content = { ...b.content };
    // Inline reference [[id|popisek]] — vyhodnocení viditelnosti cíle na serveru
    if (typeof b.content.html === 'string') {
      b.content.html = processRefs(b.content.html, viewer, a.campaignId);
      if (!rawForEditor) b.content.html = processLangs(b.content.html, viewer, a.campaignId);
    }
    if (typeof b.content.text === 'string') b.content.text = processRefs(b.content.text, viewer, a.campaignId);
    // prostá kopie textu by čtenáři prozradila obsah cizího jazyka — když existuje html, neposílá se
    if (!rawForEditor && typeof b.content.html === 'string' && b.content.html.trim() && typeof b.content.text === 'string') {
      b.content.text = '';
    }
    if (Array.isArray(b.content.items)) b.content.items = b.content.items.map(i => processRefs(i, viewer, a.campaignId));
    if (b.type === 'link' && b.content.articleId) {
      const t = db.articles.find(x => x.id === b.content.articleId);
      b.content.title = t ? t.title : '???';
    }
  }
  const linkedChar = db.characters.find(ch => ch.articleId === a.id);
  sendJSON(res, 200, {
    langColor: a.langColor || null,
    id: a.id, campaignId: a.campaignId, title: a.title, description: a.description,
    category: a.category, tags: a.tags, coverImageId: a.coverImageId,
    coverThumbId: a.coverThumbId || null,
    coverWidth: a.coverWidth || 100,
    sessionId: a.sessionId || null,
    backlinks: backlinksFor(a, viewer),
    // metadata předmětu — tajný popis dostane jen DM (hráč až přes identifikovanou instanci)
    item: a.item ? (viewer.isDM ? a.item : { ...a.item, secretText: undefined }) : null,
    charMeta: a.charMeta || null, // metadata hráčské postavy (rasa/třída/úroveň…)
    isHome: !!a.isHome, // domovský článek kampaně — nelze smazat
    character: linkedChar ? { id: linkedChar.id, name: linkedChar.name, userId: linkedChar.userId } : null,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
    owned: !viewer.isDM && isArticleOwner(a.id, viewer.userId), // hráč vlastní článek své postavy
    blocks
  });
});

/**
 * Náhled článku pro bublinu u reference.
 * Hráč bez oprávnění dostane 404 s hláškou — žádný obsah neunikne.
 */
route('GET', '/api/articles/:id/preview', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek neexistuje.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'K tomuto článku nemáte přístup.' });
  if (!viewer.isDM && !articleVisibleToPlayer(a.id, viewer.userId)) {
    return sendJSON(res, 404, { error: 'K tomuto článku nemáte přístup.' });
  }
  // úryvek z prvního viditelného textového bloku (cizí jazyky zašifrované dle znalostí)
  let snippet = '';
  for (const b of articleBlocks(a.id)) {
    if (b.type === 'heading' || b.type === 'dm_note') continue;
    if (!viewer.isDM && !blockAllowedForPlayer(b, viewer.userId)) continue;
    const t = searchableBlockText(b, viewer, a.campaignId).replace(/\s+/g, ' ').trim();
    if (t) { snippet = t.slice(0, 220) + (t.length > 220 ? '…' : ''); break; }
  }
  sendJSON(res, 200, {
    id: a.id, title: a.title, description: a.description, category: a.category,
    snippet, thumbId: thumbFor(a, viewer)
  });
});

route('PUT', '/api/articles/:id', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const asDM = viewer.realDM && !parseInt(query.viewAs || 0, 10);
  const asOwner = !asDM && isArticleOwner(a.id, userId);
  if (!asDM && !asOwner) return sendJSON(res, 403, { error: 'Nemáte oprávnění článek upravit.' });

  const body = await readJSONBody(req);
  a.title = (body.title || a.title).trim();
  a.description = body.description || '';
  if (asDM) a.category = (body.category || '').trim(); // vlastník kategorii měnit nemůže
  a.tags = body.tags || '';
  if (a.category === 'Jazyk') { // jazyk musí mít unikátní barvu
    const color = String(body.langColor || a.langColor || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return sendJSON(res, 400, { error: 'Jazyk musí mít přiřazenou barvu.' });
    const taken = campaignLanguages(a.campaignId).some(x => x.id !== a.id && (x.langColor || '').toLowerCase() === color.toLowerCase());
    if (taken) return sendJSON(res, 400, { error: 'Tato barva už je použita jiným jazykem — vyberte jinou.' });
    a.langColor = color;
  }
  if (a.category) { // nová kategorie se automaticky přidá do spravovaného seznamu
    const camp = db.campaigns.find(c => c.id === a.campaignId);
    camp.categories = camp.categories || [];
    if (!camp.categories.includes(a.category)) camp.categories.push(a.category);
  }
  a.coverImageId = body.coverImageId || null;
  a.coverThumbId = body.coverThumbId || null; // čtvercový ořez pro seznam
  a.coverWidth = [25, 50, 75, 100].includes(body.coverWidth) ? body.coverWidth : (a.coverWidth || 100);
  if (body.item && typeof body.item === 'object') { // metadata předmětu (vč. grafického inventáře)
    const it = body.item;
    const cl = (v, lo, hi, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };
    let container = null; // mřížka kontejneru: buňky s barvou zóny (g/y/r)
    if (it.container && Array.isArray(it.container.cells)) {
      const seen = new Set(); const cells = [];
      for (const c of it.container.cells.slice(0, 144)) {
        const x = cl(c.x, 0, 11, -1), y = cl(c.y, 0, 11, -1);
        if (x < 0 || y < 0) continue;
        const k = x + ',' + y; if (seen.has(k)) continue; seen.add(k);
        cells.push({ x, y, c: ['g', 'y', 'r'].includes(c.c) ? c.c : 'g' });
      }
      if (cells.length) {
        const mx = Math.min(...cells.map(c => c.x)), my = Math.min(...cells.map(c => c.y));
        cells.forEach(c => { c.x -= mx; c.y -= my; }); // tvar začíná vždy v 0,0
        container = { cells };
      }
    }
    let shape = null; // tvar tokenu: normalizované buňky; w/h se dopočítá z obálky
    if (Array.isArray(it.shape) && it.shape.length) {
      const seen = new Set(); const cellsS = [];
      for (const c of it.shape.slice(0, 36)) {
        const x = cl(c.x, 0, 5, -1), y = cl(c.y, 0, 5, -1);
        if (x < 0 || y < 0) continue;
        const k = x + ',' + y; if (seen.has(k)) continue; seen.add(k);
        cellsS.push({ x, y });
      }
      if (cellsS.length) {
        const mx = Math.min(...cellsS.map(c => c.x)), my = Math.min(...cellsS.map(c => c.y));
        cellsS.forEach(c => { c.x -= mx; c.y -= my; });
        shape = cellsS;
      }
    }
    const shW = shape ? Math.max(...shape.map(c => c.x)) + 1 : cl(it.w, 1, 6, 1);
    const shH = shape ? Math.max(...shape.map(c => c.y)) + 1 : cl(it.h, 1, 6, 1);
    a.item = {
      weight: Math.max(0, parseFloat(it.weight) || 0),
      price: String(it.price || '').slice(0, 40),
      rarity: String(it.rarity || '').slice(0, 40),
      tokenImageId: parseInt(it.tokenImageId, 10) || null,
      w: shW, h: shH, shape,
      wearable: !!it.wearable, twoHanded: !!it.twoHanded,
      stackable: !!it.stackable, stackMax: cl(it.stackMax, 1, 99, 10),
      noDrop: !!it.noDrop,
      hpMax: cl(it.hpMax, 1, 10, 10),
      identifiedDefault: !!it.identifiedDefault,
      unidentifiedName: String(it.unidentifiedName || '').slice(0, 80),
      publicText: String(it.publicText || '').slice(0, 1000),
      secretText: String(it.secretText || '').slice(0, 2000),
      bodySize: cl(it.bodySize, 1, 4, 4),
      slots: Array.isArray(it.slots)
        ? it.slots.map(String).filter(s => slotCapsFor(db.campaigns.find(c => c.id === a.campaignId))[s]).slice(0, 40)
        : [],
      container
    };
  }
  if (body.charMeta && typeof body.charMeta === 'object') { // metadata hráčské postavy (rasa, třída…)
    const cm = body.charMeta;
    a.charMeta = {
      race: String(cm.race || '').slice(0, 80), classes: String(cm.classes || '').slice(0, 120),
      level: parseInt(cm.level, 10) || null, background: String(cm.background || '').slice(0, 80),
      alignment: String(cm.alignment || '').slice(0, 40)
    };
  }
  a.updatedAt = new Date().toISOString();

  // Vlastník bloky "pouze DM" a interní poznámky DM vůbec nedostal —
  // při jeho ukládání se proto zachovají (připojí se na konec).
  const preserved = asOwner
    ? db.blocks.filter(b => b.articleId === a.id && (b.visibility === 'dm' || b.type === 'dm_note'))
    : [];
  db.blocks = db.blocks.filter(b => b.articleId !== a.id);
  let pos = 0;
  const validChar = id => db.characters.some(ch => ch.id === id && ch.campaignId === a.campaignId);
  if (Array.isArray(body.blocks)) {
    body.blocks.forEach((b) => {
      let type = String(b.type || 'paragraph');
      if (asOwner && type === 'dm_note') return; // vlastník DM poznámky nevytváří
      // Interní poznámka DM je vždy jen pro DM; vlastník nemůže blok skrýt sám před sebou.
      let visibility = type === 'dm_note' ? 'dm' : (['all', 'dm', 'custom'].includes(b.visibility) ? b.visibility : 'all');
      if (asOwner && visibility === 'dm') visibility = 'custom'; // = jen vlastník + DM
      const visibleTo = visibility === 'custom'
        ? (Array.isArray(b.visibleTo) ? b.visibleTo.filter(validChar) : [])
        : [];
      const content = { ...(b.content || {}) };
      if (typeof content.html === 'string') content.html = sanitizeHTML(content.html); // XSS ochrana
      db.blocks.push({ id: nextId(), articleId: a.id, position: pos++, type, content, visibility, visibleTo });
    });
  }
  preserved.forEach(b => { b.position = pos++; db.blocks.push(b); });
  save();
  sendJSON(res, 200, { ok: true });
});

route('DELETE', '/api/articles/:id', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  if (a.isHome) return sendJSON(res, 400, { error: 'Domovský článek kampaně nelze smazat — lze ho jen upravit.' });
  // instance předmětu mizí se svým článkem; obsah mazaných kontejnerů také
  // (kontejnery se nevnořují, takže stačí jedna úroveň)
  const gone = db.itemInstances.filter(i => i.articleId === a.id).map(i => i.id);
  if (gone.length) db.itemInstances = db.itemInstances.filter(i =>
    !gone.includes(i.id) && !(i.loc && i.loc.t === 'grid' && gone.includes(i.loc.cId)));
  db.articles = db.articles.filter(x => x.id !== a.id);
  db.blocks = db.blocks.filter(b => b.articleId !== a.id);
  save();
  sendJSON(res, 200, { ok: true });
});

// ---------- poznámky uživatelů k článkům (se schvalováním DM)
/**
 * Pravidla viditelnosti poznámky:
 * - autor ji vidí vždy (i neschválenou, se stavem "čeká na schválení"),
 * - DM vidí všechny poznámky; u článku postavy je vidí i její vlastník,
 * - schvaluje DM, u článku postavy také její vlastník,
 * - zaškrtnuté postavy ji vidí až PO schválení.
 */
function noteVisibleTo(n, viewer) {
  if (viewer.isDM) return true;
  const a = db.articles.find(a => a.id === n.articleId);
  if (!a) return false;
  const active = userCharIds(a.campaignId, viewer.userId);
  // autorství je na úrovni POSTAVY — jiná postava téhož hráče poznámku nevidí
  if (n.authorCharId) { if (active.includes(n.authorCharId)) return true; }
  else if (n.authorId === viewer.userId) return true; // starší poznámky / poznámky DM
  if (isArticleOwner(n.articleId, viewer.userId)) return true; // vlastník článku postavy vidí vše
  return !!n.approved && (n.visibleTo || []).some(id => active.includes(id));
}
function canApproveNote(articleId, userId) {
  const a = db.articles.find(a => a.id === articleId);
  if (!a) return false;
  const m = getMembership(a.campaignId, userId);
  if (!m) return false;
  return m.role === 'dm' || isArticleOwner(articleId, userId);
}

route('GET', '/api/articles/:id/notes', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  if (!viewer.isDM && !articleVisibleToPlayer(a.id, viewer.userId)) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const owner = isArticleOwner(a.id, viewer.userId);
  const activeCh = userCharIds(a.campaignId, viewer.userId);
  const notes = db.notes
    .filter(n => n.articleId === a.id && noteVisibleTo(n, viewer))
    .map(n => {
      const authorCh = n.authorCharId && db.characters.find(c => c.id === n.authorCharId);
      const mine = n.authorCharId ? activeCh.includes(n.authorCharId) : n.authorId === viewer.userId;
      return {
        id: n.id, text: n.text, approved: !!n.approved, createdAt: n.createdAt,
        author: authorCh ? authorCh.name : memberDisplayName(a.campaignId, n.authorId),
        mine,
        visibleTo: (viewer.isDM || owner || mine) ? (n.visibleTo || []) : undefined
      };
    });
  sendJSON(res, 200, notes);
});

route('POST', '/api/articles/:id/notes', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  // EMULACE: DM v režimu „zobrazit jako“ zapisuje JAKO daný hráč
  const authorId = viewer.userId;
  if (!viewer.isDM && !articleVisibleToPlayer(a.id, authorId)) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const { text, visibleTo } = await readJSONBody(req);
  if (!text || !String(text).trim()) return sendJSON(res, 400, { error: 'Poznámka je prázdná.' });
  const authorMembership = getMembership(a.campaignId, authorId);
  const authorCharId = (authorMembership && authorMembership.role === 'dm') ? null : (userCharIds(a.campaignId, authorId)[0] || null);
  // adresáty mohou být VŠECHNY ostatní postavy (i další postavy téhož hráče) — jen ne autorská
  const cleanVisibleTo = (Array.isArray(visibleTo) ? visibleTo : [])
    .filter(chId => { const ch = db.characters.find(c => c.id === chId); return ch && ch.campaignId === a.campaignId && chId !== authorCharId; });
  const note = {
    id: nextId(), articleId: a.id, authorId,
    authorCharId, // autorem je AKTIVNÍ POSTAVA (u DM žádná)
    text: String(text).slice(0, 5000), visibleTo: cleanVisibleTo,
    approved: canApproveNote(a.id, authorId), // DM a vlastník článku postavy schválení nepotřebují
    createdAt: new Date().toISOString()
  };
  db.notes.push(note); save();
  sendJSON(res, 200, { id: note.id, approved: note.approved });
});

route('PUT', '/api/notes/:id', async (req, res, params, userId, query) => {
  const n = db.notes.find(n => n.id === parseInt(params.id, 10));
  if (!n) return sendJSON(res, 404, { error: 'Poznámka nenalezena.' });
  const a = db.articles.find(a => a.id === n.articleId);
  const m = userId && getMembership(a.campaignId, userId);
  if (!m || n.authorId !== userId) return sendJSON(res, 403, { error: 'Jen autor může poznámku upravit.' });
  const { text, visibleTo } = await readJSONBody(req);
  if (text) n.text = String(text).slice(0, 5000);
  if (Array.isArray(visibleTo)) n.visibleTo = visibleTo.filter(chId => { const ch = db.characters.find(c => c.id === chId); return ch && ch.campaignId === a.campaignId && chId !== n.authorCharId; });
  n.approved = canApproveNote(a.id, userId); // úprava vyžaduje nové schválení
  save();
  sendJSON(res, 200, { ok: true });
});

route('POST', '/api/notes/:id/approve', async (req, res, params, userId, query) => {
  const n = db.notes.find(n => n.id === parseInt(params.id, 10));
  if (!n) return sendJSON(res, 404, { error: 'Poznámka nenalezena.' });
  if (!userId || !canApproveNote(n.articleId, userId)) return sendJSON(res, 403, { error: 'Schvaluje DM nebo vlastník postavy.' });
  n.approved = true; save();
  sendJSON(res, 200, { ok: true });
});

route('DELETE', '/api/notes/:id', async (req, res, params, userId, query) => {
  const n = db.notes.find(n => n.id === parseInt(params.id, 10));
  if (!n) return sendJSON(res, 404, { error: 'Poznámka nenalezena.' });
  const a = db.articles.find(a => a.id === n.articleId);
  const m = userId && getMembership(a.campaignId, userId);
  if (!m || (n.authorId !== userId && !canApproveNote(n.articleId, userId))) return sendJSON(res, 403, { error: 'Nemáte oprávnění.' });
  db.notes = db.notes.filter(x => x.id !== n.id); save();
  sendJSON(res, 200, { ok: true });
});

// ================================================================ INVENTÁŘ POSTAV
/**
 * Inventář vidí jen DM a vlastník postavy.
 * Poznámky u předmětu: 'dm' = jen DM (+ autor), 'dm_owner' = DM + vlastník postavy.
 */
// ================================================================ GRAFICKÝ INVENTÁŘ
// Instance předmětu = konkrétní kus (vlastní životy, identifikace, pozice).
// Umístění (loc): {t:'slot',charId,slot} na těle | {t:'grid',cId,x,y} v kontejneru | {t:'zone',zId} na podlaze.
// Práva: DM vše; hráč jen předměty, jejichž kořen (po vynoření z kontejnerů) je jeho postava nebo zóna.

// Sloty na těle: kapacita v políčkách. Na těle se tvar tokenu neřeší — slot je „zásuvka“
// s limitem políček (dohodnuto: štít 2×2 se do ruky vejde, rozhoduje počet políček).
const HANDS = ['handR', 'handL'];
/** Kapacity slotů kampaně: vestavěné + vlastní (DM je zakládá na stránce Inventář). */
function slotCapsFor(camp) {
  const caps = { ...BODY_SLOTS };
  for (const s of (camp && camp.customSlots) || []) caps[s.key] = s.cap;
  return caps;
}

function itemMeta(art) { return (art && art.item) || {}; }
function instArticle(inst) { return db.articles.find(a => a.id === inst.articleId); }
function instShape(inst) {
  const m = itemMeta(instArticle(inst));
  const w = Math.max(1, parseInt(m.w, 10) || 1), h = Math.max(1, parseInt(m.h, 10) || 1);
  return inst.rot ? { w: h, h: w } : { w, h };
}
/** Buňky tvaru předmětu (normalizované, bez otočení). Bez uloženého tvaru = plný obdélník. */
function shapeCells(m) {
  if (Array.isArray(m.shape) && m.shape.length) return m.shape;
  const w = Math.max(1, parseInt(m.w, 10) || 1), h = Math.max(1, parseInt(m.h, 10) || 1);
  const out = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) out.push({ x, y });
  return out;
}
/** Absolutní buňky tvaru položené na (X,Y), případně otočené o 90°. */
function placedCells(m, X, Y, rot) {
  const h = Math.max(1, parseInt(m.h, 10) || 1);
  return shapeCells(m).map(c => rot
    ? { x: X + (h - 1 - c.y), y: Y + c.x }
    : { x: X + c.x, y: Y + c.y });
}
/** Kolik políček předmět zabírá na TĚLE (kontejner může mít vlastní údaj „bodySize“). */
function instBodyCells(inst) {
  const m = itemMeta(instArticle(inst));
  if (m.container && m.bodySize) return Math.max(1, parseInt(m.bodySize, 10) || 1);
  return shapeCells(m).length;
}
/** Kořenové umístění — vynoří se z kontejneru na tělo/zónu. */
function rootLoc(inst) {
  let cur = inst.loc, guard = 0;
  while (cur && cur.t === 'grid' && guard++ < 12) {
    const cont = db.itemInstances.find(i => i.id === cur.cId);
    if (!cont) break;
    cur = cont.loc;
  }
  return cur || { t: 'zone', zId: 0 };
}
/** Smí aktér s předmětem hýbat / číst jeho detail? Fail closed. */
function canTouchInst(inst, viewer) {
  if (viewer.isDM) return true;
  const root = rootLoc(inst);
  if (root.t === 'zone') return true; // podlaha je společná pro celou kampaň
  if (root.t === 'slot') {
    const ch = db.characters.find(c => c.id === root.charId);
    return !!ch && ch.userId === viewer.userId;
  }
  return false;
}
/** Pohled na instanci pro diváka — neidentifikovaný kus neprozradí pravé jméno ani tajný popis. */
function instView(inst, viewer) {
  const art = instArticle(inst) || { title: '???', id: 0 };
  const m = itemMeta(art);
  const full = viewer.isDM || !!inst.identified;
  const o = {
    id: inst.id, qty: inst.qty || 1, hp: inst.hp, hpMax: inst.hpMax,
    broken: inst.hp === 0, identified: !!inst.identified, rot: inst.rot ? 1 : 0, loc: inst.loc,
    w: Math.max(1, parseInt(m.w, 10) || 1), h: Math.max(1, parseInt(m.h, 10) || 1),
    tokenImageId: m.tokenImageId || null,
    wearable: !!m.wearable, twoHanded: !!m.twoHanded, stackable: !!m.stackable,
    noDrop: !!m.noDrop, bodyCells: instBodyCells(inst),
    slots: Array.isArray(m.slots) ? m.slots : [],
    shape: shapeCells(m),
    container: m.container ? { cells: m.container.cells } : null,
    publicText: String(m.publicText || ''),
    name: full ? art.title : (m.unidentifiedName || 'Neznámý předmět')
  };
  if (full) {
    o.secretText = String(m.secretText || '');
    if (viewer.isDM || articleVisibleToPlayer(art.id, viewer.userId)) o.articleId = art.id;
  }
  return o;
}
/** Zápis do deníku přesunů (drží se posledních 300 na kampaň). */
function invLogAdd(cid, viewer, text) {
  const chId = chatActiveChar(viewer, cid);
  const ch = chId && db.characters.find(c => c.id === chId);
  const u = db.users.find(x => x.id === viewer.userId);
  const who = ch ? ch.name : (viewer.isDM ? 'DM' : (u ? u.username : '?'));
  db.invLog.push({ id: nextId(), campaignId: cid, ts: new Date().toISOString(), who, text: String(text).slice(0, 300) });
  const mine = db.invLog.filter(l => l.campaignId === cid);
  if (mine.length > 300) {
    const cut = new Set(mine.slice(0, mine.length - 300).map(l => l.id));
    db.invLog = db.invLog.filter(l => !cut.has(l.id));
  }
}
/** Jméno instance pro deník — neidentifikovaný kus neprozradí pravé jméno ani tady. */
function instLogName(inst) {
  const art = instArticle(inst); const m = itemMeta(art);
  return inst.identified ? (art ? art.title : '?') : (m.unidentifiedName || 'Neznámý předmět');
}

/** Ověření umístění. Vrací text chyby, nebo null když je platné. */
function placeError(inst, to, rot, viewer) {
  const m = itemMeta(instArticle(inst));
  if (!to || typeof to !== 'object') return 'Neplatný cíl.';
  if (to.t === 'slot') {
    const caps = slotCapsFor(db.campaigns.find(c => c.id === inst.campaignId));
    if (!caps[to.slot]) return 'Neznámý slot.';
    const ch = db.characters.find(c => c.id === to.charId);
    if (!ch || ch.campaignId !== inst.campaignId) return 'Postava nenalezena.';
    if (!viewer.isDM && ch.userId !== viewer.userId) return 'Cizí postava.';
    if (!m.wearable) return 'Předmět není nositelný — patří do batohu nebo kapsy.';
    // velikost se na těle neřeší — rozhoduje jen seznam povolených slotů u předmětu
    if (Array.isArray(m.slots) && m.slots.length && !m.slots.includes(to.slot)) return 'Do tohoto slotu předmět nepatří.';
    const taken = db.itemInstances.find(i => i.id !== inst.id && i.loc && i.loc.t === 'slot' && i.loc.charId === ch.id && i.loc.slot === to.slot);
    if (taken) return 'Slot je obsazený.';
    const other = HANDS.find(h => h !== to.slot);
    if (m.twoHanded) {
      if (!HANDS.includes(to.slot)) return 'Obouruční předmět patří do ruky.';
      const inOther = db.itemInstances.find(i => i.id !== inst.id && i.loc && i.loc.t === 'slot' && i.loc.charId === ch.id && i.loc.slot === other);
      if (inOther) return 'Obouruční předmět potřebuje obě ruce volné.';
    } else if (HANDS.includes(to.slot)) {
      const inOther = db.itemInstances.find(i => i.id !== inst.id && i.loc && i.loc.t === 'slot' && i.loc.charId === ch.id && i.loc.slot === other);
      if (inOther && itemMeta(instArticle(inOther)).twoHanded) return 'Druhá ruka drží obouruční předmět.';
    }
    return null;
  }
  if (to.t === 'grid') {
    const cont = db.itemInstances.find(i => i.id === to.cId);
    if (!cont || cont.campaignId !== inst.campaignId) return 'Kontejner nenalezen.';
    const cm = itemMeta(instArticle(cont));
    if (!cm.container) return 'Cíl není kontejner.';
    if (m.container) return 'Kontejnery nejdou vkládat do sebe.';
    if (cont.id === inst.id) return 'Předmět nejde vložit sám do sebe.';
    if (!canTouchInst(cont, viewer)) return 'K tomuto kontejneru nemáte přístup.';
    const cells = new Set((cm.container.cells || []).map(c => c.x + ',' + c.y));
    const x = parseInt(to.x, 10), y = parseInt(to.y, 10);
    if (isNaN(x) || isNaN(y)) return 'Neplatná pozice.';
    // skutečný tvar (kříž, L…), ne jen obdélník
    const mine = placedCells(m, x, y, rot);
    for (const c of mine) if (!cells.has(c.x + ',' + c.y)) return 'Předmět se sem nevejde.';
    const mineSet = new Set(mine.map(c => c.x + ',' + c.y));
    for (const oth of db.itemInstances.filter(i => i.id !== inst.id && i.loc && i.loc.t === 'grid' && i.loc.cId === cont.id)) {
      const om = itemMeta(instArticle(oth));
      for (const c of placedCells(om, oth.loc.x, oth.loc.y, oth.rot))
        if (mineSet.has(c.x + ',' + c.y)) return 'Místo je obsazené.';
    }
    return null;
  }
  if (to.t === 'zone') {
    const z = db.invZones.find(z => z.id === to.zId);
    if (!z || z.campaignId !== inst.campaignId) return 'Zóna nenalezena.';
    if (!viewer.isDM && m.noDrop) return 'Tento předmět nejde odložit.';
    return null;
  }
  return 'Neplatný cíl.';
}
function normLoc(to) {
  if (!to || typeof to !== 'object') return null;
  if (to.t === 'slot') return { t: 'slot', charId: parseInt(to.charId, 10), slot: String(to.slot || '') };
  if (to.t === 'grid') return { t: 'grid', cId: parseInt(to.cId, 10), x: parseInt(to.x, 10) || 0, y: parseInt(to.y, 10) || 0 };
  if (to.t === 'zone') return { t: 'zone', zId: parseInt(to.zId, 10) };
  return null;
}

// ---------- postavy, jejichž inventář smím otevřít
route('GET', '/api/campaigns/:cid/inv/chars', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const chars = db.characters.filter(c => c.campaignId === cid && (viewer.isDM || c.userId === viewer.userId));
  sendJSON(res, 200, chars.map(c => ({ id: c.id, name: c.name })));
});

// ---------- inventář postavy (tělo + obsah nasazených kontejnerů)
route('GET', '/api/inv/char/:chId', async (req, res, params, userId, query) => {
  const ch = db.characters.find(c => c.id === parseInt(params.chId, 10));
  if (!ch) return sendJSON(res, 404, { error: 'Postava nenalezena.' });
  const viewer = userId && resolveViewer(userId, ch.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  if (!viewer.isDM && ch.userId !== viewer.userId) return sendJSON(res, 404, { error: 'Postava nenalezena.' }); // neprozradit ani existenci
  const items = db.itemInstances.filter(i => {
    if (i.campaignId !== ch.campaignId) return false;
    const r = rootLoc(i);
    return r.t === 'slot' && r.charId === ch.id;
  });
  const camp = db.campaigns.find(c => c.id === ch.campaignId);
  sendJSON(res, 200, {
    characterId: ch.id, characterName: ch.name,
    slots: slotCapsFor(camp),
    systemSlots: Object.entries(SYSTEM_SLOT_LABELS).map(([key, label]) => ({ key, label })),
    customSlots: (camp && camp.customSlots) || [],
    slotCols: Object.fromEntries(slotOrderOf(camp).map(k => [k, slotColOf(camp, k)])),
    slotOrder: slotOrderOf(camp),
    items: items.map(i => instView(i, viewer))
  });
});

// ---------- zóny podlahy
route('GET', '/api/campaigns/:cid/inv/zones', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const zones = db.invZones.filter(z => z.campaignId === cid).map(z => ({
    id: z.id, name: z.name,
    count: db.itemInstances.filter(i => i.loc && i.loc.t === 'zone' && i.loc.zId === z.id).length
  }));
  sendJSON(res, 200, zones);
});
route('POST', '/api/campaigns/:cid/inv/zones', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Zóny spravuje DM.' });
  const { name } = await readJSONBody(req);
  if (!name || !String(name).trim()) return sendJSON(res, 400, { error: 'Zadejte název zóny.' });
  const z = { id: nextId(), campaignId: cid, name: String(name).trim().slice(0, 60), createdAt: new Date().toISOString() };
  db.invZones.push(z); save(); sseBroadcast(cid, { inv: 1 });
  sendJSON(res, 200, { id: z.id });
});
route('DELETE', '/api/inv/zones/:id', async (req, res, params, userId, query) => {
  const z = db.invZones.find(z => z.id === parseInt(params.id, 10));
  if (!z) return sendJSON(res, 404, { error: 'Zóna nenalezena.' });
  const viewer = userId && resolveViewer(userId, z.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Zóny spravuje DM.' });
  const inZone = db.itemInstances.filter(i => i.loc && i.loc.t === 'zone' && i.loc.zId === z.id);
  if (inZone.length && query.force !== '1')
    return sendJSON(res, 400, { error: 'Zóna není prázdná — nejdřív předměty přesuňte, nebo smažte zónu i s obsahem.', count: inZone.length });
  if (inZone.length) {
    // s obsahem: smazat i předměty UVNITŘ kontejnerů ležících v zóně (nevnořují se → jedna úroveň)
    const gone = new Set(inZone.map(i => i.id));
    db.itemInstances = db.itemInstances.filter(i =>
      !gone.has(i.id) && !(i.loc && i.loc.t === 'grid' && gone.has(i.loc.cId)));
    invLogAdd(z.campaignId, viewer, `smazal zónu ${z.name} včetně ${inZone.length} předmětů`);
  }
  db.invZones = db.invZones.filter(x => x.id !== z.id); save(); sseBroadcast(z.campaignId, { inv: 1 });
  sendJSON(res, 200, { ok: true });
});
route('GET', '/api/inv/zones/:id/items', async (req, res, params, userId, query) => {
  const z = db.invZones.find(z => z.id === parseInt(params.id, 10));
  if (!z) return sendJSON(res, 404, { error: 'Zóna nenalezena.' });
  const viewer = userId && resolveViewer(userId, z.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const items = db.itemInstances.filter(i => i.loc && i.loc.t === 'zone' && i.loc.zId === z.id);
  sendJSON(res, 200, items.map(i => instView(i, viewer)));
});

// ---------- vytvoření instance (DM)
route('POST', '/api/campaigns/:cid/inv/instances', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Předměty vytváří DM.' });
  const body = await readJSONBody(req);
  const art = db.articles.find(a => a.id === parseInt(body.articleId, 10));
  if (!art || art.campaignId !== cid) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  if (art.category !== 'Předměty') return sendJSON(res, 400, { error: 'Článek musí mít kategorii „Předměty“.' });
  const m = itemMeta(art);
  const hpMax = Math.max(1, Math.min(10, parseInt(body.hpMax, 10) || m.hpMax || 10));
  const inst = {
    id: nextId(), campaignId: cid, articleId: art.id,
    qty: m.stackable ? Math.max(1, Math.min(m.stackMax || 10, parseInt(body.qty, 10) || 1)) : 1,
    hp: Math.max(0, Math.min(hpMax, body.hp === undefined ? hpMax : parseInt(body.hp, 10) || 0)),
    hpMax,
    identified: body.identified === undefined ? !!m.identifiedDefault : !!body.identified,
    rot: 0, loc: null, createdAt: new Date().toISOString()
  };
  const to = normLoc(body.to);
  const err = to && placeError(inst, to, 0, viewer);
  if (!to || err) return sendJSON(res, 400, { error: err || 'Neplatný cíl.' });
  inst.loc = to;
  db.itemInstances.push(inst);
  invLogAdd(cid, viewer, `vytvořil ${instLogName(inst)}${inst.qty > 1 ? ' ×' + inst.qty : ''}`);
  save(); sseBroadcast(cid, { inv: 1 });
  sendJSON(res, 200, { id: inst.id });
});

// ---------- přesun / otočení / sloučení stacku
route('PUT', '/api/inv/instances/:id/move', async (req, res, params, userId, query) => {
  const inst = db.itemInstances.find(i => i.id === parseInt(params.id, 10));
  if (!inst) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  const viewer = userId && resolveViewer(userId, inst.campaignId, query.viewAs);
  if (!viewer || !canTouchInst(inst, viewer)) return sendJSON(res, 404, { error: 'Předmět nenalezen.' }); // fail closed
  const body = await readJSONBody(req);
  const wasRoot = rootLoc(inst);

  // sloučení stacků: cílem je konkrétní instance téhož článku
  if (body.mergeInto) {
    const target = db.itemInstances.find(i => i.id === parseInt(body.mergeInto, 10));
    if (!target || target.campaignId !== inst.campaignId || target.id === inst.id) return sendJSON(res, 404, { error: 'Cíl nenalezen.' });
    if (!canTouchInst(target, viewer)) return sendJSON(res, 403, { error: 'K cíli nemáte přístup.' });
    const m = itemMeta(instArticle(inst));
    if (!m.stackable || target.articleId !== inst.articleId) return sendJSON(res, 400, { error: 'Tyto předměty nejde sloučit.' });
    const max = m.stackMax || 10;
    if (target.qty + inst.qty > max) return sendJSON(res, 400, { error: `Stack pojme nejvýše ${max} ks.` });
    target.qty += inst.qty;
    db.itemInstances = db.itemInstances.filter(i => i.id !== inst.id);
    save(); sseBroadcast(inst.campaignId, { inv: 1 });
    return sendJSON(res, 200, { ok: true, merged: true });
  }

  const to = normLoc(body.to);
  const rot = to && (to.t === 'grid' || to.t === 'zone') ? (body.rot ? 1 : 0) : 0; // otočení platí v mřížce i na zemi
  const err = to && placeError(inst, to, rot, viewer);
  if (!to || err) return sendJSON(res, 400, { error: err || 'Neplatný cíl.' });
  inst.loc = to; inst.rot = rot;
  const nowRoot = rootLoc(inst);
  if (wasRoot.t !== 'zone' && nowRoot.t === 'zone') invLogAdd(inst.campaignId, viewer, `odložil ${instLogName(inst)}${inst.qty > 1 ? ' ×' + inst.qty : ''} na zem`);
  if (wasRoot.t === 'zone' && nowRoot.t === 'slot') invLogAdd(inst.campaignId, viewer, `vzal ze země ${instLogName(inst)}${inst.qty > 1 ? ' ×' + inst.qty : ''}`);
  save(); sseBroadcast(inst.campaignId, { inv: 1 });
  sendJSON(res, 200, { ok: true });
});

// ---------- životy / identifikace / max. životy
route('PUT', '/api/inv/instances/:id', async (req, res, params, userId, query) => {
  const inst = db.itemInstances.find(i => i.id === parseInt(params.id, 10));
  if (!inst) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  const viewer = userId && resolveViewer(userId, inst.campaignId, query.viewAs);
  if (!viewer || !canTouchInst(inst, viewer)) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  const body = await readJSONBody(req);
  if (body.identified !== undefined) {
    if (!viewer.realDM) return sendJSON(res, 403, { error: 'Identifikaci přepíná DM.' });
    inst.identified = !!body.identified;
  }
  if (body.hpMax !== undefined) {
    if (!viewer.realDM) return sendJSON(res, 403, { error: 'Maximum životů mění DM.' });
    inst.hpMax = Math.max(1, Math.min(10, parseInt(body.hpMax, 10) || inst.hpMax));
    inst.hp = Math.min(inst.hp, inst.hpMax);
  }
  if (body.hp !== undefined) {
    const m = itemMeta(instArticle(inst));
    if (m.stackable) return sendJSON(res, 400, { error: 'Stackovatelné předměty životy nemají.' });
    inst.hp = Math.max(0, Math.min(inst.hpMax, parseInt(body.hp, 10) || 0));
  }
  if (body.qty !== undefined) {
    const m = itemMeta(instArticle(inst));
    if (!m.stackable) return sendJSON(res, 400, { error: 'Množství jde měnit jen u stackovatelných předmětů.' });
    inst.qty = Math.max(1, Math.min(m.stackMax || 10, parseInt(body.qty, 10) || 1));
  }
  save(); sseBroadcast(inst.campaignId, { inv: 1 });
  sendJSON(res, 200, instView(inst, viewer));
});

// ---------- rozdělení stacku
route('POST', '/api/inv/instances/:id/split', async (req, res, params, userId, query) => {
  const inst = db.itemInstances.find(i => i.id === parseInt(params.id, 10));
  if (!inst) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  const viewer = userId && resolveViewer(userId, inst.campaignId, query.viewAs);
  if (!viewer || !canTouchInst(inst, viewer)) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  const body = await readJSONBody(req);
  const m = itemMeta(instArticle(inst));
  if (!m.stackable) return sendJSON(res, 400, { error: 'Předmět není stackovatelný.' });
  const qty = parseInt(body.qty, 10);
  if (!qty || qty < 1 || qty >= inst.qty) return sendJSON(res, 400, { error: 'Neplatné množství.' });
  const nu = { ...inst, id: nextId(), qty, loc: null, rot: 0 };
  const to = normLoc(body.to);
  const err = to && placeError(nu, to, 0, viewer);
  if (!to || err) return sendJSON(res, 400, { error: err || 'Neplatný cíl.' });
  nu.loc = to;
  inst.qty -= qty;
  db.itemInstances.push(nu);
  save(); sseBroadcast(inst.campaignId, { inv: 1 });
  sendJSON(res, 200, { id: nu.id });
});

// ---------- zničení instance
route('DELETE', '/api/inv/instances/:id', async (req, res, params, userId, query) => {
  const inst = db.itemInstances.find(i => i.id === parseInt(params.id, 10));
  if (!inst) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  const viewer = userId && resolveViewer(userId, inst.campaignId, query.viewAs);
  if (!viewer || !canTouchInst(inst, viewer)) return sendJSON(res, 404, { error: 'Předmět nenalezen.' });
  if (!viewer.isDM && inst.hp !== 0) return sendJSON(res, 403, { error: 'Odstranit lze jen rozbitý předmět (DM může vše).' });
  if (db.itemInstances.some(i => i.loc && i.loc.t === 'grid' && i.loc.cId === inst.id))
    return sendJSON(res, 400, { error: 'Kontejner není prázdný — nejdřív ho vyprázdněte.' });
  db.itemInstances = db.itemInstances.filter(i => i.id !== inst.id);
  invLogAdd(inst.campaignId, viewer, `odstranil ${instLogName(inst)}`);
  save(); sseBroadcast(inst.campaignId, { inv: 1 });
  sendJSON(res, 200, { ok: true });
});

// ---------- vlastní sloty postavy (platí pro celou kampaň, zakládá DM)
route('POST', '/api/campaigns/:cid/inv/slots', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Sloty spravuje DM.' });
  const camp = db.campaigns.find(c => c.id === cid);
  const body = await readJSONBody(req);
  const label = String(body.label || '').trim().slice(0, 30);
  if (!label) return sendJSON(res, 400, { error: 'Zadejte název slotu.' });
  const cap = Math.max(1, Math.min(4, parseInt(body.cap, 10) || 1));
  camp.customSlots = camp.customSlots || [];
  const key = 'cs' + nextId(); // klíč nekoliduje se systémovými
  camp.customSlots.push({ key, label, cap });
  if (body.col === 1) { camp.slotCols = camp.slotCols || {}; camp.slotCols[key] = 1; }
  save(); sseBroadcast(cid, { inv: 1 });
  sendJSON(res, 200, { key });
});
route('PUT', '/api/campaigns/:cid/inv/slots/:key', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Sloty spravuje DM.' });
  const camp = db.campaigns.find(c => c.id === cid);
  const key = String(params.key);
  const s = (camp.customSlots || []).find(x => x.key === key);
  const body = await readJSONBody(req);
  const isSystem = !!BODY_SLOTS[key];
  if (!s && !isSystem) return sendJSON(res, 404, { error: 'Slot nenalezen.' });
  if (isSystem && (body.label !== undefined || body.cap !== undefined))
    return sendJSON(res, 400, { error: 'U systémového slotu lze měnit jen sloupec a pořadí.' });
  // sloupec (1 = levý, 2 = pravý)
  if (body.col !== undefined) {
    const col = parseInt(body.col, 10);
    if (col !== 1 && col !== 2) return sendJSON(res, 400, { error: 'Sloupec musí být 1 nebo 2.' });
    camp.slotCols = camp.slotCols || {};
    camp.slotCols[key] = col;
  }
  // posun v rámci sloupce
  if (body.move === 'up' || body.move === 'down') {
    const order = slotOrderOf(camp);
    const colKeys = order.filter(k => slotColOf(camp, k) === slotColOf(camp, key));
    const ci = colKeys.indexOf(key);
    const swapWith = body.move === 'up' ? colKeys[ci - 1] : colKeys[ci + 1];
    if (swapWith) {
      const i1 = order.indexOf(key), i2 = order.indexOf(swapWith);
      [order[i1], order[i2]] = [order[i2], order[i1]];
      camp.slotOrder = order;
    }
  }
  if (isSystem) { save(); sseBroadcast(cid, { inv: 1 }); return sendJSON(res, 200, { ok: true }); }
  if (body.label !== undefined && String(body.label).trim()) s.label = String(body.label).trim().slice(0, 30);
  if (body.cap !== undefined) {
    const cap = Math.max(1, Math.min(4, parseInt(body.cap, 10) || s.cap));
    // zmenšení kapacity jen když je slot všude prázdný — jinak by předměty přetekly
    if (cap < s.cap && db.itemInstances.some(i => i.campaignId === cid && i.loc && i.loc.t === 'slot' && i.loc.slot === s.key))
      return sendJSON(res, 400, { error: 'Kapacitu nelze zmenšit — ve slotu jsou předměty.' });
    s.cap = cap;
  }
  save(); sseBroadcast(cid, { inv: 1 });
  sendJSON(res, 200, { ok: true });
});
route('DELETE', '/api/campaigns/:cid/inv/slots/:key', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Sloty spravuje DM.' });
  const camp = db.campaigns.find(c => c.id === cid);
  const key = String(params.key);
  if (BODY_SLOTS[key]) return sendJSON(res, 400, { error: 'Systémový slot nejde smazat — lze ho jen přesunout.' });
  if (!(camp.customSlots || []).some(s => s.key === key)) return sendJSON(res, 404, { error: 'Slot nenalezen.' });
  if (db.itemInstances.some(i => i.campaignId === cid && i.loc && i.loc.t === 'slot' && i.loc.slot === key))
    return sendJSON(res, 400, { error: 'Ve slotu jsou předměty — nejdřív je přesuňte.' });
  camp.customSlots = camp.customSlots.filter(s => s.key !== key);
  // vyčistit klíč i z povolených slotů předmětů
  db.articles.forEach(a => { if (a.campaignId === cid && a.item && Array.isArray(a.item.slots)) a.item.slots = a.item.slots.filter(s => s !== key); });
  save(); sseBroadcast(cid, { inv: 1 });
  sendJSON(res, 200, { ok: true });
});

// ---------- výskyty předmětu (pro článek předmětu)
route('GET', '/api/articles/:id/instances', async (req, res, params, userId, query) => {
  const a = db.articles.find(a => a.id === parseInt(params.id, 10));
  if (!a) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const viewer = userId && resolveViewer(userId, a.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  if (!viewer.isDM && !articleVisibleToPlayer(a.id, viewer.userId)) return sendJSON(res, 404, { error: 'Článek nenalezen.' });
  const out = [];
  for (const inst of db.itemInstances.filter(i => i.articleId === a.id)) {
    const root = rootLoc(inst);
    if (root.t === 'zone') {
      const z = db.invZones.find(z => z.id === root.zId);
      if (!z) continue;
      // hráči neprozradit, že neidentifikovaný kus na zemi je právě tento předmět
      if (!viewer.isDM && !inst.identified) continue;
      out.push({ id: inst.id, qty: inst.qty, identified: !!inst.identified, where: 'zone', zoneId: z.id, label: z.name });
    } else if (root.t === 'slot') {
      const ch = db.characters.find(c => c.id === root.charId);
      if (!ch) continue;
      if (!viewer.isDM && ch.userId !== viewer.userId) continue; // cizí inventáře zůstávají skryté
      if (!viewer.isDM && !inst.identified) continue;
      out.push({ id: inst.id, qty: inst.qty, identified: !!inst.identified, where: 'char', charId: ch.id, label: ch.name });
    }
  }
  sendJSON(res, 200, out);
});

// ---------- deník přesunů
route('GET', '/api/campaigns/:cid/inv/log', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const rows = db.invLog.filter(l => l.campaignId === cid).slice(-100).reverse();
  sendJSON(res, 200, rows.map(l => ({ ts: l.ts, who: l.who, text: l.text })));
});

// ================================================================ IMPORT Z D&D BEYOND
function ddbHtmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;|&ndash;/g, '-')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Parser stat bloku ve formátu D&D Beyond (2024). Funguje nad textem —
    stejně pro stažené HTML i pro text vložený uživatelem. */
function parseStatText(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  const full = lines.join('\n');
  const out = { saves: {} };
  const grab = re => { const m = re.exec(full); return m ? m[1].trim() : ''; };
  out.ac = grab(/\bAC\s+(\d+[^\n]*?)(?=\s+Initiative|\n|$)/);
  out.initiative = grab(/Initiative\s+([+\-−]?\d+(?:\s*\(\d+\))?)/);
  out.hp = grab(/\bHP\s+([^\n]+)/);
  out.speed = grab(/\bSpeed\s+([^\n]+)/);
  for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
    const m = new RegExp('\\b' + k.toUpperCase() + '\\s+(\\d+)\\s+([+\\-−]\\s?\\d+)\\s+([+\\-−]\\s?\\d+)').exec(full);
    if (m) { out[k] = parseInt(m[1], 10); out.saves[k] = m[3].replace(/\s/g, ''); }
  }
  out.skills = grab(/^Skills\s+(.+)$/m);
  out.vulnerabilities = grab(/^Vulnerabilities\s+(.+)$/m);
  out.immunities = grab(/^Immunities\s+(.+)$/m);
  out.resistances = grab(/^Resistances\s+(.+)$/m);
  out.gear = grab(/^Gear\s+(.+)$/m);
  out.senses = grab(/^Senses\s+(.+)$/m);
  out.languages = grab(/^Languages\s+(.+)$/m);
  out.cr = grab(/^CR\s+(.+)$/m);
  // jméno a meta: řádky před řádkem s AC (mimo hlaviček MOD/SAVE)
  const acIdx = lines.findIndex(l => /^AC\s+\d/.test(l));
  if (acIdx > 0) {
    out.name = lines[0];
    if (acIdx > 1) out.meta = lines.slice(1, acIdx).filter(l => !/^(MOD|SAVE)\b/.test(l)).join(' ');
  }
  // sekce Traits / Actions / Bonus Actions / Legendary Actions / Reactions
  const sectionNames = ['traits', 'actions', 'bonus actions', 'legendary actions', 'reactions', 'lair actions'];
  // řádky, které už NEpatří do stat bloku (komentáře, patička stránky D&D Beyond, habitat…)
  const STOP = /^(habitat\b|environment\b|description\b|monster tags\b|source:|posted|comments?\b|add a comment|sort by|reply|likes?\b|show more|were you looking|related|©|all rights|dungeons\s*&|d&d beyond|log in|sign in|more info|tags?\b|challenge rating\b|proficiency bonus\b|\d+ comments?)/i;
  const section = label => {
    const start = lines.findIndex(l => l.toLowerCase() === label);
    if (start < 0) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (sectionNames.includes(low) || STOP.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start + 1, end).join('\n');
  };
  out.traits = section('traits');
  out.actions = section('actions');
  out.bonusActions = section('bonus actions');
  out.legendaryActions = section('legendary actions');
  return out;
}

route('POST', '/api/campaigns/:cid/import-dndbeyond', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Import provádí DM.' });
  const body = await readJSONBody(req);
  let text = String(body.text || '').trim();
  let nameFromH1 = '';
  if (!text && body.url) {
    let u;
    try { u = new URL(String(body.url)); } catch { return sendJSON(res, 400, { error: 'Neplatný odkaz.' }); }
    if (!/(^|\.)dndbeyond\.com$/.test(u.hostname)) return sendJSON(res, 400, { error: 'Odkaz musí vést na dndbeyond.com.' });
    try {
      const resp = await fetch(u.href, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8'
        }
      });
      if (!resp.ok) return sendJSON(res, 502, { error: `D&D Beyond stránku nevydal (HTTP ${resp.status}) — zkopírujte stat blok a použijte import z textu.` });
      const html = await resp.text();
      const h1 = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
      nameFromH1 = h1 ? h1[1].trim() : '';
      text = ddbHtmlToText(html);
      // ořízneme balast stránky: začínáme u jména tvora, končíme před komentáři
      if (nameFromH1) {
        const i = text.indexOf('\n' + nameFromH1 + '\n');
        if (i >= 0) text = nameFromH1 + text.slice(i + nameFromH1.length + 1);
      }
    } catch (e) {
      return sendJSON(res, 502, { error: 'Stažení se nepodařilo (' + e.message + ') — zkopírujte stat blok a použijte import z textu.' });
    }
  }
  if (!text) return sendJSON(res, 400, { error: 'Vložte odkaz nebo text stat bloku.' });
  const parsed = parseStatText(text);
  if (nameFromH1) parsed.name = parsed.name || nameFromH1;
  if (!parsed.ac && !parsed.hp && parsed.str === undefined) {
    return sendJSON(res, 422, { error: 'Ve vloženém obsahu se nepodařilo najít stat blok (chybí AC/HP/vlastnosti).' });
  }
  sendJSON(res, 200, parsed);
});

// ================================================================ IMPORT HRÁČSKÉ POSTAVY (D&D Beyond JSON)
const DDB_ALIGN = { 1: 'Zákonně dobrý', 2: 'Neutrálně dobrý', 3: 'Chaoticky dobrý', 4: 'Zákonně neutrální', 5: 'Neutrální', 6: 'Chaoticky neutrální', 7: 'Zákonně zlý', 8: 'Neutrálně zlý', 9: 'Chaoticky zlý' };
const DDB_STAT_SUB = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const DDB_STAT_CS = ['SÍL', 'OBR', 'ODL', 'INT', 'MDR', 'CHA'];

function ddbMod(score) { return Math.floor((score - 10) / 2); }
function ddbProfBonus(level) { return Math.floor((level - 1) / 4) + 2; }
/** Pole backstory/osobnost z D&D Beyond jsou HTML — převedeme na čistý text. */
function ddbStrip(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;|&ndash;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Zpracuje JSON postavy z character-service v5 na naše pole. */
function parseDdbCharacter(data) {
  const out = { name: data.name || '' };
  // rasa, třídy, úroveň
  out.race = (data.race && (data.race.fullName || data.race.baseName)) || '';
  const classes = (data.classes || []).map(c => {
    const nm = (c.definition && c.definition.name) || '';
    const sub = c.subclassDefinition && c.subclassDefinition.name ? ` (${c.subclassDefinition.name})` : '';
    return `${nm}${sub} ${c.level || 1}`;
  });
  out.classes = classes.join(', ');
  const totalLevel = (data.classes || []).reduce((s, c) => s + (c.level || 0), 0) || 1;
  out.level = totalLevel;
  out.background = (data.background && data.background.definition && data.background.definition.name) || '';
  out.alignment = DDB_ALIGN[data.alignmentId] || '';

  // ability skóre = základ + všechny bonusy z modifiers (rasa/třída/původ/feat/předmět)
  const base = {}; (data.stats || []).forEach(s => { base[s.id] = s.value; });
  const bonusable = data.bonusStats ? {} : null;
  const allMods = [];
  const M = data.modifiers || {};
  ['race', 'class', 'background', 'item', 'feat', 'condition'].forEach(k => { if (Array.isArray(M[k])) allMods.push(...M[k]); });
  const scores = DDB_STAT_SUB.map((sub, i) => {
    let v = base[i + 1] || 10;
    // pevné bonusy k dané vlastnosti
    allMods.forEach(m => {
      if (m && m.type === 'bonus' && m.subType === `${sub}-score` && typeof m.value === 'number') v += m.value;
    });
    // override (např. rukavice síly)
    allMods.forEach(m => {
      if (m && m.type === 'set' && m.subType === `${sub}-score` && typeof m.value === 'number') v = m.value;
    });
    return v;
  });
  const abbr = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const sb = { name: out.name };
  abbr.forEach((a, i) => { sb[a] = scores[i]; });

  // proficience: záchranné hody a dovednosti
  const prof = ddbProfBonus(totalLevel);
  const saves = {};
  abbr.forEach((a, i) => {
    const isProf = allMods.some(m => m && m.type === 'proficiency' && m.subType === `${DDB_STAT_SUB[i]}-saving-throws`);
    const mod = ddbMod(scores[i]) + (isProf ? prof : 0);
    saves[a] = (mod >= 0 ? '+' : '') + mod;
  });
  sb.saves = saves;

  const skillMods = allMods.filter(m => m && m.type === 'proficiency' && m.friendlySubtypeName && !/saving throws|armor|weapons|tools|languages/i.test(m.friendlySubtypeName));
  sb.skills = [...new Set(skillMods.map(m => m.friendlySubtypeName))].join(', ');

  // HP: override, jinak base + odolnost × úroveň
  const conMod = ddbMod(scores[2]);
  let maxHp = data.overrideHitPoints;
  if (!maxHp) maxHp = (data.baseHitPoints || 0) + conMod * totalLevel + (data.bonusHitPoints || 0);
  sb.hp = String(maxHp || '');

  // rychlost
  const walk = data.race && data.race.weightSpeeds && data.race.weightSpeeds.normal && data.race.weightSpeeds.normal.walk;
  sb.speed = walk ? `${walk} ft` : '30 ft';

  // smysly (darkvision) a jazyky z modifiers
  const senses = allMods.filter(m => m && m.type === 'set-base' && /darkvision|blindsight|truesight|tremorsense/i.test(m.subType || ''))
    .map(m => `${m.friendlySubtypeName || m.subType} ${m.value || ''} ft`);
  sb.senses = senses.join('\n');
  const langs = allMods.filter(m => m && m.type === 'language' && m.friendlySubtypeName).map(m => m.friendlySubtypeName);
  sb.languages = [...new Set(langs)].join('\n');

  // AC — nejlepší odhad (10 + OBR); D&D Beyond ho počítá ze zbroje dynamicky
  sb.ac = String(10 + ddbMod(scores[1])) + ' (odhad)';
  sb.meta = ''; // rasa/třída jsou v hlavičce článku, v kartě je neduplikujeme
  sb.cr = ''; sb.initiative = (ddbMod(scores[1]) >= 0 ? '+' : '') + ddbMod(scores[1]);

  // osobnost + backstory — čistý text bez HTML (backstory = jen osobní příběh, ne generická pravidla)
  const t = data.traits || {};
  out.personality = {
    traits: ddbStrip(t.personalityTraits), ideals: ddbStrip(t.ideals),
    bonds: ddbStrip(t.bonds), flaws: ddbStrip(t.flaws), appearance: ddbStrip(t.appearance)
  };
  out.backstory = ddbStrip(data.notes && data.notes.backstory);

  // Features & Traits — krátké shrnutí (snippet); přeskočíme rutinní položky
  const SKIP = /^(ability score|proficienc|hit points|hit dice|languages$|equipment$|size$|speed$|age$|alignment$|creature type)/i;
  const feats = [];
  const addFeat = (name, snippet, desc) => {
    name = String(name || '').trim();
    if (!name || SKIP.test(name) || feats.some(f => f.name === name)) return;
    let text = ddbStrip(snippet) || ddbStrip(desc);
    if (text && text.length > 400) text = text.slice(0, 400).replace(/\s+\S*$/, '') + '…';
    feats.push({ name, text: text || '' });
  };
  ((data.race || {}).racialTraits || []).forEach(r => { const d = r.definition || {}; addFeat(d.name, d.snippet, d.description); });
  (data.classes || []).forEach(c => (c.classFeatures || []).forEach(f => {
    const d = f.definition || {};
    if (f.requiredLevel && c.level && f.requiredLevel > c.level) return;
    addFeat(d.name, d.snippet, d.description);
  }));
  (data.feats || []).forEach(f => { const d = f.definition || {}; addFeat(d.name, d.snippet, d.description); });
  const bg = (data.background || {}).definition || {};
  if (bg.featureName) addFeat(bg.featureName, bg.featureDescription, bg.featureDescription);
  out.features = feats;

  out.statblock = sb;
  return out;
}

route('POST', '/api/campaigns/:cid/import-ddb-character', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Import postav provádí DM.' });
  const { url } = await readJSONBody(req);
  const m = /dndbeyond\.com\/characters\/(\d+)/.exec(String(url || '')) || /^(\d{4,})$/.exec(String(url || '').trim());
  if (!m) return sendJSON(res, 400, { error: 'Vložte odkaz na postavu (…dndbeyond.com/characters/ID).' });
  const id = m[1];
  try {
    const resp = await fetch(`https://character-service.dndbeyond.com/character/v5/character/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (resp.status === 403 || resp.status === 401) return sendJSON(res, 403, { error: 'Postava není veřejná — na D&D Beyond ji nastavte jako Public (Character Privacy).' });
    if (!resp.ok) return sendJSON(res, 502, { error: `D&D Beyond nevrátil data (HTTP ${resp.status}).` });
    const json = await resp.json();
    const data = json.data || json;
    if (!data || !data.name) return sendJSON(res, 422, { error: 'Data postavy se nepodařilo načíst.' });
    sendJSON(res, 200, parseDdbCharacter(data));
  } catch (e) {
    return sendJSON(res, 502, { error: 'Stažení se nepodařilo: ' + e.message });
  }
});

// ================================================================ CHAT
// SSE klienti pro push v reálném čase (per kampaň)
const sseClients = new Map(); // campaignId -> Set({res, userId})
setInterval(() => { // heartbeat, ať spojení nespadne na proxy/timeoutu
  for (const set of sseClients.values()) for (const c of set) { try { c.res.write(':ping\n\n'); } catch { } }
}, 25000).unref();
function sseBroadcast(campaignId, data) {
  const set = sseClients.get(campaignId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of set) { try { c.res.write(payload); } catch { } }
}

/** Aktivní postava diváka (pro chat identitu). */
function chatActiveChar(viewer, campaignId) {
  return viewer.isDM ? null : (userCharIds(campaignId, viewer.userId)[0] || null);
}
function chatReadKey(viewer, campaignId) {
  const ch = chatActiveChar(viewer, campaignId);
  return viewer.isDM ? 'u' + viewer.userId : (ch ? 'c' + ch : null);
}
/** Viditelnost zprávy: tajné zprávy jsou pro ostatní ZCELA neviditelné. */
function chatMsgVisible(m, viewer, campaignId) {
  if (viewer.isDM) return true;
  const active = chatActiveChar(viewer, campaignId);
  if (!active) return false;
  if (m.authorCharId === active) return true; // autor vidí i své šeptání
  if (!m.secretTo) return true;
  if (m.secretTo === 'dm') return false;
  if (Array.isArray(m.secretTo)) return m.secretTo.includes(active);
  return false;
}
/** Zpráva pro diváka — jazykový filtr jako všude: neznalec dostane šifru. */
function chatMsgOut(m, viewer, campaignId) {
  const camp = db.campaigns.find(c => c.id === campaignId);
  const isCommon = !m.langId || m.langId === camp.commonLangId;
  const lang = !isCommon ? db.articles.find(a => a.id === m.langId && a.campaignId === campaignId && a.category === 'Jazyk') : null;
  let text = m.text, known = true;
  if (lang) {
    known = viewerKnowsLang(viewer, campaignId, lang.id);
    if (!known) text = scrambleText(m.text, m.text + lang.id);
  }
  const authorCh = m.authorCharId && db.characters.find(c => c.id === m.authorCharId);
  const active = chatActiveChar(viewer, campaignId);
  const mine = viewer.isDM ? !m.authorCharId : m.authorCharId === active;
  let secret = null;
  if (m.secretTo && (viewer.isDM || mine || (Array.isArray(m.secretTo) && m.secretTo.includes(active)))) {
    secret = m.secretTo === 'dm' ? '🤫 jen pro DM'
      : '🤫 tajně: ' + m.secretTo.map(id => (db.characters.find(c => c.id === id) || { name: '?' }).name).join(', ')
      // šeptá-li postava, vidí to i DM — ať to adresáti i autor vědí
      + (m.authorCharId ? ' (+ DM)' : '');
  }
  return {
    id: m.id, createdAt: m.createdAt,
    author: authorCh ? authorCh.name : 'Vypravěč (DM)',
    dmAuthor: !m.authorCharId, mine, text,
    ...(lang ? { lang: { title: known ? lang.title : 'Neznámá řeč', color: lang.langColor || '#9aa0a6' } } : {}),
    ...(secret ? { secret } : {}) // pole existuje JEN pro zúčastněné — ostatním nic neprozradí
  };
}
function roomForViewer(r, viewer) {
  const active = chatActiveChar(viewer, r.campaignId);
  return viewer.isDM || (r.characters || []).includes(active);
}
function roomUnread(r, viewer) {
  const key = chatReadKey(viewer, r.campaignId);
  if (!key) return 0;
  const read = db.chatReads.find(x => x.roomId === r.id && x.key === key);
  const last = read ? read.lastRead : 0;
  return db.chatMessages.filter(m => m.roomId === r.id && m.id > last && chatMsgVisible(m, viewer, r.campaignId)).length;
}

route('GET', '/api/campaigns/:cid/chat/rooms', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const rooms = db.chatRooms.filter(r => r.campaignId === cid && roomForViewer(r, viewer))
    .map(r => ({
      id: r.id, name: r.name,
      characters: (r.characters || []).map(id => { const ch = db.characters.find(c => c.id === id); return ch ? { id, name: ch.name } : null; }).filter(Boolean),
      sessionIds: r.sessionIds || [],
      unread: roomUnread(r, viewer)
    }));
  sendJSON(res, 200, rooms);
});

route('POST', '/api/campaigns/:cid/chat/rooms', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Místnosti zakládá DM.' });
  const body = await readJSONBody(req);
  if (!body.name || !String(body.name).trim()) return sendJSON(res, 400, { error: 'Zadejte název místnosti.' });
  const r = {
    id: nextId(), campaignId: cid, name: String(body.name).trim().slice(0, 80),
    sessionIds: (Array.isArray(body.sessionIds) ? body.sessionIds : []).filter(id => db.sessions.some(s => s.id === id && s.campaignId === cid)),
    characters: (Array.isArray(body.characters) ? body.characters : []).filter(id => db.characters.some(c => c.id === id && c.campaignId === cid)),
    createdAt: new Date().toISOString()
  };
  db.chatRooms.push(r); save();
  sseBroadcast(cid, { rooms: true });
  sendJSON(res, 200, { id: r.id });
});

route('PUT', '/api/chat/rooms/:id', async (req, res, params, userId, query) => {
  const r = db.chatRooms.find(x => x.id === parseInt(params.id, 10));
  if (!r) return sendJSON(res, 404, { error: 'Místnost nenalezena.' });
  const viewer = userId && resolveViewer(userId, r.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const body = await readJSONBody(req);
  if (body.name && String(body.name).trim()) r.name = String(body.name).trim().slice(0, 80);
  if (Array.isArray(body.sessionIds)) r.sessionIds = body.sessionIds.filter(id => db.sessions.some(s => s.id === id && s.campaignId === r.campaignId));
  if (Array.isArray(body.characters)) r.characters = body.characters.filter(id => db.characters.some(c => c.id === id && c.campaignId === r.campaignId));
  save();
  sseBroadcast(r.campaignId, { rooms: true });
  sendJSON(res, 200, { ok: true });
});

route('DELETE', '/api/chat/rooms/:id', async (req, res, params, userId, query) => {
  const r = db.chatRooms.find(x => x.id === parseInt(params.id, 10));
  if (!r) return sendJSON(res, 404, { error: 'Místnost nenalezena.' });
  const viewer = userId && resolveViewer(userId, r.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  db.chatRooms = db.chatRooms.filter(x => x.id !== r.id);
  db.chatMessages = db.chatMessages.filter(m => m.roomId !== r.id);
  db.chatReads = db.chatReads.filter(x => x.roomId !== r.id);
  save();
  sseBroadcast(r.campaignId, { rooms: true });
  sendJSON(res, 200, { ok: true });
});

route('GET', '/api/chat/rooms/:id/messages', async (req, res, params, userId, query) => {
  const r = db.chatRooms.find(x => x.id === parseInt(params.id, 10));
  if (!r) return sendJSON(res, 404, { error: 'Místnost nenalezena.' });
  const viewer = userId && resolveViewer(userId, r.campaignId, query.viewAs);
  if (!viewer || !roomForViewer(r, viewer)) return sendJSON(res, 404, { error: 'Místnost nenalezena.' });
  const after = parseInt(query.after, 10) || 0;
  const visible = db.chatMessages.filter(m => m.roomId === r.id && m.id > after && chatMsgVisible(m, viewer, r.campaignId));
  // otevření chatu označí zprávy jako přečtené (per postava / per DM)
  const key = chatReadKey(viewer, r.campaignId);
  if (key && visible.length) {
    const maxId = Math.max(...visible.map(m => m.id));
    let read = db.chatReads.find(x => x.roomId === r.id && x.key === key);
    if (!read) { read = { roomId: r.id, key, lastRead: 0 }; db.chatReads.push(read); }
    if (maxId > read.lastRead) { read.lastRead = maxId; save(); }
  }
  sendJSON(res, 200, visible.map(m => chatMsgOut(m, viewer, r.campaignId)));
});

route('POST', '/api/chat/rooms/:id/messages', async (req, res, params, userId, query) => {
  const r = db.chatRooms.find(x => x.id === parseInt(params.id, 10));
  if (!r) return sendJSON(res, 404, { error: 'Místnost nenalezena.' });
  const viewer = userId && resolveViewer(userId, r.campaignId, query.viewAs);
  if (!viewer || !roomForViewer(r, viewer)) return sendJSON(res, 404, { error: 'Místnost nenalezena.' });
  const authorCharId = chatActiveChar(viewer, r.campaignId); // emulace: DM píše ZA postavu
  const body = await readJSONBody(req);
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!text) return sendJSON(res, 400, { error: 'Prázdná zpráva.' });
  // tajné adresování: 'dm' = jen vypravěč; pole = vybrané postavy z místnosti.
  // Šeptat postavám smí DM i hráč; DM vidí veškeré šeptání (viz chatMsgVisible) — je to jeho stůl.
  let secretTo = null;
  if (body.secretTo === 'dm') {
    if (!authorCharId) return sendJSON(res, 400, { error: 'DM šeptá postavám, ne sám sobě.' });
    secretTo = 'dm';
  } else if (Array.isArray(body.secretTo) && body.secretTo.length) {
    secretTo = body.secretTo
      .map(id => parseInt(id, 10))
      .filter(id => (r.characters || []).includes(id) && id !== authorCharId); // jen postavy v místnosti, ne sám sobě
    if (!secretTo.length) return sendJSON(res, 400, { error: 'Vyberte alespoň jednu postavu.' });
  }
  const camp = db.campaigns.find(c => c.id === r.campaignId);
  let langId = parseInt(body.langId, 10) || camp.commonLangId;
  if (!db.articles.some(a => a.id === langId && a.campaignId === r.campaignId && a.category === 'Jazyk')) langId = camp.commonLangId;
  // postava nemůže psát jazykem, který neovládá (DM může vším)
  if (authorCharId && langId !== camp.commonLangId && !viewerKnowsLang(viewer, r.campaignId, langId)) {
    return sendJSON(res, 403, { error: 'Vaše postava tento jazyk neovládá.' });
  }
  const m = {
    id: nextId(), roomId: r.id, authorId: viewer.userId, authorCharId,
    langId, secretTo, text, createdAt: new Date().toISOString()
  };
  db.chatMessages.push(m);
  // autorovi se jeho zpráva rovnou počítá jako přečtená
  const key = chatReadKey(viewer, r.campaignId);
  if (key) {
    let read = db.chatReads.find(x => x.roomId === r.id && x.key === key);
    if (!read) { read = { roomId: r.id, key, lastRead: 0 }; db.chatReads.push(read); }
    read.lastRead = m.id;
  }
  save();
  sseBroadcast(r.campaignId, { roomId: r.id });
  sendJSON(res, 200, { id: m.id });
});

route('DELETE', '/api/chat/messages/:id', async (req, res, params, userId, query) => {
  const m = db.chatMessages.find(x => x.id === parseInt(params.id, 10));
  if (!m) return sendJSON(res, 404, { error: 'Zpráva nenalezena.' });
  const r = db.chatRooms.find(x => x.id === m.roomId);
  const viewer = r && userId && resolveViewer(userId, r.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Zprávy maže pouze DM.' });
  db.chatMessages = db.chatMessages.filter(x => x.id !== m.id);
  save();
  sseBroadcast(r.campaignId, { roomId: r.id });
  sendJSON(res, 200, { ok: true });
});

// SSE stream — push nových zpráv v reálném čase
route('GET', '/api/campaigns/:cid/chat/events', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  if (!userId || !getMembership(cid, userId)) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('retry: 3000\n\n');
  if (!sseClients.has(cid)) sseClients.set(cid, new Set());
  const client = { res, userId };
  sseClients.get(cid).add(client);
  sseBroadcast(cid, { presence: true }); // někdo se připojil → aktualizace „online“
  req.on('close', () => {
    const set = sseClients.get(cid);
    if (set) set.delete(client);
    sseBroadcast(cid, { presence: true }); // někdo se odpojil
  });
});

// ---------- vyhledávání (respektuje oprávnění)
route('GET', '/api/campaigns/:cid/search', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const q = (query.q || '').trim().toLowerCase();
  if (!q) return sendJSON(res, 200, []);

  // Relevance (nižší = výš): shoda v NÁZVU je vždy před shodou v textu.
  const R = { EXACT: 0, STARTS: 1, TITLE: 2, META: 3, TEXT: 4 };
  const results = new Map();
  const addArticle = (a, snippet = '', rank = R.TEXT) => {
    const cur = results.get(a.id);
    if (!cur) { results.set(a.id, { articleId: a.id, title: a.title, category: a.category || '', snippet, rank }); return; }
    if (rank < cur.rank) cur.rank = rank;          // drž nejlepší dosažené umístění
    if (snippet && !cur.snippet) cur.snippet = snippet; // ale úryvek si vezmi i tak
  };

  for (const a of db.articles.filter(a => a.campaignId === cid)) {
    const visible = viewer.isDM || articleVisibleToPlayer(a.id, viewer.userId);
    if (!visible) continue; // skrytý článek se ve výsledcích vůbec neobjeví
    // shoda v metadatech
    const title = (a.title || '').toLowerCase();
    if (title === q) addArticle(a, '', R.EXACT);
    else if (title.startsWith(q)) addArticle(a, '', R.STARTS);
    else if (title.includes(q)) addArticle(a, '', R.TITLE);
    if ([a.description, a.tags].some(t => (t || '').toLowerCase().includes(q))) addArticle(a, '', R.META);
    // shoda v blocích — hráč prohledává JEN bloky, které smí vidět,
    // a cizí jazyky, kterým nerozumí, jsou i zde zašifrované
    for (const b of articleBlocks(a.id)) {
      if (!viewer.isDM && !blockAllowedForPlayer(b, viewer.userId)) continue;
      const text = searchableBlockText(b, viewer, cid);
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        addArticle(a, (start > 0 ? '…' : '') + text.slice(start, idx + q.length + 60) + '…', R.TEXT);
      }
    }
  }
  // nejdřív názvy, pak popis/štítky, nakonec shody v textu; ve skupině abecedně
  const out = [...results.values()]
    .sort((x, y) => x.rank - y.rank || x.title.localeCompare(y.title, 'cs'))
    .map(({ rank, ...r }) => r); // rank je jen pro řazení, ven nepatří
  sendJSON(res, 200, out);
});

// ---------- obrázky
route('POST', '/api/campaigns/:cid/images', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  // nahrávat může každý člen (hráč kvůli článku své postavy); přístup k zobrazení se řídí bloky
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const buffer = await readBody(req);
  const file = parseMultipartFile(buffer, req.headers['content-type']);
  if (!file) return sendJSON(res, 400, { error: 'Soubor chybí.' });
  const filename = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
  const img = { id: nextId(), campaignId: cid, filename, originalName: file.filename, mime: file.mime };
  db.images.push(img); save();
  sendJSON(res, 200, { id: img.id, name: img.originalName, mime: img.mime });
});

/**
 * Výdej obrázku s kontrolou oprávnění: hráč jej dostane, jen pokud je
 * použit v bloku, který smí vidět, nebo je titulním obrázkem viditelného článku.
 */
route('GET', '/api/images/:id', async (req, res, params, userId, query) => {
  const img = db.images.find(i => i.id === parseInt(params.id, 10));
  if (!img) { res.writeHead(404); return res.end(); }
  const viewer = userId && resolveViewer(userId, img.campaignId, query.viewAs);
  if (!viewer) { res.writeHead(404); return res.end(); }
  // ikonka kampaně je viditelná všem jejím členům
  const isCampaignIcon = db.campaigns.some(c => c.iconImageId === img.id);
  if (!viewer.isDM && !isCampaignIcon) {
    const inlineMark = `/api/images/${img.id}"`; // obrázek vložený přímo do rich textu
    const inBlock = db.blocks.some(b => {
      const c = b.content || {};
      const uses = c.imageId === img.id || (typeof c.html === 'string' && c.html.includes(inlineMark));
      if (!uses) return false;
      const a = db.articles.find(a => a.id === b.articleId);
      return a && a.campaignId === img.campaignId && blockAllowedForPlayer(b, viewer.userId);
    })
    // obrázek v zápisu postavy u sezení, který smím vidět
    || db.sessions.some(s => s.campaignId === img.campaignId && (s.entries || []).some(en =>
      (en.blocks || []).some(bl => (bl.html || '').includes(inlineMark) && entryBlockVisible(bl, en.charId, viewer, s.campaignId))));
    const isCoverOf = a => a.coverImageId === img.id || a.coverThumbId === img.id;
    const asCover = db.articles.some(a =>
      a.campaignId === img.campaignId && isCoverOf(a) && articleVisibleToPlayer(a.id, viewer.userId));
    // token / velký obrázek předmětu — tokeny leží v zónách viditelných všem členům
    const asToken = db.articles.some(a => a.campaignId === img.campaignId && a.item &&
      a.item.tokenImageId === img.id);
    if (!inBlock && !asCover && !asToken) { res.writeHead(404); return res.end(); }
  }
  const headers = { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=3600' };
  if (query.download) { // stažení přílohy s původním názvem
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(img.originalName || 'priloha')}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(path.join(UPLOAD_DIR, img.filename)).pipe(res);
});

// Nahrání loga aplikace (zobrazí se vlevo nahoře vedle názvu a jako ikonka záložky)
route('POST', '/api/app-logo', async (req, res, params, userId, query) => {
  if (!userId && !isAdmin(req)) return sendJSON(res, 401, { error: 'Nepřihlášen' });
  const buffer = await readBody(req);
  const file = parseMultipartFile(buffer, req.headers['content-type']);
  if (!file) return sendJSON(res, 400, { error: 'Soubor chybí.' });
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mime)) return sendJSON(res, 400, { error: 'Nahrajte obrázek (PNG/JPG/WebP).' });
  fs.writeFileSync(path.join(PUBLIC_DIR, 'logo.png'), file.data);
  sendJSON(res, 200, { ok: true });
});

// ================================================================ ŠABLONY BLOKŮ (DM)
route('GET', '/api/campaigns/:cid/templates', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  sendJSON(res, 200, db.templates.filter(t => t.campaignId === cid)
    .map(t => ({ id: t.id, name: t.name, type: t.type, content: t.content }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs')));
});

route('POST', '/api/campaigns/:cid/templates', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const { name, type, content } = await readJSONBody(req);
  if (!name || !type) return sendJSON(res, 400, { error: 'Chybí název nebo typ.' });
  const c = { ...(content || {}) };
  if (typeof c.html === 'string') c.html = sanitizeHTML(c.html);
  const t = { id: nextId(), campaignId: cid, name: String(name).slice(0, 80), type: String(type), content: c };
  db.templates.push(t); save();
  sendJSON(res, 200, { id: t.id });
});

route('DELETE', '/api/templates/:id', async (req, res, params, userId, query) => {
  const t = db.templates.find(x => x.id === parseInt(params.id, 10));
  if (!t) return sendJSON(res, 404, { error: 'Šablona nenalezena.' });
  const viewer = userId && resolveViewer(userId, t.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  db.templates = db.templates.filter(x => x.id !== t.id); save();
  sendJSON(res, 200, { ok: true });
});

// ================================================================ HERNÍ SEZENÍ
/** Viditelnost JEDNOHO bloku zápisu POSTAVY: DM vše; autorská postava vždy; 'all' všichni; 'custom' vybrané postavy. */
function entryBlockVisible(bl, ownerCharId, viewer, campaignId) {
  if (viewer.isDM) return true;
  const active = userCharIds(campaignId, viewer.userId);
  if (active.includes(ownerCharId)) return true;
  if (bl.visibility === 'all') return true;
  if (bl.visibility === 'custom') return (bl.visibleTo || []).some(id => active.includes(id));
  return false; // 'dm'
}
/** Účastníci sezení jsou POSTAVY; podpora starého formátu (players = userIds). */
function normalizeSessionChars(cid, body) {
  let chars = Array.isArray(body.characters) ? body.characters : null;
  if (!chars && Array.isArray(body.players)) {
    chars = body.players.flatMap(uid => db.characters.filter(c => c.campaignId === cid && c.userId === uid).map(c => c.id));
  }
  return (chars || []).filter(id => { const ch = db.characters.find(c => c.id === id); return ch && ch.campaignId === cid; });
}

route('GET', '/api/campaigns/:cid/sessions', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  const active = userCharIds(cid, viewer.userId);
  const rows = db.sessions.filter(s => s.campaignId === cid)
    // sezení vidí jen ÚČASTNÍCÍ SE POSTAVA (aktivní postava diváka)
    .filter(s => viewer.isDM || (s.characters || []).some(id => active.includes(id)))
    .map(s => ({
      id: s.id, title: s.title, date: s.date,
      participants: (s.characters || []).map(id => { const ch = db.characters.find(c => c.id === id); return ch ? { charId: id, name: ch.name } : null; }).filter(Boolean)
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  sendJSON(res, 200, rows);
});

route('POST', '/api/campaigns/:cid/sessions', async (req, res, params, userId, query) => {
  const cid = parseInt(params.cid, 10);
  const viewer = userId && resolveViewer(userId, cid, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const body = await readJSONBody(req);
  const { title, date } = body;
  if (!title) return sendJSON(res, 400, { error: 'Zadejte název sezení.' });
  const now = new Date().toISOString();
  // zápis DM = plnohodnotný článek s bloky a viditelností (mimo běžné seznamy)
  const sid = nextId();
  const art = {
    id: nextId(), campaignId: cid, title: `Zápis ze sezení: ${String(title).trim()}`,
    description: '', category: '', tags: '', coverImageId: null,
    sessionId: sid, createdAt: now, updatedAt: now
  };
  db.articles.push(art);
  const s = {
    id: sid, campaignId: cid, title: String(title).trim().slice(0, 120), date: String(date || '').slice(0, 10),
    characters: normalizeSessionChars(cid, body), // účastníci = POSTAVY
    scenario: { left: '', right: '' }, reportArticleId: art.id, entries: [], createdAt: now
  };
  db.sessions.push(s); save();
  sendJSON(res, 200, { id: s.id });
});

route('GET', '/api/sessions/:id', async (req, res, params, userId, query) => {
  const s = db.sessions.find(x => x.id === parseInt(params.id, 10));
  if (!s) return sendJSON(res, 404, { error: 'Sezení nenalezeno.' });
  const viewer = userId && resolveViewer(userId, s.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  // ne-účastnící se POSTAVA se nesmí dozvědět ani to, že sezení existuje → stejná 404
  const activeIds = userCharIds(s.campaignId, viewer.userId);
  if (!viewer.isDM && !(s.characters || []).some(id => activeIds.includes(id))) return sendJSON(res, 404, { error: 'Sezení nenalezeno.' });
  const out = {
    id: s.id, title: s.title, date: s.date, reportArticleId: s.reportArticleId,
    participants: (s.characters || []).map(id => { const ch = db.characters.find(c => c.id === id); return ch ? { charId: id, name: ch.name } : null; }).filter(Boolean),
    // chatovací místnosti přiřazené k tomuto sezení (jen ty, do kterých divák smí)
    chatRooms: db.chatRooms.filter(r => r.campaignId === s.campaignId && (r.sessionIds || []).includes(s.id) && roomForViewer(r, viewer))
      .map(r => ({ id: r.id, name: r.name })),
    canManage: viewer.isDM,
    // SCÉNÁŘ je tajný — hráčům (i v režimu „zobrazit jako“) se vůbec neodešle
    scenario: viewer.isDM ? (s.scenario || { left: '', right: '' }) : undefined,
    entries: (s.characters || []).map(charId => {
      const ch = db.characters.find(c => c.id === charId);
      const e = s.entries.find(x => x.charId === charId) || { blocks: [] };
      const mine = activeIds.includes(charId); // zápis patří POSTAVĚ
      const wantEdit = String(query.edit || '') === '1';
      const blocks = (e.blocks || [])
        .filter(bl => entryBlockVisible(bl, charId, viewer, s.campaignId))
        .map(bl => ({
          id: bl.id,
          // surová data jen při EXPLICITNÍ editaci vlastního zápisu (?edit=1)
          html: (mine && wantEdit) || viewer.isDM
            ? processRefs(bl.html || '', viewer, s.campaignId)
            : processLangs(processRefs(bl.html || '', viewer, s.campaignId), viewer, s.campaignId),
          updatedAt: bl.updatedAt,
          ...(viewer.isDM || mine ? { visibility: bl.visibility || 'all', visibleTo: bl.visibleTo || [], text: bl.text || '' } : {})
        }));
      return { charId, name: ch ? ch.name : '?', mine, blocks, empty: blocks.length === 0 };
    })
  };
  sendJSON(res, 200, out);
});

route('PUT', '/api/sessions/:id', async (req, res, params, userId, query) => {
  const s = db.sessions.find(x => x.id === parseInt(params.id, 10));
  if (!s) return sendJSON(res, 404, { error: 'Sezení nenalezeno.' });
  const viewer = userId && resolveViewer(userId, s.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  const body = await readJSONBody(req);
  if (body.title) s.title = String(body.title).trim().slice(0, 120);
  if (body.date !== undefined) s.date = String(body.date || '').slice(0, 10);
  if (Array.isArray(body.characters) || Array.isArray(body.players)) {
    s.characters = normalizeSessionChars(s.campaignId, body);
  }
  if (body.scenario && typeof body.scenario === 'object') {
    s.scenario = {
      left: sanitizeHTML(String(body.scenario.left || '')),
      right: sanitizeHTML(String(body.scenario.right || ''))
    };
  }
  save();
  sendJSON(res, 200, { ok: true });
});

route('DELETE', '/api/sessions/:id', async (req, res, params, userId, query) => {
  const s = db.sessions.find(x => x.id === parseInt(params.id, 10));
  if (!s) return sendJSON(res, 404, { error: 'Sezení nenalezeno.' });
  const viewer = userId && resolveViewer(userId, s.campaignId, query.viewAs);
  if (!viewer || !viewer.realDM) return sendJSON(res, 403, { error: 'Pouze DM.' });
  db.blocks = db.blocks.filter(b => b.articleId !== s.reportArticleId);
  db.articles = db.articles.filter(a => a.id !== s.reportArticleId);
  db.sessions = db.sessions.filter(x => x.id !== s.id);
  save();
  sendJSON(res, 200, { ok: true });
});

// zápis hráče k sezení — při „zobrazit jako“ zapisuje EMULOVANÝ hráč
route('PUT', '/api/sessions/:id/entry', async (req, res, params, userId, query) => {
  const s = db.sessions.find(x => x.id === parseInt(params.id, 10));
  if (!s) return sendJSON(res, 404, { error: 'Sezení nenalezeno.' });
  const viewer = userId && resolveViewer(userId, s.campaignId, query.viewAs);
  if (!viewer) return sendJSON(res, 403, { error: 'Nejste členem kampaně.' });
  // zápis patří AKTIVNÍ POSTAVĚ — ta musí být účastníkem sezení
  const myChar = userCharIds(s.campaignId, viewer.userId)[0];
  if (!myChar || !(s.characters || []).includes(myChar)) {
    return sendJSON(res, 403, { error: 'Zapisovat může jen postava, která se sezení účastní (přepněte se na ni).' });
  }
  const body = await readJSONBody(req);
  const validChar = id => { const ch = db.characters.find(c => c.id === id); return ch && ch.campaignId === s.campaignId; };
  const now = new Date().toISOString();
  const blocks = (Array.isArray(body.blocks) ? body.blocks : []).map(bl => {
    const visibility = ['all', 'dm', 'custom'].includes(bl.visibility) ? bl.visibility : 'all';
    return {
      id: parseInt(bl.id, 10) || nextId(),
      html: sanitizeHTML(String(bl.html || '')),
      text: String(bl.text || '').slice(0, 20000),
      visibility,
      visibleTo: visibility === 'custom' ? (Array.isArray(bl.visibleTo) ? bl.visibleTo.filter(validChar) : []) : [],
      updatedAt: now
    };
  }).filter(bl => bl.html.trim() || bl.text.trim());
  let e = s.entries.find(x => x.charId === myChar);
  if (!e) { e = { charId: myChar, blocks: [] }; s.entries.push(e); }
  e.blocks = blocks;
  save();
  sendJSON(res, 200, { ok: true });
});

// ================================================================ server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    const userId = getSessionUser(req);
    CURRENT_VIEWCHAR = parseInt(query.viewChar, 10) || null; // aktivní postava (platnost se ověřuje v userCharIds)

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return await r.handler(req, res, params, userId, query);
    }

    if (url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Neznámá cesta.' });

    // statické soubory + SPA fallback
    let filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // app.js / style.css / index.html se mění s každou aktualizací → prohlížeč (i tunel)
    // je musí vždy ověřit, jinak servíruje starou verzi i po přepsání souboru
    if (['.html', '.js', '.css'].includes(ext)) headers['Cache-Control'] = 'no-cache, must-revalidate';
    // do index.html doplníme název aplikace do <title> — záložka prohlížeče tak sedí
    // hned od načtení, ještě než se rozběhne JS (a platí i pro záložky/historii)
    if (ext === '.html') {
      const name = (db.settings && db.settings.appName) || APP_NAME_DEFAULT;
      const html = fs.readFileSync(filePath, 'utf8')
        .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escHTML(name)}</title>`);
      res.writeHead(200, headers);
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: 'Chyba serveru.' });
  }
});

server.listen(PORT, () => console.log(`DnD wiki běží na http://localhost:${PORT}`));

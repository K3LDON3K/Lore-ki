/* DnD Wiki — frontend (vanilla JS SPA)
   Pozn.: frontend NIKDY nefiltruje viditelnost — dostává už jen to,
   co server dovolil. Vše zde je pouze zobrazení. */

const $app = document.getElementById('app');
const state = {
  me: null,          // {id, username}
  campaign: null,    // {id, name, role}
  players: [],       // členové vč. rolí — jen pro DM
  members: [],       // jména členů — pro všechny (poznámky)
  characters: [],    // postavy kampaně — viditelnost a poznámky se cílí na ně
  languages: [],     // jazyky kampaně {id, title, color, common}
  cats: [],          // kategorie pro sidebar
  catColors: {},     // uživatelské barvy kategorií
  viewAs: null,      // userId hráče při náhledu "zobrazit jako"
  viewChar: null,    // id aktivní postavy — „za koho“ se právě dívám
  appName: 'Lore-ki',
};
const previewCache = new Map(); // cache náhledů referencí

/** Název aplikace se mění v administraci — musí se propsat i do záložky prohlížeče.
    Jediné místo, kde se název nastavuje, ať se na title nedá zapomenout. */
function setAppName(name) {
  if (name) state.appName = name;
  document.title = state.appName;
}

// ---------------------------------------------------------------- téma
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'light';
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  route();
}

// ---------------------------------------------------------------- utils
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function h(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }
function fmtDate(iso) { try { return new Date(iso).toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } }

async function api(path, opts = {}) {
  const url = new URL(path, location.origin);
  if (state.viewAs) url.searchParams.set('viewAs', state.viewAs);
  if (state.viewChar) url.searchParams.set('viewChar', state.viewChar);
  const res = await fetch(url, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Chyba ${res.status}`);
  return data;
}

function imgUrl(id) { return `/api/images/${id}` + (state.viewAs ? `?viewAs=${state.viewAs}` : ''); }
function isDM() { return state.campaign && state.campaign.role === 'dm'; }
function canEdit() { return isDM() && !state.viewAs; }
function memberName(uid) {
  const m = state.members.find(m => m.id === uid);
  return m ? m.name : `#${uid}`;
}
function charName(chId) {
  const ch = state.characters.find(c => c.id === chId);
  return ch ? ch.name : `#${chId}`;
}
function myCharacters() { return state.characters.filter(c => c.userId === state.me.id); }

// ---------------------------------------------------------------- kategorie: ikony + barevný nádech
const CAT_STYLE = { // systémové a běžné kategorie: emoji + odstín (H,S dvojice; L dopočítá režim)
  'Kampaň': ['🏠', 265], 'Hráčské postavy': ['🧝', 210], 'Předměty': ['🎒', 40],
  'Jazyk': ['🗣️', 285], 'NPC': ['👤', 150], 'Monstra': ['🐲', 355],
  'Města': ['🏰', 30], 'Lokace': ['🗺️', 175], 'Frakce': ['⚔️', 20], 'Bohové': ['✨', 50],
  'Historie': ['📜', 35], 'Události': ['🎬', 320], 'Questy': ['📌', 130], 'Pravidla světa': ['📖', 240],
  'Příšery': ['🐲', 355]
};
function catIcon(cat) { return (CAT_STYLE[cat] && CAT_STYLE[cat][0]) || '📄'; }
/** Barevný nádech kategorie — uživatelská barva má přednost, pak přednastavený odstín,
    jinak odvozeno z názvu; jas se přizpůsobí nočnímu/dennímu režimu. */
function catTint(cat) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const custom = state.catColors && state.catColors[cat];
  if (custom) {
    // uživatelská barva → jemný průhledný nádech + samotná barva pro proužek
    return { bar: custom, bg: hexToRgba(custom, dark ? 0.16 : 0.10) };
  }
  let hue = CAT_STYLE[cat] ? CAT_STYLE[cat][1] : null;
  if (hue == null) { let h = 0; for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) % 360; hue = h; }
  const bar = `hsl(${hue} 60% ${dark ? 62 : 45}%)`;
  const bg = `hsl(${hue} 55% ${dark ? 22 : 92}% / ${dark ? 0.5 : 0.7})`;
  return { bar, bg };
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
/** Efektivní barva kategorie jako #hex (pro input type=color) — nezávisle na režimu. */
function catColorHex(cat) {
  const custom = state.catColors && state.catColors[cat];
  if (custom) return custom;
  const hue = CAT_STYLE[cat] ? CAT_STYLE[cat][1] : (() => { let h = 0; for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; })();
  return hslToHex(hue, 60, 50);
}
/** Průsvitná varianta barvy (přijímá #hex i hsl()). */
function hexTint(color, a = 0.16) {
  if (color[0] === '#') return hexToRgba(color, a);
  const m = /hsl\(\s*([\d.]+)[^\d]+([\d.]+)%[^\d]+([\d.]+)%/.exec(color);
  return m ? `hsl(${m[1]} ${m[2]}% ${m[3]}% / ${a})` : color;
}

/** Rich obsah bloku → HTML. Server už HTML sanitizoval a reference přefiltroval.
    Editorům chodí surová označení jazyků (s data-lang) — doplní se jim popisek. */
function richHTML(c, owned = false) {
  let html = (typeof c.html === 'string' && c.html.trim()) ? c.html : esc(c.text || '');
  html = html.replace(/<span\b([^>]*\bdata-lang="(\d+)"[^>]*)>/g, (m, attrs, id) => {
    const l = state.languages.find(x => x.id === parseInt(id, 10));
    return l ? `<span ${attrs} title="Jazyk: ${esc(l.title)}">` : m;
  });
  // obrázek v textu označený „zobrazit v náhledech“ — štítek vidí jen ten, kdo článek edituje
  // (pro čtenáře je to redakční detail, nemá mu zaplevelovat článek)
  html = html.replace(/<img\b(?=[^>]*\bdata-preview="1")[^>]*>/gi, m => {
    const tagged = m.replace(/<img\b/i, '<img title="Tento obrázek se zobrazuje i v náhledech článku"');
    return (canEdit() || owned)
      ? `<span class="imgprev">${tagged}<span class="imgprev-tag" title="Tento obrázek se zobrazuje i v náhledech článku">★</span></span>`
      : tagged;
  });
  return refsToLinks(html);
}
/** Obrázky článku pro galerii nahoře i pro lightbox — jeden zdroj pravdy, protože
    data-gal="N" je index do TÉHOŽ pole (jinak by náhled otevřel jiný obrázek).
    Pořadí a pravidla kopírují server (blockPreviewImgs): titulní obrázek,
    obrázkové bloky se „zobrazit v náhledu“ a obrázky v textu s data-preview. */
function articleGalleryIds(a) {
  const inline = (b) => {
    const html = (b.content || {}).html;
    if (typeof html !== 'string') return [];
    return [...html.matchAll(/<img\b(?=[^>]*\bdata-preview="1")[^>]*\bsrc="\/api\/images\/(\d+)"[^>]*>/gi)]
      .map(m => parseInt(m[1], 10));
  };
  return [a.coverImageId, ...(a.blocks || []).flatMap(b => [
    ...(b.type === 'image' && (b.content || {}).imageId && b.content.preview ? [b.content.imageId] : []),
    ...inline(b)
  ])].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
}
function refsToLinks(str) {
  return String(str).replace(/\[\[(\d+)\|([^\]]*)\]\]/g,
    (_, id, label) => `<a class="ref" href="#/c/${state.campaign.id}/a/${id}">${esc(label)}</a>`);
}
/** Vytáhne ID videa z YouTube odkazu. */
function ytId(url) {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{6,20})/.exec(url || '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- router
window.addEventListener('hashchange', route);

// ochrana neuložených změn (sezení) + autosave + Ctrl+S
let sessionGuard = null;  // {dirty:()=>bool, hash, save:()=>Promise}
let sessionTimer = null;
let suppressRoute = false;
window.addEventListener('beforeunload', e => {
  if (sessionGuard && sessionGuard.dirty()) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && sessionGuard) {
    e.preventDefault(); sessionGuard.save();
  }
});

async function route() {
  if (suppressRoute) { suppressRoute = false; return; }
  try { const info = await api('/api/app-info'); if (info && info.name) setAppName(info.name); } catch { }
  if (sessionGuard && sessionGuard.dirty() && location.hash !== sessionGuard.hash) {
    if (!await confirmDialog('Máte neuložené změny v sezení. Uložit je můžete tlačítkem 💾 nebo Ctrl+S.', { title: 'Odejít bez uložení?', ok: 'Odejít bez uložení', cancel: 'Zůstat', danger: true })) {
      suppressRoute = true; location.hash = sessionGuard.hash; return;
    }
  }
  sessionGuard = null;
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  closeCtxMenu(); hideRefTip(); closeRefPane(); // panel reference je dočasný — přechod ho zavře
  previewCache.clear();
  state.me = state.me || await api('/api/me');
  if (!state.me) return renderAuth();

  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'help') { state.campaign = null; chatTeardown(); return renderHelp(); }
  if (parts[0] === 'admin') { state.campaign = null; chatTeardown(); return renderAdmin(); }
  if (parts[0] === 'c' && parts[1]) {
    const cid = parseInt(parts[1], 10);
    if (!state.campaign || state.campaign.id !== cid) {
      const camps = await api('/api/campaigns');
      state.campaign = camps.find(c => c.id === cid) || null;
      state.viewAs = null;
      if (!state.campaign) { location.hash = '#/'; return; }
      state.members = await api(`/api/campaigns/${cid}/members`);
      state.players = isDM() ? await api(`/api/campaigns/${cid}/players`) : [];
    }
    try { state.characters = await api(`/api/campaigns/${cid}/characters`); } catch { state.characters = []; }
    try { state.languages = await api(`/api/campaigns/${cid}/languages`); } catch { state.languages = []; }
    // aktivní postava musí patřit aktuálnímu „divákovi“
    const viewUser = state.viewAs || state.me.id;
    if (state.viewChar && !state.characters.some(c => c.id === state.viewChar && c.userId === viewUser)) state.viewChar = null;
    // hráč se VŽDY dívá za právě jednu postavu — výchozí je jeho zvolená (⭐), jinak první
    if (!isDM() && !state.viewChar) {
      const mine = state.characters.filter(c => c.userId === state.me.id);
      if (mine.length) {
        state.viewChar = mine.some(c => c.id === state.campaign.defaultCharId)
          ? state.campaign.defaultCharId : mine[0].id;
      }
    }
    try { state.cats = await api(`/api/campaigns/${cid}/categories`); } catch { state.cats = []; }
    try { state.catColors = (await api(`/api/campaigns/${cid}/category-colors`)).colors || {}; } catch { state.catColors = {}; }
    chatInit(); // plovoucí chat panel (drží se mimo router)
    const sub = parts[2];
    if (sub === 'a' && parts[3]) return renderArticle(parseInt(parts[3], 10));
    if (sub === 'edit' && parts[3]) return renderEditor(parseInt(parts[3], 10));
    if (sub === 'new') return renderEditor(null); // nový článek rovnou formulářem
    if (sub === 'players') return renderPlayers();
    if (sub === 'categories') return renderCategoriesAdmin();
    if (sub === 'sessions') return renderSessions();
    if (sub === 'inventory') return renderInventory();
    if (sub === 'session' && parts[3]) return renderSession(parseInt(parts[3], 10));
    if (sub === 'help') return renderHelp();
    if (sub === 'settings') return renderCampaignSettings(parts[3] || 'general');
    if (sub === 'search') return renderSearch(decodeURIComponent(parts[3] || ''));
    return renderArticleList(sub === 'cat' ? decodeURIComponent(parts[3] || '') : null);
  }
  state.campaign = null;
  chatTeardown();
  renderCampaigns();
}

// ---------------------------------------------------------------- auth
function renderAuth(mode = 'login', error = '', info = '') {
  const title = mode === 'login' ? 'Přihlášení' : mode === 'register' ? 'Registrace' : 'Obnova hesla';
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="center"><img src="/logo.png?v=${localStorage.getItem('logoV') || 1}" alt="" class="auth-logo"
        onerror="this.outerHTML='<span style=&quot;font-size:56px&quot;>🐉</span>'"></div>
      <h1 class="center" style="margin:6px 0 0">${esc(state.appName)}</h1>
      <p class="center muted" style="margin-top:2px">od Sklípky a ještěrky</p>
      <div class="card">
        <h3>${title}</h3>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
        ${info ? `<div style="color:var(--ok); font-size:14px; margin:8px 0">${esc(info)}</div>` : ''}
        <label>Uživatelské jméno</label>
        <input id="username" autocomplete="username">
        ${mode === 'reset' ? `
          <label>Master heslo</label>
          <input id="master" type="password" autocomplete="off">
          <label>Nové heslo</label>
          <input id="password" type="password" autocomplete="new-password" placeholder="min. 4 znaky">
        ` : `
          <label>Heslo</label>
          <input id="password" type="password" autocomplete="current-password">
        `}
        <div style="margin-top:18px; display:flex; gap:12px; align-items:center; flex-wrap:wrap">
          <button id="submit">${mode === 'login' ? 'Přihlásit se' : mode === 'register' ? 'Zaregistrovat se' : 'Nastavit nové heslo'}</button>
          <a href="javascript:void 0" id="switch">${mode === 'login' ? 'Nemám účet' : 'Zpět na přihlášení'}</a>
          ${mode === 'login' ? `<a href="javascript:void 0" id="forgot" class="muted">Zapomenuté heslo?</a>` : ''}
        </div>
      </div>
    </div>`;
  const submit = async () => {
    const username = $app.querySelector('#username').value;
    const password = $app.querySelector('#password').value;
    try {
      if (mode === 'reset') {
        await api('/api/reset-password', {
          method: 'POST',
          body: { username, masterPassword: $app.querySelector('#master').value, newPassword: password }
        });
        renderAuth('login', '', `Heslo pro „${username.trim()}“ bylo změněno. Přihlaste se novým heslem.`);
        return;
      }
      state.me = await api(mode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST', body: { username, password }
      });
      location.hash = '#/'; route();
    } catch (e) { renderAuth(mode, e.message); }
  };
  $app.querySelector('#submit').onclick = submit;
  $app.querySelector('#password').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $app.querySelector('#switch').onclick = () => renderAuth(mode === 'login' ? 'register' : 'login');
  const fg = $app.querySelector('#forgot');
  if (fg) fg.onclick = () => renderAuth('reset');
}

// ---------------------------------------------------------------- shell
// ---------------------------------------------------------------- navigace v postranním panelu
// Jedno místo, které zná všechny položky; pořadí si DM mění v nastavení kampaně
// (state.campaign.navOrder). Nápověda tu není — stačí ❓ v horní liště.
const NAV_DEFS = {
  campaigns: { icon: '🏰', label: 'Kampaně', href: () => '#/', isActive: () => false },
  home: {
    icon: '🏠', label: 'O kampani', dmOnly: false,
    href: cid => `#/c/${cid}/a/${state.campaign.homeArticleId}`,
    show: () => !!state.campaign.homeArticleId,
    isActive: a => a === 'home',
  },
  articles: { icon: '📚', label: 'Všechny články', href: cid => `#/c/${cid}`, isActive: (a, cat) => a === 'articles' && cat === null },
  sessions: { icon: '🗓', label: 'Herní sezení', href: cid => `#/c/${cid}/sessions`, isActive: a => a === 'sessions' },
  inventory: { icon: '🎒', label: 'Inventář', href: cid => `#/c/${cid}/inventory`, isActive: a => a === 'inventory' },
  // Správa hráčů i Kategorie žijí jako záložky uvnitř Nastavení kampaně
  settings: { icon: '⚙️', label: 'Nastavení kampaně', dmOnly: true, href: cid => `#/c/${cid}/settings`, isActive: a => a === 'settings' },
};
const NAV_KEYS = Object.keys(NAV_DEFS);
/** Pořadí z kampaně, doplněné o chybějící klíče — starší kampaň nebo nová položka nikdy nezmizí. */
function navOrder() {
  const saved = (state.campaign && Array.isArray(state.campaign.navOrder) ? state.campaign.navOrder : [])
    .filter(k => NAV_KEYS.includes(k));
  return [...new Set([...saved, ...NAV_KEYS])];
}
/** Položky navigace pro aktuálního uživatele (bez těch, na které nemá právo). */
function navItems(cid) {
  return navOrder().map(k => ({ key: k, ...NAV_DEFS[k] }))
    .filter(it => (!it.dmOnly || canEdit()) && (!it.show || it.show()))
    .map(it => ({ ...it, href: it.href(cid) }));
}

// ---------------------------------------------------------------- Nastavení kampaně: záložky
// Stránky zůstávají samostatné (vlastní adresy), jen sdílí hlavičku se záložkami.
const SETTINGS_TABS = [
  { key: 'general', icon: '⚙️', label: 'Obecné', path: 'settings' },
  { key: 'nav', icon: '🧭', label: 'Navigace', path: 'settings/nav' },
  { key: 'inv', icon: '🎒', label: 'Inventář', path: 'settings/inv' },
  { key: 'articles', icon: '📄', label: 'Články', path: 'settings/articles' },
  { key: 'players', icon: '👥', label: 'Hráči a postavy', path: 'players' },
  { key: 'categories', icon: '🏷️', label: 'Kategorie', path: 'categories' },
];
function settingsHead(activeTab) {
  const cid = state.campaign.id;
  return `<div class="pagehead"><h1>⚙️ Nastavení kampaně</h1></div>
    <nav class="tabbar">${SETTINGS_TABS.map(t =>
    `<a class="tab ${t.key === activeTab ? 'active' : ''}" href="#/c/${cid}/${t.path}">${t.icon} ${esc(t.label)}</a>`).join('')}</nav>`;
}
const settingsTabLabel = key => (SETTINGS_TABS.find(t => t.key === key) || {}).label || '';

function shell(contentHTML, { activeCat = undefined, active = '', noSidebar = false, crumbs = [] } = {}) {
  const cid = state.campaign ? state.campaign.id : null;

  // ---- proklikávací cesta: Kampaně / <kampaň> / <sekce> / <stránka>
  // Sekce se odvodí z `active`/`activeCat`, `crumbs` doplní konkrétní stránku (název článku…).
  const crumbHTML = (() => {
    const items = [{ label: '🏰 Kampaně', href: '#/' }];
    if (cid) {
      // název kampaně vede na její domovský článek (rozcestník kampaně);
      // starší kampaně bez domovského článku spadnou na seznam článků
      items.push({
        label: state.campaign.name,
        href: state.campaign.homeArticleId ? `#/c/${cid}/a/${state.campaign.homeArticleId}` : `#/c/${cid}`
      });
      const SECTION = {
        home: { label: 'O kampani', href: `#/c/${cid}/a/${state.campaign.homeArticleId}` },
        sessions: { label: 'Herní sezení', href: `#/c/${cid}/sessions` },
        inventory: { label: 'Inventář', href: `#/c/${cid}/inventory` },
        help: { label: 'Nápověda', href: `#/c/${cid}/help` },
        settings: { label: 'Nastavení kampaně', href: `#/c/${cid}/settings` },
      };
      if (active === 'articles') {
        items.push({ label: 'Všechny články', href: `#/c/${cid}` });
        if (activeCat) items.push({ label: activeCat, href: `#/c/${cid}/cat/${encodeURIComponent(activeCat)}` });
      } else if (SECTION[active]) items.push(SECTION[active]);
    } else if (active === 'help') {
      items.push({ label: 'Nápověda' }); // nápověda otevřená mimo kampaň
    }
    items.push(...crumbs.filter(Boolean));
    if (items.length < 2) return ''; // na přehledu kampaní by cesta jen opakovala nadpis
    // poslední článek cesty = kde jsem → není odkaz
    return `<nav class="crumbbar" aria-label="Cesta">${items.map((it, i) => {
      const last = i === items.length - 1;
      return (last || !it.href)
        ? `<span class="crumb cur" aria-current="page">${esc(it.label)}</span>`
        : `<a class="crumb" href="${it.href}">${esc(it.label)}</a><span class="crumb-sep">/</span>`;
    }).join('')}</nav>`;
  })();
  const sidebar = (!noSidebar && cid) ? `
    <h4>Navigace</h4>
    ${navItems(cid).map(it => `<a class="catlink ${it.isActive(active, activeCat) ? 'active' : ''}" href="${it.href}">${it.icon} ${esc(it.label)}</a>`).join('')}
    <h4>Kategorie</h4>
    ${state.cats.length ? state.cats.map(c => `
      <a class="catlink ${activeCat === c.name ? 'active' : ''}"
         href="#/c/${cid}/cat/${encodeURIComponent(c.name)}"><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${catTint(c.name).bar};margin-right:7px;vertical-align:middle"></span>${catIcon(c.name)} ${esc(c.name)} <span class="count">${c.count}</span></a>`).join('')
      : '<span class="muted" style="padding:0 12px">Zatím žádné</span>'}` : '';

  // seznamy pro přepínač pohledu (potřebné i při navazování obsluhy níže)
  const dmChars = isDM() ? state.characters : [];
  const dmCharless = isDM() ? state.players.filter(p => p.role === 'player' && !dmChars.some(c => c.userId === p.id)) : [];
  const myChars = (!isDM() && state.me) ? state.characters.filter(c => c.userId === state.me.id) : [];

  $app.innerHTML = `
    <header class="topbar">
      ${sidebar ? `<button class="navbtn" id="menuToggle">☰</button>` : ''}
      <button class="navbtn" id="backBtn" title="Zpět">←</button>
      <a class="logo" href="#/"><img src="/logo.png?v=${localStorage.getItem('logoV') || 1}" alt="" class="logo-img"
        onerror="this.outerHTML='<span class=&quot;dice&quot;>🐉</span>'"><span>${esc(state.appName)}<span class="logo-sub">od Sklípky a ještěrky</span></span></a>
      <div class="grow"></div>
      ${cid ? `<div class="searchwrap">
        <input class="search" id="searchbox" placeholder="🔍 Hledat…" autocomplete="off" spellcheck="false">
        <div class="searchdrop" id="searchDrop" hidden></div>
      </div>` : ''}
      ${isDM() ? (() => { // DM: emulace pohledu LIBOVOLNÉ hráčské postavy
        if (!dmChars.length && !dmCharless.length) return '';
        const cc = state.viewChar ? dmChars.find(c => c.id === state.viewChar) : null;
        const cur = cc ? `${cc.name} (${cc.username})`
          : (state.viewAs ? memberName(state.viewAs) : 'DM (vy)');
        return `<button class="navbtn viewpick" id="viewAsSelect" title="Čí pohled na svět právě vidíte">
          <span class="vp-cap">Pohled</span><span class="vp-val">${esc(cur)}</span><span class="vp-arrow">▾</span></button>`;
      })() : (() => { // hráč: vždy za právě jednu ze svých postav
        if (!cid || myChars.length < 2 || !state.viewChar) return '';
        const isDef = state.campaign.defaultCharId === state.viewChar;
        return `<button class="navbtn viewpick" id="viewCharSelect" title="Za kterou postavu se právě díváte — v nabídce lze hvězdičkou nastavit výchozí postavu">
          <span class="vp-cap">Za</span><span class="vp-val">${esc(charName(state.viewChar))}</span>${isDef ? `<span class="vp-star" title="Tato postava je výchozí">⭐</span>` : ''}<span class="vp-arrow">▾</span></button>`;
      })()}
      <!-- pravý roh: stejně vysoká tlačítka, vzhled i odhlášení pod jménem uživatele -->
      ${cid ? `<button class="topbtn online" id="onlineBadge" title="Právě přihlášení v kampani">
        <span class="dot"></span><span data-k="n">–</span></button>` : ''}
      <a class="topbtn icon" href="${cid ? `#/c/${cid}/help` : '#/help'}" title="Nápověda">?</a>
      <button class="topbtn user" id="userBtn" title="Účet, vzhled a odhlášení">
        <span class="avatar">${esc((state.me.username || '?').slice(0, 1).toUpperCase())}</span>
        <span class="uname">${esc(state.me.username)}</span><span class="caret">▾</span></button>
    </header>
    ${crumbHTML}
    ${state.viewAs ? `
      <div class="viewas-banner">
        👁 Náhled z pohledu ${state.viewChar ? `postavy: <strong>${esc(charName(state.viewChar))}</strong> (hraje ${esc(memberName(state.viewAs))})` : `hráče: <strong>${esc(memberName(state.viewAs))}</strong>`} — vidíte přesně to, co ${state.viewChar ? 'ona' : 'on'}.
        <button class="small secondary" id="exitViewAs">Ukončit náhled</button>
      </div>` : ''}
    <div class="layout" id="layout">
      ${sidebar ? `<aside class="sidebar">${sidebar}</aside>` : ''}
      <main class="content">${contentHTML}</main>
    </div>`;

  $app.querySelector('#backBtn').onclick = () => history.back();
  // nabídka pod jménem uživatele: vzhled + odhlášení
  const ub = $app.querySelector('#userBtn');
  ub.onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const r = ub.getBoundingClientRect();
    openCtxMenu(r.left, r.bottom + 6, [
      { icon: dark ? '☀️' : '🌙', label: dark ? 'Denní režim' : 'Noční režim', action: toggleTheme },
      {
        icon: '🚪', label: 'Odhlásit', action: async () => {
          await api('/api/logout', { method: 'POST' });
          state.me = null; state.campaign = null; location.hash = '#/'; route();
        }
      },
    ]);
  };
  const mt = $app.querySelector('#menuToggle');
  if (mt) mt.onclick = () => $app.querySelector('#layout').classList.toggle('drawer-open');
  const vs = $app.querySelector('#viewAsSelect');
  if (vs) vs.onclick = () => openPicker(vs, {
    placeholder: 'Hledat postavu nebo hráče…',
    value: state.viewChar ? 'c' + state.viewChar : (state.viewAs ? 'u' + state.viewAs : ''),
    groups: [
      { label: '', items: [{ value: '', label: 'DM (vy)' }] },
      { label: 'Postavy', items: dmChars.map(c => ({ value: 'c' + c.id, label: c.name, sub: c.username })) },
      { label: 'Hráči bez postavy', items: dmCharless.map(p => ({ value: 'u' + p.id, label: p.username })) },
    ],
    onPick: v => {
      if (!v) { state.viewAs = null; state.viewChar = null; }
      else if (v.startsWith('c')) { // emulace konkrétní postavy
        const ch = state.characters.find(c => c.id === parseInt(v.slice(1), 10));
        if (ch) { state.viewAs = ch.userId; state.viewChar = ch.id; }
      } else { state.viewAs = parseInt(v.slice(1), 10) || null; state.viewChar = null; }
      route();
    }
  });
  const vc = $app.querySelector('#viewCharSelect');
  if (vc) vc.onclick = () => openPicker(vc, {
    placeholder: 'Hledat postavu…',
    value: String(state.viewChar || ''),
    footer: '⭐ Hvězdička určí <b>výchozí postavu</b> — za tu se kampaň otevře po přihlášení.',
    groups: [{
      label: '', items: myChars.map(c => ({
        value: String(c.id), label: c.name, starable: true,
        isDefault: state.campaign.defaultCharId === c.id
      }))
    }],
    onPick: v => { state.viewChar = parseInt(v, 10) || null; route(); },
    onStar: async v => {
      const charId = parseInt(v, 10);
      await api(`/api/campaigns/${state.campaign.id}/default-char`, { method: 'PUT', body: { charId } });
      state.campaign.defaultCharId = charId;
      route();
    }
  });
  const ob = $app.querySelector('#onlineBadge');
  if (ob) {
    refreshOnline();
    ob.onclick = () => {
      const r = ob.getBoundingClientRect();
      const list = (state.online || []).map(u => ({ icon: u.dm ? '📖' : '🟢', label: u.username + (u.dm ? ' (DM)' : ''), action: () => { } }));
      openCtxMenu(r.left, r.bottom + 6, list.length ? list : [{ icon: '💤', label: 'Nikdo není online', action: () => { } }]);
    };
  }
  const ex = $app.querySelector('#exitViewAs');
  if (ex) ex.onclick = () => { state.viewAs = null; state.viewChar = null; route(); };
  // ---------- našeptávač: výsledky rovnou pod polem, Enter = stránka s výsledky
  const sb = $app.querySelector('#searchbox');
  if (sb) {
    const drop = $app.querySelector('#searchDrop');
    let items = [], sel = -1, timer = null, seq = 0;
    const close = () => { drop.hidden = true; drop.innerHTML = ''; items = []; sel = -1; };
    const toResults = q => { close(); location.hash = `#/c/${cid}/search/${encodeURIComponent(q)}`; };
    const toArticle = id => { close(); location.hash = `#/c/${cid}/a/${id}`; };
    const draw = (q) => {
      drop.innerHTML = (items.length
        ? items.map((r, i) => `<div class="sd-item ${i === sel ? 'sel' : ''}" data-i="${i}">
            <span class="sd-ico">${catIcon(r.category)}</span>
            <span class="sd-txt">
              <span class="sd-title">${esc(r.title)}</span>
              ${r.snippet ? `<span class="sd-snip">${esc(r.snippet)}</span>` : ''}
            </span></div>`).join('')
        : `<div class="sd-empty">Nic nenalezeno pro „${esc(q)}“</div>`)
        + `<div class="sd-all" data-all>🔍 Zobrazit všechny výsledky${items.length ? '' : ' a hledat jinak'}</div>`;
      drop.hidden = false;
      // preventDefault na mousedown: input nesmí ztratit fokus dřív, než projde klik
      drop.querySelectorAll('.sd-item').forEach(el => {
        el.onmousedown = e => e.preventDefault();
        el.onclick = () => toArticle(items[el.dataset.i].articleId);
      });
      const all = drop.querySelector('[data-all]');
      all.onmousedown = e => e.preventDefault();
      all.onclick = () => toResults(q);
    };
    const search = async (q) => {
      const my = ++seq;
      try {
        const r = await api(`/api/campaigns/${cid}/search?q=${encodeURIComponent(q)}`);
        if (my !== seq || sb.value.trim() !== q) return; // odpověď na starší dotaz → zahodit
        items = r.slice(0, 8); sel = -1; draw(q);
      } catch { close(); }
    };
    sb.oninput = () => {
      const q = sb.value.trim();
      clearTimeout(timer);
      if (q.length < 2) return close(); // u jednoho písmene nemá napovídání smysl
      timer = setTimeout(() => search(q), 180);
    };
    sb.onkeydown = e => {
      const q = sb.value.trim();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (sel >= 0 && items[sel]) return toArticle(items[sel].articleId); // vybráno šipkami
        if (q) toResults(q);
        return;
      }
      if (e.key === 'Escape') return close();
      if (drop.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; draw(q); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; draw(q); }
    };
    sb.onfocus = () => { if (sb.value.trim().length >= 2) sb.oninput(); };
    sb.onblur = () => setTimeout(close, 120); // pojistka, kdyby klik neprošel
  }
}

// ---------------------------------------------------------------- online indikátor
async function refreshOnline() {
  if (!state.campaign) return;
  try { state.online = await api(`/api/campaigns/${state.campaign.id}/online`); } catch { state.online = []; }
  const el = $app.querySelector('#onlineBadge');
  if (el) {
    el.querySelector('[data-k=n]').textContent = state.online.length; // tečku v tlačítku nepřepisovat
    el.classList.toggle('nobody', state.online.length === 0);
    el.title = state.online.length
      ? 'Právě online: ' + state.online.map(u => u.username + (u.dm ? ' (DM)' : '')).join(', ')
      : 'Nikdo není online';
  }
}

// ---------------------------------------------------------------- kontextové menu
let savedRange = null;
function saveSel() {
  const s = getSelection();
  if (s.rangeCount) savedRange = s.getRangeAt(0).cloneRange();
}
function restoreSel() {
  if (!savedRange) return;
  const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange);
}
function closeCtxMenu() { document.querySelectorAll('.ctxmenu').forEach(m => m.remove()); }
function openCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = h(`<div class="ctxmenu">${items.map((it, i) => `<button data-i="${i}">${it.icon || ''} ${esc(it.label)}</button>`).join('')}</div>`).firstElementChild;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  // zavření kliknutím mimo menu (mousedown, aby zůstal zachován výběr textu).
  // Listener odregistrujeme dřív, než spustíme akci tlačítka — jinak by případné
  // navazující menu (např. výběr barvy) tento listener hned zase zavřel.
  const cleanup = () => document.removeEventListener('mousedown', outside, true);
  const outside = e => { if (!menu.contains(e.target)) { cleanup(); closeCtxMenu(); } };
  menu.querySelectorAll('button').forEach(b => {
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { const it = items[b.dataset.i]; cleanup(); closeCtxMenu(); it.action(); };
  });
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
function attachCtxMenu(el, itemsFn) {
  el.addEventListener('contextmenu', e => { e.preventDefault(); saveSel(); openCtxMenu(e.clientX, e.clientY, itemsFn()); });
  let timer = null;
  el.addEventListener('touchstart', e => {
    timer = setTimeout(() => { saveSel(); const t = e.touches[0]; openCtxMenu(t.clientX, t.clientY, itemsFn()); }, 550);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev => el.addEventListener(ev, () => clearTimeout(timer), { passive: true }));
}

// ---------------------------------------------------------------- rozbalovací nabídka s hledáním (výběr postavy / pohledu)
// opts: { groups:[{label, items:[{value,label,sub,starable,isDefault}]}], value, onPick(value), onStar(value), footer, placeholder }
function openPicker(anchor, opts) {
  closeCtxMenu();
  const total = opts.groups.reduce((n, g) => n + g.items.length, 0);
  const withSearch = total > 5; // hledání má smysl až u delšího seznamu
  const menu = h(`<div class="ctxmenu picker">
    ${withSearch ? `<div class="picker-search"><input type="text" placeholder="${esc(opts.placeholder || 'Hledat…')}" autocomplete="off" spellcheck="false"></div>` : ''}
    <div class="picker-list"></div>
    ${opts.footer ? `<div class="picker-foot">${opts.footer}</div>` : ''}
  </div>`).firstElementChild;
  document.body.appendChild(menu);

  const list = menu.querySelector('.picker-list');
  const input = menu.querySelector('input');
  // hledání bez ohledu na diakritiku a velikost písmen
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cleanup = () => document.removeEventListener('mousedown', outside, true);
  const outside = e => { if (!menu.contains(e.target)) { cleanup(); closeCtxMenu(); } };
  let rows = [];

  const draw = (q) => {
    const nq = norm(q);
    rows = [];
    let html = '';
    opts.groups.forEach(g => {
      const its = g.items.filter(i => !nq || norm(i.label).includes(nq) || norm(i.sub).includes(nq));
      if (!its.length) return;
      if (g.label) html += `<div class="picker-group">${esc(g.label)}</div>`;
      its.forEach(i => {
        rows.push(i);
        html += `<div class="picker-item${String(i.value) === String(opts.value) ? ' sel' : ''}" data-v="${esc(String(i.value))}">
          <span class="pi-main">${esc(i.label)}${i.sub ? ` <span class="pi-sub">(${esc(i.sub)})</span>` : ''}</span>
          ${i.starable ? `<button class="pi-star${i.isDefault ? ' on' : ''}" data-star="${esc(String(i.value))}"
            title="${i.isDefault ? 'Výchozí postava — za tuto postavu se kampaň otevře' : 'Nastavit jako výchozí — kampaň se pak otevře za tuto postavu'}">${i.isDefault ? '⭐' : '☆'}</button>` : ''}
        </div>`;
      });
    });
    list.innerHTML = html || '<div class="picker-empty">Nic nenalezeno.</div>';
    list.querySelectorAll('.picker-item').forEach(el => {
      el.onmousedown = e => { if (!e.target.closest('.pi-star')) e.preventDefault(); };
      el.onclick = e => {
        if (e.target.closest('.pi-star')) return;
        cleanup(); closeCtxMenu(); opts.onPick(el.dataset.v);
      };
    });
    list.querySelectorAll('.pi-star').forEach(b => {
      b.onmousedown = e => e.preventDefault();
      b.onclick = e => { e.stopPropagation(); cleanup(); closeCtxMenu(); opts.onStar(b.dataset.star); };
    });
  };
  draw('');

  // umístění až po vykreslení obsahu (kvůli správné výšce)
  const ar = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(ar.left, innerWidth - mr.width - 8)) + 'px';
  menu.style.top = (ar.bottom + 6 + mr.height > innerHeight - 8
    ? Math.max(8, ar.top - mr.height - 6) : ar.bottom + 6) + 'px';

  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  if (input) {
    input.oninput = () => draw(input.value);
    input.onkeydown = e => {
      if (e.key === 'Escape') { cleanup(); closeCtxMenu(); }
      if (e.key === 'Enter' && rows.length) { cleanup(); closeCtxMenu(); opts.onPick(String(rows[0].value)); }
    };
    setTimeout(() => input.focus(), 10);
  }
}

// ---------------------------------------------------------------- náhledová bublina reference
let refTipEl = null;
function hideRefTip() { if (refTipEl) { refTipEl.remove(); refTipEl = null; } }
function showRefTip(link, html) {
  hideRefTip();
  refTipEl = h(`<div class="refpreview">${html}</div>`).firstElementChild;
  document.body.appendChild(refTipEl);
  const r = link.getBoundingClientRect();
  const tr = refTipEl.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), innerWidth - tr.width - 8);
  let top = r.bottom + 8;
  if (top + tr.height > innerHeight - 8) top = r.top - tr.height - 8;
  refTipEl.style.left = left + 'px';
  refTipEl.style.top = Math.max(8, top) + 'px';
}
document.addEventListener('mouseover', async e => {
  const link = e.target.closest('a.ref');
  if (!link || !state.campaign) return;
  const m = /#\/c\/\d+\/a\/(\d+)/.exec(link.getAttribute('href') || '');
  if (!m) return;
  const id = m[1];
  let data = previewCache.get(id);
  if (!data) {
    try { data = await api(`/api/articles/${id}/preview`); }
    catch (err) { data = { error: err.message }; }
    previewCache.set(id, data);
  }
  if (!link.matches(':hover')) return; // myš už odjela
  if (data.error) {
    showRefTip(link, `<div class="locked">🔒 ${esc(data.error)}</div>`);
  } else {
    showRefTip(link, `
      <div class="t">${esc(data.title)}</div>
      ${data.category ? `<span class="tag cat">${esc(data.category)}</span>` : ''}
      ${data.description ? `<div class="muted">${esc(data.description)}</div>` : ''}
      ${data.snippet ? `<div style="margin-top:4px">${esc(data.snippet)}</div>` : ''}
      ${data.thumbId ? `<img src="${imgUrl(data.thumbId)}" alt="">` : ''}`);
  }
});
document.addEventListener('mouseout', e => { if (e.target.closest('a.ref')) hideRefTip(); });

// ---------------------------------------------------------------- boční panel reference
// Kliknutí na referenci nepřechází na stránku — článek se otevře v dočasném panelu
// vpravo (stránka se rozdělí na menu | obsah | reference). Tlačítkem nahoře se dá
// přejít na plnou stránku článku.
let refPane = { id: null };
function refPaneEl() {
  const layout = document.getElementById('layout');
  if (!layout) return null;
  let el = document.getElementById('refpane');
  if (!el) {
    el = h('<aside class="refpane" id="refpane"></aside>').firstElementChild;
    layout.appendChild(el);
  }
  layout.classList.add('refpane-open');
  return el;
}
function closeRefPane() {
  refPane.id = null;
  const el = document.getElementById('refpane');
  if (el) el.remove();
  const l = document.getElementById('layout');
  if (l) l.classList.remove('refpane-open');
}
function openRefPane(id) {
  hideRefTip();
  refPane.id = id;
  refPaneRender();
}
async function refPaneRender() {
  const el = refPaneEl();
  if (!el || !refPane.id) return;
  const id = refPane.id;
  const head = (extra = '') => `
    <div class="refpane-head">
      ${extra}
      <div style="flex:1"></div>
      <button class="small ghost" data-k="close" title="Zavřít náhled">✕</button>
    </div>`;
  el.innerHTML = head() + `<div class="refpane-body"><p class="muted">Načítám…</p></div>`;
  el.querySelector('[data-k=close]').onclick = closeRefPane;

  let a;
  try { a = await api(`/api/articles/${id}`); }
  catch (e) {
    if (refPane.id !== id) return;
    el.innerHTML = head() + `<div class="refpane-body"><p class="muted">🔒 ${esc(e.message)}</p></div>`;
    el.querySelector('[data-k=close]').onclick = closeRefPane;
    return;
  }
  if (refPane.id !== id) return; // mezitím se otevřela jiná reference

  el.innerHTML = head(`<button class="small" data-k="goto" title="Otevřít článek přes celou stránku">↗ Přejít na stránku</button>`) + `
    <div class="refpane-body article-body">
      <h2 class="refpane-title">${esc(a.title)}</h2>
      <div class="refpane-tags">
        ${a.category ? `<span class="tag cat">${catIcon(a.category)} ${esc(a.category)}</span>` : ''}
        ${(a.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">#${esc(t.trim())}</span>`).join('')}
      </div>
      ${a.description ? `<p class="muted">${esc(a.description)}</p>` : ''}
      ${a.coverImageId ? `<img class="refpane-cover" src="${imgUrl(a.coverImageId)}" alt="">` : ''}
      ${a.blocks.length ? a.blocks.map(b => renderBlockHTML(b, a.owned) + revealBtnHTML(b)).join('') : '<p class="muted">Článek zatím nemá žádný obsah.</p>'}
    </div>`;
  el.querySelector('[data-k=close]').onclick = closeRefPane;
  el.querySelector('[data-k=goto]').onclick = () => { location.hash = `#/c/${state.campaign.id}/a/${id}`; };
  el.querySelector('.refpane-body').scrollTop = 0;
}
// klik na referenci → panel místo přechodu (Ctrl/Cmd+klik nechá projít na nové okno)
document.addEventListener('click', e => {
  const link = e.target.closest('a.ref');
  if (!link || !state.campaign) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  const m = /#\/c\/\d+\/a\/(\d+)/.exec(link.getAttribute('href') || '');
  if (!m) return;
  e.preventDefault();
  openRefPane(parseInt(m[1], 10));
});

// ---------------------------------------------------------------- potvrzovací dialog
/** Potvrzení v designu aplikace (náhrada nativního confirm). Vrací Promise<boolean>.
    opts: { title, icon, ok, cancel, danger } */
function confirmDialog(message, opts = {}) {
  const { title = 'Potvrzení', icon = '⚠️', ok = 'Potvrdit', cancel = 'Zrušit', danger = false } = opts;
  return new Promise(resolve => {
    closeCtxMenu();
    const overlay = h(`<div class="modal-overlay"><div class="modal confirm-modal" role="alertdialog" aria-modal="true">
      <div class="confirm-head"><span class="confirm-icon">${icon}</span><h3>${esc(title)}</h3></div>
      <div class="confirm-msg">${esc(message).replace(/\n/g, '<br>')}</div>
      <div class="confirm-actions">
        <button class="secondary" data-k="no">${esc(cancel)}</button>
        <button class="${danger ? 'danger' : ''}" data-k="yes">${esc(ok)}</button>
      </div>
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    const done = v => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.onclick = e => { if (e.target === overlay) done(false); }; // klik mimo = zrušit
    overlay.querySelector('[data-k=no]').onclick = () => done(false);
    overlay.querySelector('[data-k=yes]').onclick = () => done(true);
    setTimeout(() => overlay.querySelector('[data-k=yes]').focus(), 10);
  });
}

/** Zadávací dialog ve stylu confirmDialog. Vrátí zadanou hodnotu, nebo null při zrušení. */
function promptDialog(message, opts = {}) {
  const { title = 'Zadání', icon = '✏️', ok = 'OK', cancel = 'Zrušit', value = '', placeholder = '', type = 'text', min, max } = opts;
  return new Promise(resolve => {
    closeCtxMenu();
    const overlay = h(`<div class="modal-overlay"><div class="modal confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-head"><span class="confirm-icon">${icon}</span><h3>${esc(title)}</h3></div>
      ${message ? `<div class="confirm-msg">${esc(message).replace(/\n/g, '<br>')}</div>` : ''}
      <input data-k="val" type="${type}"${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''} value="${esc(String(value))}" placeholder="${esc(placeholder)}" style="width:100%; margin-bottom:14px">
      <div class="confirm-actions">
        <button class="secondary" data-k="no">${esc(cancel)}</button>
        <button data-k="yes">${esc(ok)}</button>
      </div>
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    const inp = overlay.querySelector('[data-k=val]');
    const done = v => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); done(inp.value); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.onclick = e => { if (e.target === overlay) done(null); };
    overlay.querySelector('[data-k=no]').onclick = () => done(null);
    overlay.querySelector('[data-k=yes]').onclick = () => done(inp.value);
    setTimeout(() => { inp.focus(); inp.select(); }, 10);
  });
}

// ---------------------------------------------------------------- příloha (bublina) + spoiler
function openAttachment(id, name, mime) {
  const url = imgUrl(id);
  const dl = url + (url.includes('?') ? '&' : '?') + 'download=1';
  let inner;
  if (/^image\//.test(mime)) inner = `<img src="${url}" style="max-width:100%; border-radius:10px">`;
  else if (mime === 'application/pdf') inner = `<iframe src="${url}" style="width:100%; height:70vh; border:0; border-radius:10px; background:#fff"></iframe>`;
  else if (/^audio\//.test(mime)) inner = `<audio controls autoplay src="${url}" style="width:100%"></audio>`;
  else if (/^video\//.test(mime)) inner = `<video controls src="${url}" style="width:100%; border-radius:10px"></video>`;
  else if (/^text\//.test(mime)) inner = `<iframe src="${url}" style="width:100%; height:60vh; border:1px solid var(--border); border-radius:10px; background:#fff"></iframe>`;
  else inner = `<p class="muted">Náhled tohoto typu souboru není k dispozici — můžete si ho stáhnout.</p>`;
  const overlay = h(`<div class="modal-overlay"><div class="modal" style="max-width:760px">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px">
      <strong style="flex:1; overflow:hidden; text-overflow:ellipsis">📎 ${esc(name)}</strong>
      <a href="${dl}" download><button class="small secondary">⬇️ Stáhnout</button></a>
      <button class="small ghost" data-k="close">✕</button>
    </div>
    ${inner}
  </div></div>`).firstElementChild;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-k=close]').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}
document.addEventListener('click', async e => {
  const at = e.target.closest('[data-attach-id]');
  if (at) { openAttachment(at.dataset.attachId, at.dataset.attachName, at.dataset.attachMime); return; }
  const sp = e.target.closest('.spoiler:not(.revealed)');
  if (sp && !e.target.closest('.rich')) { // v editoru se spoiler needituje klikem
    const yes = await confirmDialog('Tento text je označený jako spoiler. Opravdu ho chcete odkrýt?', {
      title: 'Odkrýt spoiler?', icon: '▓', ok: 'Odkrýt', cancel: 'Nechat skryté'
    });
    if (yes) sp.classList.add('revealed');
  }
});

// ---------------------------------------------------------------- nahrávání s ořezem
function uploadImage(fileOrBlob, name = 'obrazek.jpg') {
  const fd = new FormData(); fd.append('file', fileOrBlob, name);
  return api(`/api/campaigns/${state.campaign.id}/images`, { method: 'POST', body: fd });
}

/** Editor ořezu a posunu — aby byl obrázek dobře zobrazitelný v náhledech.
    opts: {aspect: číslo (zamkne poměr), title: nadpis, noSkip: skryje „Bez ořezu“} */
function openCropper(file, cb, opts = {}) {
  // GIF se neořezává (přišel by o animaci) — nahraje se rovnou
  if (file.type === 'image/gif') { uploadImage(file, file.name).then(r => cb(r.id)); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onerror = () => { URL.revokeObjectURL(url); alert('Soubor se nepodařilo načíst jako obrázek.'); cb(null); };
  img.onload = () => {
    const overlay = h(`<div class="modal-overlay"><div class="modal crop-modal">
      <h3 style="margin:0 0 10px">✂️ ${esc(opts.title || 'Ořez obrázku')}</h3>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px; ${opts.aspect ? 'display:none' : ''}">
        <span class="blocktype">Poměr:</span>
        <select data-k="aspect" style="width:auto">
          ${[['0.75', '3 : 4 (portrét)'], ['1', '1 : 1 (čtverec)'], ['1.7778', '16 : 9 (široký)'], ['1.3333', '4 : 3']].map(([v, l]) =>
            `<option value="${v}" ${parseFloat(v) === (opts.aspectDefault || 1) ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="crop-viewport"><canvas></canvas></div>
      <div style="display:flex; gap:10px; align-items:center; margin-top:10px">
        <span class="blocktype">Zoom</span>
        <input type="range" min="25" max="300" value="100" data-k="zoom" style="flex:1">
        <span class="muted" style="font-size:11px">pod 100 % vznikne průhledný okraj</span>
      </div>
      ${opts.checkbox ? `
      <div class="pick-group" style="margin-top:8px">${pill('data-k="extra"', esc(opts.checkbox.label), !!opts.checkbox.checked)}</div>` : ''}
      ${opts.withSize ? `
      <div style="display:flex; gap:10px; align-items:center; margin-top:8px">
        <span class="blocktype">Velikost vložení:</span>
        <select data-k="insw" style="width:auto">
          <option value="25">25 % šířky</option><option value="50">50 % šířky</option>
          <option value="75">75 % šířky</option><option value="100" selected>100 % šířky</option>
        </select>
      </div>` : ''}
      <p class="muted" style="margin:8px 0">Tažením obrázek posunete, kolečkem myši přiblížíte.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap">
        <button data-k="save">✂️ Uložit ořez</button>
        ${opts.noSkip ? '' : `<button class="secondary" data-k="orig">Bez ořezu</button>`}
        <div style="flex:1"></div>
        <button class="ghost" data-k="cancel">Zrušit</button>
      </div>
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    const canvas = overlay.querySelector('canvas');
    const viewport = overlay.querySelector('.crop-viewport');
    const ctx = canvas.getContext('2d');
    let aspect = opts.aspect || opts.aspectDefault || 1, zoom = 1, ox = 0, oy = 0;

    const baseScale = () => Math.max(canvas.width / img.width, canvas.height / img.height);
    function drawIt() {
      const s = baseScale() * zoom;
      const dw = img.width * s, dh = img.height * s;
      const maxX = Math.max(0, (dw - canvas.width) / 2), maxY = Math.max(0, (dh - canvas.height) / 2);
      ox = Math.max(-maxX, Math.min(maxX, ox));
      oy = Math.max(-maxY, Math.min(maxY, oy));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, (canvas.width - dw) / 2 + ox, (canvas.height - dh) / 2 + oy, dw, dh);
    }
    function resize() {
      // plátno se vejde do dostupné šířky I výšky okna, aby ovládání zůstalo viditelné
      const availW = Math.max(200, viewport.clientWidth || 360);
      const availH = Math.max(200, Math.min(window.innerHeight * 0.55, 560));
      let w = availW, hh = w / aspect;
      if (hh > availH) { hh = availH; w = hh * aspect; }
      canvas.width = Math.round(w); canvas.height = Math.round(hh);
      drawIt();
    }
    resize();
    window.addEventListener('resize', resize);
    const _done0 = () => window.removeEventListener('resize', resize);

    // posun tažením (myš i dotyk)
    let drag = null;
    canvas.onpointerdown = e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); };
    canvas.onpointermove = e => {
      if (!drag) return;
      const k = canvas.width / canvas.getBoundingClientRect().width;
      ox += (e.clientX - drag.x) * k; oy += (e.clientY - drag.y) * k;
      drag = { x: e.clientX, y: e.clientY }; drawIt();
    };
    canvas.onpointerup = () => { drag = null; };
    canvas.onwheel = e => { e.preventDefault(); zoom = Math.max(0.25, Math.min(3, zoom * (e.deltaY < 0 ? 1.08 : 0.93))); zoomEl.value = Math.round(zoom * 100); drawIt(); };
    const zoomEl = overlay.querySelector('[data-k=zoom]');
    zoomEl.oninput = () => { zoom = zoomEl.value / 100; drawIt(); };
    overlay.querySelector('[data-k=aspect]').onchange = e => { aspect = parseFloat(e.target.value); resize(); };

    const insWidth = () => { const el = overlay.querySelector('[data-k=insw]'); return el ? parseInt(el.value, 10) : 100; };
    const extraOn = () => { const el = overlay.querySelector('[data-k=extra]'); return el ? el.checked : undefined; };
    const done = (id, w) => { const ex = extraOn(); _done0(); overlay.remove(); URL.revokeObjectURL(url); cb(id, w, ex); };
    overlay.querySelector('[data-k=cancel]').onclick = () => done(null);
    overlay.onclick = e => { if (e.target === overlay) done(null); };
    const origBtn = overlay.querySelector('[data-k=orig]');
    if (origBtn) origBtn.onclick = async () => {
      if (opts.returnBlob) return done(file, insWidth()); // vrátí soubor (nahraje se později)
      const r = await uploadImage(file, file.name); done(r.id, insWidth());
    };
    overlay.querySelector('[data-k=save]').onclick = () => {
      const OUT = 1200, k = OUT / canvas.width;
      const out = document.createElement('canvas');
      out.width = OUT; out.height = Math.round(OUT / aspect);
      const octx = out.getContext('2d');
      octx.scale(k, k);
      const s = baseScale() * zoom;
      const dw = img.width * s, dh = img.height * s;
      octx.drawImage(img, (canvas.width - dw) / 2 + ox, (canvas.height - dh) / 2 + oy, dw, dh);
      const type = zoom < 1 ? 'image/png' : 'image/jpeg'; // průhledný okraj přežije jen v PNG
      out.toBlob(async blob => {
        if (opts.returnBlob) return done(blob, insWidth()); // vrátí blob (nahraje se později)
        const r = await uploadImage(blob, zoom < 1 ? 'orez.png' : 'orez.jpg'); done(r.id, insWidth());
      }, type, 0.9);
    };
  };
  img.src = url;
}

// ---------------------------------------------------------------- lightbox (galerie obrázků)
function openLightbox(ids, start = 0) {
  if (!ids.length) return;
  let idx = Math.max(0, Math.min(start, ids.length - 1));
  const overlay = h(`<div class="lightbox">
    <button class="lb-close" title="Zavřít (Esc)">✕</button>
    ${ids.length > 1 ? `<button class="lb-prev" title="Předchozí (←)">‹</button><button class="lb-next" title="Další (→)">›</button>` : ''}
    <img alt="">
    <div class="lb-count"></div>
  </div>`).firstElementChild;
  document.body.appendChild(overlay);
  const img = overlay.querySelector('img');
  const cnt = overlay.querySelector('.lb-count');
  const show = () => { img.src = imgUrl(ids[idx]); cnt.textContent = `${idx + 1} / ${ids.length}`; };
  const move = d => { idx = (idx + d + ids.length) % ids.length; show(); };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.lb-close').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  const p = overlay.querySelector('.lb-prev'), n = overlay.querySelector('.lb-next');
  if (p) p.onclick = () => move(-1);
  if (n) n.onclick = () => move(1);
  show();
}

// ---------------------------------------------------------------- výběr článku (modal)
async function pickArticle(cb, opts = {}) {
  let articles = await api(`/api/campaigns/${state.campaign.id}/articles${opts.category ? `?category=${encodeURIComponent(opts.category)}` : ''}`);
  const overlay = h(`<div class="modal-overlay">
    <div class="modal">
      <h3 style="margin:0 0 10px">Vybrat článek</h3>
      <input placeholder="Filtrovat…" id="pickFilter">
      <div id="pickList" style="margin-top:10px"></div>
    </div></div>`).firstElementChild;
  document.body.appendChild(overlay);
  const list = overlay.querySelector('#pickList');
  const drawList = (filter = '') => {
    list.innerHTML = articles
      .filter(a => a.title.toLowerCase().includes(filter.toLowerCase()))
      .map(a => `<button class="item pick-row" data-id="${a.id}" data-title="${esc(a.title)}">
        ${(a.thumbId || (a.thumbs && a.thumbs[0])) ? `<img class="pick-thumb" src="${imgUrl(a.thumbId || a.thumbs[0])}" alt="" loading="lazy">` : '<span class="pick-thumb ph">📄</span>'}
        <span>${esc(a.title)}</span></button>`).join('') || '<p class="muted">Nic nenalezeno.</p>';
    list.querySelectorAll('button').forEach(b => b.onclick = () => { overlay.remove(); cb({ id: parseInt(b.dataset.id, 10), title: b.dataset.title }); });
  };
  drawList();
  overlay.querySelector('#pickFilter').oninput = e => drawList(e.target.value);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}

// ---------------------------------------------------------------- šablony bloků (DM)
async function pickTemplate(cb) {
  const templates = await api(`/api/campaigns/${state.campaign.id}/templates`);
  const overlay = h(`<div class="modal-overlay"><div class="modal">
    <h3 style="margin:0 0 10px">📋 Vložit blok ze šablony</h3>
    ${templates.length === 0 ? '<p class="muted">Zatím žádné šablony. Šablonu vytvoříte tlačítkem 🖫 u kteréhokoli bloku v editoru.</p>' : ''}
    <div id="tplList">${templates.map(t => `
      <div style="display:flex; align-items:center; gap:6px">
        <button class="item" data-id="${t.id}" style="flex:1">📋 ${esc(t.name)} <span class="muted">(${esc(blockTypeLabel(t.type))})</span></button>
        <button class="small ghost icon" data-del="${t.id}" title="Smazat šablonu">✕</button>
      </div>`).join('')}</div>
  </div></div>`).firstElementChild;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
    const t = templates.find(x => x.id === parseInt(b.dataset.id, 10));
    overlay.remove();
    cb({ type: t.type, content: JSON.parse(JSON.stringify(t.content || {})) });
  });
  overlay.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('Smazat šablonu?', { title: 'Smazat šablonu', ok: 'Smazat', danger: true })) return;
    await api(`/api/templates/${b.dataset.del}`, { method: 'DELETE' });
    overlay.remove(); pickTemplate(cb);
  });
}

async function saveAsTemplate(b) {
  const name = (prompt('Název šablony:', blockTypeLabel(b.type)) || '').trim();
  if (!name) return;
  await api(`/api/campaigns/${state.campaign.id}/templates`, {
    method: 'POST', body: { name, type: b.type, content: b.content }
  });
  alert(`Šablona „${name}“ uložena. Najdete ji pod „📋 Ze šablony…“ při přidávání bloku.`);
}

// ================================================================ SDÍLENÝ EDITOR BLOKŮ
const BLOCK_TYPES = [
  ['heading', 'Nadpis'], ['paragraph', 'Odstavec'], ['list', 'Seznam'],
  ['quote', 'Citace'], ['alert', 'Upozornění'], ['divider', 'Oddělovač'],
  ['image', 'Obrázek'], ['audio', 'Audio'], ['youtube', 'YouTube video'], ['file', 'Příloha'],
  ['link', 'Odkaz na článek'], ['statblock', 'Stat blok (5e)'],
  ['dm_note', 'Poznámka DM'],
];

// Předpřipravené stat bloky (D&D 5e, 2024) — hodnoty vycházejí z SRD, vzdálenosti ve stopách (ft)
const STAT_TEMPLATES = {
  'Vlastní': { name: 'Nový tvor', meta: '', ac: '10', hp: '10 (3k6)', speed: '30 ft', str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, senses: 'pasivní vnímání 10', languages: 'obecná', cr: '0', traits: '', actions: '' },
  'Goblin': { name: 'Goblin', meta: 'Malý humanoid (goblinoid), neutrálně zlý', ac: '15 (kožená zbroj, štít)', hp: '10 (3k6)', speed: '30 ft', str: 8, dex: 15, con: 10, int: 10, wis: 8, cha: 8, senses: 'vidění ve tmě 60 ft\npasivní vnímání 9', languages: 'obecná\ngobliní', cr: '1/4 (50 ZK)', traits: 'Hbitý únik. Goblin může v každém svém tahu provést Odpoutání nebo Schování jako bonusovou akci.', actions: 'Šavle. Útok na blízko: +4 k zásahu, dosah 5 ft. Zásah: 5 (1k6+2) sečného poškození.\nKrátký luk. Útok na dálku: +4 k zásahu, dostřel 80/320 ft. Zásah: 5 (1k6+2) bodného poškození.' },
  'Vlk': { name: 'Vlk', meta: 'Střední zvíře, bez přesvědčení', ac: '13 (přirozená zbroj)', hp: '11 (2k8+2)', speed: '40 ft', str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6, senses: 'pasivní vnímání 13', languages: '—', cr: '1/4 (50 ZK)', traits: 'Bystrý sluch a čich. Vlk má výhodu k ověřením Moudrosti (Vnímání) založeným na sluchu či čichu.\nSmečková taktika. Vlk má výhodu k hodu na útok, je-li do 5 ft od cíle vlkův bojeschopný spojenec.', actions: 'Kousnutí. Útok na blízko: +4 k zásahu, dosah 5 ft. Zásah: 7 (2k4+2) bodného poškození. Je-li cílem tvor, musí uspět v záchranném hodu na Sílu se SO 11, jinak je sražen k zemi.' },
  'Kostlivec': { name: 'Kostlivec', meta: 'Střední nemrtvý, zákonně zlý', ac: '13 (zbytky zbroje)', hp: '13 (2k8+4)', speed: '30 ft', str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5, senses: 'vidění ve tmě 60 ft\npasivní vnímání 9', languages: 'rozumí jazykům, jež znal zaživa, ale nemluví', cr: '1/4 (50 ZK)', traits: 'Zranitelnost vůči poškození: bodné (dříve drtivé).\nImunita: jed; nemůže být otráven ani vyčerpán.', actions: 'Krátký meč. Útok na blízko: +4 k zásahu, dosah 5 ft. Zásah: 5 (1k6+2) bodného poškození.\nKrátký luk. Útok na dálku: +4 k zásahu, dostřel 80/320 ft. Zásah: 5 (1k6+2) bodného poškození.' },
  'Bandita': { name: 'Bandita', meta: 'Střední humanoid (libovolná rasa), nezákonné přesvědčení', ac: '12 (kožená zbroj)', hp: '11 (2k8+2)', speed: '30 ft', str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10, senses: 'pasivní vnímání 10', languages: 'obecná', cr: '1/8 (25 ZK)', traits: '', actions: 'Šavle. Útok na blízko: +3 k zásahu, dosah 5 ft. Zásah: 4 (1k6+1) sečného poškození.\nLehká kuše. Útok na dálku: +3 k zásahu, dostřel 80/320 ft. Zásah: 5 (1k8+1) bodného poškození.' },
  'Zlobr': { name: 'Zlobr', meta: 'Velký obr, chaoticky zlý', ac: '11 (kůže)', hp: '59 (7k10+21)', speed: '40 ft', str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7, senses: 'vidění ve tmě 60 ft\npasivní vnímání 8', languages: 'obří\nobecná', cr: '2 (450 ZK)', traits: '', actions: 'Kyj. Útok na blízko: +6 k zásahu, dosah 5 ft. Zásah: 13 (2k8+4) drtivého poškození.\nOštěp. Útok na blízko či na dálku: +6 k zásahu, dosah 5 ft nebo dostřel 30/120 ft. Zásah: 11 (2k6+4) bodného poškození.' },
  'Mág': { name: 'Mág', meta: 'Střední humanoid (libovolná rasa), libovolné přesvědčení', ac: '12 (15 s mágovou zbrojí)', hp: '40 (9k8)', speed: '30 ft', str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11, senses: 'pasivní vnímání 11', languages: 'obecná + tři další', cr: '6 (2 300 ZK)', traits: 'Sesílání kouzel. Mág je sesilatel 9. úrovně (SO 14, +6 k zásahu kouzlem). Připravená kouzla: magická střela, štít, ohnivá koule, protikouzlo, ledová bouře, stěna ohně…', actions: 'Dýka. Útok na blízko či na dálku: +5 k zásahu, dosah 5 ft nebo dostřel 20/60 ft. Zásah: 4 (1k4+2) bodného poškození.' },
};
const RICH_TYPES = ['paragraph', 'quote', 'alert', 'dm_note'];
function blockTypeLabel(t) { return (BLOCK_TYPES.find(x => x[0] === t) || ['', t])[1]; }

function richToolbarHTML() {
  return `<div class="rt-toolbar">
    <button data-c="bold" title="Tučně"><b>B</b></button>
    <button data-c="italic" title="Kurzíva"><i>I</i></button>
    <button data-c="underline" title="Podtržení"><u>U</u></button>
    <select data-size title="Velikost písma">
      <option value="">Velikost</option>
      <option value="1">Drobné</option><option value="2">Malé</option>
      <option value="3">Normální</option><option value="5">Velké</option>
      <option value="6">Největší</option>
    </select>
    <button data-color title="Barva písma">🎨 Barva</button>
    <button data-ref title="Vložit odkaz na jiný článek">🔗 Reference</button>
    <button data-imginsert title="Vložit obrázek do textu">🖼</button>
    <button data-spoiler title="Označit vybraný text jako spoiler">▓ Spoiler</button>
    <button data-clear title="Vymazat formátování">⌫</button>
  </div>`;
}

// paleta barev textu (dobře čitelná v denním i nočním režimu)
const TEXT_PALETTE = ['#e05656', '#e08b3a', '#d9b45e', '#7bb661', '#2e9e5b', '#3bb5a9', '#3b82f6', '#6d5ae6', '#9333ea', '#d457c4', '#e0567f', '#8b5a2b', '#9aa0a6', '#4b5563'];
function openColorMenu(x, y, onColor, onClear) {
  closeCtxMenu();
  const menu = h(`<div class="ctxmenu" style="min-width:auto; padding:10px">
    <button class="colorclear" data-clear>⌫ Zrušit formátování</button>
    <div class="colorgrid">${TEXT_PALETTE.map(c => `<button class="colorswatch" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <label class="colorswatch colorcustom" title="Vlastní barva">🎨<input type="color" value="#6d5ae6"></label>
    </div>
  </div>`).firstElementChild;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  // preventDefault jen na tlačítkách (zachová výběr textu); NE na color inputu, jinak se nativní výběr neotevře
  menu.querySelectorAll('button, label').forEach(el => el.onmousedown = e => e.preventDefault());
  menu.querySelector('[data-clear]').onclick = () => { closeCtxMenu(); onClear(); };
  menu.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { closeCtxMenu(); onColor(b.dataset.c); });
  const ci = menu.querySelector('.colorcustom input');
  ci.onchange = () => { onColor(ci.value); closeCtxMenu(); };
  // zavření jen při kliknutí MIMO menu (klik na paletu menu nezavře)
  const outside = (e) => { if (!menu.contains(e.target)) { closeCtxMenu(); document.removeEventListener('mousedown', outside, true); } };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

/** Jedna toggle pilulka (checkbox skrytý uvnitř — čtení přes :checked funguje beze změny). */
function pill(attrs, label, checked) {
  return `<label class="pick-toggle${checked ? ' on' : ''}"><input type="checkbox" ${attrs}${checked ? ' checked' : ''} hidden><span class="pt-lbl">${label}</span></label>`;
}
// ---- toggle „pilulky" pro výběr postav / příjemců (nahrazují zaškrtávátka) ----
// items: [{ id, label, sub?, checked?, disabled?, color? }]; cls = třída skrytého checkboxu (zpětné čtení :checked funguje beze změny).
function pickGroup(items, cls, opts = {}) {
  if (!items.length) return opts.empty || '<span class="muted">Žádné postavy.</span>';
  const selectable = items.filter(i => !i.disabled);
  const allOn = selectable.length && selectable.every(i => i.checked);
  const all = opts.all === false ? '' :
    `<button type="button" class="pick-all" data-pickall="${cls}">${allOn ? '✕ Zrušit výběr' : '✓ Vybrat všechny'}</button>`;
  const pills = items.map(it =>
    `<label class="pick-toggle${it.checked ? ' on' : ''}${it.disabled ? ' is-disabled' : ''}"${it.color ? ` style="--pc:${it.color}"` : ''}>
      <input type="checkbox" class="${cls}" value="${it.id}"${it.checked ? ' checked' : ''}${it.disabled ? ' disabled' : ''} hidden>
      <span class="pt-lbl">${esc(it.label)}</span>${it.sub ? `<span class="muted">${esc(it.sub)}</span>` : ''}</label>`).join('');
  return `<div class="pick-group${opts.variant === 'lang' ? ' pick-lang' : ''}">${all}${pills}</div>`;
}
// vizuální stav pilulky podle checkboxu (funguje i pro dynamicky vložené skupiny)
document.addEventListener('change', e => {
  const t = e.target;
  if (t && t.matches && t.matches('.pick-toggle input[type=checkbox]')) {
    const lbl = t.closest('.pick-toggle');
    if (lbl) lbl.classList.toggle('on', t.checked);
  }
});
// tlačítko „Vybrat všechny“ / „Zrušit výběr“
document.addEventListener('click', e => {
  const all = e.target.closest && e.target.closest('.pick-all');
  if (!all) return;
  e.preventDefault();
  const group = all.closest('.pick-group');
  const boxes = [...group.querySelectorAll(`input.${all.dataset.pickall}`)].filter(c => !c.disabled);
  const turnOn = !boxes.every(c => c.checked);
  boxes.forEach(c => { if (c.checked !== turnOn) { c.checked = turnOn; c.dispatchEvent(new Event('change', { bubbles: true })); } });
  all.textContent = turnOn ? '✕ Zrušit výběr' : '✓ Vybrat všechny';
});

function wireRich(f, c) {
  const editor = f.querySelector('.rich');
  editor.innerHTML = (typeof c.html === 'string' && c.html.trim()) ? c.html : esc(c.text || '');
  const sync = () => { c.html = editor.innerHTML; c.text = editor.innerText; };
  editor.oninput = sync;
  editor.onblur = () => { saveSel(); sync(); };
  editor.onmouseup = saveSel;
  editor.onkeyup = saveSel;
  // vložení textu: odstraní barvy/pozadí (jinak by černý text z jiné aplikace
  // byl v nočním režimu nečitelný) — text pak dědí barvu z motivu a funguje v obou režimech
  editor.addEventListener('paste', e => {
    // obrázek ze schránky (screenshot…) → nahrát na server a vložit trvalý odkaz
    const imgItem = [...(e.clipboardData.items || [])].find(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (imgItem) {
      e.preventDefault();
      const file = imgItem.getAsFile();
      saveSel();
      uploadImage(file, 'vlozeny.png').then(r => {
        editor.focus(); restoreSel();
        document.execCommand('insertHTML', false, `<img src="/api/images/${r.id}" style="max-width:100%"> `);
        sync();
      }).catch(() => { });
      return;
    }
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    if (html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('script,style').forEach(n => n.remove());
      tmp.querySelectorAll('*').forEach(el => {
        el.removeAttribute('color'); el.removeAttribute('bgcolor');
        if (el.style) { el.style.color = ''; el.style.backgroundColor = ''; el.style.background = ''; }
        if (!el.getAttribute('style')) el.removeAttribute('style');
      });
      document.execCommand('insertHTML', false, tmp.innerHTML);
    } else {
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    }
    sync();
  });

  const exec = (name, val) => { editor.focus(); restoreSel(); document.execCommand(name, false, val); sync(); saveSel(); };
  const insertRef = () => {
    pickArticle(art => { editor.focus(); restoreSel(); document.execCommand('insertText', false, `[[${art.id}|${art.title}]]`); sync(); });
  };
  const insertSpoiler = () => {
    editor.focus(); restoreSel();
    const sel = getSelection().toString();
    if (!sel.trim()) return alert('Nejprve označte text, který má být spoilerem.');
    document.execCommand('insertHTML', false, `<span class="spoiler">${esc(sel)}</span>&nbsp;`);
    sync();
  };
  const insertImageFile = (file) => {
    openCropper(file, (imgId, width) => {
      if (!imgId) return;
      editor.focus(); restoreSel();
      document.execCommand('insertHTML', false, `<img src="/api/images/${imgId}" style="width:${width || 100}%"> `);
      sync();
    }, { withSize: true });
  };
  const insertImage = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => { if (input.files[0]) insertImageFile(input.files[0]); };
    input.click();
  };
  const insertLang = () => {
    const sel = getSelection().toString();
    if (!sel.trim()) return alert('Nejprve označte text, který je v cizím jazyce.');
    const langs = state.languages;
    if (!langs.length) return alert('V kampani zatím nejsou žádné jazyky (kategorie „Jazyk“).');
    const overlay = h(`<div class="modal-overlay"><div class="modal">
      <h3 style="margin:0 0 10px">🌐 Kterým jazykem je text psán?</h3>
      ${langs.map(l => `<button class="item" data-id="${l.id}">
        <span style="display:inline-block; width:14px; height:14px; border-radius:4px; background:${l.color}; margin-right:8px; vertical-align:middle"></span>
        <span style="color:${l.color}; text-decoration:underline">${esc(l.title)}</span></button>`).join('')}
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelectorAll('[data-id]').forEach(btn => btn.onclick = () => {
      const l = langs.find(x => x.id === parseInt(btn.dataset.id, 10));
      overlay.remove();
      editor.focus(); restoreSel();
      document.execCommand('insertHTML', false,
        `<span class="lang" data-lang="${l.id}" style="color:${l.color}">${esc(sel)}</span>&nbsp;`);
      sync();
    });
  };
  // přetažení obrázku ze systému přímo do textu
  editor.addEventListener('dragover', e => { e.preventDefault(); });
  editor.addEventListener('drop', e => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    e.preventDefault();
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (range) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    saveSel();
    insertImageFile(file);
  });
  // pravé tlačítko na obrázku v textu → nabídka velikosti / odstranění (capture: má přednost před obecným menu)
  editor.addEventListener('contextmenu', e => {
    const img = e.target.closest('img');
    if (!img) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const inPrev = img.getAttribute('data-preview') === '1';
    openCtxMenu(e.clientX, e.clientY, [25, 50, 75, 100].map(w => ({
      icon: '📐', label: `Šířka ${w} %`, action: () => { img.style.width = w + '%'; img.style.maxWidth = ''; sync(); hideImgHandle(); }
    })).concat([
      {
        icon: inPrev ? '★' : '☆',
        label: inPrev ? 'Nezobrazovat v náhledech' : 'Zobrazit i v náhledech',
        action: () => {
          if (inPrev) img.removeAttribute('data-preview'); else img.setAttribute('data-preview', '1');
          sync(); hideImgHandle();
        }
      },
      { icon: '✕', label: 'Odstranit obrázek', action: () => { img.remove(); sync(); hideImgHandle(); } }
    ]));
  }, true);

  // levý klik na obrázek → táhlo v pravém dolním rohu pro změnu velikosti myší
  let imgHandle = null;
  const hideImgHandle = () => { if (imgHandle) { imgHandle.remove(); imgHandle = null; } };
  const placeHandle = (img) => {
    const r = img.getBoundingClientRect();
    imgHandle.style.left = (r.right - 9) + 'px';
    imgHandle.style.top = (r.bottom - 9) + 'px';
  };
  editor.addEventListener('click', e => {
    const img = e.target.closest('img');
    hideImgHandle();
    if (!img) return;
    e.preventDefault();
    imgHandle = h(`<div class="img-resize" title="Tažením změníte velikost"></div>`).firstElementChild;
    document.body.appendChild(imgHandle);
    placeHandle(img);
    imgHandle.onpointerdown = pe => {
      pe.preventDefault();
      imgHandle.setPointerCapture(pe.pointerId);
      const startX = pe.clientX;
      const startW = img.getBoundingClientRect().width;
      const edW = editor.getBoundingClientRect().width;
      imgHandle.onpointermove = me => {
        const pct = Math.max(10, Math.min(100, ((startW + (me.clientX - startX)) / edW) * 100));
        img.style.width = pct.toFixed(0) + '%';
        img.style.maxWidth = '';
        placeHandle(img);
      };
      imgHandle.onpointerup = () => { imgHandle.onpointermove = null; sync(); };
    };
  });
  editor.addEventListener('input', hideImgHandle);
  editor.addEventListener('blur', () => setTimeout(hideImgHandle, 150));
  window.addEventListener('scroll', hideImgHandle, { passive: true });
  f.querySelectorAll('[data-c]').forEach(btn => {
    btn.onmousedown = e => e.preventDefault();
    btn.onclick = () => exec(btn.dataset.c);
  });
  const size = f.querySelector('[data-size]');
  size.onchange = () => { if (size.value) exec('fontSize', size.value); size.value = ''; };
  // barva textu z vlastní palety — každý výběr aplikuje (žádný „zaseknutý“ stav)
  const applyColor = (col) => exec('foreColor', col);
  const colorBtn = f.querySelector('[data-color]');
  colorBtn.onclick = e => {
    e.preventDefault(); saveSel();
    const r = colorBtn.getBoundingClientRect();
    openColorMenu(r.left, r.bottom + 4, applyColor, () => exec('removeFormat'));
  };
  f.querySelector('[data-ref]').onclick = e => { e.preventDefault(); saveSel(); insertRef(); };
  f.querySelector('[data-imginsert]').onclick = e => { e.preventDefault(); saveSel(); insertImage(); };
  f.querySelector('[data-spoiler]').onclick = e => { e.preventDefault(); insertSpoiler(); };
  f.querySelector('[data-clear]').onclick = () => exec('removeFormat');

  attachCtxMenu(editor, () => [
    { icon: '𝐁', label: 'Tučně', action: () => exec('bold') },
    { icon: '𝘐', label: 'Kurzíva', action: () => exec('italic') },
    { icon: 'U̲', label: 'Podtržení', action: () => exec('underline') },
    { icon: '🎨', label: 'Barva písma…', action: () => { const s = getSelection(); const rr = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : { left: 200, bottom: 200 }; openColorMenu(rr.left, rr.bottom + 4, applyColor, () => exec('removeFormat')); } },
    { icon: '▓', label: 'Označit jako spoiler', action: insertSpoiler },
    { icon: '🌐', label: 'Označit jako cizí jazyk…', action: insertLang },
    { icon: '🖼', label: 'Vložit obrázek…', action: insertImage },
    { icon: '🔗', label: 'Vložit referenci na článek…', action: insertRef },
    { icon: '⌫', label: 'Vymazat formátování', action: () => exec('removeFormat') },
  ]);
}

/** Pole editoru pro daný typ bloku (sdíleno plným editorem i inline editací). */
function blockFields(b, redraw) {
  const f = document.createElement('div');
  const c = b.content;
  if (b.type === 'heading') {
    f.innerHTML = `<div class="row" style="display:flex; gap:8px"><select data-k="level" style="width:auto">
      <option value="1">Úroveň 1</option><option value="2">Úroveň 2</option><option value="3">Úroveň 3</option></select>
      <input data-k="text" placeholder="Text nadpisu" style="flex:1"></div>`;
    const sel = f.querySelector('[data-k=level]'); sel.value = c.level || 2;
    sel.onchange = () => { c.level = parseInt(sel.value, 10); };
    const inp = f.querySelector('[data-k=text]'); inp.value = c.text || '';
    inp.oninput = () => { c.text = inp.value; };
  } else if (RICH_TYPES.includes(b.type)) {
    f.innerHTML = richToolbarHTML() + `<div class="rich" contenteditable="true"></div>`;
    wireRich(f, c);
  } else if (b.type === 'list') {
    f.innerHTML = `<div class="pick-group">${pill('data-k="ordered"', 'číslovaný seznam', false)}</div>
      <textarea data-k="items" placeholder="Jedna položka na řádek"></textarea>`;
    const cb = f.querySelector('[data-k=ordered]'); cb.checked = !!c.ordered;
    cb.onchange = () => { c.ordered = cb.checked; };
    const ta = f.querySelector('[data-k=items]'); ta.value = (c.items || []).join('\n');
    ta.oninput = () => { c.items = ta.value.split('\n').filter(x => x.trim()); };
  } else if (b.type === 'image') {
    const w = [25, 50, 75, 100].includes(c.width) ? c.width : 100;
    f.innerHTML = `<div class="row" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        ${c.imageId ? `<img src="${imgUrl(c.imageId)}" style="height:64px; border-radius:8px">` : '<span class="muted">žádný obrázek</span>'}
        <input type="file" accept="image/*" style="width:auto" data-k="file">
        <select data-k="width" style="width:auto" title="Velikost zobrazení">
          <option value="25">25 % šířky</option><option value="50">50 % šířky</option>
          <option value="75">75 % šířky</option><option value="100">100 % šířky</option>
        </select>
        <span title="Obrázek se zobrazí i v seznamu článků">${pill('data-k="preview"', 'zobrazit v náhledu', false)}</span></div>
      <input data-k="caption" placeholder="Popisek (volitelné)" style="margin-top:8px">`;
    f.querySelector('[data-k=file]').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // GIF se vloží bez ořezu (openCropper to detekuje), jen s volbou velikosti
      openCropper(file, (imgId) => { if (imgId) { c.imageId = imgId; redraw(); } });
    };
    const ws = f.querySelector('[data-k=width]'); ws.value = String(w);
    ws.onchange = () => { c.width = parseInt(ws.value, 10); };
    const pv = f.querySelector('[data-k=preview]'); pv.checked = !!c.preview;
    pv.onchange = () => { c.preview = pv.checked; };
    const cap = f.querySelector('[data-k=caption]'); cap.value = c.caption || '';
    cap.oninput = () => { c.caption = cap.value; };
  } else if (b.type === 'youtube') {
    const w = [25, 50, 75, 100].includes(c.width) ? c.width : 100;
    f.innerHTML = `
      <label style="margin-top:0">Odkaz na YouTube video</label>
      <input data-k="url" placeholder="https://www.youtube.com/watch?v=… nebo https://youtu.be/…">
      <div class="row" style="display:flex; gap:8px; align-items:center; margin-top:8px">
        <span class="blocktype">Velikost okna:</span>
        <select data-k="width" style="width:auto">
          <option value="25">25 % šířky</option><option value="50">50 % šířky</option>
          <option value="75">75 % šířky</option><option value="100">100 % šířky</option>
        </select>
        <span class="muted" data-k="state">${ytId(c.url) ? '✓ platný odkaz' : ''}</span>
      </div>
      <input data-k="caption" placeholder="Popisek (volitelné)" style="margin-top:8px">`;
    const url = f.querySelector('[data-k=url]'); url.value = c.url || '';
    url.oninput = () => { c.url = url.value; f.querySelector('[data-k=state]').textContent = ytId(c.url) ? '✓ platný odkaz' : (c.url ? '✗ odkaz nerozpoznán' : ''); };
    const ws = f.querySelector('[data-k=width]'); ws.value = String(w);
    ws.onchange = () => { c.width = parseInt(ws.value, 10); };
    const cap = f.querySelector('[data-k=caption]'); cap.value = c.caption || '';
    cap.oninput = () => { c.caption = cap.value; };
  } else if (['audio', 'file'].includes(b.type)) {
    const accept = b.type === 'audio' ? 'audio/*' : '*/*';
    f.innerHTML = `<div class="row" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        ${c.imageId ? `<span class="tag">📎 ${esc(c.name || 'soubor')}</span>` : '<span class="muted">žádný soubor</span>'}
        <input type="file" accept="${accept}" data-k="file" style="width:auto"></div>
      <input data-k="caption" placeholder="Popisek (volitelné)" style="margin-top:8px">`;
    f.querySelector('[data-k=file]').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const r = await uploadImage(file, file.name);
      c.imageId = r.id; c.name = r.name; c.mime = r.mime; redraw();
    };
    const cap = f.querySelector('[data-k=caption]'); cap.value = c.caption || '';
    cap.oninput = () => { c.caption = cap.value; };
  } else if (b.type === 'statblock') {
    // zaškrtávátko = zobrazit položku po uložení (výchozí: vše zaškrtnuto)
    const showChk = (k) => `<label class="pick-toggle mini" title="Zobrazit po uložení" style="margin-left:auto"><input type="checkbox" data-sbshow="${k}" hidden><span class="pt-lbl">👁</span></label>`;
    const F = (k, label) => `<div style="flex:1; min-width:130px">
      <div class="sb-lblrow">${label}${showChk(k)}</div>
      <input data-sb="${k}"></div>`;
    const FT = (k, label, ph) => `
      <div class="sb-lblrow">${label}${showChk(k)}</div>
      <textarea data-sb="${k}" placeholder="${ph || ''}"></textarea>`;
    f.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px">
        <span class="blocktype">Šablona:</span>
        <select data-k="tpl" style="width:auto">${Object.keys(STAT_TEMPLATES).map(t => `<option>${t}</option>`).join('')}</select>
        <span class="muted" style="font-size:12px">☑ = položka se zobrazí po uložení</span>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap">
        <div style="flex:1; min-width:130px"><label>Jméno</label><input data-sb="name"></div>
        ${F('meta', 'Typ a přesvědčení')}${F('cr', 'Nebezpečnost (CR)')}
        ${F('ac', 'Obranné číslo (AC)')}${F('initiative', 'Iniciativa')}${F('hp', 'Životy (HP)')}${F('speed', 'Rychlost (ft)')}
      </div>
      <label style="display:flex; align-items:center; gap:6px">Vlastnosti (SÍL–CHA) — hodnota a záchranný hod (SAVE)${showChk('abilities')}</label>
      <div style="display:flex; gap:10px; flex-wrap:wrap">
        ${['str|SÍL', 'dex|OBR', 'con|ODL', 'int|INT', 'wis|MDR', 'cha|CHA'].map(x => { const [k, l] = x.split('|'); return `<div style="flex:1; min-width:72px"><label>${l}</label><input type="number" data-sb="${k}" min="1" max="30"><input data-sbsave="${k}" placeholder="SAVE" style="margin-top:4px; font-size:12px; padding:4px 8px"></div>`; }).join('')}
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap">
        ${F('skills', 'Dovednosti (Skills)')}${F('vulnerabilities', 'Zranitelnosti')}${F('immunities', 'Imunity')}
        ${F('resistances', 'Odolnosti (Resistances)')}${F('gear', 'Vybavení (Gear)')}
      </div>
      ${FT('senses', 'Smysly (jeden na řádek)', 'např. vidění ve tmě 60 ft')}
      ${FT('languages', 'Jazyky (jeden na řádek)', 'např. obecná')}
      ${FT('traits', 'Vlastnosti / Traits (jedna na řádek)')}
      ${FT('actions', 'Akce (jedna na řádek)')}
      ${FT('bonusActions', 'Bonusové akce (jedna na řádek)')}
      ${FT('legendaryActions', 'Legendární akce (jedna na řádek)')}
      <label>Vlastní položky</label>
      <div data-role="customs"></div>
      <button class="small secondary" data-k="addcustom" style="margin-top:6px">＋ Vlastní položka</button>`;
    if (!c.name && c.name !== '') Object.assign(c, STAT_TEMPLATES['Vlastní']);
    c.custom = Array.isArray(c.custom) ? c.custom : [];
    c.show = (c.show && typeof c.show === 'object') ? c.show : {};
    c.saves = (c.saves && typeof c.saves === 'object') ? c.saves : {};
    f.querySelectorAll('[data-sb]').forEach(inp => {
      const k = inp.dataset.sb;
      inp.value = c[k] ?? '';
      inp.oninput = () => { c[k] = inp.type === 'number' ? (parseInt(inp.value, 10) || 10) : inp.value; };
    });
    f.querySelectorAll('[data-sbsave]').forEach(inp => {
      const k = inp.dataset.sbsave;
      inp.value = c.saves[k] ?? '';
      inp.oninput = () => { c.saves[k] = inp.value; };
    });
    f.querySelectorAll('[data-sbshow]').forEach(chk => {
      const k = chk.dataset.sbshow;
      chk.checked = c.show[k] !== false;
      const l = chk.closest('.pick-toggle'); if (l) l.classList.toggle('on', chk.checked); // stav nastavený kódem
      chk.onchange = () => { c.show[k] = chk.checked; };
    });
    f.querySelector('[data-k=tpl]').onchange = e => {
      Object.assign(c, JSON.parse(JSON.stringify(STAT_TEMPLATES[e.target.value])));
      c.show = {}; // šablona zobrazuje vše
      redraw();
    };
    const customs = f.querySelector('[data-role=customs]');
    const drawCustoms = () => {
      customs.innerHTML = c.custom.map((x, i) => `
        <div style="display:flex; gap:8px; margin-bottom:6px">
          <input data-cl="${i}" placeholder="Název (např. Záchranné hody)" value="${esc(x.label || '')}" style="flex:1">
          <input data-cv="${i}" placeholder="Hodnota (např. MDR +3)" value="${esc(x.value || '')}" style="flex:2">
          <button class="small ghost icon" data-cd="${i}">✕</button>
        </div>`).join('') || '<span class="muted">Žádné — přidejte např. záchranné hody, dovednosti, odolnosti…</span>';
      customs.querySelectorAll('[data-cl]').forEach(inp => inp.oninput = () => { c.custom[inp.dataset.cl].label = inp.value; });
      customs.querySelectorAll('[data-cv]').forEach(inp => inp.oninput = () => { c.custom[inp.dataset.cv].value = inp.value; });
      customs.querySelectorAll('[data-cd]').forEach(btn => btn.onclick = () => { c.custom.splice(btn.dataset.cd, 1); drawCustoms(); });
    };
    drawCustoms();
    f.querySelector('[data-k=addcustom]').onclick = () => { c.custom.push({ label: '', value: '' }); drawCustoms(); };
  } else if (b.type === 'link') {
    f.innerHTML = `<div class="row" style="display:flex; gap:8px; align-items:center">
      <span>${c.articleId ? `🔗 <a class="ref">${esc(c.title || ('článek #' + c.articleId))}</a>` : '<span class="muted">žádný cíl</span>'}</span>
      <button class="small secondary" data-k="pick">Vybrat článek…</button></div>
    <p class="muted" style="margin:6px 0 0">Hráč odkaz uvidí, jen pokud smí vidět cílový článek.</p>`;
    f.querySelector('[data-k=pick]').onclick = () => pickArticle(art => {
      c.articleId = art.id; c.title = art.title; redraw();
    });
  }
  return f;
}

/** Ovládání viditelnosti bloku (sdíleno). Cílí se na POSTAVY.
    forOwner = hráč edituje článek své postavy (nemá volbu „Pouze DM“). */
function blockVisControls(b, forOwner = false) {
  const v = document.createElement('div');
  v.style.marginTop = '10px';
  // vlastníkovi se nenabízejí jeho vlastní postavy — svůj článek vidí vždy
  const chars = forOwner ? state.characters.filter(c => c.userId !== state.me.id) : state.characters;
  if (b.type === 'dm_note') {
    v.innerHTML = `<span class="vis-badge vis-dm">Vždy pouze DM</span>`;
    return v;
  }
  v.innerHTML = `
    <div class="row" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
      <span class="blocktype">Viditelnost:</span>
      <select data-k="visibility" style="width:auto">
        <option value="all">Všichni hráči</option>
        ${forOwner ? '' : '<option value="dm">Pouze DM</option>'}
        <option value="custom">${forOwner ? 'Vybrané postavy (+ vy a DM)' : 'Vybrané postavy'}</option>
      </select>
      <span data-role="checks"></span>
    </div>`;
  const sel = v.querySelector('[data-k=visibility]');
  sel.value = (forOwner && b.visibility === 'dm') ? 'custom' : b.visibility;
  b.visibility = sel.value;
  const checks = v.querySelector('[data-role=checks]');
  const drawChecks = () => {
    checks.innerHTML = sel.value !== 'custom' ? '' :
      pickGroup(chars.map(ch => ({
        id: ch.id, label: ch.name, checked: b.visibleTo.includes(ch.id),
        sub: ch.username && ch.name !== ch.username ? `(${ch.username})` : ''
      })), 'blkVis', { empty: '<span class="muted">V kampani zatím nejsou postavy.</span>' });
    checks.querySelectorAll('input').forEach(cb => cb.onchange = () => {
      const id = parseInt(cb.value, 10);
      b.visibleTo = cb.checked ? [...b.visibleTo, id] : b.visibleTo.filter(x => x !== id);
    });
  };
  sel.onchange = () => { b.visibility = sel.value; drawChecks(); };
  drawChecks();
  return v;
}

function newBlock(type) {
  return { type, content: type === 'list' ? { items: [] } : {}, visibility: type === 'dm_note' ? 'dm' : 'all', visibleTo: [] };
}

// ---------------------------------------------------------------- kampaně
async function renderCampaigns() {
  const camps = await api('/api/campaigns');
  shell(`
    <div class="pagehead"><h1>Moje kampaně</h1></div>
    ${camps.length === 0 ? `<p class="muted">Zatím nejste členem žádné kampaně. Vytvořte novou, nebo požádejte svého DM o přidání.</p>` : ''}
    ${camps.map(c => `
      <div class="card article-row" onclick="location.hash='#/c/${c.id}'">
        ${c.iconImageId ? `<img class="article-thumb" src="${imgUrl(c.iconImageId)}" alt="">` : `<div class="article-thumb placeholder">🏰</div>`}
        <div style="min-width:0"><h3>${esc(c.name)}</h3>
        ${c.description ? `<div class="muted" style="margin-bottom:4px">${esc(c.description)}</div>` : ''}
        <span class="tag cat">${c.role === 'dm' ? 'Dungeon Master' : 'Hráč'}</span></div>
      </div>`).join('')}
    <div style="margin-top:18px"><button id="campNew">＋ Vytvořit novou kampaň</button></div>
    <div class="card" id="campForm" style="display:none">
      <h3>Nová kampaň</h3>
      <label>Název</label>
      <input id="campName" placeholder="Např. Kopule">
      <label>Krátký popis (nepovinné)</label>
      <input id="campDesc" placeholder="O čem kampaň je…">
      <label>Ikonka (nepovinné)</label>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap">
        <div class="article-thumb placeholder" id="campIconPrev">🏰</div>
        <input type="file" id="campIcon" accept="image/*" style="width:auto">
      </div>
      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">
        <button id="campCreate">Vytvořit (stanu se DM)</button>
        <button class="ghost" id="campCancel">Zrušit</button>
      </div>
      <div class="error" id="campErr"></div>
    </div>
    <div style="margin-top:18px"><a href="#/admin"><button class="secondary">⚙️ Administrace aplikace</button></a></div>`, { noSidebar: true });
  // formulář je skrytý, dokud si o něj uživatel neřekne
  const campForm = $app.querySelector('#campForm');
  const campNewBtn = $app.querySelector('#campNew');
  campNewBtn.onclick = () => {
    campForm.style.display = '';
    campNewBtn.style.display = 'none';
    $app.querySelector('#campName').focus();
  };
  $app.querySelector('#campCancel').onclick = () => {
    campForm.style.display = 'none';
    campNewBtn.style.display = '';
    $app.querySelector('#campName').value = '';
    $app.querySelector('#campDesc').value = '';
    $app.querySelector('#campErr').textContent = '';
  };
  let newIconBlob = null;
  $app.querySelector('#campIcon').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    // kampaň ještě neexistuje → obrázek si podržíme jako blob a nahrajeme po vytvoření
    openCropper(file, (blob) => {
      if (!blob) return;
      newIconBlob = blob;
      $app.querySelector('#campIconPrev').outerHTML = `<img class="article-thumb" id="campIconPrev" src="${URL.createObjectURL(blob)}" alt="">`;
    }, { aspect: 1, title: 'Ikonka kampaně (1 : 1)', noSkip: true, returnBlob: true });
  };
  $app.querySelector('#campCreate').onclick = async () => {
    const name = $app.querySelector('#campName').value.trim();
    if (!name) return;
    try {
      const c = await api('/api/campaigns', { method: 'POST', body: { name, description: $app.querySelector('#campDesc').value } });
      if (newIconBlob) { // nahraj ikonku do nové kampaně a nastav ji
        const fd = new FormData(); fd.append('file', newIconBlob, 'ikonka.jpg');
        const img = await api(`/api/campaigns/${c.id}/images`, { method: 'POST', body: fd });
        await api(`/api/campaigns/${c.id}/settings`, { method: 'PUT', body: { iconImageId: img.id } });
      }
      location.hash = `#/c/${c.id}`;
    } catch (e) { $app.querySelector('#campErr').textContent = e.message; }
  };
}

// ================================================================ ADMINISTRACE APLIKACE
let adminUnlocked = false;
async function renderAdmin() {
  if (!state.me) { location.hash = '#/'; return; }
  if (!adminUnlocked) return renderAdminGate();
  let ov;
  try { ov = await api('/api/admin/overview'); }
  catch { adminUnlocked = false; return renderAdminGate('Administrace vypršela — zadejte master heslo znovu.'); }

  $app.innerHTML = `
    <header class="topbar">
      <button class="navbtn" id="backBtn" title="Zpět">←</button>
      <a class="logo" href="#/"><img src="/logo.png?v=${localStorage.getItem('logoV') || 1}" alt="" class="logo-img" onerror="this.outerHTML='<span class=&quot;dice&quot;>🐉</span>'"><span>${esc(state.appName)}</span></a>
      <span class="muted" style="white-space:nowrap">/ <a href="#/">Kampaně</a> / <b>Administrace</b></span>
      <div class="grow"></div>
      <button class="small ghost" id="adminLock">🔒 Zamknout administraci</button>
      <span class="topbtn user" style="cursor:default">
        <span class="avatar">${esc((state.me.username || '?').slice(0, 1).toUpperCase())}</span>
        <span class="uname">${esc(state.me.username)}</span></span>
    </header>
    <div class="layout"><main class="content">
      <div class="pagehead"><h1>⚙️ Administrace aplikace</h1></div>

      <div class="card">
        <h3>🎨 Vzhled aplikace</h3>
        <label>Název aplikace</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <input id="aName" value="${esc(ov.appName)}" style="flex:1; min-width:180px">
          <button class="small" id="aNameSave">Uložit název</button>
        </div>
        <label>Logo (zobrazí se vlevo nahoře a jako ikonka)</label>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap">
          <img src="/logo.png?v=${Date.now()}" alt="" style="height:48px; width:48px; border-radius:50%; object-fit:cover" onerror="this.style.display='none'">
          <input type="file" id="aLogo" accept="image/*" style="width:auto">
        </div>
        <div class="error" id="aErr"></div>
      </div>

      <div class="card">
        <h3>🗺️ Kampaně (${ov.campaigns.length})</h3>
        <div style="margin:8px 0"><label>Obnovit ze zálohy (vytvoří novou kampaň)</label>
          <input type="file" id="aRestore" accept="application/json,.json" style="width:auto"></div>
        ${ov.campaigns.length === 0 ? '<p class="muted">Žádné kampaně.</p>' : ''}
        ${ov.campaigns.map(c => `
          <div class="card" style="padding:12px 16px; margin-bottom:8px">
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
              <strong style="flex:1; min-width:140px">${esc(c.name)}</strong>
              <span class="muted" style="font-size:12px">${c.articles} článků · DM: ${c.dms.map(esc).join(', ') || '—'} · ${c.players} hráčů</span>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px">
              <a href="#/c/${c.id}"><button class="small secondary">Otevřít</button></a>
              <button class="small secondary" data-export="${c.id}">⬇ Export zálohy</button>
              ${!c.amIdm ? `<button class="small secondary" data-joindm="${c.id}">＋ Vstoupit jako DM</button>` : '<span class="tag cat" style="align-self:center">jste DM</span>'}
              <button class="small danger" data-delcamp="${c.id}" data-name="${esc(c.name)}">🗑 Smazat</button>
            </div>
          </div>`).join('')}
      </div>

      <div class="card">
        <h3>👥 Registrovaní uživatelé (${ov.users.length})</h3>
        ${ov.users.map(u => `
          <div style="display:flex; align-items:flex-start; gap:12px; padding:8px 12px; border-bottom:1px solid var(--border)">
            <strong style="min-width:120px">👤 ${esc(u.username)}</strong>
            <div style="flex:1">${u.memberships.length
              ? u.memberships.map(m => `<span class="tag ${m.role === 'dm' ? 'cat' : ''}">${m.role === 'dm' ? '📖 DM' : '🎭 hráč'} · ${esc(m.campaign)}</span>`).join('')
              : '<span class="muted">bez kampaní</span>'}</div>
          </div>`).join('')}
      </div>
    </main></div>`;

  $app.querySelector('#backBtn').onclick = () => history.back();
  $app.querySelector('#adminLock').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); adminUnlocked = false; location.hash = '#/'; };
  $app.querySelector('#aNameSave').onclick = async () => {
    try {
      const r = await api('/api/admin/app-name', { method: 'PUT', body: { name: $app.querySelector('#aName').value } });
      setAppName(r.name); renderAdmin(); // propíše i do záložky prohlížeče
    } catch (e) { $app.querySelector('#aErr').textContent = e.message; }
  };
  $app.querySelector('#aLogo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const fd = new FormData(); fd.append('file', file);
      await api('/api/app-logo', { method: 'POST', body: fd });
      localStorage.setItem('logoV', String(Date.now())); location.reload();
    } catch (err) { $app.querySelector('#aErr').textContent = err.message; }
  };
  $app.querySelectorAll('[data-export]').forEach(b => b.onclick = () => {
    // stáhne JSON zálohu (endpoint posílá attachment)
    window.location = `/api/admin/campaigns/${b.dataset.export}/export`;
  });
  $app.querySelector('#aRestore').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!await confirmDialog('Ze zálohy se vytvoří nová kampaň. Stávající kampaně zůstanou nedotčené.', { title: 'Obnovit zálohu', icon: '♻️', ok: 'Obnovit' })) { e.target.value = ''; return; }
    try {
      const res = await fetch('/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text() });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Chyba');
      alert(`Obnoveno jako „${d.name}“.`); renderAdmin();
    } catch (err) { $app.querySelector('#aErr').textContent = err.message; }
  };
  $app.querySelectorAll('[data-joindm]').forEach(b => b.onclick = async () => {
    await api(`/api/admin/campaigns/${b.dataset.joindm}/join-dm`, { method: 'POST' });
    alert('Nyní jste DM této kampaně.'); renderAdmin();
  });
  $app.querySelectorAll('[data-delcamp]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog(`Kampaň „${b.dataset.name}“ se všemi články, postavami a chaty bude NENÁVRATNĚ smazána.\nDoporučujeme nejdřív stáhnout zálohu.`, { title: 'Smazat kampaň', ok: 'Nenávratně smazat', danger: true })) return;
    await api(`/api/admin/campaigns/${b.dataset.delcamp}`, { method: 'DELETE' });
    renderAdmin();
  });
}

function renderAdminGate(msg = '') {
  $app.innerHTML = `
    <header class="topbar">
      <button class="navbtn" id="backBtn" title="Zpět">←</button>
      <a class="logo" href="#/"><span class="dice">🐉</span> ${esc(state.appName)}</a>
      <span class="muted">/ <a href="#/">Kampaně</a> / <b>Administrace</b></span>
    </header>
    <div class="auth-wrap">
      <div class="card">
        <h3>🔒 Administrace aplikace</h3>
        <p class="muted">Přístup je chráněn master heslem.</p>
        ${msg ? `<div class="error">${esc(msg)}</div>` : ''}
        <label>Master heslo</label>
        <input id="aMaster" type="password" autocomplete="off">
        <div id="aGateErr" class="error"></div>
        <div style="margin-top:14px"><button id="aUnlock">Odemknout</button></div>
      </div>
    </div>`;
  $app.querySelector('#backBtn').onclick = () => { location.hash = '#/'; };
  const submit = async () => {
    try {
      await api('/api/admin/auth', { method: 'POST', body: { masterPassword: $app.querySelector('#aMaster').value } });
      adminUnlocked = true; renderAdmin();
    } catch (e) { $app.querySelector('#aGateErr').textContent = e.message; }
  };
  $app.querySelector('#aUnlock').onclick = submit;
  $app.querySelector('#aMaster').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $app.querySelector('#aMaster').focus();
}

// ---------------------------------------------------------------- seznam článků
async function renderArticleList(category = null) {
  const cid = state.campaign.id;
  const q = category ? `?category=${encodeURIComponent(category === 'Nezařazeno' ? '' : category)}` : '';
  const articles = await api(`/api/campaigns/${cid}/articles${q}`);
  const allTags = [...new Set(articles.flatMap(a => (a.tags || '').split(',').map(t => t.trim()).filter(Boolean)))].sort((x, y) => x.localeCompare(y, 'cs'));
  shell(`
    <div class="pagehead">
      <h1>${category ? esc(category) : 'Články'}</h1>
      ${canEdit() ? `<button id="newArticle">+ Nový článek</button>` : ''}
    </div>
    <div class="card" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; padding:12px 16px">
      <input id="fText" placeholder="🔍 Filtrovat podle názvu či popisu…" style="flex:2; min-width:160px">
      ${category ? '' : `<select id="fCat" style="flex:1; min-width:130px; width:auto">
        <option value="">Všechny kategorie</option>
        ${state.cats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
      </select>`}
      <select id="fTag" style="flex:1; min-width:120px; width:auto">
        <option value="">Všechny štítky</option>
        ${allTags.map(t => `<option value="${esc(t)}">#${esc(t)}</option>`).join('')}
      </select>
      <select id="fThumbs" style="width:auto" title="Počet zobrazených náhledů u článku">
        ${[['1', '1 náhled'], ['2', '2 náhledy'], ['3', '3 náhledy'], ['5', '5 náhledů'], ['all', 'Všechny náhledy']].map(([v, l]) =>
          `<option value="${v}">🖼 ${l}</option>`).join('')}
      </select>
    </div>
    <div id="articleCards">
    ${articles.length === 0 ? `<p class="muted">Žádné články.</p>` : ''}
    ${articles.map(a => {
      const tint = catTint(a.category);
      return `
      <div class="card article-row" data-open="${a.id}"
           style="border-left:4px solid ${tint.bar}; background:${tint.bg}"
           data-f-text="${esc((a.title + ' ' + (a.description || '')).toLowerCase())}"
           data-f-cat="${esc(a.category || 'Nezařazeno')}"
           data-f-tags="${esc((a.tags || '').toLowerCase())}">
        <div style="min-width:0; flex:1">
          <h3>${esc(a.title)}</h3>
          ${a.description ? `<div class="muted" style="margin-bottom:4px">${esc(a.description)}</div>` : ''}
          ${a.category ? `<span class="tag cat" style="background:${hexTint(tint.bar)}; color:${tint.bar}">${catIcon(a.category)} ${esc(a.category)}</span>` : ''}
          ${(a.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">#${esc(t.trim())}</span>`).join('')}
        </div>
        <div class="thumb-strip" data-thumbs="${esc((a.thumbs || []).join(','))}">
          ${a.thumb_id
            ? `<img class="article-thumb" src="${imgUrl(a.thumb_id)}" alt="" loading="lazy">`
            : `<div class="article-thumb placeholder" style="background:${tint.bg}; color:${tint.bar}">${catIcon(a.category)}</div>`}
        </div>
      </div>`; }).join('')}
    <p class="muted" id="noMatch" style="display:none">Žádný článek neodpovídá filtru.</p>
    </div>`, { activeCat: category, active: 'articles' });
  $app.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { location.hash = `#/c/${cid}/a/${el.dataset.open}`; });
  const nb = $app.querySelector('#newArticle');
  if (nb) nb.onclick = () => { location.hash = `#/c/${cid}/new`; };

  // ---------- filtry (klientské, nad už přefiltrovaným obsahem ze serveru)
  const fText = $app.querySelector('#fText');
  const fCat = $app.querySelector('#fCat');
  const fTag = $app.querySelector('#fTag');
  const applyFilters = () => {
    const t = (fText.value || '').toLowerCase().trim();
    const cat = fCat ? fCat.value : '';
    const tag = (fTag.value || '').toLowerCase();
    let visible = 0;
    $app.querySelectorAll('#articleCards [data-open]').forEach(card => {
      const ok = (!t || card.dataset.fText.includes(t))
        && (!cat || card.dataset.fCat === cat)
        && (!tag || card.dataset.fTags.split(',').map(x => x.trim()).includes(tag));
      card.style.display = ok ? '' : 'none';
      if (ok) visible++;
    });
    const nm = $app.querySelector('#noMatch');
    if (nm) nm.style.display = (visible === 0 && articles.length > 0) ? '' : 'none';
  };
  fText.oninput = applyFilters;
  if (fCat) fCat.onchange = applyFilters;
  fTag.onchange = applyFilters;

  // počet náhledů u článku (uloženo v prohlížeči)
  const fThumbs = $app.querySelector('#fThumbs');
  const applyThumbs = () => {
    const v = fThumbs.value;
    localStorage.setItem('thumbCount', v);
    $app.querySelectorAll('.thumb-strip').forEach(strip => {
      const ids = strip.dataset.thumbs.split(',').filter(Boolean);
      const n = v === 'all' ? ids.length : Math.max(1, parseInt(v, 10) || 1);
      const cat = (strip.closest('[data-f-cat]') || {}).dataset ? strip.closest('[data-f-cat]').dataset.fCat : '';
      const tint = catTint(cat);
      strip.innerHTML = ids.slice(0, n).map(id => `<img class="article-thumb" src="${imgUrl(id)}" alt="" loading="lazy">`).join('')
        || `<div class="article-thumb placeholder" style="background:${tint.bg}; color:${tint.bar}">${catIcon(cat)}</div>`;
    });
  };
  fThumbs.value = localStorage.getItem('thumbCount') || '1';
  fThumbs.onchange = applyThumbs;
  if (fThumbs.value !== '1') applyThumbs();
}


// ---------------------------------------------------------------- nastavení kampaně (DM)
async function renderCampaignSettings(tab = 'general') {
  if (!canEdit()) { location.hash = `#/c/${state.campaign.id}`; return; }
  if (tab === 'nav') return renderNavSettings();
  if (tab === 'inv') return renderInvSettings();
  if (tab === 'articles') return renderArticleSettings();
  const c = state.campaign;
  shell(`
    ${settingsHead('general')}
    <div class="card">
      <label>Název kampaně</label>
      <input id="csName" value="${esc(c.name)}">
      <label>Krátký popis</label>
      <input id="csDesc" value="${esc(c.description || '')}" placeholder="O čem kampaň je…">
      <label>Ikonka kampaně</label>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap">
        <div class="article-thumb ${c.iconImageId ? '' : 'placeholder'}" id="csIconPrev">${c.iconImageId ? `<img src="${imgUrl(c.iconImageId)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">` : '🏰'}</div>
        <input type="file" id="csIcon" accept="image/*" style="width:auto">
        ${c.iconImageId ? `<button class="small danger" id="csIconDel">Odebrat</button>` : ''}
      </div>
      <div style="margin-top:14px"><button id="csSave">💾 Uložit</button></div>
      <div class="error" id="csErr"></div>
    </div>
    <p class="muted">Domovský článek kampaně (🏠 O kampani) upravíte přímo v něm tlačítkem „Upravit“.</p>`,
    { active: 'settings', crumbs: [{ label: settingsTabLabel('general') }] });

  let iconId = c.iconImageId || null;
  $app.querySelector('#csIcon').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    openCropper(file, async (id) => {
      if (!id) return;
      iconId = id;
      $app.querySelector('#csIconPrev').outerHTML = `<div class="article-thumb" id="csIconPrev"><img src="${imgUrl(id)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px"></div>`;
    }, { aspect: 1, title: 'Ikonka kampaně (1 : 1)', noSkip: true });
  };
  const del = $app.querySelector('#csIconDel');
  if (del) del.onclick = () => { iconId = null; $app.querySelector('#csIconPrev').outerHTML = `<div class="article-thumb placeholder" id="csIconPrev">🏰</div>`; };
  $app.querySelector('#csSave').onclick = async () => {
    try {
      await api(`/api/campaigns/${c.id}/settings`, { method: 'PUT', body: { name: $app.querySelector('#csName').value, description: $app.querySelector('#csDesc').value, iconImageId: iconId } });
      c.name = $app.querySelector('#csName').value.trim() || c.name;
      c.description = $app.querySelector('#csDesc').value; c.iconImageId = iconId;
      location.hash = `#/c/${c.id}`;
    } catch (e) { $app.querySelector('#csErr').textContent = e.message; }
  };
}

// ---------------------------------------------------------------- nastavení → články: prozrazování informací (DM)
async function renderArticleSettings() {
  const c = state.campaign;
  let data;
  try { data = await api(`/api/campaigns/${c.id}/reveals`); }
  catch (e) { shell(`${settingsHead('articles')}<p class="error">${esc(e.message)}</p>`, { active: 'settings' }); return; }
  shell(`
    ${settingsHead('articles')}
    <div class="card">
      <h3 style="margin-top:0">Prozrazování informací</h3>
      <p class="muted">Postava, která vidí blok určený jen vybraným postavám, ho může <b>prozradit</b> jiné postavě. Informace se zpřístupní až po schválení — nebo hned, když zapnete automatiku.</p>
      <label class="pick-toggle ${data.auto ? 'on' : ''}" style="width:fit-content"><input type="checkbox" id="csAutoReveal" ${data.auto ? 'checked' : ''}>✅ Automatické schvalování prozrazování informací</label>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Žádosti ke schválení ${data.requests.length ? `<span class="badge pending">${data.requests.length}</span>` : ''}</h3>
      ${data.requests.length ? data.requests.map(r => `
        <div class="reveal-req" data-req="${r.id}">
          <div class="reveal-req-head">
            <b>🎭 ${esc(r.fromChar)}</b> chce prozradit postavě <b>🎭 ${esc(r.toChar)}</b>
            <a href="#/c/${c.id}/a/${r.articleId}">📄 ${esc(r.articleTitle)}</a>
            <span class="muted">${fmtDate(r.ts)}</span>
          </div>
          ${r.excerpt ? `<blockquote class="reveal-req-quote">${esc(r.excerpt)}${r.excerpt.length >= 200 ? '…' : ''}</blockquote>` : '<p class="muted">(blok bez textu — obrázek či příloha)</p>'}
          <div class="reveal-req-actions">
            <button class="small" data-approve-rev="${r.id}">✓ Schválit</button>
            <button class="small danger" data-reject-rev="${r.id}">✕ Zamítnout</button>
          </div>
        </div>`).join('')
      : '<p class="muted">Žádné žádosti nečekají.</p>'}
    </div>`,
    { active: 'settings', crumbs: [{ label: settingsTabLabel('articles') }] });

  const auto = $app.querySelector('#csAutoReveal');
  auto.onchange = async () => {
    const l = auto.closest('.pick-toggle'); if (l) l.classList.toggle('on', auto.checked);
    try { await api(`/api/campaigns/${c.id}/settings`, { method: 'PUT', body: { autoReveal: auto.checked } }); }
    catch (e) { invToast(e.message); auto.checked = !auto.checked; if (l) l.classList.toggle('on', auto.checked); }
  };
  const act = async (id, action) => {
    try { await api(`/api/reveals/${id}`, { method: 'PUT', body: { action } }); renderArticleSettings(); }
    catch (e) { invToast(e.message); renderArticleSettings(); }
  };
  $app.querySelectorAll('[data-approve-rev]').forEach(b => b.onclick = () => act(+b.dataset.approveRev, 'approve'));
  $app.querySelectorAll('[data-reject-rev]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('Zamítnout žádost? Hráč se to nedozví, jen se informace nezpřístupní.', { title: 'Zamítnout prozrazení', ok: 'Zamítnout', danger: true })) return;
    act(+b.dataset.rejectRev, 'reject');
  });
}

// ---------------------------------------------------------------- nastavení → inventář: sloty postavy (DM)
async function renderInvSettings() {
  const c = state.campaign;
  let data;
  try { data = await api(`/api/campaigns/${c.id}/inv/slots`); }
  catch (e) { shell(`${settingsHead('inv')}<p class="error">${esc(e.message)}</p>`, { active: 'settings' }); return; }
  shell(`
    ${settingsHead('inv')}
    <div class="card">
      <h3 style="margin-top:0">Systémové sloty postavy</h3>
      <p class="muted">Šestice pevných slotů nejde smazat, ale můžete jim dát vlastní <b>zobrazovaný název</b> — třeba z „Plášť / toulec“ udělat jen „Záda“. Prázdné pole = výchozí název.</p>
      <div class="slotset">
        ${data.systemSlots.map(s => `<div class="slotset-row">
          <span class="slotset-base" title="Výchozí název (nejde změnit)">${esc(s.baseLabel)}</span>
          <input data-syslot="${s.key}" value="${esc(s.label)}" placeholder="${esc(s.baseLabel)}" maxlength="30">
        </div>`).join('')}
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Vlastní sloty</h3>
      <p class="muted">Platí pro všechny postavy v kampani a zobrazují se v pravém sloupci nákresu (jde je přesunout i doleva). Smazat jde jen prázdný slot.</p>
      <div class="slotset" id="csCustom">
        ${data.customSlots.map(s => `<div class="slotset-row">
          <input data-cuslot="${s.key}" value="${esc(s.label)}" maxlength="30">
          <select data-cucol="${s.key}"><option value="1" ${s.col === 1 ? 'selected' : ''}>Levý sloupec</option><option value="2" ${s.col === 2 ? 'selected' : ''}>Pravý sloupec</option></select>
          <button class="small danger" data-cudel="${s.key}" title="Smazat slot (musí být prázdný u všech postav)">✕</button>
        </div>`).join('') || '<p class="muted">Zatím žádné — přidejte třeba Prsten nebo Přívěsek.</p>'}
      </div>
      <button class="small secondary" id="csSlotAdd" style="margin-top:10px">＋ nový slot</button>
    </div>`,
    { active: 'settings', crumbs: [{ label: settingsTabLabel('inv') }] });

  const put = async (key, body) => {
    try { await api(`/api/campaigns/${c.id}/inv/slots/${key}`, { method: 'PUT', body }); return true; }
    catch (e) { invToast(e.message); return false; }
  };
  $app.querySelectorAll('[data-syslot]').forEach(inp => inp.onchange = () => put(inp.dataset.syslot, { label: inp.value }));
  $app.querySelectorAll('[data-cuslot]').forEach(inp => inp.onchange = async () => {
    if (!inp.value.trim()) { invToast('Název nesmí být prázdný.'); return; }
    await put(inp.dataset.cuslot, { label: inp.value });
  });
  $app.querySelectorAll('[data-cucol]').forEach(sel => sel.onchange = () => put(sel.dataset.cucol, { col: +sel.value }));
  $app.querySelectorAll('[data-cudel]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('Smazat slot pro celou kampaň? Musí být prázdný u všech postav.', { title: 'Smazat slot', ok: 'Smazat', danger: true })) return;
    try { await api(`/api/campaigns/${c.id}/inv/slots/${b.dataset.cudel}`, { method: 'DELETE' }); renderInvSettings(); }
    catch (e) { invToast(e.message); }
  });
  $app.querySelector('#csSlotAdd').onclick = async () => {
    const name = await promptDialog('', { title: 'Nový slot postavy', icon: '🧍', ok: 'Vytvořit', placeholder: 'Název (např. Prsten)' });
    if (!name || !name.trim()) return;
    try { await api(`/api/campaigns/${c.id}/inv/slots`, { method: 'POST', body: { label: name, col: 2 } }); renderInvSettings(); }
    catch (e) { invToast(e.message); }
  };
}

// ---------------------------------------------------------------- nastavení → pořadí navigace (DM)
async function renderNavSettings() {
  const c = state.campaign;
  shell(`
    ${settingsHead('nav')}
    <div class="card">
      <h3 style="margin-top:0">🧭 Pořadí položek v levém menu</h3>
      <p class="muted" style="margin-top:0">Změna platí pro celou kampaň — pro vás i pro hráče.
      Položka <b>Nastavení kampaně</b> je jen pro DM, hráči ji nevidí; pořadí zbylých se jim přenese.</p>
      <div id="navList" class="navorder"></div>
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <button id="navSave">💾 Uložit pořadí</button>
        <button class="secondary" id="navReset">Výchozí pořadí</button>
        <span class="muted" id="navState"></span>
      </div>
    </div>`, { active: 'settings', crumbs: [{ label: settingsTabLabel('nav') }] });

  // přesun ↑/↓ nad pracovní kopií — uloží se až tlačítkem
  let order = navOrder();
  const navList = $app.querySelector('#navList');
  const navState = $app.querySelector('#navState');
  const drawNav = () => {
    navList.innerHTML = order.map((k, i) => {
      const d = NAV_DEFS[k];
      return `<div class="navorder-row">
        <span class="navorder-grip">${i + 1}.</span>
        <span class="navorder-label">${d.icon} ${esc(d.label)}</span>
        ${d.dmOnly ? '<span class="tag">jen DM</span>' : ''}
        ${k === 'home' && !c.homeArticleId ? '<span class="muted" style="font-size:12px">(kampaň nemá domovský článek)</span>' : ''}
        <div style="flex:1"></div>
        <button class="small ghost" data-up="${i}" title="Posunout výš" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="small ghost" data-down="${i}" title="Posunout níž" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`;
    }).join('');
    const swap = (i, j) => { [order[i], order[j]] = [order[j], order[i]]; navState.textContent = 'Neuloženo…'; drawNav(); };
    navList.querySelectorAll('[data-up]').forEach(b => b.onclick = () => swap(+b.dataset.up, +b.dataset.up - 1));
    navList.querySelectorAll('[data-down]').forEach(b => b.onclick = () => swap(+b.dataset.down, +b.dataset.down + 1));
  };
  drawNav();
  $app.querySelector('#navReset').onclick = () => { order = [...NAV_KEYS]; navState.textContent = 'Neuloženo…'; drawNav(); };
  $app.querySelector('#navSave').onclick = async () => {
    try {
      const r = await api(`/api/campaigns/${c.id}/settings`, { method: 'PUT', body: { navOrder: order } });
      c.navOrder = r.navOrder || order;
      route(); // menu se překreslí hned
    } catch (e) { navState.textContent = e.message; }
  };
}

// ---------------------------------------------------------------- nastavení → kategorie (DM)
async function renderCategoriesAdmin() {
  if (!canEdit()) { location.hash = `#/c/${state.campaign.id}`; return; }
  const { categories, system = [] } = await api(`/api/campaigns/${state.campaign.id}/category-list`);
  const counts = Object.fromEntries(state.cats.map(c => [c.name, c.count]));
  shell(`
    ${settingsHead('categories')}
    <p class="muted" style="margin-top:-4px">Odebráním kategorie se její články přesunou do „Nezařazeno“. Nová kategorie zapsaná v editoru článku se do seznamu přidá automaticky. Systémové kategorie (inventář, postavy) odebrat nelze.</p>
    ${categories.length === 0 ? `<p class="muted">Zatím žádné kategorie.</p>` : ''}
    ${categories.map(name => `
      <div class="card" style="display:flex; align-items:center; gap:12px; padding:14px 20px; border-left:4px solid ${catTint(name).bar}">
        <span style="font-size:20px">${catIcon(name)}</span>
        <strong style="flex:1">${esc(name)}</strong>
        <input type="color" class="catcolor" data-cat="${esc(name)}" value="${catColorHex(name)}" title="Barevný nádech kategorie" style="width:34px; height:30px; padding:2px">
        <span class="tag">${counts[name] || 0} článků</span>
        ${system.includes(name)
          ? `<span class="tag cat" title="Systémová kategorie">⚙️ systémová</span>`
          : `<button class="small danger" data-del="${esc(name)}">Odebrat</button>`}
      </div>`).join('')}
    <div class="card">
      <h3>Přidat kategorii</h3>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">
        <input id="catName" placeholder="Např. Tajné spolky" style="flex:1; min-width:180px" list="catSuggest">
        <datalist id="catSuggest">${['Města', 'Lokace', 'Frakce', 'Bohové', 'Historie', 'Události', 'Questy', 'Pravidla světa'].filter(c => !categories.includes(c)).map(c => `<option>${c}</option>`).join('')}</datalist>
        <button id="catAdd">Přidat</button>
      </div>
      <div class="error" id="catError"></div>
    </div>`, { active: 'settings', crumbs: [{ label: settingsTabLabel('categories') }] });
  const add = async () => {
    const name = $app.querySelector('#catName').value.trim();
    if (!name) return;
    try {
      await api(`/api/campaigns/${state.campaign.id}/category-list`, { method: 'POST', body: { name } });
      route();
    } catch (e) { $app.querySelector('#catError').textContent = e.message; }
  };
  $app.querySelector('#catAdd').onclick = add;
  $app.querySelector('#catName').onkeydown = e => { if (e.key === 'Enter') add(); };
  $app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog(`Články zůstanou, jen budou nezařazené.`, { title: `Odebrat kategorii „${b.dataset.del}“`, ok: 'Odebrat', danger: true })) return;
    await api(`/api/campaigns/${state.campaign.id}/category-list/remove`, { method: 'POST', body: { name: b.dataset.del } });
    route();
  });
  $app.querySelectorAll('.catcolor').forEach(inp => inp.onchange = async () => {
    await api(`/api/campaigns/${state.campaign.id}/category-color`, { method: 'PUT', body: { name: inp.dataset.cat, color: inp.value } });
    state.catColors[inp.dataset.cat] = inp.value;
    renderCategoriesAdmin();
  });
}

// ---------------------------------------------------------------- zobrazení článku
function visBadge(b, owned = false) {
  if (!canEdit() && !owned) return '';
  if (b.type === 'dm_note' || b.visibility === 'dm') return `<span class="vis-badge vis-dm">Pouze DM</span>`;
  if (b.visibility === 'all') return `<span class="vis-badge vis-all">Všichni</span>`;
  const names = (b.visibleTo || []).map(id => esc(charName(id))).join(', ');
  return `<span class="vis-badge vis-custom">${names || (owned ? 'jen vy + DM' : '—')}</span>`;
}

function renderBlockHTML(b, owned = false) {
  const c = b.content || {};
  const badge = visBadge(b, owned);
  switch (b.type) {
    case 'heading': {
      const lvl = Math.min(3, Math.max(1, c.level || 2)) + 1;
      return `<h${lvl}>${esc(c.text)}${badge}</h${lvl}>`;
    }
    case 'paragraph': return `<p>${richHTML(c, owned)}${badge}</p>`;
    case 'list': {
      const tag = c.ordered ? 'ol' : 'ul';
      return `<${tag}>${(c.items || []).map(i => `<li>${refsToLinks(esc(i))}</li>`).join('')}</${tag}>${badge}`;
    }
    case 'quote': return `<div class="block-quote">${richHTML(c, owned)}${badge}</div>`;
    case 'alert': return `<div class="block-alert">⚠️ ${richHTML(c, owned)}${badge}</div>`;
    case 'divider': return `<hr class="block-divider" style="margin:8px 0">${badge}`;
    case 'image': {
      const w = [25, 50, 75, 100].includes(c.width) ? c.width : 100;
      return `<div class="block-image" style="margin:4px 0">${c.imageId ? `<img src="${imgUrl(c.imageId)}" style="width:${w}%" alt="">` : ''}${c.caption ? `<div class="caption">${esc(c.caption)}</div>` : ''}${badge}</div>`;
    }
    case 'link': return `<p>🔗 <a class="ref" href="#/c/${state.campaign.id}/a/${c.articleId}">${esc(c.title || c.label || 'Odkaz')}</a>${badge}</p>`;
    case 'audio': return `<div class="block-image" style="margin:8px 0">
      ${c.caption || c.name ? `<div class="caption" style="margin-bottom:4px">🎵 ${esc(c.caption || c.name)}</div>` : ''}
      ${c.imageId ? `<audio controls preload="none" src="${imgUrl(c.imageId)}" style="width:100%; max-width:480px"></audio>` : ''}${badge}</div>`;
    case 'video': return `<div class="block-image" style="margin:8px 0">
      ${c.caption || c.name ? `<div class="caption" style="margin-bottom:4px">🎬 ${esc(c.caption || c.name)}</div>` : ''}
      ${c.imageId ? `<video controls preload="metadata" src="${imgUrl(c.imageId)}" style="width:100%; max-width:640px; border-radius:12px; box-shadow:var(--shadow)"></video>` : ''}${badge}</div>`;
    case 'youtube': {
      const id = ytId(c.url);
      const w = [25, 50, 75, 100].includes(c.width) ? c.width : 100;
      return `<div class="block-image" style="margin:12px 0; width:${w}%">
        ${c.caption ? `<div class="caption" style="margin-bottom:4px">▶️ ${esc(c.caption)}</div>` : ''}
        ${id ? `<div style="position:relative; padding-top:56.25%; border-radius:12px; overflow:hidden; box-shadow:var(--shadow)">
          <iframe src="https://www.youtube.com/embed/${id}" style="position:absolute; inset:0; width:100%; height:100%; border:0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        </div>` : `<span class="muted">Neplatný odkaz na YouTube.</span>`}${badge}</div>`;
    }
    case 'file': return `<p>📎 <a href="javascript:void 0" class="attach" data-attach-id="${c.imageId}"
      data-attach-name="${esc(c.name || 'příloha')}" data-attach-mime="${esc(c.mime || '')}">${esc(c.caption || c.name || 'Příloha')}</a>${badge}</p>`;
    case 'statblock': {
      const mod = v => { const m = Math.floor(((parseInt(v, 10) || 10) - 10) / 2); return (m >= 0 ? '+' : '') + m; };
      const paras = t => String(t || '').split('\n').filter(x => x.trim())
        .map(x => `<p>${esc(x).replace(/^([^.:]{1,60}[.:])/, '<b><i>$1</i></b>')}</p>`).join('');
      const ml = t => esc(t).replace(/\n/g, ', ');
      const show = (c.show && typeof c.show === 'object') ? c.show : {};
      const on = k => show[k] !== false; // nezaškrtnuté položky se po uložení nezobrazí
      const saves = c.saves || {};
      const abRow = (l, k) => `<tr><th>${l}</th><td>${esc(c[k] ?? 10)}</td><td>${esc(mod(c[k]))}</td><td class="sb-save">${esc(saves[k] || mod(c[k]))}</td></tr>`;
      const line = (label, val, key) => (on(key || label) && val) ? `<div class="sb-line"><b>${label}</b> ${ml(val)}</div>` : '';
      const section = (label, val, key) => (on(key) && val) ? `<div class="sb-h">${label}</div>${paras(val)}` : '';
      // „stat karta“ (AC…CR) drží pohromadě v jednom sloupci; akce/vlastnosti
      // pak plynou novinovou sazbou do tolika sloupců, kolik se vejde
      const statCard = `<div class="sb-card">
        ${on('ac') && c.ac ? `<div class="sb-line"><b>AC</b> ${esc(c.ac)}${on('initiative') && c.initiative ? ` &nbsp; <b>Initiative</b> ${esc(c.initiative)}` : ''}</div>` : ''}
        ${on('hp') && c.hp ? `<div class="sb-line"><b>HP</b> ${esc(c.hp)}</div>` : ''}
        ${on('speed') && c.speed ? `<div class="sb-line"><b>Speed</b> ${esc(c.speed)}</div>` : ''}
        ${on('abilities') ? `<div class="sb-sep"></div><div class="sb-abgrid">
          <table class="sb-table"><thead><tr><th></th><th></th><th>MOD</th><th>SAVE</th></tr></thead>
            <tbody>${abRow('STR', 'str')}${abRow('DEX', 'dex')}${abRow('CON', 'con')}</tbody></table>
          <table class="sb-table"><thead><tr><th></th><th></th><th>MOD</th><th>SAVE</th></tr></thead>
            <tbody>${abRow('INT', 'int')}${abRow('WIS', 'wis')}${abRow('CHA', 'cha')}</tbody></table>
        </div><div class="sb-sep"></div>` : ''}
        ${line('Skills', c.skills, 'skills')}
        ${line('Vulnerabilities', c.vulnerabilities, 'vulnerabilities')}
        ${line('Resistances', c.resistances, 'resistances')}
        ${line('Immunities', c.immunities, 'immunities')}
        ${line('Gear', c.gear, 'gear')}
        ${on('senses') && c.senses ? `<div class="sb-line"><b>Senses</b> ${ml(c.senses)}</div>` : ''}
        ${on('languages') && c.languages ? `<div class="sb-line"><b>Languages</b> ${ml(c.languages)}</div>` : ''}
        ${on('cr') && c.cr ? `<div class="sb-line"><b>CR</b> ${esc(c.cr)}</div>` : ''}
        ${(c.custom || []).filter(x => x.label || x.value).map(x => `<div class="sb-line"><b>${esc(x.label)}</b> ${esc(x.value)}</div>`).join('')}
      </div>`;
      return `<div class="statblock">
        <div class="sb-name">${esc(c.name || 'Tvor')}</div>
        ${on('meta') && c.meta ? `<div class="sb-meta">${esc(c.meta)}</div>` : ''}
        <div class="sb-sep"></div>
        <div class="sb-flow">
          ${statCard}
          ${section('Traits', c.traits, 'traits')}
          ${section('Actions', c.actions, 'actions')}
          ${section('Bonus Actions', c.bonusActions, 'bonusActions')}
          ${section('Legendary Actions', c.legendaryActions, 'legendaryActions')}
        </div>
      </div>${badge}`;
    }
    case 'dm_note': return `<div class="block-dmnote">${richHTML(c, owned)}</div>`;
    default: return `<p>${richHTML(c, owned)}${badge}</p>`;
  }
}

/** Tlačítko „prozradit informaci“ — jen pro hráče u bloků, které jeho postava vidí jmenovitě. */
function revealBtnHTML(b) {
  if (!b.canReveal || canEdit()) return '';
  const pend = (b.pendingReveals || []).length
    ? `<span class="reveal-pending" title="Žádost o prozrazení čeká na schválení DM">⏳ žádost o prozrazení podána: ${b.pendingReveals.map(esc).join(', ')}</span>` : '';
  return `<div class="reveal-row"><button class="small ghost" data-reveal="${b.id}" title="Vaše postava tuto informaci zná jmenovitě — může ji prozradit jiné postavě (schvaluje DM)">🤫 Prozradit jiné postavě…</button>${pend}</div>`;
}
/** Výběr cílové postavy a odeslání žádosti. */
async function revealDialog(blockId) {
  const others = state.characters.filter(c => c.id !== state.viewChar);
  if (!others.length) return invToast('V kampani není žádná jiná postava.');
  const picked = await new Promise(resolve => {
    closeCtxMenu();
    const overlay = h(`<div class="modal-overlay"><div class="modal confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-head"><span class="confirm-icon">🤫</span><h3>Prozradit informaci</h3></div>
      <div class="confirm-msg">Komu chce vaše postava tuto informaci prozradit? Lze vybrat víc postav. Pokud DM nemá zapnuté automatické schvalování, informace se zpřístupní až po jeho souhlasu.</div>
      <div class="zone-pick">${others.map(c => `<label class="pick-toggle"><input type="checkbox" value="${c.id}">🎭 ${esc(c.name)}</label>`).join('')}</div>
      <div class="confirm-actions">
        <button class="secondary" data-k="no">Zrušit</button>
        <button data-k="yes">🤫 Prozradit</button>
      </div>
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.pick-toggle input').forEach(i =>
      i.addEventListener('change', () => i.closest('.pick-toggle').classList.toggle('on', i.checked)));
    const done = v => { overlay.remove(); resolve(v); };
    overlay.onclick = e => { if (e.target === overlay) done(null); };
    overlay.querySelector('[data-k=no]').onclick = () => done(null);
    overlay.querySelector('[data-k=yes]').onclick = () =>
      done([...overlay.querySelectorAll('.pick-toggle input:checked')].map(i => +i.value));
  });
  if (!picked || !picked.length) return;
  const ok = [], wait = [], fail = [];
  for (const chId of picked) {
    const name = (state.characters.find(c => c.id === chId) || {}).name || '?';
    try {
      const r = await api(`/api/blocks/${blockId}/reveal`, { method: 'POST', body: { toCharId: chId } });
      (r.approved ? ok : wait).push(name);
    } catch (e) { fail.push(name); }
  }
  const parts = [];
  if (ok.length) parts.push(`prozrazeno: ${ok.join(', ')}`);
  if (wait.length) parts.push(`čeká na DM: ${wait.join(', ')}`);
  if (fail.length) parts.push(`nevyšlo: ${fail.join(', ')}`);
  invToast(parts.join(' · ') || 'Hotovo.');
  route(); // překreslit — u bloku se ukáže podaná žádost
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-reveal]');
  if (btn && state.campaign) revealDialog(+btn.dataset.reveal);
});

async function renderArticle(aid) {
  let a, notes;
  try {
    [a, notes] = await Promise.all([api(`/api/articles/${aid}`), api(`/api/articles/${aid}/notes`)]);
  } catch (e) { shell(`<p class="error">${esc(e.message)}</p>`); return; }
  const cid = state.campaign.id;
  const dm = canEdit();
  // inventář postavy (vidí DM a vlastník); poznámky z inventářů na článku předmětu
  // grafický inventář má vlastní stránku (menu → Inventář); na článku postavy je jen odkaz
  let itemInst = null; // výskyty předmětu (jen kategorie Předměty)
  if (a.category === 'Předměty') { try { itemInst = await api(`/api/articles/${aid}/instances`); } catch { } }
  const ownerMode = !dm && !!a.owned; // hráč edituje článek své postavy
  const editable = dm || ownerMode;
  // pracovní kopie bloků pro inline úpravy — vlastník si SUROVÁ data (neporušená
  // označení jazyků) vyžádá explicitně přes ?edit=1; DM je má rovnou
  let editSource = a;
  if (ownerMode) { try { editSource = await api(`/api/articles/${aid}?edit=1`); } catch { } }
  const editBlocks = editable ? editSource.blocks.map(b => ({
    type: b.type, content: { ...b.content }, visibility: b.visibility || 'all', visibleTo: b.visibleTo || []
  })) : null;

  const segTools = (i) => editable ? `
    <div class="seg-tools">
      <button data-seg-up="${i}" title="Posunout výš">↑</button>
      <button data-seg-down="${i}" title="Posunout níž">↓</button>
      <button data-seg-edit="${i}" title="Upravit blok">✏️</button>
      <button data-seg-del="${i}" title="Odstranit blok">✕</button>
    </div>` : '';
  const addZone = (i) => editable ? `<div class="seg-add" data-seg-add="${i}" title="Vložit blok sem"><span>+</span></div>` : '';

  shell(`
    <div class="article-body">
      <div class="pagehead">
        <h1>${esc(a.title)}</h1>
        ${ownerMode ? `<span class="tag cat">Vaše postava</span>` : ''}
        ${a.character ? `<span class="tag" title="Majitel postavy">🎭 hraje: ${esc((state.characters.find(c => c.id === a.character.id) || {}).username || '?')}</span>` : ''}
        ${a.character ? ((state.characters.find(c => c.id === a.character.id) || {}).languages || []).map(id => {
          const l = state.languages.find(x => x.id === id);
          return l ? `<span class="tag" title="Postava ovládá tento jazyk" style="color:${l.color}; text-decoration:underline">${esc(l.title)}</span>` : '';
        }).join('') : ''}
        ${a.category === 'Jazyk' && a.langColor ? `<span class="tag" style="background:${esc(a.langColor)}; color:#fff">■ barva jazyka</span>` : ''}
        ${a.isHome ? `<span class="tag cat">🏠 Domovský článek</span>` : ''}
        ${editable ? `<button class="small secondary" id="editBtn">✏️ Celý editor</button>` : ''}
        ${dm && !a.isHome ? `<button class="small danger" id="delBtn">Smazat</button>` : ''}
      </div>
      <p class="muted" style="margin-top:-8px">
        ${a.category ? `<span class="tag cat">${esc(a.category)}</span>` : ''}
        ${(a.tags || '').split(',').filter(t => t.trim()).map(t => `<span class="tag">#${esc(t.trim())}</span>`).join('')}
      </p>
      ${a.charMeta && a.category === 'Hráčské postavy' ? `<div class="item-meta">
        ${a.charMeta.race ? `<span class="tag">🧝 ${esc(a.charMeta.race)}</span>` : ''}
        ${a.charMeta.classes ? `<span class="tag cat">⚔️ ${esc(a.charMeta.classes)}</span>` : ''}
        ${a.charMeta.level ? `<span class="tag">Úroveň ${a.charMeta.level}</span>` : ''}
        ${a.charMeta.background ? `<span class="tag">📜 ${esc(a.charMeta.background)}</span>` : ''}
        ${a.charMeta.alignment ? `<span class="tag">☯ ${esc(a.charMeta.alignment)}</span>` : ''}
      </div>` : ''}
      ${a.description ? `<p class="muted" style="font-size:15px">${esc(a.description)}</p>` : ''}
      ${a.item && a.category === 'Předměty' ? `<div class="item-meta">
        ${a.item.rarity ? `<span class="tag inv-rarity" style="border-left:3px solid">◆ ${esc(a.item.rarity)}</span>` : ''}
        ${a.item.weight ? `<span class="tag">⚖️ ${a.item.weight} lb</span>` : ''}
        ${a.item.price ? `<span class="tag">💰 ${esc(a.item.price)}</span>` : ''}
      </div>` : ''}
      ${(() => { // galerie: hlavní fotka (portrét) + náhledy obrázků označených „v náhledu“
        const ids = articleGalleryIds(a);
        if (!ids.length) return '';
        return `<div class="article-gallery">
          <img class="gal-main" src="${imgUrl(ids[0])}" data-gal="0" alt="" title="Kliknutím zvětšíte">
          ${ids.length > 1 ? `<div class="gal-thumbs">${ids.slice(1).map((id, i) =>
            `<img class="gal-thumb" src="${imgUrl(id)}" data-gal="${i + 1}" alt="" loading="lazy">`).join('')}</div>` : ''}
        </div>`;
      })()}
      <div id="segments">
        ${a.blocks.map((b, i) => addZone(i) + `<div class="seg" data-seg="${i}">${renderBlockHTML(b, ownerMode)}${revealBtnHTML(b)}${segTools(i)}</div>`).join('')}
        ${addZone(a.blocks.length)}
        ${editable && a.blocks.length === 0 ? '<p class="muted">Článek zatím nemá žádný obsah — přidejte první blok tlačítkem +.</p>' : ''}
      </div>
      <p class="muted" style="margin-top:28px">Naposledy upraveno: ${fmtDate(a.updatedAt)}</p>

      ${a.character ? `
      <p><a href="#/c/${cid}/inventory"><button class="small secondary">🎒 Otevřít inventář postavy</button></a></p>` : ''}
      ${itemInst && itemInst.length ? `
      <hr class="block-divider">
      <h2 style="font-size:19px">🎒 Výskyty předmětu</h2>
      <div>${itemInst.map(x => `
        <a class="tag cat" href="#/c/${cid}/inventory" data-inst-goto="${x.where}:${x.where === 'char' ? x.charId : x.zoneId}" style="margin:0 6px 6px 0; display:inline-block">
          ${x.where === 'char' ? '🎭 má v inventáři: ' : '📍 leží na zemi: '}${esc(x.label)}${x.qty > 1 ? ` ×${x.qty}` : ''}${!x.identified ? ' ❓' : ''}
        </a>`).join('')}</div>` : ''}
      ${itemInst && !itemInst.length ? `<p class="muted">🎒 Žádný kus tohoto předmětu teď ${canEdit() ? 'v kampani není' : 'nemáte a neleží na zemi'}.</p>` : ''}

      <hr class="block-divider">
      <h2 style="font-size:19px">📝 Poznámky</h2>
      <div id="notesWrap">
        ${notes.length === 0 ? `<p class="muted">Zatím žádné poznámky.</p>` : ''}
        ${notes.map(n => `
          <div class="note">
            <div class="meta">
              <span class="author">${esc(n.author)}</span>
              <span class="muted">${fmtDate(n.createdAt)}</span>
              ${!n.approved ? `<span class="badge pending">čeká na schválení</span>` : (n.mine || editable) ? `<span class="badge approved">schváleno</span>` : ''}
              ${n.visibleTo !== undefined && n.visibleTo.length ? `<span class="muted">→ ${n.visibleTo.map(charName).map(esc).join(', ')}</span>` : ''}
              <span style="flex:1"></span>
              ${editable && !n.approved ? `<button class="small" data-approve="${n.id}">✓ Schválit</button>` : ''}
              ${(n.mine || editable) ? `<button class="small ghost" data-delnote="${n.id}">Smazat</button>` : ''}
            </div>
            <div>${esc(n.text).replace(/\n/g, '<br>')}</div>
          </div>`).join('')}
      </div>
      ${a.backlinks && a.backlinks.length ? `
      <hr class="block-divider">
      <h2 style="font-size:19px">🔁 Reference — odkazuje sem</h2>
      <p>${a.backlinks.map(b => `<a class="ref" href="#/c/${cid}/a/${b.id}" style="margin-right:8px; display:inline-block; margin-bottom:6px">${esc(b.title)}</a>`).join(' ')}</p>` : ''}

      <div class="card" style="margin-top:14px">
        <h3 style="font-size:15px">Přidat poznámku</h3>
        <textarea id="noteText" placeholder="Co si vaše postava poznamenala…"></textarea>
        <label>Které postavy poznámku uvidí (kromě vás a DM)${editable ? '' : ' — zobrazí se až po schválení (DM nebo vlastník postavy)'}</label>
        ${pickGroup(state.characters.filter(ch => !state.viewChar || ch.id !== state.viewChar).map(ch =>
          ({ id: ch.id, label: ch.name })), 'noteVis', { empty: '<span class="muted">V kampani nejsou další postavy.</span>' })}
        <div style="margin-top:12px"><button id="noteAdd">Uložit poznámku</button></div>
      </div>
    </div>`, a.isHome
    ? { active: 'home' }
    : { active: 'articles', activeCat: a.category || undefined, crumbs: [{ label: a.title }] });

  // proklik z výskytu předmětu rovnou na správné místo v inventáři
  $app.querySelectorAll('[data-inst-goto]').forEach(el => el.onclick = () => {
    const [where, id] = el.dataset.instGoto.split(':');
    if (where === 'char') { invUI.tab = 'c' + id; invUI.zoneOpen = null; }
    else invUI.zoneOpen = +id;
  });

  // ---------- galerie → lightbox s listováním šipkami (stejné pole jako nahoře!)
  {
    const galIds = articleGalleryIds(a);
    $app.querySelectorAll('[data-gal]').forEach(el => el.onclick = () => openLightbox(galIds, parseInt(el.dataset.gal, 10)));
  }

  // ---------- akce hlavičky
  const eb = $app.querySelector('#editBtn');
  if (eb) eb.onclick = () => { location.hash = `#/c/${cid}/edit/${aid}`; };
  const dbtn = $app.querySelector('#delBtn');
  if (dbtn) dbtn.onclick = async () => {
    if (!await confirmDialog('Opravdu smazat celý článek včetně všech bloků a poznámek?', { title: 'Smazat článek', ok: 'Smazat článek', danger: true })) return;
    await api(`/api/articles/${aid}`, { method: 'DELETE' });
    location.hash = `#/c/${cid}`;
  };

  // ---------- poznámky
  $app.querySelector('#noteAdd').onclick = async () => {
    const text = $app.querySelector('#noteText').value.trim();
    if (!text) return;
    const visibleTo = [...$app.querySelectorAll('.noteVis:checked')].map(cb => parseInt(cb.value, 10));
    await api(`/api/articles/${aid}/notes`, { method: 'POST', body: { text, visibleTo } });
    renderArticle(aid);
  };
  $app.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
    await api(`/api/notes/${b.dataset.approve}/approve`, { method: 'POST' });
    renderArticle(aid);
  });
  $app.querySelectorAll('[data-delnote]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('Smazat poznámku?', { title: 'Smazat poznámku', ok: 'Smazat', danger: true })) return;
    await api(`/api/notes/${b.dataset.delnote}`, { method: 'DELETE' });
    renderArticle(aid);
  });

  // ---------- inline úpravy segmentů (DM nebo vlastník postavy)
  if (!editable) return;

  async function persist() {
    await api(`/api/articles/${aid}`, {
      method: 'PUT',
      body: { title: a.title, description: a.description, category: a.category, tags: a.tags, coverImageId: a.coverImageId, coverThumbId: a.coverThumbId, coverWidth: a.coverWidth || 100, item: a.item || undefined, langColor: a.langColor || undefined, blocks: editBlocks }
    });
    renderArticle(aid);
  }

  /** Otevře inline editor bloku na pozici i (isNew = nový blok, zrušení ho odstraní). */
  function openInline(i, isNew = false) {
    const b = editBlocks[i];
    const seg = $app.querySelector(`[data-seg="${i}"]`) || $app.querySelector(`[data-seg-add="${i}"]`);
    const box = h(`<div class="editor-block inline-editor">
      <div class="row" style="display:flex; align-items:center; gap:8px">
        <span class="blocktype">${blockTypeLabel(b.type)}</span>
        <div style="flex:1"></div>
        ${dm ? `<button class="small ghost icon" data-k="tpl" title="Uložit jako šablonu">🖫</button>` : ''}
        <button class="small" data-k="save">💾 Uložit</button>
        <button class="small ghost" data-k="cancel">Zrušit</button>
      </div>
      <div data-role="fields"></div>
    </div>`).firstElementChild;
    const fieldsWrap = box.querySelector('[data-role=fields]');
    const redraw = () => { fieldsWrap.innerHTML = ''; fieldsWrap.appendChild(blockFields(b, redraw)); fieldsWrap.appendChild(blockVisControls(b, ownerMode)); };
    redraw();
    if (isNew) seg.after(box); else { seg.style.display = 'none'; seg.after(box); }
    box.querySelector('[data-k=save]').onclick = () => persist();
    box.querySelector('[data-k=cancel]').onclick = () => {
      if (isNew) editBlocks.splice(i, 1);
      renderArticle(aid);
    };
    const tplB = box.querySelector('[data-k=tpl]');
    if (tplB) tplB.onclick = () => saveAsTemplate(b);
    const richEl = box.querySelector('.rich');
    if (richEl) richEl.focus();
  }

  $app.querySelectorAll('[data-seg-edit]').forEach(btn => btn.onclick = () => openInline(parseInt(btn.dataset.segEdit, 10)));
  $app.querySelectorAll('[data-seg]').forEach(seg => seg.ondblclick = e => {
    if (e.target.closest('a')) return;
    openInline(parseInt(seg.dataset.seg, 10));
  });
  $app.querySelectorAll('[data-seg-del]').forEach(btn => btn.onclick = async () => {
    if (!await confirmDialog('Odstranit tento blok?', { title: 'Odstranit blok', ok: 'Odstranit', danger: true })) return;
    editBlocks.splice(parseInt(btn.dataset.segDel, 10), 1);
    persist();
  });
  $app.querySelectorAll('[data-seg-up]').forEach(btn => btn.onclick = () => {
    const i = parseInt(btn.dataset.segUp, 10);
    if (i > 0) { [editBlocks[i - 1], editBlocks[i]] = [editBlocks[i], editBlocks[i - 1]]; persist(); }
  });
  $app.querySelectorAll('[data-seg-down]').forEach(btn => btn.onclick = () => {
    const i = parseInt(btn.dataset.segDown, 10);
    if (i < editBlocks.length - 1) { [editBlocks[i + 1], editBlocks[i]] = [editBlocks[i], editBlocks[i + 1]]; persist(); }
  });
  $app.querySelectorAll('[data-seg-add]').forEach(zone => zone.onclick = e => {
    const at = parseInt(zone.dataset.segAdd, 10);
    const types = BLOCK_TYPES.filter(([t]) => !ownerMode || t !== 'dm_note'); // vlastník DM poznámky nevkládá
    const items = types.map(([type, label]) => ({
      icon: '＋', label,
      action: () => { editBlocks.splice(at, 0, newBlock(type)); openInline(at, true); }
    }));
    if (dm) items.push({
      icon: '📋', label: 'Ze šablony…',
      action: () => pickTemplate(t => { editBlocks.splice(at, 0, { ...newBlock(t.type), content: t.content }); openInline(at, true); })
    });
    openCtxMenu(e.clientX, e.clientY, items);
  });
}

// ================================================================ HERNÍ SEZENÍ
async function renderSessions() {
  const cid = state.campaign.id;
  const sessions = await api(`/api/campaigns/${cid}/sessions`);
  shell(`
    <div class="pagehead"><h1>🗓 Herní sezení</h1></div>
    ${sessions.length === 0 ? `<p class="muted">Zatím žádná sezení.</p>` : ''}
    ${sessions.map(s => `
      <div class="card article-row" data-open="${s.id}">
        <div class="article-thumb placeholder">🗓</div>
        <div style="min-width:0; flex:1">
          <h3>${esc(s.title)}</h3>
          <div class="muted">${s.date ? new Date(s.date).toLocaleDateString('cs-CZ') : 'bez data'}</div>
          <div>${s.participants.map(p => `<span class="tag">🎭 ${esc(p.name)}</span>`).join('')}</div>
        </div>
      </div>`).join('')}
    ${canEdit() ? `
    <div class="card">
      <h3>➕ Nové sezení</h3>
      <div style="display:flex; gap:12px; flex-wrap:wrap">
        <div style="flex:2; min-width:180px"><label>Název sezení</label><input id="sTitle" placeholder="Např. Sestup do katakomb"></div>
        <div style="flex:1; min-width:140px"><label>Datum</label><input id="sDate" type="date"></div>
      </div>
      <label>Účastnící se postavy</label>
      ${pickGroup(state.characters.map(c => ({ id: c.id, label: c.name, sub: `(${c.username})`, checked: true })), 'sChar', { empty: '<span class="muted">V kampani nejsou postavy.</span>' })}
      <div style="margin-top:12px"><button id="sCreate">Vytvořit sezení</button></div>
      <div class="error" id="sError"></div>
    </div>` : ''}`, { active: 'sessions' });
  $app.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { location.hash = `#/c/${cid}/session/${el.dataset.open}`; });
  const sc = $app.querySelector('#sCreate');
  if (sc) sc.onclick = async () => {
    try {
      const s = await api(`/api/campaigns/${cid}/sessions`, {
        method: 'POST',
        body: {
          title: $app.querySelector('#sTitle').value,
          date: $app.querySelector('#sDate').value,
          characters: [...$app.querySelectorAll('.sChar:checked')].map(c => parseInt(c.value, 10))
        }
      });
      location.hash = `#/c/${cid}/session/${s.id}`;
    } catch (e) { $app.querySelector('#sError').textContent = e.message; }
  };
}

async function renderSession(sid, editMine = false) {
  // úklid po případném předchozím vykreslení téže stránky
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  sessionGuard = null;
  const cid = state.campaign.id;
  let s;
  try { s = await api(`/api/sessions/${sid}${editMine ? '?edit=1' : ''}`); } // edit=1: surová data vlastního zápisu
  catch (e) { shell(`<p class="error">${esc(e.message)}</p>`); return; }
  // zápis DM = článek s bloky (server filtruje dle oprávnění); hráč bez viditelných bloků dostane 404
  let report = null;
  try { report = await api(`/api/articles/${s.reportArticleId}`); } catch { }
  const dm = s.canManage;

  const entryBadge = bl => bl.visibility === undefined ? '' :
    bl.visibility === 'all' ? `<span class="vis-badge vis-all">Všichni</span>` :
    bl.visibility === 'dm' ? `<span class="vis-badge vis-dm">Pouze DM</span>` :
    `<span class="vis-badge vis-custom">${(bl.visibleTo || []).map(charName).map(esc).join(', ') || '—'}</span>`;
  const entryBlocksView = (e, withBadges) => e.blocks.map(bl => `
    <div class="seg no-tools">
      ${withBadges ? entryBadge(bl) : ''}
      <div>${refsToLinks(bl.html)}</div>
    </div>`).join('');
  const entrySeg = (e) => `
    <details class="session-seg" data-player-seg="${e.charId}" open>
      <summary>🎭 Zápis — ${esc(e.name)} ${e.mine ? '<span class="tag cat">vaše postava</span>' : ''}</summary>
      <div class="seg-body">
        ${e.mine
          ? (editMine
            ? `<div data-entry-editor="${e.charId}"></div>`
            : `${e.blocks.length ? entryBlocksView(e, true) : '<p class="muted">Zatím bez zápisu.</p>'}
               <button class="small secondary" data-edit-entry style="margin-top:6px">✏️ Upravit zápis</button>`)
          : e.empty
            ? `<p class="muted">Zatím bez zápisu${dm ? ' (nebo je zápis skrytý)' : ''}.</p>`
            : entryBlocksView(e, dm)}
      </div>
    </details>`;

  shell(`
    <div class="pagehead">
      <h1>🗓 ${esc(s.title)}</h1>
      ${dm ? `<button class="small secondary" id="sEdit">✏️ Upravit</button>
              <button class="small danger" id="sDel">Smazat</button>` : ''}
    </div>
    <p class="muted" style="margin-top:-8px">
      ${s.date ? '📅 ' + new Date(s.date).toLocaleDateString('cs-CZ') + ' · ' : ''}
      ${s.participants.map(p => `<span class="tag">🎭 ${esc(p.name)}</span>`).join('')}
      ${(s.chatRooms || []).map(r => `<a href="javascript:void 0" class="tag cat" onclick="chatOpenRoom(${r.id})" title="Otevřít chat">💬 ${esc(r.name)}</a>`).join('')}
    </p>
    <div id="sEditForm" style="display:none"></div>

    <div class="toolbar" style="margin-top:4px">
      <button class="small secondary" id="expandAll">⬇ Rozbalit vše</button>
      <button class="small secondary" id="collapseAll">⬆ Složit vše</button>
      <button class="small" data-save-session>💾 Uložit (Ctrl+S)</button>
      <span class="muted" data-save-state></span>
      <div style="flex:1"></div>
      <select id="playerFilter" style="width:auto">
        <option value="">Zápisy: všechny postavy</option>
        ${s.participants.map(p => `<option value="${p.charId}">Jen: ${esc(p.name)}</option>`).join('')}
      </select>
    </div>

    ${s.scenario !== undefined ? `
    <details class="session-seg" open>
      <summary>📜 Scénář <span class="vis-badge vis-dm">Pouze DM</span></summary>
      <div class="seg-body" data-scenario-body></div>
    </details>` : ''}

    <details class="session-seg" open>
      <summary>📖 Zápis ze sezení (DM)</summary>
      <div class="seg-body" id="reportBody"></div>
    </details>

    <h2 style="font-size:19px; margin-top:22px">Zápisy z pohledu hráčů</h2>
    ${s.entries.map(entrySeg).join('')}

    ${(s.chatRooms || []).length ? `<h2 style="font-size:19px; margin-top:22px">Chat k sezení</h2>` : ''}
    ${(s.chatRooms || []).map(r => `
    <details class="session-seg" data-chatroom="${r.id}">
      <summary>💬 Chat — ${esc(r.name)}
        <button class="small secondary" data-openchat="${r.id}" style="margin-left:auto">Otevřít v panelu</button>
      </summary>
      <div class="seg-body" data-chatlog="${r.id}"><p class="muted">Historie se načte po rozbalení…</p></div>
    </details>`).join('')}
    <div class="toolbar">
      <button class="small" data-save-session>💾 Uložit (Ctrl+S)</button>
      <span class="muted" data-save-state></span>
      <span class="muted" style="margin-left:auto">Změny se automaticky ukládají každou minutu.</span>
    </div>
  `, { active: 'sessions', crumbs: [{ label: s.title }] });

  // ---------- historie chatu přiřazeného k sezení (načte se po rozbalení)
  $app.querySelectorAll('[data-chatroom]').forEach(det => {
    det.addEventListener('toggle', async () => {
      if (!det.open || det.dataset.loaded) return;
      det.dataset.loaded = '1';
      const log = det.querySelector('[data-chatlog]');
      try {
        const msgs = await api(`/api/chat/rooms/${det.dataset.chatroom}/messages`);
        log.innerHTML = msgs.length ? msgs.map(m => chatMsgHTML(m, true)).join('') : '<p class="muted">Zatím žádné zprávy.</p>';
        chatLoadRooms(); // otevření historie = přečteno → aktualizace badge
      } catch (e) { log.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    });
  });
  $app.querySelectorAll('[data-openchat]').forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    chatOpenRoom(parseInt(b.dataset.openchat, 10));
  });

  // ---------- ovládání segmentů
  $app.querySelector('#expandAll').onclick = () => $app.querySelectorAll('details.session-seg').forEach(d => d.open = true);
  $app.querySelector('#collapseAll').onclick = () => $app.querySelectorAll('details.session-seg').forEach(d => d.open = false);
  $app.querySelector('#playerFilter').onchange = e => {
    const v = e.target.value;
    $app.querySelectorAll('[data-player-seg]').forEach(d => { d.style.display = (!v || d.dataset.playerSeg === v) ? '' : 'none'; });
  };

  // ---------- DM: úprava hlavičky
  if (dm) {
    $app.querySelector('#sDel').onclick = async () => {
      if (!await confirmDialog('Smazat celé sezení včetně zápisu DM a zápisů hráčů?', { title: 'Smazat sezení', ok: 'Smazat sezení', danger: true })) return;
      await api(`/api/sessions/${sid}`, { method: 'DELETE' });
      location.hash = `#/c/${cid}/sessions`;
    };
    $app.querySelector('#sEdit').onclick = () => {
      const form = $app.querySelector('#sEditForm');
      if (form.style.display !== 'none') { form.style.display = 'none'; return; }
      form.style.display = '';
      form.innerHTML = `<div class="card">
        <div style="display:flex; gap:12px; flex-wrap:wrap">
          <div style="flex:2; min-width:180px"><label>Název</label><input id="seTitle" value="${esc(s.title)}"></div>
          <div style="flex:1; min-width:140px"><label>Datum</label><input id="seDate" type="date" value="${esc(s.date || '')}"></div>
        </div>
        <label>Účastnící se postavy</label>
        ${pickGroup(state.characters.map(c => ({ id: c.id, label: c.name, sub: `(${c.username})`, checked: s.participants.some(x => x.charId === c.id) })), 'seChar')}
        <div style="margin-top:10px"><button class="small" id="seSave">💾 Uložit</button></div>
      </div>`;
      form.querySelector('#seSave').onclick = async () => {
        await api(`/api/sessions/${sid}`, {
          method: 'PUT',
          body: {
            title: form.querySelector('#seTitle').value,
            date: form.querySelector('#seDate').value,
            characters: [...form.querySelectorAll('.seChar:checked')].map(c => parseInt(c.value, 10))
          }
        });
        renderSession(sid);
      };
    };
  }

  // ---------- neuložené změny, ukládání (ruční, Ctrl+S, autosave)
  let dirty = false;
  const markDirtyOn = el => {
    if (!el) return;
    el.addEventListener('input', () => { dirty = true; });
    el.addEventListener('change', () => { dirty = true; });
  };

  // ---------- zápis DM: bez tlačítka „Upravit“ — (+) zóny a editace přímo zde
  const reportBody = $app.querySelector('#reportBody');
  let reportBlocks = null, reportEditing = false;

  function reportAddMenu(e, at) {
    const items = BLOCK_TYPES.map(([type, label]) => ({
      icon: '＋', label,
      action: () => { reportBlocks.splice(at, 0, newBlock(type)); dirty = true; drawReportEditor(); }
    }));
    items.push({
      icon: '📋', label: 'Ze šablony…',
      action: () => pickTemplate(t => { reportBlocks.splice(at, 0, { ...newBlock(t.type), content: t.content }); dirty = true; drawReportEditor(); })
    });
    openCtxMenu(e.clientX, e.clientY, items);
  }
  function reportAddZone(at) {
    const z = h(`<div class="seg-add" title="Vložit blok sem"><span>+</span></div>`).firstElementChild;
    z.onclick = e => reportAddMenu(e, at);
    return z;
  }
  function drawReportPreview() {
    reportEditing = false;
    reportBody.innerHTML = '';
    reportBlocks.forEach((b, i) => {
      reportBody.appendChild(reportAddZone(i));
      const seg = h(`<div class="seg">${renderBlockHTML(b, false)}<div class="seg-tools">
        <button data-k="edit" title="Upravit bloky">✏️</button></div></div>`).firstElementChild;
      seg.querySelector('[data-k=edit]').onclick = () => drawReportEditor();
      seg.ondblclick = e => { if (!e.target.closest('a')) drawReportEditor(); };
      reportBody.appendChild(seg);
    });
    reportBody.appendChild(reportAddZone(reportBlocks.length));
    if (!reportBlocks.length) reportBody.appendChild(h(`<p class="muted">Zatím prázdné — přidejte blok tlačítkem ＋ (veřejné i tajné části).</p>`).firstElementChild);
  }
  function drawReportEditor() {
    reportEditing = true;
    reportBody.innerHTML = '';
    reportBlocks.forEach((b, i) => {
      const card = h(`<div class="editor-block" style="margin-bottom:10px">
        <div class="row" style="display:flex; align-items:center; gap:6px">
          <span class="blocktype">${i + 1} · ${blockTypeLabel(b.type)}</span>
          <div style="flex:1"></div>
          <button class="small ghost icon" data-k="tpl" title="Uložit jako šablonu">🖫</button>
          <button class="small secondary icon" data-k="up" title="Posunout výš">↑</button>
          <button class="small secondary icon" data-k="down" title="Posunout níž">↓</button>
          <button class="small ghost icon" data-k="del" title="Odstranit">✕</button>
        </div>
        <div data-role="fields"></div>
      </div>`).firstElementChild;
      const fw = card.querySelector('[data-role=fields]');
      const redraw = () => { fw.innerHTML = ''; fw.appendChild(blockFields(b, redraw)); fw.appendChild(blockVisControls(b, false)); };
      redraw();
      card.querySelector('[data-k=tpl]').onclick = () => saveAsTemplate(b);
      card.querySelector('[data-k=del]').onclick = async () => { if (await confirmDialog('Odstranit tento blok?', { ok: 'Odstranit', danger: true })) { reportBlocks.splice(i, 1); dirty = true; drawReportEditor(); } };
      card.querySelector('[data-k=up]').onclick = () => { if (i > 0) { [reportBlocks[i - 1], reportBlocks[i]] = [reportBlocks[i], reportBlocks[i - 1]]; dirty = true; drawReportEditor(); } };
      card.querySelector('[data-k=down]').onclick = () => { if (i < reportBlocks.length - 1) { [reportBlocks[i + 1], reportBlocks[i]] = [reportBlocks[i], reportBlocks[i + 1]]; dirty = true; drawReportEditor(); } };
      reportBody.appendChild(card);
    });
    const bar = h(`<div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
      <button class="small secondary" data-k="add">＋ Přidat blok</button>
      <button class="small" data-k="save">💾 Uložit a zobrazit náhled</button>
    </div>`).firstElementChild;
    bar.querySelector('[data-k=add]').onclick = e => reportAddMenu(e, reportBlocks.length);
    bar.querySelector('[data-k=save]').onclick = async () => { await saveAll(); drawReportPreview(); };
    reportBody.appendChild(bar);
  }
  if (reportBody) {
    if (dm && report) {
      reportBlocks = report.blocks.map(b => ({
        type: b.type, content: { ...b.content }, visibility: b.visibility || 'all', visibleTo: b.visibleTo || []
      }));
      drawReportPreview();
      markDirtyOn(reportBody);
    } else {
      reportBody.innerHTML = report && report.blocks.length
        ? report.blocks.map(b => renderBlockHTML(b, false)).join('\n')
        : `<p class="muted">DM zatím nic nesdílel.</p>`;
    }
  }

  // ---------- DM: scénář — náhled s proklikávatelnými referencemi ↔ editace
  let scenLeft = null, scenRight = null;
  const scenBody = $app.querySelector('[data-scenario-body]');
  if (s.scenario !== undefined && scenBody) {
    scenLeft = { html: s.scenario.left || '', text: '' };
    scenRight = { html: s.scenario.right || '', text: '' };
    // každý sloupec má VLASTNÍ režim náhled/editace a vlastní tlačítka
    const scenMode = {
      left: (scenLeft.html || '').trim() ? 'view' : 'edit',
      right: (scenRight.html || '').trim() ? 'view' : 'edit'
    };
    const drawScen = () => {
      scenBody.innerHTML = `<div class="session-cols">
        <div><label style="margin-top:0">Scénář sezení</label><div data-scen="left"></div></div>
        <div><label style="margin-top:0">Poznámky k průběhu (jak to hráči odehráli)</label><div data-scen="right"></div></div>
      </div>`;
      [['left', scenLeft, 'Upravit scénář'], ['right', scenRight, 'Upravit poznámky']].forEach(([side, obj, lbl]) => {
        const holder = scenBody.querySelector(`[data-scen="${side}"]`);
        if (scenMode[side] === 'view') {
          holder.innerHTML = `<div class="seg no-tools">${richHTML(obj) || '<span class="muted">Zatím prázdné.</span>'}</div>
            <button class="small secondary" data-k="edit" style="margin-top:6px">✏️ ${lbl}</button>`;
          holder.querySelector('[data-k=edit]').onclick = () => { scenMode[side] = 'edit'; drawScen(); };
        } else {
          holder.innerHTML = richToolbarHTML() + `<div class="rich" contenteditable="true" style="min-height:140px"></div>
            <div style="margin-top:8px"><button class="small" data-k="save">💾 Uložit a zobrazit náhled</button></div>`;
          wireRich(holder, obj);
          markDirtyOn(holder);
          holder.querySelector('[data-k=save]').onclick = async () => { await saveAll(); scenMode[side] = 'view'; drawScen(); };
        }
      });
    };
    drawScen();
  }

  // ---------- můj zápis: náhled ↔ editace více bloků s vlastní viditelností
  const myEntry = s.entries.find(e => e.mine);
  const editBtn2 = $app.querySelector('[data-edit-entry]');
  if (editBtn2) editBtn2.onclick = () => renderSession(sid, true);
  let myBlocks = null;
  if (myEntry && editMine) {
    const holder = $app.querySelector(`[data-entry-editor="${myEntry.charId}"]`);
    if (holder) {
      myBlocks = (myEntry.blocks || []).map(bl => ({
        id: bl.id, html: bl.html || '', text: bl.text || '',
        visibility: bl.visibility || 'all', visibleTo: bl.visibleTo || []
      }));
      const drawMyBlocks = () => {
        holder.innerHTML = '';
        myBlocks.forEach((bl, i) => {
          const card = h(`<div class="editor-block" style="margin-bottom:10px">
            <div class="row" style="display:flex; align-items:center; gap:6px">
              <span class="blocktype">Blok ${i + 1}</span>
              <div style="flex:1"></div>
              <button class="small secondary icon" data-k="up" title="Posunout výš">↑</button>
              <button class="small secondary icon" data-k="down" title="Posunout níž">↓</button>
              <button class="small ghost icon" data-k="del" title="Odstranit blok">✕</button>
            </div>
            <div data-role="rich">${richToolbarHTML()}<div class="rich" contenteditable="true" style="min-height:80px"></div></div>
          </div>`).firstElementChild;
          wireRich(card.querySelector('[data-role=rich]'), bl);
          card.appendChild(blockVisControls(bl, false));
          card.querySelector('[data-k=del]').onclick = async () => { if (await confirmDialog('Odstranit tento blok zápisu?', { ok: 'Odstranit', danger: true })) { myBlocks.splice(i, 1); dirty = true; drawMyBlocks(); } };
          card.querySelector('[data-k=up]').onclick = () => { if (i > 0) { [myBlocks[i - 1], myBlocks[i]] = [myBlocks[i], myBlocks[i - 1]]; dirty = true; drawMyBlocks(); } };
          card.querySelector('[data-k=down]').onclick = () => { if (i < myBlocks.length - 1) { [myBlocks[i + 1], myBlocks[i]] = [myBlocks[i], myBlocks[i + 1]]; dirty = true; drawMyBlocks(); } };
          holder.appendChild(card);
        });
        const bar = h(`<div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
          <button class="small secondary" data-k="add">＋ Přidat blok zápisu</button>
          <button class="small" data-k="savepreview">💾 Uložit a zobrazit náhled</button>
        </div>`).firstElementChild;
        bar.querySelector('[data-k=add]').onclick = () => { myBlocks.push({ html: '', text: '', visibility: 'all', visibleTo: [] }); dirty = true; drawMyBlocks(); };
        bar.querySelector('[data-k=savepreview]').onclick = async () => { await saveAll(); renderSession(sid, false); };
        holder.appendChild(bar);
      };
      drawMyBlocks();
      markDirtyOn(holder);
    }
  }

  // ---------- uložení všeho
  async function saveAll() {
    try {
      if (s.scenario !== undefined && scenLeft) {
        await api(`/api/sessions/${sid}`, { method: 'PUT', body: { scenario: { left: scenLeft.html, right: scenRight.html } } });
      }
      if (myBlocks) {
        await api(`/api/sessions/${sid}/entry`, { method: 'PUT', body: { blocks: myBlocks } });
      }
      if (dm && report && reportBlocks) { // zápis DM (článek sezení)
        await api(`/api/articles/${s.reportArticleId}`, {
          method: 'PUT',
          body: {
            title: report.title, description: report.description, category: report.category,
            tags: report.tags, coverImageId: report.coverImageId, coverThumbId: report.coverThumbId,
            coverWidth: report.coverWidth || 100, blocks: reportBlocks
          }
        });
      }
      dirty = false;
      const t = '✓ uloženo ' + new Date().toLocaleTimeString('cs-CZ');
      $app.querySelectorAll('[data-save-state]').forEach(el => el.textContent = t);
    } catch (e) {
      $app.querySelectorAll('[data-save-state]').forEach(el => el.textContent = '✗ ' + e.message);
    }
  }
  $app.querySelectorAll('[data-save-session]').forEach(b => b.onclick = saveAll);
  sessionGuard = { dirty: () => dirty, hash: location.hash, save: saveAll };
  sessionTimer = setInterval(() => { if (dirty) saveAll(); }, 60000); // autosave každou minutu
}

// ---------------------------------------------------------------- vyhledávání
async function renderSearch(q) {
  const results = await api(`/api/campaigns/${state.campaign.id}/search?q=${encodeURIComponent(q)}`);
  shell(`
    <div class="pagehead"><h1>Hledání: „${esc(q)}“</h1></div>
    ${results.length === 0 ? `<p class="muted">Nic nenalezeno.</p>` : ''}
    ${results.map(r => `
      <div class="card article-row" data-open="${r.articleId}">
        <div class="article-thumb placeholder">🔍</div>
        <div><h3>${esc(r.title)}</h3>
        ${r.snippet ? `<div class="muted">${esc(r.snippet)}</div>` : ''}</div>
      </div>`).join('')}`, { crumbs: [{ label: `Hledání: „${q}“` }] });
  $app.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { location.hash = `#/c/${state.campaign.id}/a/${el.dataset.open}`; });
}

// ---------------------------------------------------------------- správa hráčů
async function renderPlayers() {
  if (!isDM()) { location.hash = `#/c/${state.campaign.id}`; return; }
  state.players = await api(`/api/campaigns/${state.campaign.id}/players`);
  state.characters = await api(`/api/campaigns/${state.campaign.id}/characters`);
  const charsOf = uid => state.characters.filter(ch => ch.userId === uid);
  shell(`
    ${settingsHead('players')}
    ${state.players.map(p => `
      <div class="card">
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <div style="flex:1; min-width:180px">
            <strong>${esc(p.username)}</strong>
            <span class="tag ${p.role === 'dm' ? 'cat' : ''}">${p.role === 'dm' ? 'DM' : 'Hráč'}</span>
          </div>
          ${p.role === 'player' ? `
            <button class="small secondary" data-pass="${p.id}">🔑 Změnit heslo</button>
            <button class="small danger" data-remove="${p.id}">Odebrat</button>` : ''}
        </div>
        ${p.role === 'player' ? `
        <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center">
          <span class="blocktype">Postavy:</span>
          ${charsOf(p.id).map(ch => `
            <span class="tag" style="display:inline-flex; align-items:center; gap:6px">
              ${ch.articleId ? `<a href="#/c/${state.campaign.id}/a/${ch.articleId}">🎭 ${esc(ch.name)}</a>` : `🎭 ${esc(ch.name)}`}
              <a href="javascript:void 0" data-langs="${ch.id}" title="Jazyky postavy">🌐</a>
              <a href="javascript:void 0" data-reassign="${ch.id}" title="Předat jinému hráči">⇄</a>
              <a href="javascript:void 0" data-delchar="${ch.id}" title="Odebrat postavu" style="color:var(--danger)">✕</a>
            </span>`).join('') || '<span class="muted">žádné</span>'}
          <button class="small ghost" data-addchar="${p.id}">＋ postava</button>
        </div>` : ''}
      </div>`).join('')}

    <div class="card">
      <h3>➕ Vytvořit účet hráče</h3>
      <p class="muted">Vytvoříte účet s heslem a předáte přihlašovací údaje hráči sami — hráč se nemusí registrovat.</p>
      <div style="display:flex; gap:12px; flex-wrap:wrap">
        <div style="flex:1; min-width:140px"><label>Uživatelské jméno</label><input id="nUsername"></div>
        <div style="flex:1; min-width:140px"><label>Heslo</label><input id="nPassword" placeholder="min. 4 znaky"></div>
        <div style="flex:1; min-width:140px"><label>Jméno postavy</label><input id="nCharacter" placeholder="volitelné"></div>
      </div>
      <div style="margin-top:12px"><button id="nCreate">Vytvořit a přidat do kampaně</button></div>
      <div class="error" id="nError"></div>
    </div>

    <div class="card">
      <h3>Přidat existujícího uživatele</h3>
      <p class="muted">Všichni registrovaní uživatelé, kteří zatím nejsou v této kampani. Jeden uživatel může být ve více kampaních.</p>
      <div style="display:flex; gap:12px; flex-wrap:wrap">
        <div style="flex:1; min-width:160px"><label>Filtrovat</label><input id="pFilter" placeholder="Hledat podle jména…"></div>
        <div style="flex:1; min-width:160px"><label>Jméno postavy pro přidávaného</label><input id="pCharacter" placeholder="volitelné — vytvoří postavu"></div>
      </div>
      <div id="pUserList" style="margin-top:12px"></div>
      <div class="error" id="pError"></div>
    </div>`, { active: 'settings', crumbs: [{ label: settingsTabLabel('players') }] });

  $app.querySelector('#nCreate').onclick = async () => {
    try {
      const u = await api(`/api/campaigns/${state.campaign.id}/users`, {
        method: 'POST',
        body: {
          username: $app.querySelector('#nUsername').value,
          password: $app.querySelector('#nPassword').value,
          characterName: $app.querySelector('#nCharacter').value
        }
      });
      alert(`Účet vytvořen.\n\nPřihlašovací údaje pro hráče:\nJméno: ${u.username}\nHeslo: ${$app.querySelector('#nPassword').value}`);
      state.members = await api(`/api/campaigns/${state.campaign.id}/members`);
      renderPlayers();
    } catch (e) { $app.querySelector('#nError').textContent = e.message; }
  };
  // seznam všech registrovaných uživatelů mimo tuto kampaň
  let availableUsers = [];
  try { availableUsers = await api(`/api/campaigns/${state.campaign.id}/available-users`); } catch { }
  const drawUserList = (filter = '') => {
    const list = $app.querySelector('#pUserList');
    const rows = availableUsers.filter(u => u.username.toLowerCase().includes(filter.toLowerCase()));
    list.innerHTML = rows.length ? rows.map(u => `
      <div style="display:flex; align-items:center; gap:10px; padding:8px 12px; border:1px solid var(--border); border-radius:10px; margin-bottom:6px; background:var(--bg)">
        <strong style="flex:1">👤 ${esc(u.username)}</strong>
        ${u.campaigns ? `<span class="muted" style="font-size:12px">v ${u.campaigns} ${u.campaigns === 1 ? 'kampani' : 'kampaních'}</span>` : `<span class="muted" style="font-size:12px">nováček</span>`}
        <button class="small" data-adduser="${esc(u.username)}">＋ Přidat</button>
      </div>`).join('')
      : `<p class="muted">${availableUsers.length ? 'Nikdo neodpovídá filtru.' : 'Všichni registrovaní uživatelé už v kampani jsou.'}</p>`;
    list.querySelectorAll('[data-adduser]').forEach(b => b.onclick = async () => {
      try {
        await api(`/api/campaigns/${state.campaign.id}/players`, {
          method: 'POST',
          body: { username: b.dataset.adduser, characterName: $app.querySelector('#pCharacter').value }
        });
        state.members = await api(`/api/campaigns/${state.campaign.id}/members`);
        renderPlayers();
      } catch (e) { $app.querySelector('#pError').textContent = e.message; }
    });
  };
  drawUserList();
  $app.querySelector('#pFilter').oninput = e => drawUserList(e.target.value);
  $app.querySelectorAll('[data-pass]').forEach(btn => btn.onclick = async () => {
    const pwd = prompt('Nové heslo pro hráče (min. 4 znaky):');
    if (!pwd) return;
    try {
      await api(`/api/campaigns/${state.campaign.id}/players/${btn.dataset.pass}/password`, { method: 'PUT', body: { password: pwd } });
      alert('Heslo změněno.');
    } catch (e) { alert(e.message); }
  });
  $app.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = async () => {
    if (!await confirmDialog('Odebrat hráče z kampaně?', { title: 'Odebrat hráče', ok: 'Odebrat', danger: true })) return;
    await api(`/api/campaigns/${state.campaign.id}/players/${btn.dataset.remove}`, { method: 'DELETE' });
    renderPlayers();
  });
  $app.querySelectorAll('[data-addchar]').forEach(btn => btn.onclick = async (e) => {
    const uid = parseInt(btn.dataset.addchar, 10);
    let unassigned = [];
    try { unassigned = await api(`/api/campaigns/${state.campaign.id}/unassigned-characters`); } catch { }
    const items = [{
      icon: '＋', label: 'Založit novou postavu…',
      action: () => { newArticlePreset = { category: 'Hráčské postavy', ownerUserId: uid }; location.hash = `#/c/${state.campaign.id}/new`; }
    }];
    unassigned.forEach(a => items.push({
      icon: '🎭', label: `Přiřadit: ${a.title}`,
      action: async () => { await api(`/api/articles/${a.id}/owner`, { method: 'POST', body: { userId: uid } }); renderPlayers(); }
    }));
    openCtxMenu(e.clientX, e.clientY, items);
  });
  $app.querySelectorAll('[data-delchar]').forEach(el => el.onclick = async () => {
    if (!await confirmDialog('Její článek zůstane, ale hráč ztratí vlastnictví.', { title: 'Odebrat postavu', ok: 'Odebrat', danger: true })) return;
    await api(`/api/characters/${el.dataset.delchar}`, { method: 'DELETE' });
    renderPlayers();
  });
  // jazyky postavy (bez přiřazení = automaticky Běžný jazyk)
  $app.querySelectorAll('[data-langs]').forEach(el => el.onclick = () => {
    const chId = parseInt(el.dataset.langs, 10);
    const ch = state.characters.find(c => c.id === chId);
    const current = (ch && ch.languages) || [];
    const overlay = h(`<div class="modal-overlay"><div class="modal">
      <h3 style="margin:0 0 6px">🌐 Jazyky postavy ${esc(ch ? ch.name : '')}</h3>
      <p class="muted" style="margin-top:0">Běžný jazyk zná každá postava vždy.</p>
      ${pickGroup(state.languages.map(l => ({
        id: l.id, label: l.title, color: l.color,
        checked: l.common || current.includes(l.id), disabled: l.common,
        sub: l.common ? '(vždy)' : ''
      })), 'langChk', { all: false, variant: 'lang', empty: '<p class="muted">Žádné jazyky — vytvořte článek v kategorii „Jazyk“.</p>' })}
      <div style="margin-top:12px"><button class="small" data-k="save">💾 Uložit</button></div>
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('[data-k=save]').onclick = async () => {
      const languages = [...overlay.querySelectorAll('.langChk:checked')].filter(c => !c.disabled).map(c => parseInt(c.value, 10));
      await api(`/api/characters/${chId}`, { method: 'PUT', body: { languages } });
      overlay.remove();
      state.characters = await api(`/api/campaigns/${state.campaign.id}/characters`);
      renderPlayers();
    };
  });
  // DM předá postavu (a vlastnictví jejího článku) jinému hráči
  $app.querySelectorAll('[data-reassign]').forEach(el => el.onclick = e => {
    const chId = parseInt(el.dataset.reassign, 10);
    const ch = state.characters.find(c => c.id === chId);
    const others = state.players.filter(p => p.role === 'player' && p.id !== (ch ? ch.userId : 0));
    if (!others.length) return alert('V kampani není jiný hráč.');
    openCtxMenu(e.clientX, e.clientY, others.map(p => ({
      icon: '👤', label: `Předat hráči ${p.username}`,
      action: async () => {
        await api(`/api/characters/${chId}`, { method: 'PUT', body: { userId: p.id } });
        renderPlayers();
      }
    })));
  });
}

// ---------------------------------------------------------------- PLNÝ EDITOR
let newArticlePreset = null; // {category, ownerUserId} — předvyplnění nového článku (např. z Správy hráčů)
async function renderEditor(aid) {
  const isNew = !aid; // nový článek = formulář bez existujícího záznamu
  const preset = isNew ? newArticlePreset : null;
  newArticlePreset = null;
  if (state.viewAs || (isNew && !canEdit())) { location.hash = `#/c/${state.campaign.id}${aid ? '/a/' + aid : ''}`; return; }
  const a = isNew
    ? { title: '', description: '', category: (preset && preset.category) || '', tags: '', coverImageId: null, coverThumbId: null, coverWidth: 100, blocks: [], owned: false, character: null, item: null, charMeta: null, langColor: null }
    : await api(`/api/articles/${aid}?edit=1`); // surová data pro editaci
  let ownerUserId = preset ? (preset.ownerUserId || null) : ((a.character && a.character.userId) || null); // vlastník článku postavy
  const ownerMode = !canEdit() && !!a.owned; // hráč edituje článek své postavy
  if (!isNew && !canEdit() && !ownerMode) { location.hash = `#/c/${state.campaign.id}/a/${aid}`; return; }
  const { categories } = canEdit()
    ? await api(`/api/campaigns/${state.campaign.id}/category-list`)
    : { categories: [] };
  const blocks = a.blocks.map(b => ({
    type: b.type, content: { ...b.content }, visibility: b.visibility || 'all', visibleTo: b.visibleTo || []
  }));
  const typeOptions = BLOCK_TYPES.filter(([t]) => !ownerMode || t !== 'dm_note');

  function draw() {
    const catOpts = [`<option value="">— Nezařazeno —</option>`]
      .concat(categories.map(c => `<option value="${esc(c)}" ${a.category === c ? 'selected' : ''}>${esc(c)}</option>`))
      .concat(a.category && !categories.includes(a.category) ? [`<option value="${esc(a.category)}" selected>${esc(a.category)}</option>`] : [])
      .concat([`<option value="__new">＋ Nová kategorie…</option>`]).join('');
    shell(`
      <div class="pagehead"><h1>${isNew ? '＋ Nový článek' : 'Úprava článku'}</h1></div>
      <div class="card">
        <label>Název</label><input id="eTitle" value="${esc(a.title)}" placeholder="Např. Hlavní město">
        <label>Krátký popis</label><input id="eDesc" value="${esc(a.description || '')}">
        <div style="display:flex; gap:14px; flex-wrap:wrap">
          <div style="flex:1; min-width:160px"><label>Kategorie</label>
            ${ownerMode ? `<input value="${esc(a.category || 'Nezařazeno')}" disabled title="Kategorii spravuje DM">` : `<select id="eCat">${catOpts}</select>`}
          </div>
          <div style="flex:1; min-width:160px"><label>Štítky (odděl čárkou)</label>
            <input id="eTags" value="${esc(a.tags || '')}"></div>
        </div>
        <label>Hlavní obrázek (portrét 3:4)</label>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap">
          ${a.coverImageId ? `<img src="${imgUrl(a.coverImageId)}" style="height:72px; aspect-ratio:3/4; object-fit:cover; border-radius:8px">
            <button class="small danger" id="eCoverDel">Odebrat</button>` : '<span class="muted">žádný</span>'}
          <input type="file" id="eCover" accept="image/*" style="width:auto">
        </div>
        ${a.category === 'Monstra' && canEdit() ? `
        <label>⬇ Import z D&D Beyond</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
          <input id="ddbUrl" placeholder="https://www.dndbeyond.com/monsters/…" style="flex:1; min-width:220px">
          <button class="small secondary" id="ddbImport">⬇ Importovat z odkazu</button>
        </div>
        <details style="margin:8px 0">
          <summary class="muted" style="cursor:pointer; font-size:13px">Import z odkazu nefunguje? (placený obsah / přihlášení)</summary>
          <p class="muted" style="margin:6px 0">Import z odkazu funguje jen pro volně dostupná monstra (základní sada / SRD). Obsah <b>za přihlášením nebo zakoupený</b> server načíst nedokáže — D&D Beyond ho vydá jen vašemu přihlášenému prohlížeči. Řešení: na stránce monstra označte stat blok (nebo Ctrl+A), zkopírujte (Ctrl+C) a vložte sem — funguje i pro placený obsah:</p>
        </details>
        <textarea id="ddbText" placeholder="Vložte zkopírovaný stat blok z D&D Beyond…&#10;&#10;Beholder&#10;Large Aberration, Lawful Evil&#10;AC 18 Initiative +12 (22)&#10;HP 190 …" style="min-height:70px"></textarea>
        <div style="margin-top:6px"><button class="small secondary" id="ddbImportText">⬇ Importovat z textu</button>
        <span class="muted" id="ddbState"></span></div>` : ''}
        ${a.category === 'Hráčské postavy' && canEdit() ? `
        <label>⬇ Import postavy z D&D Beyond</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
          <input id="ddbcUrl" placeholder="https://www.dndbeyond.com/characters/…" style="flex:1; min-width:220px">
          <button class="small secondary" id="ddbcImport">⬇ Importovat postavu</button>
          <button class="small ghost" id="ddbcManual" title="Přidat prázdná pole a vyplnit ručně">✍️ Vyplnit ručně</button>
        </div>
        <p class="muted" style="margin:6px 0 0">Postava musí být na D&D Beyond nastavena jako <b>veřejná</b> (Character Privacy → Public). Naimportuje jméno, rasu, třídu, staty, features & traits a příběh; AC a HP jsou dopočítané — zkontrolujte je. Nemáte odkaz? Tlačítkem „Vyplnit ručně“ přidáte prázdnou kartu postavy. <span id="ddbcState"></span></p>` : ''}
        ${a.category === 'Hráčské postavy' && canEdit() ? `
        <label>Vlastník (hráč) — nepovinné</label>
        <select id="cmOwner">
          <option value="">— bez vlastníka —</option>
          ${state.players.filter(p => p.role === 'player').map(p => `<option value="${p.id}" ${ownerUserId === p.id ? 'selected' : ''}>👤 ${esc(p.username)}${p.character_name ? ' (' + esc(p.character_name) + ')' : ''}</option>`).join('')}
        </select>
        <p class="muted" style="margin:4px 0 0">Nastavením vlastníka získá hráč práva na tuto postavu (může ji editovat, vidí ji ve svém přepínači).</p>` : ''}
        ${a.category === 'Hráčské postavy' ? `
        <label>Metadata postavy</label>
        <div style="display:flex; gap:12px; flex-wrap:wrap">
          <div style="flex:1; min-width:120px"><label style="margin-top:0">Rasa / druh</label><input id="cmRace" value="${esc((a.charMeta || {}).race || '')}"></div>
          <div style="flex:2; min-width:160px"><label style="margin-top:0">Třída a úroveň</label><input id="cmClasses" value="${esc((a.charMeta || {}).classes || '')}"></div>
          <div style="flex:1; min-width:90px"><label style="margin-top:0">Úroveň</label><input id="cmLevel" type="number" min="1" max="20" value="${(a.charMeta || {}).level || ''}"></div>
        </div>
        <div style="display:flex; gap:12px; flex-wrap:wrap">
          <div style="flex:1; min-width:140px"><label style="margin-top:0">Background</label><input id="cmBackground" value="${esc((a.charMeta || {}).background || '')}"></div>
          <div style="flex:1; min-width:140px"><label style="margin-top:0">Přesvědčení</label><input id="cmAlignment" value="${esc((a.charMeta || {}).alignment || '')}"></div>
        </div>` : ''}
        ${a.character ? (() => {
          const chLangs = ((state.characters.find(c => c.id === a.character.id) || {}).languages) || [];
          if (!canEdit()) { // hráč jazyky NEMĚNÍ — jen vidí, co jeho postava ovládá
            return `<label>🌐 Jazyky postavy</label>
            <p class="muted" style="margin:0 0 6px">Jazyky postav nastavuje DM.</p>
            <div>${chLangs.map(id => { const l = state.languages.find(x => x.id === id); return l ? `<span class="tag" style="color:${l.color}; text-decoration:underline">${esc(l.title)}</span>` : ''; }).join('') || '<span class="muted">—</span>'}</div>`;
          }
          return `<label>🌐 Jazyky postavy</label>
          <p class="muted" style="margin:0 0 6px">Běžný jazyk zná každá postava vždy. Vyberte další jazyky, které ${esc(a.character.name)} ovládá.</p>
          ${pickGroup(state.languages.map(l => ({
            id: l.id, label: l.title, color: l.color,
            checked: l.common || chLangs.includes(l.id), disabled: l.common,
            sub: l.common ? '(vždy)' : ''
          })), 'charLang', { all: false, variant: 'lang', empty: '<span class="muted">V kampani zatím nejsou jazyky.</span>' })}`;
        })() : ''}
        ${a.category === 'Jazyk' ? `
        <label>Barva jazyka (musí být unikátní)</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
          ${['#e05656', '#e08b3a', '#d9b45e', '#7bb661', '#2e9e5b', '#3bb5a9', '#3b82f6', '#6d5ae6', '#9333ea', '#d457c4', '#e0567f', '#8b5a2b', '#9aa0a6', '#4b5563', '#0ea5e9', '#84cc16'].map(col => {
            const takenBy = state.languages.find(l => l.color.toLowerCase() === col && l.id !== a.id);
            return `<button class="icon" data-langcolor="${col}" ${takenBy ? 'disabled title="Použito: ' + esc(takenBy.title) + '"' : ''}
              style="width:30px; height:30px; border-radius:8px; background:${col}; opacity:${takenBy ? .25 : 1};
              outline:${(a.langColor || '').toLowerCase() === col ? '3px solid var(--text)' : 'none'}"></button>`;
          }).join('')}
          <input type="color" id="langColorCustom" value="${esc(a.langColor || '#6d5ae6')}" title="Vlastní barva" style="width:36px; height:32px; padding:2px">
        </div>` : ''}
        ${a.category === 'Předměty' ? (() => {
          const it = a.item || {};
          const num = (v, d) => v === undefined || v === null ? d : v;
          return `
        <div class="formsec">
          <h4>🎴 Token a tvar</h4>
          <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap">
            <div id="iTokenPrev" class="token-prev">${it.tokenImageId ? `<img src="${imgUrl(it.tokenImageId)}" alt="">` : '🎴'}</div>
            <div style="flex:1; min-width:200px">
              <label style="margin-top:0">Obrázek tokenu (s průhledností, ideálně PNG)</label>
              <input type="file" id="iToken" accept="image/*" style="width:auto">
            </div>
            <div>
              <label style="margin-top:0">Tvar tokenu — klikáním v mřížce (jde i kříž, L…)</label>
              <div id="iShapeGrid" class="contgrid-edit shape"></div>
              <p class="muted" style="margin:6px 0 0">Velikost: <b id="iShapeCount">?</b> políček (spočítá se z tvaru)</p>
            </div>
          </div>
        </div>

        <div class="formsec">
          <h4>🧷 Vlastnosti</h4>
          <div class="pick-group">
            ${pill('id="iTwoHanded"', 'obouruční — zabere obě ruce', !!it.twoHanded)}
            ${pill('id="iNoDrop"', 'nejde odhodit (quest předmět)', !!it.noDrop)}
            ${pill('id="iStackable"', 'stackovatelný', !!it.stackable)}
            <span class="vischeck" style="margin:0">max ve stacku <input id="iStackMax" type="number" min="1" max="99" value="${num(it.stackMax, 10)}" style="width:64px; margin-left:6px"> ks</span>
          </div>
          <div style="display:flex; gap:14px; align-items:center; margin-top:10px">
            <label style="margin:0">Max. životy (1–10)</label>
            <input id="iHpMax" type="number" min="1" max="10" value="${num(it.hpMax, 10)}" style="width:72px">
            <span class="muted" style="font-size:12px">stackovatelné předměty životy nemají</span>
          </div>
        </div>

        <div class="formsec">
          <h4>📍 Kam jde předmět nasadit</h4>
          <p class="muted" style="margin:0 0 8px">Vyberte sloty, nebo <b>Kamkoli</b>. Velikost se na těle neřeší — tvar hraje roli až v batozích. <b>Nic nevybráno = předmět nejde nosit.</b></p>
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap">
            <input id="iSlotFilter" placeholder="🔍 Najít slot… (např. prsten)" style="max-width:280px">
            <button type="button" class="small secondary" id="iSlotNew">＋ nový slot</button>
          </div>
          <div class="pick-group" style="margin-bottom:6px">${pill('id="iAnywhere"', '🌐 Kamkoli', !!it.wearable && !(it.slots || []).length)}</div>
          ${(() => {
            const customs = (state.campaign && state.campaign.customSlots) || [];
            const grps = [
              { label: 'Systémové sloty', items: Object.entries(INV_SLOT_DEFS).map(([k, d]) => ({ key: k, label: d.l })) },
              { label: 'Vlastní sloty', items: customs.map(c => ({ key: c.key, label: c.label })) }
            ];
            return grps.filter(g => g.items.length).map(g => `
              <div class="slotgrp" data-grp>
                <div class="inv-group-label">${esc(g.label)}</div>
                <div class="pick-group">${g.items.map(s =>
                  pill(`class="iSlot" value="${s.key}"`, esc(s.label), (it.slots || []).includes(s.key))).join('')}</div>
              </div>`).join('');
          })()}
        </div>

        <div class="formsec">
          <h4>💰 Herní údaje</h4>
          <div style="display:flex; gap:12px; flex-wrap:wrap">
            <div style="flex:1; min-width:110px"><label style="margin-top:0">Váha (lb)</label><input id="iWeight" type="number" min="0" step="0.1" value="${it.weight || 0}"></div>
            <div style="flex:1; min-width:110px"><label style="margin-top:0">Cena</label><input id="iPrice" placeholder="např. 50 zl" value="${esc(it.price || '')}"></div>
            <div style="flex:1; min-width:140px"><label style="margin-top:0">Vzácnost</label>
              <select id="iRarity">${['', 'Běžný', 'Neobvyklý', 'Vzácný', 'Velmi vzácný', 'Legendární', 'Artefakt'].map(r =>
                `<option value="${r}" ${it.rarity === r ? 'selected' : ''}>${r || '—'}</option>`).join('')}</select>
            </div>
          </div>
        </div>

        <div class="formsec">
          <h4>❓ Identifikace a popisy</h4>
          <p class="muted" style="margin:0 0 8px">Neidentifikovaný kus ukazuje hráči jen <b>obecný název</b> a <b>veřejný popis</b>. Pravé jméno (název článku) a tajný popis odhalí až identifikace od DM.</p>
          <div class="pick-group" style="margin-bottom:8px">${pill('id="iIdentDef"', 'nové kusy jsou rovnou identifikované', it.identifiedDefault === undefined ? true : !!it.identifiedDefault)}</div>
          <label style="margin-top:4px">Obecný název (neidentifikováno)</label>
          <input id="iUnident" placeholder="např. Tajemný meč" value="${esc(it.unidentifiedName || '')}">
          <label>Veřejný popis (vidí každý držitel)</label>
          <textarea id="iPublic" style="min-height:52px">${esc(it.publicText || '')}</textarea>
          <label>Tajný popis (odhalí se identifikací)</label>
          <textarea id="iSecret" style="min-height:52px">${esc(it.secretText || '')}</textarea>
        </div>

        <div class="formsec">
          <h4>🎒 Kontejner</h4>
          <div class="pick-group">${pill('id="iIsCont"', 'tento předmět je kontejner (batoh, brašna, opasek s kapsami…)', !!it.container)}</div>
          <div id="iContWrap" style="${it.container ? '' : 'display:none'}; margin-top:8px">
            <p class="muted" style="margin:0 0 6px">Klikáním nakreslete tvar. Každé kliknutí přepne políčko: prázdné → 🟢 volná akce → 🟡 akce → 🔴 celé kolo → prázdné. Poloha na plátně nehraje roli — tvar se sám přisune k okraji.</p>
            <div id="iContGrid" class="contgrid-edit"></div>
          </div>
        </div>`;
        })() : ''}
      </div>

      <h2 style="font-size:19px">Obsahové bloky</h2>
      <p class="muted" style="margin-top:-6px">Nový blok vložíte tlačítkem ＋ mezi bloky. Tip: pravé tlačítko myši (nebo podržení prstu) v textu otevře nabídku formátování a vkládání referencí.</p>
      <div id="blocksWrap"></div>
      <div class="toolbar">
        <div style="flex:1"></div>
        <button id="saveArticle">💾 ${isNew ? 'Vytvořit článek' : 'Uložit článek'}</button>
        <a href="${isNew ? `#/c/${state.campaign.id}` : `#/c/${state.campaign.id}/a/${aid}`}"><button class="ghost">Zrušit</button></a>
      </div>
      <div class="error" id="eError"></div>`, {
    active: 'articles', activeCat: a.category || undefined,
    crumbs: isNew
      ? [{ label: 'Nový článek' }]
      : [{ label: a.title, href: `#/c/${state.campaign.id}/a/${aid}` }, { label: 'Editor' }]
  });

    const addZoneEl = (at) => {
      const z = h(`<div class="seg-add" title="Vložit blok sem"><span>+</span></div>`).firstElementChild;
      z.onclick = e => {
        const items = typeOptions.map(([type, label]) => ({
          icon: '＋', label,
          action: () => { blocks.splice(at, 0, newBlock(type)); draw(); }
        }));
        if (canEdit()) items.push({
          icon: '📋', label: 'Ze šablony…',
          action: () => pickTemplate(t => { blocks.splice(at, 0, { ...newBlock(t.type), content: t.content }); draw(); })
        });
        openCtxMenu(e.clientX, e.clientY, items);
      };
      return z;
    };
    const wrap = $app.querySelector('#blocksWrap');
    blocks.forEach((b, i) => { wrap.appendChild(addZoneEl(i)); wrap.appendChild(drawBlock(b, i)); });
    wrap.appendChild(addZoneEl(blocks.length));
    $app.querySelector('#eCover').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.type === 'image/gif') { // gif bez ořezu
        uploadImage(file, file.name).then(r => { a.coverImageId = r.id; a.coverThumbId = r.id; draw(); });
        return;
      }
      // hlavní obrázek: poměr si vybereš (portrét/čtverec/širokoúhlý/4:3), jde i odzoomovat;
      // čtvercový náhled do seznamu je volitelný druhý krok
      openCropper(file, (mainId, _w, makeThumb) => {
        if (!mainId) return;
        if (makeThumb === false) { a.coverImageId = mainId; a.coverThumbId = mainId; draw(); return; }
        openCropper(file, thumbId => {
          a.coverImageId = mainId;
          a.coverThumbId = thumbId || mainId;
          draw();
        }, { aspect: 1, title: 'Miniatura do seznamu článků (čtverec 1 : 1)', noSkip: true });
      }, {
        aspectDefault: 0.75, title: 'Hlavní obrázek článku — zobrazí se nahoře v článku a v galerii', noSkip: false,
        checkbox: { label: 'vytvořit i čtvercový náhled (miniatura v seznamu článků — další krok)', checked: true }
      });
    };
    const cd = $app.querySelector('#eCoverDel');
    if (cd) cd.onclick = () => { a.coverImageId = null; a.coverThumbId = null; draw(); };
    // ---------- import z D&D Beyond (kategorie Monstra)
    const ddbApply = (p) => {
      if (!a.title.trim() && p.name) { a.title = p.name; }
      let sb = blocks.find(b => b.type === 'statblock');
      if (!sb) { sb = newBlock('statblock'); blocks.unshift(sb); }
      const map = ['name', 'meta', 'ac', 'initiative', 'hp', 'speed', 'str', 'dex', 'con', 'int', 'wis', 'cha',
        'skills', 'vulnerabilities', 'immunities', 'resistances', 'gear', 'senses', 'languages', 'cr',
        'traits', 'actions', 'bonusActions', 'legendaryActions'];
      map.forEach(k => { if (p[k] !== undefined && p[k] !== '') sb.content[k] = p[k]; });
      if (p.saves) sb.content.saves = p.saves;
      sb.content.show = {};
      draw();
    };
    const ddbRun = async (body) => {
      const st = $app.querySelector('#ddbState');
      st.textContent = '⏳ importuji…';
      try {
        const p = await api(`/api/campaigns/${state.campaign.id}/import-dndbeyond`, { method: 'POST', body });
        ddbApply(p);
      } catch (e) { st.textContent = '✗ ' + e.message; }
    };
    const dbtn = $app.querySelector('#ddbImport');
    if (dbtn) dbtn.onclick = () => ddbRun({ url: $app.querySelector('#ddbUrl').value.trim() });
    const dtxt = $app.querySelector('#ddbImportText');
    if (dtxt) dtxt.onclick = () => ddbRun({ text: $app.querySelector('#ddbText').value });

    // ---------- import HRÁČSKÉ POSTAVY z D&D Beyond
    const dcBtn = $app.querySelector('#ddbcImport');
    if (dcBtn) dcBtn.onclick = async () => {
      const st = $app.querySelector('#ddbcState');
      st.textContent = '⏳ importuji…';
      try {
        const p = await api(`/api/campaigns/${state.campaign.id}/import-ddb-character`, {
          method: 'POST', body: { url: $app.querySelector('#ddbcUrl').value.trim() }
        });
        if (!a.title.trim() && p.name) a.title = p.name;
        a.charMeta = { race: p.race, classes: p.classes, level: p.level, background: p.background, alignment: p.alignment };
        // karta postavy (stat blok) — nahradí případnou předchozí (bez reassignmentu pole)
        for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === 'statblock') blocks.splice(i, 1);
        const sb = newBlock('statblock');
        Object.assign(sb.content, p.statblock, { show: {} });
        blocks.push(sb);
        const plain = (label, text) => {
          if (!text || !text.trim()) return;
          const b = newBlock('paragraph');
          const safe = text.split('\n').filter(x => x.trim()).map(esc).join('<br>');
          b.content = { html: `<b>${esc(label)}</b><br>${safe}`, text: `${label}\n${text}` };
          blocks.push(b);
        };
        // osobnost jako přehledný seznam
        const pe = p.personality || {};
        const persLines = [
          pe.traits && `<b>Povahové rysy:</b> ${esc(pe.traits).replace(/\n/g, ' ')}`,
          pe.ideals && `<b>Ideály:</b> ${esc(pe.ideals).replace(/\n/g, ' ')}`,
          pe.bonds && `<b>Pouta:</b> ${esc(pe.bonds).replace(/\n/g, ' ')}`,
          pe.flaws && `<b>Slabiny:</b> ${esc(pe.flaws).replace(/\n/g, ' ')}`
        ].filter(Boolean);
        if (persLines.length) {
          const b = newBlock('paragraph');
          b.content = { html: '<b>🎭 Osobnost</b><br>' + persLines.join('<br>'), text: persLines.join('\n').replace(/<[^>]+>/g, '') };
          blocks.push(b);
        }
        // Features & Traits jako přehledný seznam
        if (p.features && p.features.length) {
          const items = p.features.map(f => `<b>${esc(f.name)}.</b> ${esc(f.text).replace(/\n/g, ' ')}`).join('<br><br>');
          const b = newBlock('paragraph');
          b.content = { html: '<b>⚙️ Vlastnosti a rysy (Features &amp; Traits)</b><br>' + items, text: p.features.map(f => f.name + '. ' + f.text).join('\n\n') };
          blocks.push(b);
        }
        plain('👤 Vzhled', pe.appearance);
        plain('📖 Příběh', p.backstory);
        draw();
      } catch (e) { st.textContent = '✗ ' + e.message; }
    };
    // ruční vyplnění — přidá prázdnou kartu postavy, pokud ještě není
    const dcMan = $app.querySelector('#ddbcManual');
    if (dcMan) dcMan.onclick = () => {
      if (!blocks.some(b => b.type === 'statblock')) { blocks.push(newBlock('statblock')); }
      draw();
      $app.querySelector('#blocksWrap').scrollIntoView({ behavior: 'smooth', block: 'end' });
    };
    $app.querySelectorAll('[data-langcolor]').forEach(btn => btn.onclick = () => { a.langColor = btn.dataset.langcolor; draw(); });
    const lcc = $app.querySelector('#langColorCustom');
    if (lcc) lcc.onchange = () => { a.langColor = lcc.value; draw(); };
    // ---------- předmět: token, mřížka kontejneru, sběr polí až při uložení
    if (a.category === 'Předměty') {
      a.item = a.item || {};
      const tok = $app.querySelector('#iToken');
      if (tok) tok.onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try {
          const r = await uploadImage(file, file.name || 'token.png'); // bez ořezu — tokeny mívají průhlednost
          a.item.tokenImageId = r.id;
          $app.querySelector('#iTokenPrev').innerHTML = `<img src="${imgUrl(r.id)}" alt="">`;
        } catch (err) { alert(err.message); }
      };
      // klikací tvar tokenu (6×6): políčko zapnout/vypnout; velikost = počet políček
      const shapeEl = $app.querySelector('#iShapeGrid');
      const shapeSet = new Set(
        (a.item.shape && a.item.shape.length ? a.item.shape : (() => {
          const o = []; const w = a.item.w || 1, hh = a.item.h || 1;
          for (let x = 0; x < w; x++) for (let y = 0; y < hh; y++) o.push({ x, y });
          return o;
        })()).map(c => c.x + ',' + c.y));
      const drawShape = () => {
        if (!shapeEl) return;
        let html = '';
        for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++)
          html += `<div class="cg-cell ${shapeSet.has(x + ',' + y) ? 'on c-s' : ''}" data-x="${x}" data-y="${y}"></div>`;
        shapeEl.innerHTML = html;
        const cnt = $app.querySelector('#iShapeCount');
        if (cnt) cnt.textContent = shapeSet.size;
        shapeEl.querySelectorAll('.cg-cell').forEach(el2 => el2.onclick = () => {
          const k = el2.dataset.x + ',' + el2.dataset.y;
          if (shapeSet.has(k)) { if (shapeSet.size > 1) shapeSet.delete(k); } // aspoň jedno políčko musí zůstat
          else shapeSet.add(k);
          drawShape();
        });
      };
      drawShape();

      // klikací mřížka kontejneru (8×6): prázdné → g → y → r → prázdné
      const gridEl = $app.querySelector('#iContGrid');
      const cellMap = new Map(((a.item.container || {}).cells || []).map(c => [c.x + ',' + c.y, c.c]));
      const drawGrid = () => {
        if (!gridEl) return;
        let html = '';
        for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
          const c = cellMap.get(x + ',' + y);
          html += `<div class="cg-cell ${c ? 'on c-' + c : ''}" data-x="${x}" data-y="${y}"></div>`;
        }
        gridEl.innerHTML = html;
        gridEl.querySelectorAll('.cg-cell').forEach(el => el.onclick = () => {
          const k = el.dataset.x + ',' + el.dataset.y;
          const cur = cellMap.get(k);
          const next = !cur ? 'g' : cur === 'g' ? 'y' : cur === 'y' ? 'r' : null;
          if (next) cellMap.set(k, next); else cellMap.delete(k);
          drawGrid();
        });
      };
      drawGrid();
      const isCont = $app.querySelector('#iIsCont');
      if (isCont) isCont.onchange = () => { $app.querySelector('#iContWrap').style.display = isCont.checked ? '' : 'none'; };
      // ＋ nový slot rovnou z editoru — vytvoří se v kampani a hned se předvybere
      const slotNewBtn = $app.querySelector('#iSlotNew');
      if (slotNewBtn) slotNewBtn.onclick = () => invNewSlotDialog(null, null, (key, label) => {
        state.campaign.customSlots = [...(state.campaign.customSlots || []), { key, label, cap: 1 }];
        // pilulka do skupiny „Vlastní sloty“ (když neexistuje, založí se)
        let grp = [...$app.querySelectorAll('.slotgrp')].find(g => g.querySelector('.inv-group-label').textContent === 'Vlastní sloty');
        if (!grp) {
          const last = [...$app.querySelectorAll('.slotgrp')].pop();
          grp = h(`<div class="slotgrp" data-grp><div class="inv-group-label">Vlastní sloty</div><div class="pick-group"></div></div>`).firstElementChild;
          last.after(grp);
        }
        grp.querySelector('.pick-group').insertAdjacentHTML('beforeend', pill(`class="iSlot" value="${key}"`, esc(label), true));
        const nu = grp.querySelector(`.iSlot[value="${key}"]`);
        const anyEl2 = $app.querySelector('#iAnywhere');
        nu.addEventListener('change', () => { // stejná logika jako u ostatních pilulek
          if (!nu.checked && anyEl2 && anyEl2.checked) { anyEl2.checked = false; const l = anyEl2.closest('.pick-toggle'); if (l) l.classList.remove('on'); }
        });
        if (anyEl2 && anyEl2.checked) { anyEl2.checked = false; const l = anyEl2.closest('.pick-toggle'); if (l) l.classList.remove('on'); }
      });
      // hledání slotu: filtruje pilulky, prázdné oblasti se schovají
      const slotFilter = $app.querySelector('#iSlotFilter');
      if (slotFilter) slotFilter.oninput = () => {
        const q = slotFilter.value.trim().toLowerCase();
        $app.querySelectorAll('.slotgrp').forEach(grp => {
          let any = false;
          grp.querySelectorAll('.pick-toggle').forEach(p => {
            const hit = !q || p.textContent.toLowerCase().includes(q);
            p.style.display = hit ? '' : 'none';
            if (hit) any = true;
          });
          grp.style.display = any ? '' : 'none';
        });
      };
      // „Kamkoli“ a výběr konkrétních slotů se vylučují
      const anyEl = $app.querySelector('#iAnywhere');
      const syncPill = el => { const l = el.closest('.pick-toggle'); if (l) l.classList.toggle('on', el.checked); };
      if (anyEl) anyEl.addEventListener('change', () => {
        // Kamkoli = rychlé „označit vše“; při vypnutí se vše zase odznačí
        $app.querySelectorAll('.iSlot').forEach(x => { x.checked = anyEl.checked; syncPill(x); });
      });
      $app.querySelectorAll('.iSlot').forEach(x => x.addEventListener('change', () => {
        if (!x.checked && anyEl && anyEl.checked) { anyEl.checked = false; syncPill(anyEl); } // ruční výjimka vypne Kamkoli, zbytek zůstane
      }));
      // sběr všech polí předmětu do a.item (volá se před uložením)
      a._collectItem = () => {
        const g = id => $app.querySelector('#' + id);
        const chk = id => { const el = g(id); return el ? el.checked : false; };
        const val = (id, d) => { const el = g(id); return el ? el.value : d; };
        const cont = chk('iIsCont')
          ? { cells: [...cellMap.entries()].map(([k, c]) => { const [x, y] = k.split(','); return { x: +x, y: +y, c }; }) }
          : null;
        a.item = {
          ...a.item,
          weight: parseFloat(val('iWeight', 0)) || 0, price: val('iPrice', ''), rarity: val('iRarity', ''),
          shape: [...shapeSet].map(k => { const [x, y] = k.split(','); return { x: +x, y: +y }; }), // w/h dopočítá server z obálky
          hpMax: parseInt(val('iHpMax', 10), 10) || 10,
          // nositelnost plyne z výběru slotů: „Kamkoli“ NEBO aspoň jeden konkrétní slot
          wearable: chk('iAnywhere') || !![...$app.querySelectorAll('.iSlot:checked')].length,
          twoHanded: chk('iTwoHanded'),
          stackable: chk('iStackable'), stackMax: parseInt(val('iStackMax', 10), 10) || 10,
          noDrop: chk('iNoDrop'), identifiedDefault: chk('iIdentDef'),
          unidentifiedName: val('iUnident', ''), publicText: val('iPublic', ''), secretText: val('iSecret', ''),
          slots: chk('iAnywhere') ? [] : [...$app.querySelectorAll('.iSlot:checked')].map(x => x.value),
          container: cont && cont.cells.length ? cont : null
        };
      };
    }
    $app.querySelector('#saveArticle').onclick = async () => {
      try {
        if (!String(a.title).trim()) throw new Error('Zadejte název článku.');
        let saveId = aid;
        if (isNew) { // formulář vytvoří článek až při uložení
          const r = await api(`/api/campaigns/${state.campaign.id}/articles`, { method: 'POST', body: { title: a.title } });
          saveId = r.id;
        }
        // sběr metadat postavy z formuláře
        if (a.category === 'Hráčské postavy') {
          const g = id => { const el = $app.querySelector('#' + id); return el ? el.value : ''; };
          a.charMeta = { race: g('cmRace'), classes: g('cmClasses'), level: parseInt(g('cmLevel'), 10) || null, background: g('cmBackground'), alignment: g('cmAlignment') };
        }
        if (a.category === 'Předměty' && a._collectItem) a._collectItem();
        await api(`/api/articles/${saveId}`, {
          method: 'PUT',
          body: { title: a.title, description: a.description, category: a.category, tags: a.tags, coverImageId: a.coverImageId, coverThumbId: a.coverThumbId, coverWidth: a.coverWidth || 100, item: a.item || undefined, charMeta: a.charMeta || undefined, langColor: a.langColor || undefined, blocks }
        });
        // vlastník článku hráčské postavy (nepovinné) — vytvoří/změní/odebere propojenou postavu
        if (a.category === 'Hráčské postavy' && canEdit()) {
          const os = $app.querySelector('#cmOwner');
          const newOwner = os && os.value ? parseInt(os.value, 10) : null;
          if (newOwner !== ((a.character && a.character.userId) || null)) {
            await api(`/api/articles/${saveId}/owner`, { method: 'POST', body: { userId: newOwner } });
          }
        }
        if (a.character && canEdit()) { // jazyky postav nastavuje pouze DM
          const languages = [...$app.querySelectorAll('.charLang:checked')]
            .filter(c => !c.disabled).map(c => parseInt(c.value, 10));
          await api(`/api/characters/${a.character.id}`, { method: 'PUT', body: { languages } });
        }
        state.characters = await api(`/api/campaigns/${state.campaign.id}/characters`);
        location.hash = `#/c/${state.campaign.id}/a/${saveId}`;
      } catch (e) { $app.querySelector('#eError').textContent = e.message; }
    };
    [['eTitle', 'title'], ['eDesc', 'description'], ['eTags', 'tags']].forEach(([id, key]) => {
      const el = $app.querySelector('#' + id);
      el.oninput = () => { a[key] = el.value; };
    });
    const catSel = $app.querySelector('#eCat');
    if (catSel) catSel.onchange = async () => {
      if (catSel.value === '__new') {
        const name = (prompt('Název nové kategorie:') || '').trim();
        if (name) {
          await api(`/api/campaigns/${state.campaign.id}/category-list`, { method: 'POST', body: { name } });
          if (!categories.includes(name)) categories.push(name);
          a.category = name;
        }
      } else {
        a.category = catSel.value;
      }
      draw(); // překreslí i sekci parametrů předmětu
    };
  }

  function drawBlock(b, i) {
    const el = h(`<div class="editor-block">
      <div class="row">
        <span class="blocktype">${i + 1} · ${blockTypeLabel(b.type)}</span>
        <div style="flex:1"></div>
        ${canEdit() ? `<button class="small ghost icon" data-act="tpl" title="Uložit jako šablonu">🖫</button>` : ''}
        <button class="small secondary icon" data-act="up" title="Posunout výš">↑</button>
        <button class="small secondary icon" data-act="down" title="Posunout níž">↓</button>
        <button class="small ghost icon" data-act="del" title="Odstranit">✕</button>
      </div>
      <div data-role="fields"></div>
    </div>`).firstElementChild;
    const fw = el.querySelector('[data-role=fields]');
    fw.appendChild(blockFields(b, draw));
    fw.appendChild(blockVisControls(b, ownerMode));
    const tplBtn = el.querySelector('[data-act=tpl]');
    if (tplBtn) tplBtn.onclick = () => saveAsTemplate(b);
    el.querySelector('[data-act=del]').onclick = () => { blocks.splice(i, 1); draw(); };
    el.querySelector('[data-act=up]').onclick = () => { if (i > 0) { [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]]; draw(); } };
    el.querySelector('[data-act=down]').onclick = () => { if (i < blocks.length - 1) { [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]]; draw(); } };
    return el;
  }

  draw();
}

// ================================================================ NÁPOVĚDA
// POZOR: při každé změně funkcí aplikace aktualizuj i tento obsah!
const HELP_SECTIONS = [
  ['🚀', 'Začínáme — první kroky', `
    <p>Lore-ki je <b>znalostní wiki pro vaši kampaň</b>. Vypadá jako encyklopedie světa, ale má jednu zvláštnost: <b>každý v ní vidí jen to, co ví jeho postava</b>. Otevřete se spolubojovníkem tentýž článek o městě a on v něm může mít o dva odstavce míň — a vůbec o tom neví.</p>
    <h4>Jsem hráč, co mám dělat?</h4>
    <p>Přihlaste se jménem a heslem, které vám dal váš DM. Uvidíte seznam kampaní — klikněte na tu svoji. Vlevo je menu s články, nahoře vyhledávání, vlevo dole bublina 💬 chatu. Doporučujeme začít <b>🏠 O kampani</b> (úvod od DM) a svým článkem postavy v kategorii <b>Hráčské postavy</b> — ten patří vám a můžete si do něj psát.</p>
    <h4>Jsem DM, co mám dělat?</h4>
    <p>Zaregistrujte se, vytvořte kampaň (stanete se jejím DM), pak v <b>⚙️ Nastavení kampaně → 👥 Hráči a postavy</b> přidejte hráče a vytvořte jim postavy. Pak už jen pište články a u každého bloku určete, kdo ho uvidí.</p>
    <h4>Zlaté pravidlo</h4>
    <p>Než něco pustíte hráčům, zkontrolujte se přepínačem <b>Pohled</b> v horní liště — podívá se na web očima kterékoli postavy a uvidíte přesně to co ona. Je to nejrychlejší způsob, jak si ověřit, že jste omylem neprozradili víc, než jste chtěli.</p>`],

  ['🧩', 'Jak to celé funguje (přečtěte si to)', `
    <p>Tohle je jediná sekce, kterou opravdu potřebujete pochopit. Zbytek je pak už jen ovládání.</p>
    <h4>Článek se skládá z bloků</h4>
    <p>Článek není jeden kus textu, ale <b>stavebnice</b>: každý odstavec, obrázek nebo seznam je samostatný <b>blok</b>. A <b>u každého bloku zvlášť</b> se nastavuje, kdo ho uvidí. Proto může jeden článek „Hostinec U Tří seker“ obsahovat popis pro všechny, tajemství pro jednu postavu a poznámku jen pro DM — a každý si přečte svou verzi.</p>
    <h4>Oprávnění se týkají POSTAV, ne uživatelů</h4>
    <p>Tohle je nejčastější zádrhel. Nenastavujete „tohle uvidí Honza“, ale „tohle uvidí Baradir“. Když má Honza dvě postavy, <b>každá ví něco jiného</b> — a on sám vidí vždy jen to, co ví postava, za kterou se právě dívá (přepínač <b>Za</b> v liště). Co ví Baradir, neví Toruk, i když je hraje tentýž člověk.</p>
    <h4>Skrytý obsah k hráči vůbec nedorazí</h4>
    <p>Není to jen schované v prohlížeči. Server hráči skrytý text <b>vůbec neodešle</b> — není v datech stránky, nenajde se vyhledáváním, neobjeví se ve zdrojovém kódu. Ani zvídavý hráč se k němu nedostane.</p>
    <h4>Prázdný článek = neexistující článek</h4>
    <p>Hráč vidí článek jen tehdy, když v něm má <b>aspoň jeden viditelný blok</b>. Pokud ne, článek pro něj neexistuje — nevidí ho v seznamu, nenajde ho hledáním a přes přímý odkaz dostane „nenalezeno“. Nedozví se ani to, že nějaký takový článek je.</p>`],

  ['👁️', 'Viditelnost bloků — srdce aplikace', `
    <p>U každého bloku v editoru je rozbalovací pole s volbou:</p>
    <p><b>Všichni hráči</b> — vidí každý v kampani. Běžný popis světa.</p>
    <p><b>Pouze DM</b> — vidíte jen vy. Vaše zákulisní poznámky přímo v článku, kde je potřebujete.</p>
    <p><b>Vybrané postavy</b> — vyberete konkrétní postavy zlatými tlačítky. Ostatní blok neuvidí. Tlačítkem <b>„Vybrat všechny“</b> označíte celou družinu naráz.</p>
    <h4>Odemykání informací</h4>
    <p>Tohle je hlavní pracovní postup při hře. Napište rovnou celou pravdu o světě a schovejte ji. Jak se družina dozvídá věci, <b>přepínáte viditelnost bloků</b> z „Pouze DM“ na „Vybrané postavy“ nebo „Všichni“. Nemusíte nic přepisovat — jen odemykáte, co už je napsané. Když někdo něco zjistí sám, odemknete blok jen jemu.</p>
    <h4>Štítky u bloků</h4>
    <p>Když článek prohlížíte jako DM (nebo jako vlastník svého článku), u každého bloku svítí štítek <b>Všichni / Pouze DM / jména postav</b>. Hráči tyhle štítky nevidí — nepoznají, že tam něco skrytého vůbec je.</p>
    <h4>Poznámka DM</h4>
    <p>Zvláštní typ bloku, který je <b>vždy</b> jen pro DM. Nedá se nastavit jinak, takže se nemůže stát, že ho omylem odhalíte.</p>`],

  ['🎭', 'Postavy a přepínač „Za“', `
    <p>Postavu vám vytvoří DM. S ní vznikne i <b>její článek</b> v kategorii „Hráčské postavy“ — a ten <b>patří vám</b>: píšete si do něj backstory, nahráváte obrázky a sami určujete, kdo který blok uvidí. Můžete tak mít v článku tajemství, které nezná ani zbytek družiny.</p>
    <h4>Mám víc postav</h4>
    <p>Pak se <b>vždy díváte za právě jednu</b> — v liště je přepínač <b>Za</b>. Vše se řídí aktivní postavou: co vidíte v článcích, co najdete hledáním, který inventář, které jazyky, co čtete v chatu a pod jakým jménem píšete zprávy.</p>
    <p>V nabídce přepínače je <b>vyhledávací pole</b> (u delších seznamů) a u každé postavy <b>hvězdička ⭐</b> — tou si nastavíte <b>výchozí postavu</b>, za kterou se kampaň otevře po přihlášení. Platí na všech zařízeních.</p>
    <h4>Pozor na záměnu</h4>
    <p>Píšete-li do chatu nebo poznámku, jde to vždy za <b>aktivní</b> postavu. Než začnete psát, mrkněte, koho máte přepnutého.</p>`],

  ['📚', 'Články, kategorie a seznam', `
    <p>Článek má název, popis, kategorii, štítky (#), hlavní obrázek a obsah z bloků.</p>
    <h4>Zakládání a úpravy</h4>
    <p>Nový článek: tlačítko <b>＋ Nový článek</b> v seznamu. Vyplníte název, kategorii a metadata a uloží se až tlačítkem <b>Vytvořit článek</b>.</p>
    <p>Hotový článek jde upravovat <b>přímo v něm</b>: najeďte myší na blok a objeví se ✏️ (upravit), ↑ ↓ (posunout) a ✕ (odstranit). <b>Dvojklik</b> na blok ho rovnou otevře k úpravě. Tlačítko <b>+</b> mezi bloky vloží nový blok na to místo. Kompletní formulář se vším všudy je pod <b>✏️ Celý editor</b>.</p>
    <h4>Kategorie</h4>
    <p>Vlevo v menu jsou kategorie s počty článků a barevným puntíkem. Kategorie spravuje DM v <b>⚙️ Nastavení kampaně → 🏷️ Kategorie</b> — přidává, odebírá (články zůstanou, jen budou „Nezařazeno“) a mění jim barvu. Nová kategorie napsaná v editoru se do seznamu přidá sama.</p>
    <p>Šest kategorií je <b>systémových</b> a nejdou odebrat, protože mají zvláštní funkce: <b>Kampaň</b> (domovský článek), <b>Hráčské postavy</b>, <b>Předměty</b> (inventář), <b>Jazyk</b>, <b>NPC</b> a <b>Monstra</b> (import z D&D Beyond).</p>
    <h4>Filtry a náhledy</h4>
    <p>Nad seznamem je filtrování podle textu, kategorie a štítku. Vpravo si přepnete, kolik <b>náhledových obrázků</b> se u článků ukazuje. Článek bez obrázku dostane ikonku své kategorie v její barvě.</p>`],

  ['🧱', 'Typy bloků', `
    <p><b>Nadpis</b> — tři úrovně, člení delší článek.</p>
    <p><b>Odstavec</b> — základní text s formátováním (viz další sekce).</p>
    <p><b>Seznam</b> — odrážkový nebo číslovaný.</p>
    <p><b>Citace</b> — odsazený text, hodí se na výroky postav a úryvky z knih.</p>
    <p><b>Upozornění</b> — zvýrazněný rámeček ⚠️ na důležité informace.</p>
    <p><b>Oddělovač</b> — vodorovná čára.</p>
    <p><b>Obrázek</b> — s ořezem, popiskem, volbou šířky a zaškrtávátkem <b>„zobrazit v náhledu“</b> (pak se objeví v seznamu článků a galerii).</p>
    <p><b>Audio</b> — nahraný zvuk, přehraje se v článku.</p>
    <p><b>YouTube video</b> — vložíte odkaz, vyberete velikost, přehraje se přímo v článku.</p>
    <p><b>Příloha</b> — libovolný soubor (PDF, mapa…) ke stažení.</p>
    <p><b>Odkaz na článek</b> — proklik na jiný článek jako samostatný blok.</p>
    <p><b>Stat blok (5e)</b> — statistiky tvora v klasickém vzhledu. Jsou předpřipravené šablony (Goblin, Vlk, Kostlivec, Bandita, Zlobr, Mág) i vlastní položky. U dlouhých bloků se text sází do sloupců.</p>
    <p><b>Poznámka DM</b> — vždy jen pro DM.</p>
    <p class="muted">Kterýkoli blok si můžete uložit jako <b>šablonu</b> (🖫) a jinde ji vložit (📋).</p>`],

  ['✏️', 'Psaní a formátování textu', `
    <p>V textových blocích máte lištu a <b>kontextovou nabídku</b> (pravé tlačítko myši, na dotyku podržení prstu). V nabídce je vše podstatné pohromadě.</p>
    <h4>Formátování</h4>
    <p>Tučně, kurzíva, podtržení, velikost písma a <b>barva písma</b> (paleta s doporučenými barvami čitelnými v denním i nočním režimu, vlastní barva 🎨 a „Zrušit formátování“).</p>
    <h4>Obrázky přímo v textu</h4>
    <p>Vložíte je tlačítkem 🖼, <b>přetažením souboru</b> do textu nebo <b>ze schránky (Ctrl+V)</b> — třeba screenshot. Kliknutím na obrázek chytnete rohové táhlo pro změnu velikosti, pravé tlačítko nabídne pevné šířky (25–100 %) a odstranění.</p>
    <p>V nabídce obrázku je i <b>„☆ Zobrazit i v náhledech“</b> — obrázek se pak ukáže v seznamu článků a v galerii nahoře. Označený obrázek poznáte podle <b>zlatého rámečku</b> a hvězdičky ★ v rohu (hráči ji nevidí).</p>
    <h4>Další v nabídce</h4>
    <p><b>Spoiler</b> (▓), <b>cizí jazyk</b> (🌐), <b>reference na článek</b> (🔗) — každé má svou sekci níže.</p>`],

  ['🔗', 'Reference — odkazy mezi články', `
    <p>Označíte text a v nabídce zvolíte <b>🔗 Reference</b>; vyberete cílový článek. V textu z toho bude barevný štítek.</p>
    <p><b>Najetím myší</b> se ukáže bublina s krátkým náhledem cíle.</p>
    <p><b>Kliknutím</b> se článek otevře v <b>panelu vpravo</b> — stránka se rozdělí na tři části (menu | článek | reference) a vy neztratíte místo, kde jste četli. Tlačítkem <b>„↗ Přejít na stránku“</b> nahoře si ho otevřete přes celou obrazovku, ✕ panel zavře. Reference uvnitř panelu se otevírají zase v panelu, takže se dá řetězit.</p>
    <h4>A oprávnění?</h4>
    <p>Hráč, který na cílový článek nemá právo, <b>nedostane odkaz vůbec</b> — zbyde mu jen obyčejný text. Nepozná, že tam nějaký odkaz je. V bublině se případně objeví jen „🔒 K tomuto článku nemáte přístup“.</p>
    <p>Na konci každého článku je sekce <b>„🔁 Reference — odkazuje sem“</b> se zpětnými odkazy (jen z bloků, které smíte vidět).</p>`],

  ['🌐', 'Cizí jazyky', `
    <p>Jazyk je <b>článek v kategorii „Jazyk“</b> s vlastní unikátní barvou. „Běžný jazyk“ existuje automaticky a umí ho každý.</p>
    <h4>Jak se používá</h4>
    <p>Označíte text, v kontextové nabídce zvolíte <b>🌐 Označit jako cizí jazyk</b> a vyberete jazyk. Text zbarví do barvy jazyka a podtrhne se.</p>
    <h4>Co uvidí ostatní</h4>
    <p>Postava, která jazyk <b>ovládá</b>, čte text normálně. Postava, která ho <b>neovládá</b>, dostane <b>náhodné znaky stejné délky</b> — pozná tedy, že tam něco je a jak je to dlouhé, ale ne co. Původní text se k ní ze serveru vůbec nedostane, takže ho nevydoluje ani ze zdrojového kódu.</p>
    <p>Jakmile DM postavě jazyk přidělí, text se jí <b>okamžitě</b> zpřístupní — nemusí se nic přepisovat.</p>
    <h4>Kdo jazyky přiděluje</h4>
    <p>Pouze DM: v <b>Nastavení kampaně → 👥 Hráči a postavy</b> tlačítkem 🌐 u postavy, nebo přímo v editoru článku postavy. Jazyky, které postava umí, jsou vypsané na jejím článku.</p>
    <p>V chatu si jazyk zprávy vyberete barevnými tlačítky — psát můžete jen jazykem, který vaše postava <b>ovládá</b> (DM může kterýmkoli).</p>`],

  ['▓', 'Spoilery', `
    <p>Označte text a v nabídce zvolte <b>▓ Spoiler</b>. Čtenáři se text zobrazí <b>začerněný</b>. Po kliknutí dostane dotaz, jestli chce spoiler opravdu odkrýt — když odmítne, text zůstane skrytý.</p>
    <p>Hodí se na věci, které hráč <b>smí</b> vědět, ale možná nechce (dějové zvraty, obsah modulu). <b>Není to nástroj na utajení</b> — kdo klikne, uvidí. Na skutečné tajemství použijte viditelnost bloku.</p>`],

  ['📝', 'Poznámky ke článkům', `
    <p>Pod každým článkem si můžete připsat poznámku za svou postavu — co si zapamatovala, co ji napadlo.</p>
    <p>Zlatými tlačítky vyberete, <b>které postavy ji uvidí</b> (vy a DM vždycky). Tlačítko „Vybrat všechny“ označí celou družinu.</p>
    <p>Poznámka k <b>cizímu</b> článku postavy se zobrazí ostatním až po <b>schválení</b> — schvaluje ji DM nebo vlastník té postavy. Než ji schválí, vidíte ji jen vy a DM.</p>`],

  ['🎒', 'Grafický inventář', `
    <p>Položka <b>Inventář</b> v menu. Nahoře přepínáte mezi <b>svými postavami</b> a <b>zónami podlahy</b>; DM vidí postavy všech. Do cizího inventáře hráč nevidí.</p>
    <h4>Nákres postavy</h4>
    <p>Postava má sloty (hlava, trup, ruce, opasek, prsteny…). <b>Nositelné</b> předměty na ně přetáhnete myší nebo prstem — rozhoduje počet políček, ne tvar (štít 2×2 se do ruky vejde). <b>Obouruční</b> zbraň zabere obě ruce, druhá zešedne.</p>
    <h4>Předmět = konkrétní kus</h4>
    <p>Každý kus má <b>vlastní životy</b> (číslo na tokenu; hráč si je upravuje podle pokynů DM v detailu předmětu), stav <b>identifikace</b> a pozici. Na <b>0 životech</b> je předmět rozbitý (zšedne, ✕) — odstranit ho může vlastník nebo DM. Když kus předáte dál, jdou všechny tyto informace s ním.</p>
    <h4>Batohy a kapsy</h4>
    <p>Kontejner (batoh, brašna, opasek) nasazený na tělo zpřístupní svou <b>mřížku</b>. Tam záleží na tvaru tokenu — během tažení otočíte předmět klávesou <b>R</b>, položený předmět tlačítkem ⟳ v detailu. Barvy políček říkají, jak rychle se k předmětu ve hře dostanete: 🟢 volná akce, 🟡 akce, 🔴 celé kolo. Nenositelné předměty patří jen do kontejnerů a zón. Sundaný batoh si obsah nese s sebou; kontejnery do sebe nejdou vkládat.</p>
    <h4>Zóny podlahy a předávání</h4>
    <p>Zóny („Táborák“, „Jeskyně B“…) zakládá DM. Jsou <b>společné pro celou kampaň</b> — co tam kdo odloží, může si vzít kdokoli. Předání předmětu jinému hráči jde právě takto: odložit → on si vezme. Změny se všem projeví okamžitě. <b>📜 Deník přesunů</b> dole zaznamenává, kdo co odložil a vzal. Quest předměty se zaškrtnutím „nejde odhodit“ na zem položit nejdou.</p>
    <h4>Identifikace</h4>
    <p>Neidentifikovaný kus (žlutý otazník) ukazuje jen <b>obecný název</b> a veřejný popis — pravé jméno a tajné vlastnosti se odhalí, až identifikaci přepne DM (po použití svitku, zaplacení služby…).</p>
    <h4>Zakládání předmětů (DM)</h4>
    <p>Předmět je článek v kategorii <b>Předměty</b>. V editoru mu nastavíte <b>token</b> (obrázek s průhledností), velikost v políčkách, vlastnosti (nositelný, obouruční, stackovatelný, quest), max. životy, obecný název, veřejný a tajný popis — a u kontejnerů <b>naklikáte mřížku</b> včetně barev. Konkrétní kusy pak vytváříte tlačítkem <b>＋ Vytvořit předmět</b> v zóně a rozdáte je přetažením.</p>`],

  ['🗓', 'Herní sezení', `
    <p>Sezení je záznam jednoho hraní: název, datum a účastnící se postavy.</p>
    <h4>Scénář (jen DM)</h4>
    <p>Dvousloupcová příprava — vlevo scénář, vpravo poznámky. <b>Hráči ho nevidí nikdy</b>, ani náhodou.</p>
    <h4>Zápis DM</h4>
    <p>Skládá se z bloků a <b>u každého se nastavuje viditelnost</b> stejně jako v článku. Můžete tak sepsat, co se stalo, a část nechat jen pro sebe nebo pro konkrétní postavy.</p>
    <h4>Zápisy hráčů</h4>
    <p>Každý hráč si píše svůj zápis, taky po blocích s vlastní viditelností. Můžete tedy něco nechat jen pro sebe a DM.</p>
    <h4>Ukládání</h4>
    <p>Ukládá se <b>automaticky každou minutu</b>, ručně tlačítkem 💾 nebo <b>Ctrl+S</b>. Když byste odcházeli s neuloženými změnami, aplikace se zeptá.</p>
    <p>K sezení se dá přiřadit <b>chatovací místnost</b> — odkaz se pak objeví na stránce sezení.</p>`],

  ['💬', 'Chat', `
    <p>Bublina 💬 vlevo dole, číslo u ní jsou nepřečtené zprávy. Zprávy chodí <b>v reálném čase</b> a u cizí zprávy jemně pípne.</p>
    <p class="muted">Zvuk povolí prohlížeč až po prvním kliknutí do aplikace — to je jeho pravidlo, ne chyba.</p>
    <h4>Místnosti</h4>
    <p>Zakládá je <b>DM</b> a zve do nich <b>postavy</b> (ne uživatele). Kdo v místnosti není, o její existenci neví.</p>
    <h4>Šeptání</h4>
    <p>U pole <b>„Tajně“</b> vyberete zlatými tlačítky příjemce — jednu i víc postav. Hráč má navíc <b>„jen DM“</b> (zpráva jen pro vypravěče); to se s výběrem postav vylučuje.</p>
    <p><b>Důležité:</b> když postava šeptá jiné postavě, <b>DM to vidí taky</b> — je to jeho stůl. Proto je u zprávy značka <b>„(+ DM)“</b>, ať o tom všichni vědí. Pro <b>ostatní</b> jsou tajné zprávy zcela neviditelné — nepoznají ani, že nějaká padla.</p>
    <h4>Jazyky v chatu</h4>
    <p>Barevnými tlačítky zvolíte jazyk zprávy. Psát můžete jen jazykem, který vaše postava umí; kdo ho neumí, uvidí šifru.</p>
    <p>Mazat zprávy smí jen DM. Stavový pruh nad polem vždy ukazuje, čím a komu právě píšete.</p>`],

  ['🔍', 'Vyhledávání', `
    <p>Pole 🔍 v horní liště. Už <b>při psaní</b> (od dvou znaků) vyjede nabídka nalezených článků s ikonkou kategorie a úryvkem — kliknutím se článek rovnou otevře.</p>
    <p>Procházet se dá i <b>šipkami ↑/↓</b> a potvrdit Enterem, <b>Esc</b> nabídku zavře. <b>Enter</b> bez vybrané položky otevře stránku se všemi výsledky.</p>
    <p>Řadí se od nejtrefnějšího: nejdřív shody v <b>názvu</b>, pak v popisu a štítcích, nakonec v textu článku.</p>
    <p>Prohledává názvy, popisy, štítky i obsah bloků — ale <b>jen v rozsahu vašich oprávnění</b>. Skryté bloky, texty v neznámém jazyce ani cizí sezení se ve výsledcích neobjeví.</p>`],

  ['🕵️', 'Pohled — kontrola očima hráče (DM)', `
    <p>Přepínačem <b>Pohled</b> v horní liště se podíváte na celý web <b>očima kterékoli postavy</b> — články, seznamy, vyhledávání, obrázky, inventář, sezení, jazyky i chat. V nabídce jde postavu vyhledat podle jména. Zlatý pruh nahoře připomíná, čí pohled je aktivní; <b>„Ukončit náhled“</b> vás vrátí zpět.</p>
    <p><b>Používejte to.</b> Je to jediný spolehlivý způsob, jak si před hrou ověřit, že hráči vidí přesně to, co mají.</p>
    <h4>Pozor: v náhledu jednáte ZA postavu</h4>
    <p>Poznámky, zápisy a zprávy v chatu se v tomto režimu uloží <b>jejím jménem</b>. Je to záměr — hodí se na NPC — ale dejte si pozor, ať omylem nenapíšete něco za hráče.</p>`],

  ['⚙️', 'Nastavení kampaně (DM)', `
    <p>Vše kolem kampaně je na jednom místě, rozdělené na záložky. Hráči tuhle položku v menu nevidí.</p>
    <h4>⚙️ Obecné</h4>
    <p>Název, krátký popis a ikonka kampaně. Domovský článek (🏠 O kampani) se upravuje přímo v něm.</p>
    <h4>🧭 Navigace</h4>
    <p>Pořadí položek v levém menu — šipkami ↑/↓ a uložit. Platí pro celou kampaň, tedy i pro hráče. „Výchozí pořadí“ vrátí původní stav.</p>
    <h4>👥 Hráči a postavy</h4>
    <p>Vytvoření účtu hráči (jméno + heslo k předání), přidání už zaregistrovaného uživatele, změna hesla (🔑), odebrání z kampaně. U každého hráče spravujete postavy: <b>＋ postava</b> (nová, nebo přiřazení postavy bez vlastníka), <b>🌐 jazyky</b>, <b>⇄ předat</b> jinému hráči (vlastnictví článku i inventář jdou s ní) a <b>✕ odebrat</b>.</p>
    <h4>🏷️ Kategorie</h4>
    <p>Přidání, odebrání a barva kategorií.</p>`],

  ['🐉', 'Import z D&D Beyond (DM)', `
    <p>U článků v kategorii <b>Monstra</b> a <b>Hráčské postavy</b> je v editoru import.</p>
    <h4>Monstra</h4>
    <p>Vložte <b>odkaz</b> na monstrum — funguje pro volně dostupný obsah (základní sada / SRD). <b>Placený obsah nebo obsah za přihlášením</b> server načíst nedokáže, D&D Beyond ho vydá jen vašemu prohlížeči. Řešení: stat blok na stránce označte, zkopírujte (Ctrl+C) a vložte do pole <b>„Importovat z textu“</b> — tak projde i placený obsah.</p>
    <h4>Postavy</h4>
    <p>Vložte odkaz na postavu. Musí být na D&D Beyond nastavená jako <b>veřejná</b> (Character Privacy → Public). Naimportuje jméno, rasu, třídu, staty, features &amp; traits a příběh. <b>AC a HP jsou dopočítané — zkontrolujte je.</b> Nemáte odkaz? Tlačítko „Vyplnit ručně“ přidá prázdnou kartu.</p>`],

  ['🛡️', 'Administrace aplikace', `
    <p>Tlačítko na úvodní obrazovce se seznamem kampaní, chráněné <b>master heslem</b>. Odemčení platí jen pro vaši přihlášenou relaci.</p>
    <p>Umí: změnit <b>název a logo</b> aplikace (název se propíše i do záložky prohlížeče), zobrazit <b>všechny kampaně a uživatele</b> s rolemi, <b>exportovat zálohu</b> kampaně do souboru, <b>obnovit ze zálohy</b> jako novou kampaň, <b>smazat</b> kampaň a <b>vstoupit do kampaně jako další DM</b>.</p>
    <p class="muted">Master heslo se nastavuje mimo aplikaci — souborem <code>data/master-password.txt</code> nebo proměnnou <code>MASTER_PASSWORD</code>. Slouží i k obnově zapomenutého hesla na přihlašovací obrazovce.</p>`],

  ['💾', 'Zálohy a provoz', `
    <p><b>Zálohujte přes Administraci → export zálohy.</b> Vznikne JSON se vším včetně obrázků, který jde kdykoli naimportovat zpět jako novou kampaň. Dělejte to pravidelně, ideálně po každém sezení.</p>
    <p>Celá data žijí ve složce <code>data/</code> vedle serveru — dá se zálohovat i prostým zkopírováním. Při aktualizaci aplikace přepisujte jen programové soubory, <code>data/</code> nechte být.</p>
    <p><b>Restart serveru odhlásí přihlášené</b> — přihlášení je držené v paměti. Data zůstanou.</p>
    <p>Neupravujte tentýž článek ve dvou lidech naráz — kdo uloží druhý, přepíše toho prvního.</p>`],

  ['🖥️', 'Ovládání a drobnosti', `
    <p><b>Pravý horní roh:</b> zelená tečka s číslem = kolik lidí z kampaně je právě online (kliknutím jména), <b>?</b> = tato nápověda, <b>vaše jméno</b> = nabídka s přepnutím <b>denního/nočního režimu</b> a <b>Odhlásit</b>.</p>
    <p><b>Cesta pod lištou</b> (Kampaně / Kampaň / Sekce / Stránka) ukazuje, kde jste — každá část je proklikávací. Šipka ← vás vrátí zpět.</p>
    <p><b>Kontextová nabídka</b> (pravé tlačítko / podržení prstu) funguje v textu, na obrázcích i na blocích a schovává většinu funkcí.</p>
    <p><b>Klávesy:</b> Ctrl+S uloží sezení, Enter ve vyhledávání otevře výsledky, Esc zavírá nabídky.</p>
    <p><b>Zapomenuté heslo:</b> na přihlašovací obrazovce, potřebujete master heslo od správce.</p>
    <p><b>Mobil a tablet:</b> rozhraní se přizpůsobí, menu se schová pod ☰.</p>`],
];

function renderHelp() {
  const draw = (q = '') => {
    const query = q.trim().toLowerCase();
    const holder = $app.querySelector('#helpBody');
    const strip = html => h(`<div>${html}</div>`).textContent.toLowerCase();
    const hits = HELP_SECTIONS.filter(([icon, title, body]) =>
      !query || title.toLowerCase().includes(query) || strip(body).includes(query));
    holder.innerHTML = hits.map(([icon, title, body], i) => `
      <details class="session-seg" ${query || i === 0 ? 'open' : ''}>
        <summary>${icon} ${esc(title)}</summary>
        <div class="seg-body">${body}</div>
      </details>`).join('') || `<p class="muted">Nic nenalezeno — zkuste jiné slovo.</p>`;
    if (query) { // zvýraznění nalezeného textu (jen v textových uzlech)
      holder.querySelectorAll('.seg-body').forEach(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(n => {
          const idx = n.textContent.toLowerCase().indexOf(query);
          if (idx < 0) return;
          const span = document.createElement('span');
          span.innerHTML = esc(n.textContent).replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${esc(m)}</mark>`);
          n.replaceWith(span);
        });
      });
    }
  };
  shell(`
    <div class="pagehead"><h1>❓ Nápověda</h1></div>
    <input id="helpSearch" placeholder="🔍 Hledat v nápovědě… (např. jazyk, spoiler, inventář)" style="margin-bottom:14px">
    <div id="helpBody"></div>
  `, { active: 'help', noSidebar: !state.campaign });
  draw();
  const hs = $app.querySelector('#helpSearch');
  hs.oninput = () => draw(hs.value);
  hs.focus();
}

// ================================================================ CHAT (plovoucí panel vlevo dole)
const chat = { el: null, es: null, campId: null, identity: '', open: false, view: 'rooms', roomId: null, rooms: [], msgs: [], lastId: 0, secretDM: false, secretChars: [] };

function chatTeardown() {
  if (chat.es) { chat.es.close(); chat.es = null; }
  if (chat.el) { chat.el.remove(); chat.el = null; }
  chat.campId = null; chat.open = false; chat.view = 'rooms'; chat.roomId = null; chat.rooms = []; chat.msgs = [];
}

function chatInit() {
  if (!state.campaign || !state.me) { chatTeardown(); return; }
  const identity = `${state.campaign.id}:${state.viewAs || ''}:${state.viewChar || ''}`;
  if (chat.campId !== state.campaign.id) {
    chatTeardown();
    chat.campId = state.campaign.id;
    chatBuild();
    chatConnect();
  } else if (chat.identity !== identity) {
    // změna postavy/emulace = jiná identita → reset pohledu
    chat.view = 'rooms'; chat.roomId = null;
  }
  chat.identity = identity;
  chatLoadRooms();
}

function chatConnect() {
  try {
    chat.es = new EventSource(`/api/campaigns/${chat.campId}/chat/events`);
    chat.es.onmessage = (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch { }
      if (data.presence) { refreshOnline(); return; } // někdo se připojil/odpojil
      if (data.inv) { invOnPush(); return; } // změna inventáře → překreslit stránku Inventář
      if (data.roomId && chat.open && chat.view === 'room' && chat.roomId === data.roomId) {
        chatLoadNewMessages(); // zahraje zvuk, dorazí-li cizí zpráva
      } else {
        chatLoadRooms(true); // zvuk při nárůstu nepřečtených
      }
    };
  } catch { }
}

function chatBuild() {
  chat.el = h(`<div>
    <button class="chat-bubble" title="Chat" style="position:fixed">💬<span class="chat-badge" style="display:none">0</span></button>
    <div class="chat-panel" style="display:none"></div>
  </div>`).firstElementChild;
  document.body.appendChild(chat.el);
  chat.el.querySelector('.chat-bubble').onclick = () => {
    chat.open = !chat.open;
    chat.el.querySelector('.chat-panel').style.display = chat.open ? 'flex' : 'none';
    if (chat.open) chatRender();
  };
}

function chatBadge() {
  const total = chat.rooms.reduce((s, r) => s + (r.unread || 0), 0);
  const b = chat.el && chat.el.querySelector('.chat-badge');
  if (!b) return;
  b.style.display = total ? 'flex' : 'none';
  b.textContent = total > 99 ? '99+' : total;
}

async function chatLoadRooms(soundOnIncrease = false) {
  if (!chat.campId) return;
  const prev = chat.rooms.reduce((s, r) => s + (r.unread || 0), 0);
  try { chat.rooms = await api(`/api/campaigns/${chat.campId}/chat/rooms`); } catch { chat.rooms = []; }
  const now = chat.rooms.reduce((s, r) => s + (r.unread || 0), 0);
  if (soundOnIncrease && now > prev) chatPlaySound();
  chatBadge();
  if (chat.open && chat.view === 'rooms') chatRender();
}

async function chatOpenRoom(roomId) {
  chat.roomId = roomId; chat.view = 'room'; chat.open = true;
  chat.msgs = []; chat.lastId = 0; chat.secretDM = false; chat.secretChars = [];
  if (chat.el) chat.el.querySelector('.chat-panel').style.display = 'flex';
  try {
    chat.msgs = await api(`/api/chat/rooms/${roomId}/messages`);
    chat.lastId = chat.msgs.length ? Math.max(...chat.msgs.map(m => m.id)) : 0;
  } catch (e) { chat.msgs = []; }
  chatRender();
  chatLoadRooms(); // přepočet nepřečtených
}
window.chatOpenRoom = chatOpenRoom; // pro odkazy ze stránky sezení

async function chatLoadNewMessages() {
  if (chat.loading) { chat.pending = true; return; } // souběžné volání (odeslání + SSE ping)
  chat.loading = true;
  try {
    const fresh = await api(`/api/chat/rooms/${chat.roomId}/messages?after=${chat.lastId}`);
    const known = new Set(chat.msgs.map(m => m.id));
    const add = fresh.filter(m => !known.has(m.id)); // deduplikace podle id
    if (add.length) {
      chat.msgs.push(...add);
      chat.lastId = Math.max(...chat.msgs.map(m => m.id));
      if (add.some(m => !m.mine)) chatPlaySound(); // jemné pípnutí u cizí zprávy
      chatRender();
      chatLoadRooms();
    }
  } catch { }
  finally {
    chat.loading = false;
    if (chat.pending) { chat.pending = false; chatLoadNewMessages(); } // doběhne, co mezitím přišlo
  }
}

function chatMsgHTML(m, readonly = false) {
  const t = new Date(m.createdAt).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const text = m.lang
    ? `<span class="lang-text" style="color:${m.lang.color}" title="${esc(m.lang.title)}">${esc(m.text)}</span>`
    : esc(m.text);
  return `<div class="chat-msg ${m.mine ? 'mine' : ''}">
    <div class="meta">
      <span class="who ${m.dmAuthor ? 'dm' : ''}">${m.dmAuthor ? '📖 ' : '🎭 '}${esc(m.author)}</span>
      <span>${t}</span>
      ${m.secret ? `<span class="secret-tag">${esc(m.secret)}</span>` : ''}
      ${m.lang ? `<span style="color:${m.lang.color}">◈ ${esc(m.lang.title)}</span>` : ''}
      ${canEdit() && !readonly ? `<a href="javascript:void 0" data-delmsg="${m.id}" class="muted" title="Smazat zprávu">✕</a>` : ''}
    </div>
    <div class="bubble">${text}</div>
  </div>`;
}

function chatRender() {
  if (!chat.el) return;
  const panel = chat.el.querySelector('.chat-panel');
  const dm = canEdit();

  if (chat.view === 'rooms') {
    panel.innerHTML = `
      <div class="chat-head">💬 Chat <div style="flex:1"></div>
        ${dm ? `<button class="small secondary" data-k="new">＋ Místnost</button>` : ''}
        <button class="small ghost" data-k="min">✕</button>
      </div>
      <div class="chat-body">
        ${chat.rooms.length === 0 ? `<p class="muted" style="padding:8px">${dm ? 'Zatím žádné místnosti — založte první.' : 'Nejste v žádné chatovací místnosti.'}</p>` : ''}
        ${chat.rooms.map(r => `<button class="chat-room-item" data-room="${r.id}">
          <span>💬</span><span style="${r.unread ? 'font-weight:800' : ''}">${esc(r.name)}</span>
          ${r.unread ? `<span class="unread">${r.unread}</span>` : ''}
        </button>`).join('')}
      </div>`;
    panel.querySelector('[data-k=min]').onclick = () => { chat.open = false; panel.style.display = 'none'; };
    const nb = panel.querySelector('[data-k=new]');
    if (nb) nb.onclick = () => { chat.view = 'manage'; chat.roomId = null; chatRender(); };
    panel.querySelectorAll('[data-room]').forEach(b => b.onclick = () => chatOpenRoom(parseInt(b.dataset.room, 10)));
    return;
  }

  if (chat.view === 'manage') {
    chatRenderManage(panel);
    return;
  }

  // ---------- pohled do místnosti
  const room = chat.rooms.find(r => r.id === chat.roomId) || { name: 'Chat', characters: [] };
  panel.innerHTML = `
    <div class="chat-head">
      <button class="small ghost" data-k="back">←</button>
      <span style="overflow:hidden; text-overflow:ellipsis">💬 ${esc(room.name)}</span>
      <div style="flex:1"></div>
      ${dm ? `<button class="small ghost" data-k="edit" title="Nastavení místnosti">⚙️</button>` : ''}
      <button class="small ghost" data-k="min">✕</button>
    </div>
    <div class="chat-body" data-k="msgs">
      ${chat.msgs.map(chatMsgHTML).join('') || '<p class="muted" style="padding:8px">Zatím žádné zprávy.</p>'}
    </div>
    <div class="chat-composer">
      <div data-k="status"></div>
      <div class="row1">
        <input type="text" data-k="text" placeholder="Napište zprávu…" maxlength="4000">
        <button data-k="send">➤</button>
      </div>
      <div class="opts" data-k="langchips"></div>
      <div class="opts" data-k="secretchips"></div>
    </div>`;

  const body = panel.querySelector('[data-k=msgs]');
  // vždy odscrolovat na poslední zprávu (i po dokreslení layoutu / obrázků)
  const toBottom = () => { body.scrollTop = body.scrollHeight; };
  toBottom(); requestAnimationFrame(toBottom); setTimeout(toBottom, 60);
  panel.querySelector('[data-k=back]').onclick = () => { chat.view = 'rooms'; chatRender(); chatLoadRooms(); };
  panel.querySelector('[data-k=min]').onclick = () => { chat.open = false; panel.style.display = 'none'; };
  const eb = panel.querySelector('[data-k=edit]');
  if (eb) eb.onclick = () => { chat.view = 'manage'; chatRender(); };
  panel.querySelectorAll('[data-delmsg]').forEach(a => a.onclick = async () => {
    if (!await confirmDialog('Smazat zprávu?', { title: 'Smazat zprávu', ok: 'Smazat', danger: true })) return;
    await api(`/api/chat/messages/${a.dataset.delmsg}`, { method: 'DELETE' });
    chat.msgs = chat.msgs.filter(m => m.id !== parseInt(a.dataset.delmsg, 10));
    chatRender();
  });

  // ---------- composer: jazykové chipy (jen jazyky, které postava OVLÁDÁ) + toggle šeptání
  const input = panel.querySelector('[data-k=text]');
  const activeCharId = dm ? null : (state.viewChar || (state.characters.find(c => c.userId === state.me.id) || {}).id);
  const myChar = state.characters.find(c => c.id === activeCharId);
  const knownIds = dm ? state.languages.map(l => l.id)
    : (myChar && myChar.languages ? myChar.languages : state.languages.filter(l => l.common).map(l => l.id));
  const langs = state.languages.filter(l => knownIds.includes(l.id) || l.common);
  if (!chat.langId || !langs.some(l => l.id === chat.langId)) chat.langId = (state.languages.find(l => l.common) || { id: 0 }).id;

  const updateComposer = () => {
    const cur = state.languages.find(l => l.id === chat.langId) || {};
    const isCommon = !!cur.common;
    // stav: čím a komu píšu
    const names = chat.secretChars.map(id => (room.characters.find(c => c.id === id) || {}).name || '?');
    const secretLabel = names.length
      ? `Tajně pouze pro: ${names.join(', ')}${dm ? '' : ' (+ DM vidí vše)'}`
      : ((!dm && chat.secretDM) ? 'Tajně pouze pro DM' : null);
    panel.querySelector('[data-k=status]').innerHTML = (!isCommon || secretLabel) ? `<div class="compose-status" ${!isCommon ? `style="border-left-color:${cur.color}"` : ''}>
        ${!isCommon ? `<span class="cs-lang" style="color:${cur.color}">◈ Píšete jazykem: ${esc(cur.title)}</span>` : ''}
        ${secretLabel ? `<span class="cs-secret">🤫 ${esc(secretLabel)}</span>` : ''}
      </div>` : '';
    // zvýraznění vstupu barvou jazyka
    input.style.borderColor = isCommon ? '' : cur.color;
    input.style.color = isCommon ? '' : cur.color;
    input.style.textDecoration = isCommon ? '' : 'underline';
    // jazykové chipy (bez ikon, kompaktní)
    panel.querySelector('[data-k=langchips]').innerHTML = `<span class="opt-label">Jazyk</span>` +
      langs.map(l => `<button class="lang-chip ${chat.langId === l.id ? 'on' : ''}" data-langchip="${l.id}"
        style="--lc:${l.color}">${esc(l.title)}</button>`).join('');
    panel.querySelectorAll('[data-langchip]').forEach(b => b.onclick = () => { chat.langId = parseInt(b.dataset.langchip, 10); updateComposer(); input.focus(); });
    // toggle tlačítka příjemců šeptání (bez ikon) — hráč šeptá DM i ostatním postavám v místnosti
    const targets = room.characters.filter(c => dm || c.id !== activeCharId); // sám sobě nešeptám
    panel.querySelector('[data-k=secretchips]').innerHTML = `<span class="opt-label">Tajně</span>` +
      (dm ? '' : `<button class="secret-chip ${chat.secretDM ? 'on' : ''}" data-secretdm>jen DM</button>`) +
      targets.map(c => `<button class="secret-chip ${chat.secretChars.includes(c.id) ? 'on' : ''}" data-secretchip="${c.id}">${esc(c.name)}</button>`).join('');
    panel.querySelectorAll('[data-secretchip]').forEach(b => b.onclick = () => {
      const id = parseInt(b.dataset.secretchip, 10);
      chat.secretChars = chat.secretChars.includes(id) ? chat.secretChars.filter(x => x !== id) : [...chat.secretChars, id];
      if (chat.secretChars.length) chat.secretDM = false; // „jen DM" a šeptání postavám se vylučují
      updateComposer(); input.focus();
    });
    const sdm = panel.querySelector('[data-secretdm]');
    if (sdm) sdm.onclick = () => { chat.secretDM = !chat.secretDM; if (chat.secretDM) chat.secretChars = []; updateComposer(); input.focus(); };
  };
  updateComposer();

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    const secretTo = chat.secretChars.length ? chat.secretChars : ((!dm && chat.secretDM) ? 'dm' : null);
    try {
      await api(`/api/chat/rooms/${chat.roomId}/messages`, {
        method: 'POST', body: { text, langId: chat.langId, secretTo }
      });
      input.value = '';
      chatLoadNewMessages();
    } catch (e) { alert(e.message); }
  };
  panel.querySelector('[data-k=send]').onclick = send;
  input.onkeydown = e => { if (e.key === 'Enter') send(); };
  input.focus();
}

// jemný zvuk příchozí zprávy (WebAudio, bez souboru)
let chatAudio = null;
// Prohlížeč povolí přehrávání jen tehdy, vznikne-li/probudí-li se AudioContext při
// interakci uživatele. Zpráva ze SSE interakce NENÍ — proto zvuk odemkneme
// při prvním kliknutí/stisku klávesy kdekoli v aplikaci.
function chatAudioUnlock() {
  try {
    chatAudio = chatAudio || new (window.AudioContext || window.webkitAudioContext)();
    if (chatAudio.state === 'suspended') chatAudio.resume();
  } catch { }
}
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, chatAudioUnlock, { capture: true, passive: true }));

function chatPlaySound() {
  const beep = () => {
    // čas se čte AŽ po probuzení — u uspaného kontextu stojí a tóny by padly do minulosti
    const t = chatAudio.currentTime;
    [[660, 0], [880, 0.09]].forEach(([f, off]) => {
      const o = chatAudio.createOscillator(), g = chatAudio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.05, t + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.18);
      o.connect(g).connect(chatAudio.destination);
      o.start(t + off); o.stop(t + off + 0.2);
    });
  };
  try {
    chatAudioUnlock();
    if (!chatAudio) return;
    if (chatAudio.state === 'suspended') chatAudio.resume().then(beep).catch(() => { });
    else beep();
  } catch { }
}

async function chatRenderManage(panel) {
  const editing = chat.roomId ? chat.rooms.find(r => r.id === chat.roomId) : null;
  let sessions = [];
  try { sessions = await api(`/api/campaigns/${chat.campId}/sessions`); } catch { }
  panel.innerHTML = `
    <div class="chat-head">
      <button class="small ghost" data-k="back">←</button>
      ${editing ? '⚙️ Nastavení místnosti' : '＋ Nová místnost'}
      <div style="flex:1"></div>
      <button class="small ghost" data-k="min">✕</button>
    </div>
    <div class="chat-body">
      <label>Název místnosti</label>
      <input data-k="name" value="${esc(editing ? editing.name : '')}" placeholder="Např. U táboráku">
      <label>Pozvané postavy</label>
      ${pickGroup(state.characters.map(c => ({ id: c.id, label: c.name, sub: `(${c.username})`, checked: !!(editing && editing.characters.some(x => x.id === c.id)) })), 'chat-ch', { empty: '<span class="muted">Žádné postavy.</span>' })}
      <label>Přiřadit k sezením (volitelné)</label>
      ${pickGroup(sessions.map(s => ({ id: s.id, label: s.title, checked: !!(editing && (editing.sessionIds || []).includes(s.id)) })), 'chat-sess', { empty: '<span class="muted">Žádná sezení.</span>' })}
      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">
        <button data-k="save">💾 ${editing ? 'Uložit' : 'Vytvořit'}</button>
        ${editing ? `<button class="small danger" data-k="del">Smazat místnost</button>` : ''}
      </div>
      <div class="error" data-k="err"></div>
    </div>`;
  panel.querySelector('[data-k=back]').onclick = () => { chat.view = editing ? 'room' : 'rooms'; chatRender(); };
  panel.querySelector('[data-k=min]').onclick = () => { chat.open = false; panel.style.display = 'none'; };
  panel.querySelector('[data-k=save]').onclick = async () => {
    const body = {
      name: panel.querySelector('[data-k=name]').value,
      characters: [...panel.querySelectorAll('.chat-ch:checked')].map(c => parseInt(c.value, 10)),
      sessionIds: [...panel.querySelectorAll('.chat-sess:checked')].map(c => parseInt(c.value, 10))
    };
    try {
      if (editing) { await api(`/api/chat/rooms/${editing.id}`, { method: 'PUT', body }); }
      else { const r = await api(`/api/campaigns/${chat.campId}/chat/rooms`, { method: 'POST', body }); chat.roomId = r.id; }
      await chatLoadRooms();
      chatOpenRoom(chat.roomId);
    } catch (e) { panel.querySelector('[data-k=err]').textContent = e.message; }
  };
  const del = panel.querySelector('[data-k=del]');
  if (del) del.onclick = async () => {
    if (!await confirmDialog('Smazat místnost včetně všech zpráv?', { title: 'Smazat místnost', ok: 'Smazat', danger: true })) return;
    await api(`/api/chat/rooms/${editing.id}`, { method: 'DELETE' });
    chat.view = 'rooms'; chat.roomId = null;
    await chatLoadRooms(); chatRender();
  };
}

// ================================================================ INVENTÁŘ (grafický)
// Nákres postavy se sloty, mřížky kontejnerů, zóny podlahy. Drag&drop přes Pointer
// Events (funguje myší i dotykem). Server všechno validuje — klient jen kreslí a posílá.
const INV_SLOT_DEFS = { // systémové sloty (labels; nejdou smazat)
  head: { l: 'Hlava' }, torso: { l: 'Trup' }, cloak: { l: 'Plášť / toulec' },
  back: { l: 'Záda / batoh' }, handL: { l: 'Levá ruka' }, handR: { l: 'Pravá ruka' }
};
const invUI = { tab: null, chars: [], zones: [], items: [], charData: null, reloading: false };
/** Buňky tvaru položené na (X,Y) s otočením — zrcadlí server. */
function invPlacedCells(it, X, Y, rot) {
  const cells = (it.shape && it.shape.length) ? it.shape : (() => {
    const o = []; for (let x = 0; x < it.w; x++) for (let y = 0; y < it.h; y++) o.push({ x, y }); return o;
  })();
  return cells.map(c => rot ? { x: X + (it.h - 1 - c.y), y: Y + c.x } : { x: X + c.x, y: Y + c.y });
}
function INV_SLOT_LABEL_RO(key) { return (INV_SLOT_DEFS[key] || {}).l || key; }
function invSlotLabel(key) {
  if ((invUI.sysLabels || {})[key]) return invUI.sysLabels[key];
  if (INV_SLOT_DEFS[key]) return INV_SLOT_DEFS[key].l;
  const cs = [...(invUI.customSlots || []), ...((state.campaign && state.campaign.customSlots) || [])].find(s => s.key === key);
  return cs ? cs.label : key;
}

function invToast(msg) {
  document.querySelectorAll('.inv-toast').forEach(t => t.remove());
  const t = h(`<div class="inv-toast">${esc(msg)}</div>`).firstElementChild;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/** Token předmětu. cell = velikost políčka v px; fit = roztáhnout do rodiče (sloty na těle). */
function invTokenEl(it, cell, fit = false) {
  const w = it.rot ? it.h : it.w, h0 = it.rot ? it.w : it.h;
  const el = document.createElement('div');
  el.className = 'inv-token' + (it.broken ? ' broken' : '') + (it.stackable && it.qty > 1 ? ' stacked' : '');
  el.dataset.inst = it.id;
  if (it.articleId) el.dataset.art = it.articleId;
  if (it.stackable) el.dataset.stack = 1;
  el.title = it.name;
  if (!fit) { el.style.width = (w * cell) + 'px'; el.style.height = (h0 * cell) + 'px'; }
  // otočený obrázek dostane prohozené rozměry (jinak by se nejdřív vtěsnal do širokého boxu a zmenšil)
  const rotStyle = it.rot && !fit ? ` style="width:${h0 * cell}px; height:${w * cell}px"` : '';
  const img = it.tokenImageId
    ? `<img src="${imgUrl(it.tokenImageId)}" alt="" draggable="false" ${it.rot ? `class="rot90"${rotStyle}` : ''}>`
    : `<span class="inv-token-fallback">📦</span>`;
  el.innerHTML = `${img}
    ${!it.identified ? '<span class="tk-unident" title="Neidentifikováno">?</span>' : ''}
    ${it.stackable && it.qty > 1 ? `<span class="tk-qty">×${it.qty}</span>` : ''}
    ${it.broken ? '<span class="tk-broken">✕</span>' : ''}`;
  // tvarovaný token (kříž, L…): myš chytají jen skutečná políčka tvaru — prázdné rohy
  // obálky propustí kliknutí na předmět POD nimi (jinak by malý předmět v rohu nešel vzít)
  const cellsArr = it.shape && it.shape.length ? it.shape : null;
  if (!fit && cellsArr && cellsArr.length < it.w * it.h) {
    el.classList.add('shaped');
    for (const p of invPlacedCells(it, 0, 0, it.rot)) {
      const hit = document.createElement('div');
      hit.className = 'tk-hit';
      hit.style.left = (p.x * cell) + 'px'; hit.style.top = (p.y * cell) + 'px';
      hit.style.width = cell + 'px'; hit.style.height = cell + 'px';
      el.appendChild(hit);
    }
  }
  invAttachDrag(el, it);
  // pravé tlačítko: rychlé akce bez otevírání detailu
  el.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    const items = [{ icon: 'ℹ️', label: 'Podrobnosti', action: () => invDetail(it.id) }];
    if (it.loc && (it.loc.t === 'grid' || it.loc.t === 'zone') && !(it.w === 1 && it.h === 1))
      items.push({ icon: '⟳', label: 'Otočit', action: async () => { if (await invRotate(it)) invRefresh(); } });
    if (it.stackable && it.qty > 1)
      items.push({ icon: '✂️', label: 'Rozdělit stack…', action: async () => { if (await invSplitStack(it)) invRefresh(); } });
    // přesun rovnou z nabídky: nasadit do povoleného volného slotu, uložit do jiného kontejneru
    const chId = invUI.tab && invUI.tab[0] === 'c' ? +invUI.tab.slice(1) : null;
    const mv = async to => { try { await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to } }); invRefresh(); } catch (err) { invToast(err.message); } };
    if (it.wearable && chId) {
      const used = new Set((invUI.items || []).filter(i => i.id !== it.id && i.loc && i.loc.t === 'slot' && i.loc.charId === chId).map(i => i.loc.slot));
      const allowed = (it.slots && it.slots.length) ? it.slots : Object.keys(invUI.slotCaps || {});
      for (const key of allowed) {
        if (used.has(key)) continue;
        if (it.loc && it.loc.t === 'slot' && it.loc.charId === chId && it.loc.slot === key) continue;
        items.push({ icon: '🧍', label: `Nasadit: ${invSlotLabel(key)}`, action: () => mv({ t: 'slot', charId: chId, slot: key }) });
      }
    }
    if (!it.container) {
      const all = [...(invUI.items || []), ...(invUI.zoneItems || [])];
      const inCont = it.loc && it.loc.t === 'grid' ? it.loc.cId : -1;
      for (const cont of (invUI.items || []).filter(i => i.container && i.loc && i.loc.t === 'slot' && i.id !== inCont)) {
        const spot = invFindSpot(cont, all, it);
        if (!spot) continue;
        items.push({ icon: '🎒', label: `Do: ${cont.name}`, action: () => mv({ t: 'grid', cId: cont.id, x: spot.x, y: spot.y }) });
      }
    }
    for (const z of invUI.zones) {
      if (it.loc && it.loc.t === 'zone' && it.loc.zId === z.id) continue; // tam už leží
      items.push({
        icon: '📍', label: `Odložit: ${z.name}`, action: async () => {
          try { await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: { t: 'zone', zId: z.id } } }); invRefresh(); }
          catch (err) { invToast(err.message); }
        }
      });
    }
    openCtxMenu(e.clientX, e.clientY, items);
  });
  return el;
}

/** Zeleně/červeně označí všechny cíle podle toho, zda tam tažený předmět jde položit.
    Jen rychlá klientská předpověď — server má poslední slovo. */
function invMarkTargets(it, rot, offX = 0, offY = 0) {
  invClearMarks();
  const items = [...invUI.items, ...(invUI.zoneItems || [])];
  const caps = invUI.slotCaps || {};
  document.querySelectorAll('[data-drop-slot]').forEach(el => {
    const key = el.dataset.dropSlot, chId = +el.dataset.char;
    let ok = !!it.wearable
      && !(it.slots && it.slots.length && !it.slots.includes(key));
    if (ok && it.twoHanded && !['handR', 'handL'].includes(key)) ok = false;
    if (ok) {
      const other = key === 'handR' ? 'handL' : key === 'handL' ? 'handR' : null;
      const inOther = other && items.find(i => i.id !== it.id && i.loc && i.loc.t === 'slot' && i.loc.charId === chId && i.loc.slot === other);
      if (it.twoHanded && inOther) ok = false;
      if (inOther && inOther.twoHanded) ok = false;
    }
    el.classList.add(ok ? 'drop-can' : 'drop-no'); // obsazený slot zůstává zelený — vyřeší se výměnou
  });
  document.querySelectorAll('.contgrid').forEach(grid => {
    const first = grid.querySelector('[data-drop-cell]');
    if (!first) return;
    const cId = +first.dataset.c;
    const cont = items.find(i => i.id === cId);
    if (!cont || !cont.container || it.container || cont.id === it.id) {
      grid.querySelectorAll('[data-drop-cell]').forEach(c => c.classList.add('drop-no'));
      return;
    }
    const cells = new Set(cont.container.cells.map(c => c.x + ',' + c.y));
    const occupied = new Set();
    items.filter(i => i.id !== it.id && i.loc && i.loc.t === 'grid' && i.loc.cId === cId)
      .forEach(i => invPlacedCells(i, i.loc.x, i.loc.y, i.rot).forEach(c => occupied.add(c.x + ',' + c.y)));
    grid.querySelectorAll('[data-drop-cell]').forEach(c => {
      // buňka pod kurzorem = políčko, ZA KTERÉ předmět držím → kotva se odečítá
      const x = +c.dataset.x - offX, y = +c.dataset.y - offY;
      let ok = x >= 0 && y >= 0;
      if (ok) for (const p of invPlacedCells(it, x, y, rot)) {
        const k = p.x + ',' + p.y;
        if (!cells.has(k) || occupied.has(k)) { ok = false; break; }
      }
      c.classList.add(ok ? 'drop-can' : 'drop-no');
    });
  });
  document.querySelectorAll('[data-drop-zone]').forEach(el =>
    el.classList.add((it.noDrop && !canEdit()) ? 'drop-no' : 'drop-can'));
}
function invClearMarks() {
  document.querySelectorAll('.drop-can, .drop-no').forEach(x => x.classList.remove('drop-can', 'drop-no'));
}

/** Cíl pod ukazatelem při puštění tokenu. */
function invDropTarget(ev, dragging) {
  const els = document.elementsFromPoint(ev.clientX, ev.clientY);
  for (const el of els) {
    if (!el.closest) continue;
    if (el.classList && el.classList.contains('inv-ghost')) continue;
    const tok = el.closest('[data-inst]');
    if (tok && dragging.stackable && dragging.articleId && +tok.dataset.art === dragging.articleId && +tok.dataset.inst !== dragging.id)
      return { type: 'merge', into: +tok.dataset.inst, el: tok };
    if (tok && +tok.dataset.inst !== dragging.id) {
      const target = [...invUI.items, ...(invUI.zoneItems || [])].find(i => i.id === +tok.dataset.inst);
      // puštění na předmět ve SLOTU = výměna (starý jde na zem)
      if (target && target.loc && target.loc.t === 'slot' && dragging.wearable)
        return { type: 'swap', target, el: tok.closest('[data-drop-slot]') || tok };
      // puštění nad tokenem v MŘÍŽCE = spočítat buňku pod kurzorem — s kotvou a tvarem
      // se tam tažený předmět klidně může vejít (kříž do kříže), rozhodne server
      const grid = tok.closest('.contgrid');
      if (grid) {
        const first = grid.querySelector('[data-drop-cell]');
        if (first) {
          const r = grid.getBoundingClientRect();
          const cellPx = first.getBoundingClientRect().width || 54;
          const gx = Math.floor((ev.clientX - r.left) / cellPx);
          const gy = Math.floor((ev.clientY - r.top) / cellPx);
          return { type: 'move', to: { t: 'grid', cId: +first.dataset.c, x: gx, y: gy }, el: grid };
        }
      }
    }
    const cellEl = el.closest('[data-drop-cell]');
    if (cellEl) return { type: 'move', to: { t: 'grid', cId: +cellEl.dataset.c, x: +cellEl.dataset.x, y: +cellEl.dataset.y }, el: cellEl };
    const slotEl = el.closest('[data-drop-slot]');
    if (slotEl) return { type: 'move', to: { t: 'slot', charId: +slotEl.dataset.char, slot: slotEl.dataset.dropSlot }, el: slotEl };
    const zoneEl = el.closest('[data-drop-zone]');
    if (zoneEl) return { type: 'move', to: { t: 'zone', zId: +zoneEl.dataset.dropZone }, el: zoneEl };
    const takeEl = el.closest('[data-drop-take]');
    if (takeEl) return { type: 'take', charId: +takeEl.dataset.dropTake, el: takeEl };
  }
  return null;
}

/** Výběr zóny: 0 zón → chyba, 1 → rovnou, více → dialog. Vrátí id nebo null. */
function invPickZone(title = 'Kam odložit?') {
  const zs = invUI.zones || [];
  if (!zs.length) { invToast('Není kam odložit — žádná zóna podlahy neexistuje.'); return Promise.resolve(null); }
  if (zs.length === 1) return Promise.resolve(zs[0].id);
  return new Promise(resolve => {
    closeCtxMenu();
    const overlay = h(`<div class="modal-overlay"><div class="modal confirm-modal" role="dialog" aria-modal="true">
      <div class="confirm-head"><span class="confirm-icon">📍</span><h3>${esc(title)}</h3></div>
      <div class="zone-pick">${zs.map(z => `<button class="secondary" data-z="${z.id}">📍 ${esc(z.name)}</button>`).join('')}</div>
      <div class="confirm-actions"><button class="secondary" data-k="no">Zrušit</button></div>
    </div></div>`).firstElementChild;
    document.body.appendChild(overlay);
    const done = v => { overlay.remove(); resolve(v); };
    overlay.onclick = e => { if (e.target === overlay) done(null); };
    overlay.querySelector('[data-k=no]').onclick = () => done(null);
    overlay.querySelectorAll('[data-z]').forEach(b => b.onclick = () => done(+b.dataset.z));
  });
}

/** Rozdělení stacku: oddělená část zůstává v témže kontejneru, když je místo;
    jinak do zóny (u více zón s výběrem, bez zóny se rozdělit nedá). */
async function invSplitStack(it) {
  const v = await promptDialog(`Kolik kusů oddělit? (1–${it.qty - 1})`, { title: 'Rozdělit stack', icon: '✂️', ok: 'Rozdělit', type: 'number', value: '1', min: 1, max: it.qty - 1 });
  if (v === null) return false;
  const n = parseInt(v, 10);
  if (!n || n < 1 || n > it.qty - 1) { invToast('Neplatný počet.'); return false; }
  const split = async to => { await api(`/api/inv/instances/${it.id}/split`, { method: 'POST', body: { qty: n, to } }); return true; };
  // 1) volné místo v kontejneru, kde rozdělení probíhá
  if (it.loc && it.loc.t === 'grid') {
    const all = [...invUI.items, ...(invUI.zoneItems || [])];
    const cont = all.find(i => i.id === it.loc.cId);
    const spot = cont && invFindSpot(cont, all, { ...it, id: -1 });
    if (spot) {
      try { return await split({ t: 'grid', cId: cont.id, x: spot.x, y: spot.y }); }
      catch { /* server nesouhlasí → zkusí se zóna */ }
    }
  }
  // 2) leží-li v zóně, druhá část zůstane tam
  if (it.loc && it.loc.t === 'zone') {
    try { return await split({ t: 'zone', zId: it.loc.zId }); }
    catch (e) { invToast(e.message); return false; }
  }
  // 3) jinam se nevejde → zóna dle výběru
  const zId = await invPickZone('Kontejner je plný — kam s druhou částí?');
  if (zId === null) return false;
  try { return await split({ t: 'zone', zId }); }
  catch (e) { invToast(e.message); return false; }
}

/** Chytré otočení: na místě, a když se nevejde, najde jiné volné místo v témže kontejneru. */
async function invRotate(it) {
  const newRot = it.rot ? 0 : 1;
  try {
    await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: it.loc, rot: newRot } });
    return true;
  } catch (e) {
    if (it.loc && it.loc.t === 'grid') {
      const all = [...invUI.items, ...(invUI.zoneItems || [])];
      const cont = all.find(i => i.id === it.loc.cId);
      const spot = cont && invFindSpot(cont, all, it, newRot);
      if (spot) {
        try {
          await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: { t: 'grid', cId: cont.id, x: spot.x, y: spot.y }, rot: newRot } });
          return true;
        } catch (e2) { invToast(e2.message); return false; }
      }
    }
    invToast(e.message); return false;
  }
}

/** Výměna: cílový předmět jde na zem (do otevřené/první zóny), tažený na jeho slot. */
async function invSwap(it, target) {
  const zId = invUI.zoneOpen || (invUI.zones[0] && invUI.zones[0].id);
  if (!zId) { invToast('Není kam odložit — DM musí založit zónu podlahy.'); return false; }
  const slotLoc = target.loc;
  try { await api(`/api/inv/instances/${target.id}/move`, { method: 'PUT', body: { to: { t: 'zone', zId } } }); }
  catch (e) { invToast(e.message); return false; }
  try { await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: slotLoc } }); }
  catch (e) {
    // nový se do slotu nevešel → vrátit původní zpět, ať výměna nic nerozbije
    try { await api(`/api/inv/instances/${target.id}/move`, { method: 'PUT', body: { to: slotLoc } }); } catch { }
    invToast(e.message);
    return false;
  }
  return true;
}

/** „Vzít si“: najde na postavě první volné místo — nejdřív sloty, pak mřížky kontejnerů. */
async function invTakeToChar(it, chId) {
  let lastErr = null;
  let data;
  try { data = await api(`/api/inv/char/${chId}`); } catch (e) { invToast(e.message); return false; }
  const used = new Set(data.items.filter(i => i.loc && i.loc.t === 'slot').map(i => i.loc.slot));
  if (it.wearable) {
    const caps = data.slots || {};
    let order = ['handR', 'handL', 'back', 'cloak', 'torso', 'head',
      ...(data.customSlots || []).map(s => s.key)];
    if (it.slots && it.slots.length) order = order.filter(sl => it.slots.includes(sl)); // předmět s vyhrazenými sloty
    for (const slot of order.filter(sl => !used.has(sl) && caps[sl])) {
      try { await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: { t: 'slot', charId: chId, slot } } }); return true; }
      catch (e) { lastErr = e; } // např. obouruční pravidlo — zkusí se další slot
    }
  }
  if (!it.container) { // do mřížek nasazených kontejnerů (kontejner do mřížky nesmí)
    for (const cont of data.items.filter(i => i.container && i.loc && i.loc.t === 'slot')) {
      const spot = invFindSpot(cont, data.items, it);
      if (!spot) continue;
      try { await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: { t: 'grid', cId: cont.id, x: spot.x, y: spot.y }, rot: spot.rot } }); return true; }
      catch (e) { lastErr = e; }
    }
  }
  invToast(lastErr ? lastErr.message : 'Nikam se nevejde — uvolněte místo nebo použijte přesné přetažení.');
  return false;
}
/** Klientské hledání volného místa v mřížce (server stejně validuje znovu).
    forceRot: hledat jen pro dané otočení. */
function invFindSpot(cont, items, it, forceRot = null) {
  const cells = new Set((cont.container.cells || []).map(c => c.x + ',' + c.y));
  const occupied = new Set();
  items.filter(i => i.loc && i.loc.t === 'grid' && i.loc.cId === cont.id && i.id !== it.id)
    .forEach(i => invPlacedCells(i, i.loc.x, i.loc.y, i.rot).forEach(c => occupied.add(c.x + ',' + c.y)));
  const maxX = Math.max(...[...cells].map(k => +k.split(',')[0]), 0);
  const maxY = Math.max(...[...cells].map(k => +k.split(',')[1]), 0);
  for (const rot of (forceRot === null ? [0, 1] : [forceRot])) {
    for (let y = 0; y <= maxY; y++) for (let x = 0; x <= maxX; x++) {
      let ok = true;
      for (const p of invPlacedCells(it, x, y, rot)) {
        const k = p.x + ',' + p.y;
        if (!cells.has(k) || occupied.has(k)) { ok = false; break; }
      }
      if (ok) return { x, y, rot };
    }
    if (forceRot === null && it.w === it.h) break;
  }
  return null;
}

/** Drag&drop tokenu (pointer events = myš i dotyk). Klik bez tažení otevře detail. */
function invAttachDrag(el, it) {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    if (e.button) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false, ghost = null, rot = it.rot;
    const cell = 44;
    // které políčko tokenu držím (u vícepolíčkových předmětů určuje cíl přesunu)
    let offX = 0, offY = 0;
    {
      const r0 = el.getBoundingClientRect();
      const gw = it.rot ? it.h : it.w, gh = it.rot ? it.w : it.h;
      offX = Math.min(gw - 1, Math.max(0, Math.floor((e.clientX - r0.left) / (r0.width / gw))));
      offY = Math.min(gh - 1, Math.max(0, Math.floor((e.clientY - r0.top) / (r0.height / gh))));
    }
    const ghostSize = () => {
      const w = rot ? it.h : it.w, h0 = rot ? it.w : it.h;
      ghost.style.width = (w * cell) + 'px'; ghost.style.height = (h0 * cell) + 'px';
      // duch se drží prstu/kurzoru přesně za chycené políčko
      ghost.style.transform = `translate(${-(offX + 0.5) * cell}px, ${-(offY + 0.5) * cell}px)`;
      const img = ghost.querySelector('img');
      if (img) {
        img.classList.toggle('rot90', !!rot);
        if (rot) { img.style.width = (h0 * cell) + 'px'; img.style.height = (w * cell) + 'px'; }
        else { img.style.width = ''; img.style.height = ''; }
      }
      // obrys skutečného tvaru (u kříže je vidět kříž, ne jen obdélník obrázku)
      ghost.querySelectorAll('.ghost-cell').forEach(x => x.remove());
      for (const p of invPlacedCells(it, 0, 0, rot)) {
        const d = document.createElement('div');
        d.className = 'ghost-cell';
        d.style.left = (p.x * cell) + 'px'; d.style.top = (p.y * cell) + 'px';
        d.style.width = cell + 'px'; d.style.height = cell + 'px';
        ghost.appendChild(d);
      }
    };
    const clearHl = () => document.querySelectorAll('.drop-ok').forEach(x => x.classList.remove('drop-ok'));
    const onMove = ev => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 7) {
        moved = true;
        ghost = el.cloneNode(true);
        ghost.className = 'inv-token inv-ghost';
        document.body.appendChild(ghost);
        ghostSize();
        el.classList.add('drag-src');
        invMarkTargets(it, rot, offX, offY); // zeleně kam to jde, červeně kam ne
      }
      if (!moved) return;
      ghost.style.left = ev.pageX + 'px'; ghost.style.top = ev.pageY + 'px';
      clearHl();
      const t = invDropTarget(ev, it);
      if (t && t.el) t.el.classList.add('drop-ok');
    };
    const onKey = ev => { // R otočí token během tažení (desktop)
      if ((ev.key === 'r' || ev.key === 'R') && moved && !(it.w === 1 && it.h === 1)) {
        const gh = rot ? it.w : it.h; // výška před otočením
        [offX, offY] = [gh - 1 - offY, offX]; // kotva se otočí s předmětem
        rot = rot ? 0 : 1;
        ghostSize(); invMarkTargets(it, rot, offX, offY);
      }
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('keydown', onKey);
      clearHl(); invClearMarks();
      if (ghost) ghost.remove();
      el.classList.remove('drag-src');
    };
    const onUp = async ev => {
      const t = moved ? invDropTarget(ev, it) : null;
      cleanup();
      if (!moved) { invDetail(it.id); return; }
      if (!t) return;
      if (t.type === 'move' && t.to.t === 'grid') { t.to.x -= offX; t.to.y -= offY; } // kotva: cílová buňka = ta, za kterou držím
      try {
        if (t.type === 'merge') await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { mergeInto: t.into } });
        else if (t.type === 'take') { if (!await invTakeToChar(it, t.charId)) return; }
        else if (t.type === 'swap') { if (!await invSwap(it, t.target)) return; }
        else await api(`/api/inv/instances/${it.id}/move`, { method: 'PUT', body: { to: t.to, rot } });
        invRefresh();
      } catch (err) { invToast(err.message); }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
    document.addEventListener('keydown', onKey);
  });
}

/** Mřížka kontejneru: buňky s barvou zóny + tokeny uvnitř. */
function invContGridEl(cont, items, cell = null) {
  const cells = (cont.container && cont.container.cells) || [];
  const maxX = Math.max(...cells.map(c => c.x), 0), maxY = Math.max(...cells.map(c => c.y), 0);
  if (cell === null) cell = (maxY + 1 >= 4 || maxX + 1 >= 6) ? 42 : 54; // velké mřížky kompaktněji
  const wrap = document.createElement('div');
  wrap.className = 'contgrid';
  wrap.style.width = ((maxX + 1) * cell) + 'px';
  wrap.style.height = ((maxY + 1) * cell) + 'px';
  for (const c of cells) {
    const d = document.createElement('div');
    d.className = 'cg-cell on c-' + (c.c || 'g');
    d.dataset.c = cont.id; d.dataset.x = c.x; d.dataset.y = c.y;
    d.setAttribute('data-drop-cell', '1');
    d.style.left = (c.x * cell) + 'px'; d.style.top = (c.y * cell) + 'px';
    d.style.width = cell + 'px'; d.style.height = cell + 'px';
    wrap.appendChild(d);
  }
  for (const it of items.filter(i => i.loc && i.loc.t === 'grid' && i.loc.cId === cont.id)) {
    const tok = invTokenEl(it, cell);
    tok.style.position = 'absolute';
    tok.style.left = (it.loc.x * cell) + 'px'; tok.style.top = (it.loc.y * cell) + 'px';
    wrap.appendChild(tok);
  }
  return wrap;
}

async function renderInventory() {
  const cid = state.campaign.id;
  let chars = [], zones = [];
  try { [chars, zones] = await Promise.all([api(`/api/campaigns/${cid}/inv/chars`), api(`/api/campaigns/${cid}/inv/zones`)]); } catch { }
  invUI.chars = chars; invUI.zones = zones;
  const valid = invUI.tab && invUI.tab[0] === 'c' && chars.some(c => 'c' + c.id === invUI.tab);
  if (!valid) invUI.tab = chars.length ? 'c' + chars[0].id : null;
  if (invUI.zoneOpen && !zones.some(z => z.id === invUI.zoneOpen)) invUI.zoneOpen = null;
  const dm = canEdit();

  shell(`
    <div class="pagehead"><h1>🎒 Inventář</h1></div>
    <p class="muted" style="margin-top:-8px">Předměty přetahujte myší nebo prstem. Během tažení otočíte token klávesou <b>R</b>; kliknutím otevřete detail. Kliknutím na <b>📍 zónu</b> nahoře se podlaha otevře v pravém panelu — předměty pak přetahujete rovnou mezi zemí a postavou (na zem jde předmět pustit i na tlačítko zóny). Předání jinému hráči: odložte do zóny, on si vezme.</p>
    <div class="inv-tabs">
      <div class="inv-tabgrp"><span class="tabgrp-label">🎭 Postavy</span><div class="tabgrp-items">
        ${chars.map(c => `<button class="inv-tab ${invUI.tab === 'c' + c.id ? 'on' : ''}" data-tab="c${c.id}" data-drop-take="${c.id}">${esc(c.name)}</button>`).join('')}
      </div></div>
      <div class="inv-tabgrp"><span class="tabgrp-label">📍 Zóny podlahy</span><div class="tabgrp-items">
        ${zones.map(z => `<button class="inv-tab zone ${invUI.zoneOpen === z.id ? 'on' : ''}" data-zonebtn="${z.id}" data-drop-zone="${z.id}" title="Otevřít zónu v pravém panelu; předmět sem jde i přetáhnout">${esc(z.name)} <span class="count">${z.count}</span></button>`).join('')}
        ${dm ? `<button class="inv-tab ghostbtn" id="invZoneAdd" title="Nová zóna podlahy">＋ zóna</button>` : ''}
      </div></div>
    </div>
    <div id="invBody"><p class="muted">Načítám…</p></div>
    <details class="session-seg" style="margin-top:18px">
      <summary>📜 Deník přesunů</summary>
      <div class="seg-body" id="invLogBody"><p class="muted">Načte se po rozbalení…</p></div>
    </details>`,
    { active: 'inventory' });

  $app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { invUI.tab = b.dataset.tab; renderInventory(); });
  $app.querySelectorAll('[data-zonebtn]').forEach(b => b.onclick = () => {
    const z = +b.dataset.zonebtn;
    invUI.zoneOpen = invUI.zoneOpen === z ? null : z;
    if (invUI.zoneOpen) invZonePane(); else closeRefPane();
    renderInventoryTabsMark();
  });
  const za = $app.querySelector('#invZoneAdd');
  if (za) za.onclick = async () => {
    const name = await promptDialog('', { title: 'Nová zóna podlahy', icon: '📍', ok: 'Vytvořit', placeholder: 'Název zóny (např. Táborák)' });
    if (!name || !name.trim()) return;
    try { await api(`/api/campaigns/${cid}/inv/zones`, { method: 'POST', body: { name } }); renderInventory(); }
    catch (e) { invToast(e.message); }
  };
  const logSeg = $app.querySelector('.session-seg');
  logSeg.addEventListener('toggle', async () => {
    if (!logSeg.open) return;
    const rows = await api(`/api/campaigns/${cid}/inv/log`).catch(() => []);
    $app.querySelector('#invLogBody').innerHTML = rows.length
      ? rows.map(r => `<div class="invlog-row"><span class="muted">${fmtDate(r.ts)}</span> <b>${esc(r.who)}</b> ${esc(r.text)}</div>`).join('')
      : '<p class="muted">Zatím žádné záznamy.</p>';
  });
  await invDrawBody();
  if (invUI.zoneOpen) invZonePane();
}
/** Označení aktivní zóny v liště bez plného překreslení. */
function renderInventoryTabsMark() {
  document.querySelectorAll('[data-zonebtn]').forEach(b => b.classList.toggle('on', +b.dataset.zonebtn === invUI.zoneOpen));
}

/** Překreslí tělo stránky podle aktivní záložky (volá se i po SSE zprávě). */
async function invDrawBody() {
  const body = document.getElementById('invBody');
  if (!body) return;
  if (!invUI.tab) { body.innerHTML = '<p class="muted">Žádná postava — inventář se váže na postavy. Zóny podlahy otevřete tlačítky 📍 nahoře.</p>'; if (invUI.zoneOpen) invZonePane(); return; }
  {
    const dm = canEdit(); // používá tlačítko ＋ slot a mazání vlastních slotů
    const chId = +invUI.tab.slice(1);
    let data;
    try { data = await api(`/api/inv/char/${chId}`); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    invUI.items = data.items;
    body.innerHTML = '';
    invUI.slotCaps = data.slots; // sloučené kapacity (vestavěné + vlastní) — používá i „vzít si“
    invUI.customSlots = data.customSlots || [];
    invUI.sysLabels = Object.fromEntries((data.systemSlots || []).map(s => [s.key, s.label]));
    const doll = document.createElement('div');
    doll.className = 'inv-doll';
    const mkSlot = (key, label, cap, custom) => {
      const slot = document.createElement('div');
      // šířka i výška rostou s kapacitou — velikost slotu je vidět na první pohled
      slot.className = 'inv-slot2 cap' + Math.max(1, Math.min(4, cap));
      slot.dataset.dropSlot = key; slot.dataset.char = chId;
      slot.innerHTML = `<span class="sl-name" title="${esc(label)}${dm ? ' — pravé tlačítko: úpravy slotu' : ''}">${esc(label)}</span><div class="sl-body"></div>`;
      if (dm) slot.addEventListener('contextmenu', e => {
        if (e.target.closest('.inv-token')) return; // menu předmětu má přednost
        e.preventDefault(); e.stopPropagation();
        const col = (data.slotCols || {})[key] || (INV_SLOT_DEFS[key] ? 1 : 2);
        const items = [
          { icon: '✎', label: custom ? 'Upravit slot…' : 'Přesunout do jiné oblasti…', action: () => invNewSlotDialog(null, custom ? { key, label, col } : { key, label, col, builtin: true }) },
          { icon: '↑', label: 'Posunout výš', action: async () => { try { await api(`/api/campaigns/${state.campaign.id}/inv/slots/${key}`, { method: 'PUT', body: { move: 'up' } }); invDrawBody(); } catch (err) { invToast(err.message); } } },
          { icon: '↓', label: 'Posunout níž', action: async () => { try { await api(`/api/campaigns/${state.campaign.id}/inv/slots/${key}`, { method: 'PUT', body: { move: 'down' } }); invDrawBody(); } catch (err) { invToast(err.message); } } },
        ];
        if (custom) items.push({ icon: '✕', label: 'Smazat slot…', action: async () => {
          if (!await confirmDialog('Smazat slot pro celou kampaň? Musí být prázdný u všech postav.', { title: 'Smazat slot', ok: 'Smazat', danger: true })) return;
          try { await api(`/api/campaigns/${state.campaign.id}/inv/slots/${key}`, { method: 'DELETE' }); invDrawBody(); }
          catch (err) { invToast(err.message); }
        } });
        openCtxMenu(e.clientX, e.clientY, items);
      });
      const it = data.items.find(i => i.loc && i.loc.t === 'slot' && i.loc.charId === chId && i.loc.slot === key);
      if (it) { const tok = invTokenEl(it, 52, true); tok.classList.add('fit'); slot.querySelector('.sl-body').appendChild(tok); slot.classList.add('filled'); }
      return slot;
    };
    const custom = data.customSlots || [];
    const cols = data.slotCols || {};
    const order = data.slotOrder || [];
    const labelOf = key => (invUI.sysLabels || {})[key] || (INV_SLOT_DEFS[key] || {}).l || (custom.find(c => c.key === key) || {}).label || key;
    const isCustom = key => !INV_SLOT_DEFS[key];
    const colKeys = n => order.filter(k => (cols[k] || (INV_SLOT_DEFS[k] ? 1 : 2)) === n);
    const mkCol = (n, title) => {
      const col = document.createElement('div');
      col.className = 'inv-col2';
      col.innerHTML = `<div class="inv-group-label">${title}</div>`;
      const keys = colKeys(n);
      keys.forEach(key => col.appendChild(mkSlot(key, labelOf(key), 1, isCustom(key))));
      if (n === 2 && dm) {
        const add = document.createElement('button');
        add.className = 'inv-slot-add';
        add.textContent = '＋ slot';
        add.title = 'Nový slot postavy (platí pro všechny postavy v kampani)';
        add.onclick = () => invNewSlotDialog();
        col.appendChild(add);
      }
      return col;
    };
    doll.classList.add('two-col');
    doll.appendChild(mkCol(1, 'Systémové sloty'));
    doll.appendChild(mkCol(2, 'Vlastní sloty'));
    // obouruční zbraň v ruce → druhá ruka zašedne
    const hands = ['handR', 'handL'];
    for (const hd of hands) {
      const it = data.items.find(i => i.loc && i.loc.t === 'slot' && i.loc.slot === hd && i.twoHanded);
      if (it) {
        const other = doll.querySelector(`[data-drop-slot="${hands.find(x => x !== hd)}"]`);
        if (other) { other.classList.add('disabled'); other.removeAttribute('data-drop-slot'); other.title = 'Obouruční zbraň zabírá obě ruce'; }
      }
    }
    // nákres vlevo, kontejnery ve sloupci napravo
    const main = document.createElement('div');
    main.className = 'inv-main';
    main.appendChild(doll);
    const conts = data.items.filter(i => i.container && i.loc && i.loc.t === 'slot');
    if (conts.length) {
      const wrap = document.createElement('div');
      wrap.className = 'inv-conts';
      for (const cont of conts) {
        const box = document.createElement('div');
        box.className = 'inv-cont';
        // úzké kontejnery (toulec, váček) smí vedle sebe; široké mřížky dostanou vlastní řádek
        const cc = (cont.container && cont.container.cells) || [];
        const gw = Math.max(...cc.map(c => c.x), 0) + 1, gh = Math.max(...cc.map(c => c.y), 0) + 1;
        const px = gw * ((gh >= 4 || gw >= 6) ? 42 : 54);
        if (px >= 250) box.classList.add('wide');
        if (gh >= 3 && gw <= 2) box.classList.add('tall'); // toulec apod. — titulek svisle vlevo
        box.dataset.contbox = cont.id;
        box.innerHTML = `<div class="inv-cont-title">${esc(cont.name)} <span class="muted">(${esc(labelOf(cont.loc.slot))})</span></div>`;
        box.appendChild(invContGridEl(cont, data.items));
        wrap.appendChild(box);
      }
      main.appendChild(wrap);
    }
    body.appendChild(main);
    return;
  }

}
function renderInventoryTabsRefresh() { }

/** Zóna podlahy v pravém panelu (jako reference) — jde z ní táhnout rovnou do slotů. */
async function invZonePane() {
  const zId = invUI.zoneOpen;
  if (!zId) return;
  const cid = state.campaign.id;
  const dm = canEdit();
  const zone = invUI.zones.find(z => z.id === zId) || { name: 'Zóna' };
  let items = [];
  try { items = await api(`/api/inv/zones/${zId}/items`); } catch (e) { invToast(e.message); return; }
  if (invUI.zoneOpen !== zId) return; // mezitím zavřeno/přepnuto
  invUI.zoneItems = items;
  const el = refPaneEl(); if (!el) return;
  refPane.id = null;
  invUI.paneMode = 'zone';
  el.innerHTML = `
    <div class="refpane-head">
      <b>📍 ${esc(zone.name)}</b>
      <div style="flex:1"></div>
      ${dm ? `<button class="small" data-k="spawn" title="Vytvořit nový předmět v této zóně">＋ předmět</button>
              <button class="small danger" data-k="zdel" title="Smazat zónu (musí být prázdná)">🗑</button>` : ''}
      <button class="small ghost" data-k="close" title="Zavřít">✕</button>
    </div>
    <div class="refpane-body">
      <p class="muted" style="margin-top:0">Společná odkládací plocha. Předměty táhněte na nákres postavy vlevo, nebo sem.</p>
      <div class="inv-zonearea pane" data-drop-zone="${zId}"></div>
    </div>`;
  const area = el.querySelector('.inv-zonearea');
  if (!items.length) area.innerHTML = '<p class="muted" style="padding:12px">Prázdno.</p>';
  for (const it of items) area.appendChild(invTokenEl(it, 44));
  el.querySelector('[data-k=close]').onclick = () => { invUI.zoneOpen = null; invUI.paneMode = null; closeRefPane(); renderInventoryTabsMark(); };
  const sp = el.querySelector('[data-k=spawn]');
  if (sp) sp.onclick = () => pickArticle(async art => {
    try { await api(`/api/campaigns/${cid}/inv/instances`, { method: 'POST', body: { articleId: art.id, to: { t: 'zone', zId } } }); invZonePane(); }
    catch (e) { invToast(e.message); }
  }, { category: 'Předměty' });
  const zd = el.querySelector('[data-k=zdel]');
  if (zd) zd.onclick = async () => {
    const n = (invUI.zoneItems || []).length;
    const msg = n
      ? `V zóně ${n === 1 ? 'leží 1 předmět' : n < 5 ? `leží ${n} předměty` : `leží ${n} předmětů`} — smažou se NENÁVRATNĚ spolu s ní (včetně obsahu batohů).`
      : 'Zóna je prázdná, jen se odstraní.';
    if (!await confirmDialog(msg, { title: 'Smazat zónu', ok: n ? 'Smazat i s předměty' : 'Smazat', danger: true })) return;
    try { await api(`/api/inv/zones/${zId}${n ? '?force=1' : ''}`, { method: 'DELETE' }); invUI.zoneOpen = null; invUI.paneMode = null; renderInventory(); }
    catch (e) { invToast(e.message); }
  };
}


/** Detail předmětu v pravém panelu (stejný vzor jako reference). */
async function invDetail(instId) {
  const it = invUI.items.find(i => i.id === instId) || (invUI.zoneItems || []).find(i => i.id === instId);
  if (!it) return;
  const el = refPaneEl(); if (!el) return;
  refPane.id = null; // panel teď patří inventáři
  invUI.paneMode = 'detail';
  // vybraný kontejner zvýraznit v layoutu
  document.querySelectorAll('[data-contbox]').forEach(b => b.classList.toggle('sel', it.container && +b.dataset.contbox === it.id));
  // obsah kontejneru pro výpis v detailu
  const contents = it.container
    ? [...invUI.items, ...(invUI.zoneItems || [])].filter(i => i.loc && i.loc.t === 'grid' && i.loc.cId === it.id)
    : [];
  const dm = canEdit();
  const fromZone = it.loc && it.loc.t === 'zone' && invUI.zoneOpen === it.loc.zId;
  const zoneBack = fromZone && invUI.zones.find(z => z.id === invUI.zoneOpen);
  el.innerHTML = `
    <div class="refpane-head">
      ${zoneBack ? `<button class="small ghost" data-k="back" title="Zpět na zónu">← 📍 ${esc(zoneBack.name)}</button>` : ''}
      <div style="flex:1"></div>
      <button class="small ghost" data-k="close" title="Zavřít">✕</button>
    </div>
    <div class="refpane-body">
      <div class="invd-imgwrap">${it.tokenImageId ? `<img class="invd-img" src="${imgUrl(it.tokenImageId)}" alt="">` : '<div class="invd-img invd-noimg">📦</div>'}</div>
      <h2 class="refpane-title">${esc(it.name)} ${!it.identified ? '<span class="tag" title="Neidentifikováno">❓ neidentifikováno</span>' : ''} ${it.broken ? '<span class="tag" style="color:var(--danger)">rozbitý</span>' : ''}</h2>
      ${it.publicText ? `<p>${esc(it.publicText)}</p>` : ''}
      <p class="invd-meta">
        <b>Velikost:</b> ${it.w} × ${it.h} (${it.w * it.h} ${it.w * it.h === 1 ? 'políčko' : it.w * it.h < 5 ? 'políčka' : 'políček'})<br>
        <b>Lze nasadit:</b> ${!it.wearable ? 'nejde nosit — patří do batohů, kapes a na zem'
    : (!it.slots || !it.slots.length) ? 'kamkoli, kam se vejde'
      : esc(it.slots.map(invSlotLabel).join(', '))}
        ${it.twoHanded ? '<br><b>Obouruční</b> — zabere obě ruce' : ''}
      </p>
      ${it.secretText ? `<div class="invd-secret"><b>🔮 Odhalené vlastnosti</b><br>${esc(it.secretText)}</div>` : ''}
      ${it.stackable ? `
      <div class="invd-hp">
        <b>🗃 Ve stacku</b>
        <button class="small secondary" data-k="qtym" ${it.qty <= 1 ? 'disabled' : ''}>−</button>
        <span class="invd-hpval">${it.qty} ks</span>
        <button class="small secondary" data-k="qtyp">＋</button>
        ${it.qty > 1 ? `<button class="small secondary" data-k="split" style="margin-left:8px">Rozdělit…</button>` : ''}
      </div>` : `
      <div class="invd-hp">
        <b>Životy</b>
        <button class="small secondary" data-k="hpm" ${it.hp <= 0 ? 'disabled' : ''}>−</button>
        <span class="invd-hpval ${it.hp <= 3 ? 'low' : ''}">${it.hp} / ${it.hpMax}</span>
        <button class="small secondary" data-k="hpp" ${it.hp >= it.hpMax ? 'disabled' : ''}>＋</button>
        ${dm ? `<label style="margin:0 0 0 10px">max</label><input data-k="hpmax" type="number" min="1" max="10" value="${it.hpMax}" style="width:64px">` : ''}
      </div>`}
      <div class="toolbar" style="margin:14px 0 0">
        ${it.loc && it.loc.t === 'zone' ? `<div class="invd-takes" title="Vzít si — kliknutím na postavu">${invUI.chars.map(c => `<button class="small" data-take="${c.id}" title="Vzít si (${esc(c.name)})">🫳 ${esc(c.name)}</button>`).join('')}</div>` : ''}
        ${it.loc && (it.loc.t === 'grid' || it.loc.t === 'zone') && !(it.w === 1 && it.h === 1) ? `<button class="small secondary" data-k="rot">⟳ Otočit</button>` : ''}
        ${dm ? `<button class="small secondary" data-k="ident">${it.identified ? '🔒 Zrušit identifikaci' : '🔓 Identifikovat'}</button>` : ''}
        ${(dm || it.broken) ? `<button class="small danger" data-k="del">Odstranit předmět</button>` : ''}
        ${it.articleId ? `<a href="#/c/${state.campaign.id}/a/${it.articleId}"><button class="small ghost">📄 Článek předmětu</button></a>` : ''}
      </div>
      ${it.noDrop ? '<p class="muted" style="margin-top:10px">📌 Tento předmět nejde odhodit na zem.</p>' : ''}
      <div data-k="artbox" class="invd-art"></div>
      ${it.container ? `
      <h3 style="margin:16px 0 6px">🎒 Obsah</h3>
      ${contents.length ? contents.map(c => `<div class="invd-contitem" data-open-inst="${c.id}">
        ${c.tokenImageId ? `<img src="${imgUrl(c.tokenImageId)}" alt="">` : '<span>📦</span>'}
        <span>${esc(c.name)}</span>${c.stackable && c.qty > 1 ? `<span class="tag">×${c.qty}</span>` : ''}
      </div>`).join('') : '<p class="muted">Prázdný.</p>'}` : ''}
    </div>`;
  // obsah článku předmětu (bloky filtruje server podle práv postavy)
  const artBox = el.querySelector('[data-k=artbox]');
  if (it.articleId && artBox) {
    api(`/api/articles/${it.articleId}`).then(a => {
      if (!a.blocks.length && !a.description) return;
      artBox.innerHTML = `<hr class="block-divider">
        ${a.description ? `<p class="muted">${esc(a.description)}</p>` : ''}
        ${a.blocks.map(b => renderBlockHTML(b, a.owned)).join('')}`;
    }).catch(() => { });
  }
  // zavření detailu se vrací do panelu zóny (pokud byl otevřený)
  const back = () => {
    document.querySelectorAll('[data-contbox].sel').forEach(b => b.classList.remove('sel'));
    invUI.paneMode = null;
    if (invUI.zoneOpen) invZonePane(); else closeRefPane();
  };
  const done = () => { invRefresh(); back(); };
  el.querySelector('[data-k=close]').onclick = back;
  const bk = el.querySelector('[data-k=back]');
  if (bk) bk.onclick = back;
  el.querySelectorAll('[data-open-inst]').forEach(r => r.onclick = () => invDetail(+r.dataset.openInst));
  el.querySelectorAll('[data-take]').forEach(b => b.onclick = async () => {
    if (await invTakeToChar(it, +b.dataset.take)) done();
  });
  const hpSet = async hp => {
    try { await api(`/api/inv/instances/${it.id}`, { method: 'PUT', body: { hp } }); invRefresh(); invDetailReload(it.id); }
    catch (e) { invToast(e.message); }
  };
  const q = k => el.querySelector(`[data-k=${k}]`);
  if (q('hpm')) q('hpm').onclick = () => hpSet(it.hp - 1);
  if (q('hpp')) q('hpp').onclick = () => hpSet(it.hp + 1);
  const qtySet = async qty => {
    try { await api(`/api/inv/instances/${it.id}`, { method: 'PUT', body: { qty } }); invRefresh(); invDetailReload(it.id); }
    catch (e) { invToast(e.message); }
  };
  if (q('qtym')) q('qtym').onclick = () => qtySet(it.qty - 1);
  if (q('qtyp')) q('qtyp').onclick = () => qtySet(it.qty + 1);
  if (q('hpmax')) q('hpmax').onchange = async () => {
    try { await api(`/api/inv/instances/${it.id}`, { method: 'PUT', body: { hpMax: parseInt(q('hpmax').value, 10) } }); invRefresh(); invDetailReload(it.id); }
    catch (e) { invToast(e.message); }
  };
  if (q('ident')) q('ident').onclick = async () => {
    try { await api(`/api/inv/instances/${it.id}`, { method: 'PUT', body: { identified: !it.identified } }); invRefresh(); invDetailReload(it.id); }
    catch (e) { invToast(e.message); }
  };
  if (q('rot')) q('rot').onclick = async () => { if (await invRotate(it)) { invRefresh(); invDetailReload(it.id); } };
  if (q('split')) q('split').onclick = async () => { if (await invSplitStack(it)) done(); };
  if (q('del')) q('del').onclick = async () => {
    if (!await confirmDialog('Předmět bude nenávratně odstraněn.', { title: 'Odstranit předmět', ok: 'Odstranit', danger: true })) return;
    try { await api(`/api/inv/instances/${it.id}`, { method: 'DELETE' }); done(); }
    catch (e) { invToast(e.message); }
  };
}
/** Po změně načte čerstvá data instance a překreslí detail. */
async function invDetailReload(instId) {
  // items se překreslily — počkat na ně a znovu otevřít detail
  setTimeout(() => {
    if (invUI.items.some(i => i.id === instId) || (invUI.zoneItems || []).some(i => i.id === instId)) invDetail(instId);
  }, 200);
}
/** Dialog pro nový slot postavy: název, velikost, umístění (existující nebo nová oblast). */
function invNewSlotDialog(_unused, edit = null, onCreated = null) {
  const overlay = h(`<div class="modal-overlay"><div class="modal">
    <h3 style="margin:0 0 10px">${edit ? (edit.builtin ? '✎ Přesunout slot' : '✎ Upravit slot') : '＋ Nový slot postavy'}</h3>
    <p class="muted" style="margin-top:0">${edit ? 'Změna platí pro všechny postavy v kampani.' : 'Slot se objeví u <b>všech postav v kampani</b>.'}${edit && edit.builtin ? ' Systémový slot jde jen přesunout (sloupec, pořadí šipkami na nákresu).' : ''}</p>
    <label>Název slotu</label>
    <input data-k="name" placeholder="např. Prsten" value="${edit ? esc(edit.label) : ''}" ${edit && edit.builtin ? 'disabled' : ''}>
    <label>Sloupec</label>
    <select data-k="col" style="width:auto">
      <option value="1" ${edit && edit.col === 1 ? 'selected' : ''}>Levý (systémové)</option>
      <option value="2" ${!edit || edit.col !== 1 ? 'selected' : ''}>Pravý (vlastní)</option>
    </select>
    <div style="margin-top:14px; display:flex; gap:8px">
      <button data-k="save">${edit ? 'Uložit změny' : 'Vytvořit slot'}</button>
      <button class="ghost" data-k="cancel">Zrušit</button>
    </div>
    <div class="error" data-k="err"></div>
  </div></div>`).firstElementChild;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const q = k => overlay.querySelector(`[data-k=${k}]`);
  q('cancel').onclick = () => overlay.remove();
  q('save').onclick = async () => {
    const label = q('name').value.trim();
    if (!edit && !label) { q('err').textContent = 'Zadejte název slotu.'; return; }
    const col = parseInt(q('col').value, 10);
    try {
      if (edit) {
        const body = edit.builtin ? { col } : { label, col };
        await api(`/api/campaigns/${state.campaign.id}/inv/slots/${edit.key}`, { method: 'PUT', body });
      } else {
        const r = await api(`/api/campaigns/${state.campaign.id}/inv/slots`, { method: 'POST', body: { label, col } });
        if (onCreated) { overlay.remove(); onCreated(r.key, label); return; }
      }
      overlay.remove(); invDrawBody();
    } catch (e) { q('err').textContent = e.message; }
  };
  setTimeout(() => { if (!q('name').disabled) q('name').focus(); }, 30);
}

/** Překreslí tělo i otevřený panel zóny. */
function invRefresh() { invDrawBody(); if (invUI.zoneOpen) invZonePane(); }
/** SSE zpráva o změně inventáře → překreslit, pokud je stránka otevřená. */
let invPushTimer = null;
function invOnPush() {
  if (!location.hash.includes('/inventory')) return;
  clearTimeout(invPushTimer);
  invPushTimer = setTimeout(() => invRefresh(), 200);
}

// ---------------------------------------------------------------- start
route();

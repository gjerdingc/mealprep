'use strict';

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');
const THEMES = [
  ['mist', 'Tåke', 'Dempet grå med blågrønt'],
  ['haze', 'Dis', 'Litt mørkere grå med turkis'],
  ['slate', 'Skifer', 'Mørk grå med blågrønt'],
  ['', 'Automatisk', 'Følger telefonen eller PC-en'],
  ['light', 'Lys', 'Rolig og lys'],
  ['dark', 'Mørk', 'Behagelig om kvelden'],
  ['sun', 'Solskinn', 'Varm og fargerik'],
];
const COMMON_STAPLES = [
  ['Salt', 'Krydder'], ['Pepper', 'Krydder'], ['Paprikapulver', 'Krydder'], ['Spisskummen', 'Krydder'],
  ['Oregano', 'Krydder'], ['Kanel', 'Krydder'], ['Hvitløkspulver', 'Krydder'],
  ['Hvetemel', 'Bakevarer'], ['Sukker', 'Bakevarer'], ['Bakepulver', 'Bakevarer'],
  ['Melk', 'Kjøleskap'], ['Egg', 'Kjøleskap'], ['Smør', 'Kjøleskap'], ['Ost', 'Kjøleskap'],
  ['Brød', 'Brød og korn'], ['Ris', 'Brød og korn'], ['Pasta', 'Brød og korn'],
  ['Olivenolje', 'Hermetikk og glass'], ['Hermetiske tomater', 'Hermetikk og glass'], ['Buljongterninger', 'Hermetikk og glass'],
  ['Løk', 'Annet'], ['Hvitløk', 'Annet'], ['Poteter', 'Annet'],
];

let S = null;          // household state from /api/state
let weekStart = null;  // Monday of the week on screen
let weekPlan = {};     // date -> plan entry for the week on screen
let shopDays = 10;  // how many days ahead the shopping list covers
let pantryCategory = 'Annet';  // last category used when adding a staple

// ------------------------------------------------------------------ helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    showLogin();
    const err = new Error('Logg inn først');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not JSON */ }
    const err = new Error(typeof msg === 'string' ? msg : 'Noe gikk galt');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

/** Runs an action and shows a message instead of failing silently. */
async function run(fn) {
  try { return await fn(); } catch (e) { if (e.status !== 401) toast(e.message); }
}

const D = (s) => new Date(s + 'T12:00:00');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
const monday = (s) => addDays(s, -((D(s).getDay() + 6) % 7));
const fmtDay = (s) => D(s).toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'short' });
/** ISO week number, as used in Norway: weeks start on Monday, and week 1 holds the first Thursday. */
function weekNumber(s) {
  const d = D(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));  // Thursday of this week
  const jan4 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round((d - jan4) / 864e5 / 7 - (3 - ((jan4.getDay() + 6) % 7)) / 7);
}
const fmtShort = (s) => D(s).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });

function mins(n) {
  if (!n) return '';
  const hrs = Math.floor(n / 60), m = n % 60;
  return hrs ? `${hrs} t${m ? ` ${m} min` : ''}` : `${m} min`;
}

function startBy(total) {
  const [hh, mm] = (S.settings.dinner_time || '17:00').split(':').map(Number);
  const t = ((hh * 60 + mm - total) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function timeText(r) {
  const parts = [];
  if (r.prep_min) parts.push(`${mins(r.prep_min)} forarbeid`);
  if (r.cook_min) parts.push(`${mins(r.cook_min)} tilberedning`);
  return parts.join(' + ');
}

/** Ingredients split into groups under their optional heading, keeping the recipe's order.
 *  `draw(ingredient, index)` makes one item; `listClass` is the class of each group's list. */
function ingredientGroups(list, draw, listClass) {
  const groups = [];
  list.forEach((i, n) => {
    const section = i.section || '';
    if (!groups.length || groups[groups.length - 1].section !== section) groups.push({ section, items: [] });
    groups[groups.length - 1].items.push(draw(i, n));
  });
  return groups.map((g) => [g.section && h('div', { class: 'ing-group' }, g.section), h('div', { class: listClass }, g.items)]);
}
const ingNote = (i) => i.note && h('span', { class: 'ing-note' }, i.note);

const qtyText = (q) => (q == null ? '' : String(Math.round(q * 100) / 100));
const itemText = (i) => [qtyText(i.quantity), i.unit, i.name].filter(Boolean).join(' ');
/** Shopping list text: amounts per dinner are shown, never added up ("2 × 400 g Kjøttdeig"). */
function buyText(i) {
  // Amounts in the same unit are added up by the server; the amount for each dish is shown
  // under the name. With different units, only the name is shown here.
  if (i.mixed_units || i.quantity == null) return i.name;
  return [[shopQty(i.quantity), i.unit, i.name].filter(Boolean).join(' '),
    i.more && h('span', { class: 'more', title: 'En av middagene har ikke mengde for denne' }, ' + mer')];
}
/** Amounts in the shopping list, with halves and quarters as fractions: ½ stk, 1½ dl. */
function shopQty(q) {
  if (q == null) return '';
  const whole = Math.floor(q + 1e-9);
  const frac = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 100) / 100];
  if (frac) return `${whole || ''}${frac}`;
  return qtyText(q).replace('.', ',');
}

/** How many packs to suggest at Oda: one per dinner that needs an amount of it. */
/** How many packs Oda suggests: counted things are added up and rounded up (½ + ½ cucumber
 *  is 1), weights get one pack per dish (two 400 g packs of mince), and spoons, dl and the
 *  like are one pack (8 ss butter is one butter). */
function packCount(i) {
  if (i.mixed_units || i.quantity == null) return 1;
  const unit = (i.unit || '').toLowerCase();
  if (['', 'stk', 'pk', 'boks', 'pose', 'flaske', 'glass'].includes(unit)) return Math.max(1, Math.ceil(i.quantity - 1e-9));
  if (['g', 'kg'].includes(unit)) return Math.max(1, i.amounts.filter((a) => a.quantity != null).length);
  return 1;
}

/** Small labels under an ingredient: the amount for each dish. Only shown when it is used more
 *  than once, unless `always` (the Oda view, where the dish heading is not on screen). */
function useChips(i, { always = false } = {}) {
  if (always && !(i.amounts || []).length) {
    const why = i.kind === 'extra' ? EXTRA : i.kind === 'staple' ? OUT : null;
    return why && h('div', { class: 'uses' }, h('span', { class: 'use' }, why));
  }
  if (!i.amounts || i.amounts.length < (always ? 1 : 2)) return null;
  return h('div', { class: 'uses' }, i.amounts.map((a) => {
    const amount = [shopQty(a.quantity), a.unit].filter(Boolean).join(' ');
    const what = a.side ? `tilbehør · ${a.recipe}` : a.quantity == null && i.quantity != null ? `${a.recipe} · uten mengde` : a.recipe;
    return h('span', { class: 'use' }, amount && h('b', null, amount), amount && ' ', what);
  }));
}

const SHARED = 'Delt';
const OUT = 'Basisvarer dere er tomme for';
const EXTRA = 'Lagt til av dere';
/** Groups items under the dish they belong to; an ingredient used by several dishes goes under "Delt". */
function groupBuy(list) {
  const order = [...new Set(list.dinners.filter((d) => !d.shopped).map((d) => d.name)), SHARED, OUT, EXTRA];
  const groups = new Map(order.map((g) => [g, []]));
  for (const i of list.buy) {
    const g = i.kind === 'extra' ? EXTRA
      : i.kind === 'staple' ? OUT
        : i.recipes.length > 1 ? SHARED : i.recipes[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  return [...groups].filter(([, items]) => items.length);
}

/** The grey line under an item. Under a dish's own header its name would only repeat,
 *  so only "Delt" items say which dish needs how much. */
function buyNote(i) {
  return i.staple_out && i.kind !== 'staple' ? 'basisvare dere er tomme for' : '';
}

const memberName = (id) => (S.members.find((m) => m.id === id) || {}).name;

// A "form" dialog holds something the user is writing: a click outside it does
// nothing, and closing it with unsaved text asks first.
let dlgIsForm = false;
let dlgDirty = false;

function openDialog(title, nodes, { form = false, wide = false } = {}) {
  dlgIsForm = form;
  dlg.classList.toggle('wide', wide);
  dlgDirty = false;
  document.getElementById('dlg-title').textContent = title;
  document.getElementById('dlg-body').replaceChildren(...[nodes].flat(Infinity).filter((n) => n != null && n !== false));
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
function closeDialog() { if (dlg.open) dlg.close(); }
function askToClose() {
  if (dlgIsForm && dlgDirty && !confirm('Lukke uten å lagre? Det du har skrevet blir borte.')) return;
  closeDialog();
}
document.getElementById('dlg-close').addEventListener('click', askToClose);
document.getElementById('dlg-body').addEventListener('input', () => { dlgDirty = true; });
dlg.addEventListener('cancel', (e) => { e.preventDefault(); askToClose(); });  // Esc key
dlg.addEventListener('mousedown', (e) => { dlg.dataset.downOutside = e.target === dlg ? '1' : ''; });
dlg.addEventListener('click', (e) => {
  if (e.target === dlg && dlg.dataset.downOutside && !dlgIsForm) closeDialog();
});
window.addEventListener('beforeunload', (e) => {
  if (dlg.open && dlgIsForm && dlgDirty) e.preventDefault();
});

/**
 * Suggestions under a text field. Nothing is shown until `minChars` characters are
 * typed, and only the best `max` matches are listed. Typing something new is fine.
 */
function suggest(input, options, { minChars = 1, max = 6 } = {}) {
  const list = h('div', { class: 'ac-list', hidden: true });
  const wrap = h('div', { class: 'ac' }, input, list);
  let active = -1;
  const hide = () => { list.hidden = true; active = -1; };
  const pick = (value) => {
    input.value = value;
    hide();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    dlgDirty = true;
  };
  const show = () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < minChars) return hide();
    const all = options();
    const matches = [
      ...all.filter((o) => o.toLowerCase().startsWith(q)),
      ...all.filter((o) => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q)),
    ].filter((o) => o.toLowerCase() !== q).slice(0, max);
    if (!matches.length) return hide();
    active = -1;
    list.replaceChildren(...matches.map((o) => h('div', {
      class: 'ac-item',
      onpointerdown: (e) => { e.preventDefault(); pick(o); },
    }, o)));
    list.hidden = false;
  };
  input.autocomplete = 'off';
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('blur', hide);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const items = [...list.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === active));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active].textContent);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });
  return wrap;
}

// ------------------------------------------------------------------ routing

const currentTab = () => {
  const t = location.hash.replace('#', '');
  if (t.startsWith('cook/')) return 'cook';
  if (t === 'stats') return 'stats';
  return ['week', 'recipes', 'pantry', 'shopping'].includes(t) ? t : 'week';
};
let lastTab = 'week';  // where "Tilbake" in the kitchen view goes

async function refresh() { S = await api('GET', '/state'); }

async function render() {
  if (!S) return;
  const tab = currentTab();
  view.dataset.tab = tab;
  document.body.classList.toggle('cooking', tab === 'cook');
  if (tab !== 'cook' && tab !== 'stats') lastTab = tab;
  if (tab !== 'cook') keepAwake(false);
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === tab);
  await run({ week: renderWeek, recipes: renderRecipes, pantry: renderPantry, shopping: renderShopping, cook: renderCook, stats: renderStats }[tab]);
}

// Two people use this from their own phones, so always fetch fresh data before drawing.
async function reload() { await run(refresh); await render(); }

window.addEventListener('hashchange', reload);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S && !dlg.open) reload();
});
document.getElementById('settings-btn').addEventListener('click', openSettings);

async function init() {
  try { await refresh(); } catch (e) { if (e.status !== 401) toast(e.message); return; }
  weekStart = defaultWeek();
  const params = new URLSearchParams(location.search);
  if (params.has('oda')) {
    const messages = {
      connected: 'Oda er koblet til',
      denied: 'Oda ble ikke koblet til',
      error: 'Klarte ikke å koble til Oda. Prøv igjen.',
    };
    toast(messages[params.get('oda')] || '');
    history.replaceState(null, '', location.pathname + location.hash);
  }
  await render();
}

function showLogin() {
  closeDialog();
  const pw = h('input', { type: 'password', placeholder: 'Familiens passord', autocomplete: 'current-password' });
  view.replaceChildren(h('form', {
    class: 'card', style: 'display:grid;gap:10px',
    onsubmit: (e) => {
      e.preventDefault();
      run(async () => { await api('POST', '/login', { password: pw.value }); await init(); });
    },
  }, h('h2', null, 'Logg inn'), pw, h('button', { class: 'primary', type: 'submit' }, 'Logg inn')));
}

// --------------------------------------------------------------------- week

/** The week shown first: this week, but from Friday at 18 and through the weekend the coming
 *  week, since that is when the next week's dinners get planned. */
function planningTime() {
  const day = D(S.today).getDay();  // 0 = Sunday, 5 = Friday, 6 = Saturday
  return day === 6 || day === 0 || (day === 5 && new Date().getHours() >= 18);
}
const defaultWeek = () => (planningTime() ? addDays(monday(S.today), 7) : monday(S.today));

async function renderWeek() {
  const plan = await api('GET', `/plan?start=${weekStart}&days=7`);
  weekPlan = Object.fromEntries(plan.map((p) => [p.date, p]));
  const isThisWeek = weekStart === monday(S.today);
  const home = defaultWeek();
  // Tonight's dinner stays on top in the planning view too, even though it is in another week.
  let tonight = weekPlan[S.today];
  if (!isThisWeek && weekStart === home) {
    tonight = (await api('GET', `/plan?start=${S.today}&days=1`))[0];
    if (tonight) weekPlan[S.today] = tonight;  // so changing tonight keeps its cook and note
  }
  const nodes = [
    h('div', { class: 'toolbar' },
      h('button', { class: 'small', onclick: () => { weekStart = addDays(weekStart, -7); render(); } }, '‹ Forrige'),
      h('div', { class: 'grow week-title' },
        h('div', { class: 'week-no' }, `Uke ${weekNumber(weekStart)}`),
        h('div', { class: 'muted' }, `${fmtShort(weekStart)} – ${fmtShort(addDays(weekStart, 6))}`)),
      h('button', { class: 'small', onclick: () => { weekStart = addDays(weekStart, 7); render(); } }, 'Neste ›')),
  ];
  if (isThisWeek || weekStart === home) nodes.push(tonightCard(tonight));
  if (weekStart !== home) {
    nodes.push(h('button', { class: 'small', onclick: () => { weekStart = home; render(); } },
      home === monday(S.today) ? 'Tilbake til denne uka' : 'Tilbake til neste uke'));
  }
  if (!S.members.length) {
    nodes.push(h('div', { class: 'card row' },
      h('div', { class: 'grow muted' }, 'Legg til hvem som lager mat, så hver middag kan få en kokk.'),
      h('button', { class: 'small', onclick: openSettings }, 'Legg til kokker')));
  }
  nodes.push(h('div', { class: 'week-list' }, [0, 1, 2, 3, 4, 5, 6].map((i) => dayCard(addDays(weekStart, i)))));
  view.replaceChildren(...nodes);
}

function tonightCard(p) {
  const planned = p && (p.recipe_id || p.note);
  if (!planned) {
    return h('div', { class: 'card tonight row' },
      h('div', { class: 'grow' }, h('div', { class: 'muted' }, 'I kveld'), h('div', { class: 'big' }, 'Ingenting planlagt ennå')),
      h('button', { class: 'primary', onclick: () => openPicker(S.today) }, 'Planlegg'));
  }
  const total = (p.prep_min || 0) + (p.cook_min || 0);
  const cook = memberName(p.cook_id);
  return h('div', { class: 'card tonight' },
    h('div', { class: 'muted' }, 'I kveld'),
    h('div', { class: 'row' },
      h('div', { class: 'big grow' }, p.recipe_name || p.note),
      p.recipe_id && h('button', { class: 'primary small', onclick: () => openCook(p.recipe_id, S.today) }, '👩‍🍳 Lag maten')),
    h('div', null,
      cook ? `${cook} lager mat` : h('span', { class: 'need-cook' }, 'Ingen har fått ansvaret for maten ennå'),
      total ? ` · ${mins(total)} · start senest ${startBy(total)} for å spise ${S.settings.dinner_time}` : ''));
}

function dayCard(date) {
  const p = weekPlan[date];
  const planned = p && (p.recipe_id || p.note);
  const isToday = date === S.today;
  const card = h('div', { class: `card day${isToday ? ' today' : ''}${date < S.today ? ' past' : ''}` });
  card.append(h('div', { class: 'row' },
    h('div', { class: 'day-label grow' }, fmtDay(date) + (isToday ? ' · i dag' : '')),
    planned && h('button', { class: 'small ghost', onclick: () => openPicker(date) }, 'Bytt'),
    planned && h('button', { class: 'small ghost', 'aria-label': 'Fjern middagen', onclick: () => savePlan(date, { recipe_id: null, note: '', cook_id: null }) }, '✕')));

  if (!planned) {
    card.append(h('div', { class: 'row' },
      h('button', { class: 'plan-btn grow', onclick: () => openPicker(date) }, '+ Planlegg middag'),
      S.recipes.length > 0 && h('button', { onclick: () => surprise(date), title: 'Velg en oppskrift for meg' }, '🎲')));
    return card;
  }

  const total = (p.prep_min || 0) + (p.cook_min || 0);
  card.append(h('div', { class: 'row' },
    h('button', {
      class: 'dish grow',
      onclick: () => (p.recipe_id ? openRecipe(p.recipe_id) : openPicker(date)),
    }, p.recipe_name || p.note),
    p.recipe_id && h('button', { class: 'pill', title: 'Vis oppskriften stort, til bruk på kjøkkenet', onclick: () => openCook(p.recipe_id, date) }, '👩‍🍳 Lag maten')));
  const meta = [];
  if (total) meta.push(`${timeText(p)} · start senest ${startBy(total)}`);
  if (p.recipe_id && p.note) meta.push(p.note);
  if (meta.length || p.shopped) {
    card.append(h('div', { class: 'muted' }, meta.join(' · '), p.shopped ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, 'handlet') : null));
  }
  if (p.gcal_error && date >= S.today && S.gcal.enabled) {
    card.append(h('div', { class: 'gcal-error row' },
      h('span', { class: 'grow' }, `Ikke i kalenderen: ${p.gcal_error}`),
      h('button', { class: 'small', onclick: () => retryCalendar(date) }, 'Prøv igjen')));
  }
  if (S.members.length) {
    card.append(h('div', { class: 'chips' },
      S.members.map((m) => h('button', {
        class: `chip${p.cook_id === m.id ? ' on' : ''}`,
        onclick: () => savePlan(date, { cook_id: p.cook_id === m.id ? null : m.id }),
      }, m.name)),
      !p.cook_id && h('span', { class: 'need-cook' }, '← Hvem lager mat?')));
  }
  return card;
}

async function savePlan(date, patch) {
  const cur = weekPlan[date] || {};
  const body = { recipe_id: cur.recipe_id ?? null, note: cur.note || '', cook_id: cur.cook_id ?? null, ...patch };
  await run(async () => {
    const res = await api('PUT', `/plan/${date}`, body);
    closeDialog();
    await reload();
    if (res.gcal_error) toast(`Lagret, men kalenderen ble ikke oppdatert: ${res.gcal_error}`);
  });
}

async function retryCalendar(day) {
  await run(async () => {
    await api('POST', day ? `/gcal/sync?day=${day}` : '/gcal/sync');
    toast(day ? 'Kalenderen er oppdatert' : 'Alle kommende middager er synket');
  });
  await reload();
}

function leastRecent(recipes) {
  return [...recipes].sort((a, b) => (a.last_planned || '').localeCompare(b.last_planned || ''));
}

function surprise(date) {
  const used = new Set(Object.values(weekPlan).map((p) => p.recipe_id));
  let pool = S.recipes.filter((r) => !used.has(r.id));
  if (!pool.length) pool = S.recipes;
  if (!pool.length) return toast('Legg til en oppskrift først');
  const top = leastRecent(pool).slice(0, 3);
  const pick = top[Math.floor(Math.random() * top.length)];
  savePlan(date, { recipe_id: pick.id, note: '' });
}

function openPicker(date) {
  const listEl = h('div', { style: 'display:grid;gap:6px' });
  const search = h('input', { type: 'search', placeholder: 'Søk i oppskrifter' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const matches = leastRecent(S.recipes).filter((r) => r.name.toLowerCase().includes(q));
    listEl.replaceChildren(...matches.map((r) => h('button', {
      class: 'pick', onclick: () => savePlan(date, { recipe_id: r.id, note: '' }),
    }, h('span', null, r.name),
       h('span', { class: 'muted' }, mins(r.prep_min + r.cook_min) || ''))));
    if (!matches.length) listEl.append(h('p', { class: 'muted' }, S.recipes.length ? 'Ingen oppskrifter passer.' : 'Ingen oppskrifter ennå. Legg til noen under Oppskrifter.'));
  };
  search.addEventListener('input', fill);
  fill();
  const note = h('input', { placeholder: 'Rester, takeaway, hos mormor …', value: (weekPlan[date] || {}).recipe_id ? '' : ((weekPlan[date] || {}).note || '') });
  openDialog(fmtDay(date), [
    S.recipes.length > 0 && h('div', { class: 'row' }, h('div', { class: 'grow' }, search),
      h('button', { onclick: () => surprise(date) }, '🎲 Overrask meg')),
    listEl,
    h('div', { class: 'section-title' }, 'Eller noe uten oppskrift'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (note.value.trim()) savePlan(date, { recipe_id: null, note: note.value }); } },
      h('div', { class: 'grow' }, note), h('button', { type: 'submit' }, 'Lagre')),
  ]);
}

// ------------------------------------------------------------------ recipes

function renderRecipes() {
  const nodes = [h('button', { class: 'primary', onclick: () => openRecipeForm() }, '+ Ny oppskrift')];
  if (!S.recipes.length) {
    nodes.push(h('div', { class: 'card empty' }, 'Ingen oppskrifter ennå. Legg inn middagene dere allerede lager – fem–seks holder for å komme i gang.'));
  }
  nodes.push(h('div', { class: 'cards-grid' }, S.recipes.map((r) => h('button', { class: 'card recipe-card', onclick: () => openRecipe(r.id) },
    h('h3', null, r.name),
    h('div', { class: 'muted' }, [timeText(r), `${r.ingredients.filter((i) => !i.side).length} ingredienser`, `${r.servings} porsjoner`].filter(Boolean).join(' · '))))));
  view.replaceChildren(...nodes);
}

// ------------------------------------------------------------- markdown

/** Inline Markdown: **bold**, *italic*, `code`, [links](https://…) and bare https:// links.
 *  Builds elements from text only, so pasted text can never run as HTML. */
function mdInline(text) {
  const out = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3(?![\p{L}\d])|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gu;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(h('strong', null, mdInline(m[2])));
    else if (m[4] != null) out.push(h('em', null, mdInline(m[4])));
    else if (m[5] != null) out.push(h('code', null, m[5]));
    else {
      const href = m[7] || m[8];
      out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[6] || href));
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Block Markdown for recipe instructions: headings, numbered and bullet lists,
 *  quotes (shown as tips), rules and paragraphs. Single line breaks are kept. */
function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = null, list = null, quote = null;
  const close = () => { para = null; list = null; quote = null; };
  const withBreaks = (target, text) => {
    if (target.childNodes.length) target.append(h('br'));
    target.append(...mdInline(text));
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/))) {
      close();
      blocks.push(h(m[1].length <= 2 ? 'h3' : 'h4', { class: 'md-h' }, mdInline(m[2])));
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      close();
      blocks.push(h('hr'));
    } else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      if (!list || list.tagName !== 'OL') {
        close();
        list = h('ol', { start: Number(m[1]) });
        blocks.push(list);
      }
      list.append(h('li', null, mdInline(m[2])));
    } else if ((m = line.match(/^\s*[-*+•]\s+(?:\[[ xX]\]\s+)?(.*)$/))) {
      if (!list || list.tagName !== 'UL') {
        close();
        list = h('ul');
        blocks.push(list);
      }
      list.append(h('li', null, mdInline(m[1])));
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      if (!quote) {
        close();
        quote = h('blockquote');
        blocks.push(quote);
      }
      withBreaks(quote, m[1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      withBreaks(list.lastElementChild, line.trim());  // continuation of a list item
    } else {
      if (!para) {
        close();
        para = h('p');
        blocks.push(para);
      }
      withBreaks(para, line.trim());
    }
  }
  return h('div', { class: 'md' }, blocks);
}

function openRecipe(id) {
  const r = S.recipes.find((x) => x.id === id);
  if (!r) return;
  const total = r.prep_min + r.cook_min;
  openDialog(r.name, [
    h('div', { class: 'row', style: 'align-items:flex-start' },
      h('div', { class: 'muted grow' }, [timeText(r), total ? `${mins(total)} totalt` : '', `${r.servings} porsjoner`].filter(Boolean).join(' · ')),
      h('button', { class: 'pill', onclick: () => openRecipeForm(null, { copyOf: r }), title: 'Lag en ny oppskrift med denne som utgangspunkt' }, '⧉ Kopier'),
      h('button', { class: 'pill', onclick: () => openRecipeForm(r) }, '✎ Endre')),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Ingredienser'),
      r.ingredients.some((i) => !i.side)
        ? ingredientGroups(r.ingredients.filter((i) => !i.side),
          (i) => h('div', { class: 'item' }, h('span', null, itemText(i)), ingNote(i)), 'list')
        : h('div', { class: 'muted' }, 'Ingen ingredienser lagt inn.')),
    r.ingredients.some((i) => i.side) && h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Tilbehør på bordet'),
      h('div', { class: 'chips' }, r.ingredients.filter((i) => i.side).map((i) => h('span', { class: 'tag plain' }, i.name)))),
    r.instructions && h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Slik gjør du'),
      renderMarkdown(r.instructions)),
    h('button', { class: 'primary', onclick: () => openCook(r.id) }, '👩‍🍳 Lag maten'),
  ]);
}

/** Edits `recipe`, or makes a new one. With `copyOf`, the new one starts as a copy of that recipe. */
function openRecipeForm(recipe, { copyOf = null } = {}) {
  const r = recipe || copyOf || { name: '', prep_min: '', cook_min: '', servings: 4, instructions: '', ingredients: [] };
  const known = new Set(S.pantry.map((p) => p.name));
  for (const x of S.recipes) for (const i of x.ingredients) known.add(i.name);
  const knownList = [...known].sort((a, b) => a.localeCompare(b, 'nb'));

  const name = h('input', { value: copyOf ? `${copyOf.name} (kopi)` : r.name, placeholder: 'Taco, fiskesuppe, pannekaker …', required: true });
  const prep = h('input', { type: 'number', min: 0, inputMode: 'numeric', value: r.prep_min });
  const cook = h('input', { type: 'number', min: 0, inputMode: 'numeric', value: r.cook_min });
  const servings = h('input', { type: 'number', min: 1, inputMode: 'numeric', value: r.servings });
  const instructions = h('textarea', {
    value: r.instructions, rows: 10,
    placeholder: '1. Forvarm ovnen til 200 °C.\n2. …\n\n**Tips:** Kan lages dagen før.',
  });
  const rows = h('div', { style: 'display:grid;gap:6px' });
  const addRow = (ing = {}) => {
    const qty = h('input', { class: 'ing-qty', type: 'number', min: 0, step: 'any', inputMode: 'decimal', placeholder: 'Mengde', value: ing.quantity ?? '', 'aria-label': 'Mengde' });
    const unit = suggest(h('input', { placeholder: 'Enhet', value: ing.unit || '', 'aria-label': 'Enhet', autocapitalize: 'off' }),
      () => S.settings.units, { minChars: 0, max: 40 });
    unit.classList.add('ing-unit');
    const what = suggest(h('input', { placeholder: 'Ingrediens', value: ing.name || '', 'aria-label': 'Ingrediens' }),
      () => knownList, { minChars: 1, max: 6 });
    what.classList.add('ing-name');
    // Optional note, e.g. "til steking". Written in a small popup; the icon is coloured when there is one.
    const noteBtn = h('button', { type: 'button', class: 'ghost ing-note-btn', innerHTML: NOTE_ICON });
    const showNote = (text) => {
      row.dataset.note = text;
      noteBtn.classList.toggle('has-note', Boolean(text));
      noteBtn.title = text ? `Kommentar: ${text}` : 'Legg til en kommentar';
      noteBtn.setAttribute('aria-label', noteBtn.title);
    };
    noteBtn.addEventListener('click', () => editNote(row.dataset.note, what.querySelector('input').value.trim(), (text) => {
      if (text !== row.dataset.note) dlgDirty = true;
      showNote(text);
    }));
    const row = h('div', { class: 'ing-row' }, dragHandle(), qty, unit, what, noteBtn,
      h('button', { type: 'button', class: 'ghost ing-del', 'aria-label': 'Fjern ingrediens', onclick: () => { row.remove(); dlgDirty = true; } }, '✕'));
    showNote(ing.note || '');
    rows.append(row);
    return row;
  };
  // A small heading between ingredients, e.g. "Råkost". Everything below it belongs to it,
  // up to the next heading. Rows are dragged into place by their handle.
  const addHeading = (text = '') => {
    const input = h('input', { placeholder: 'Overskrift, f.eks. Råkost', value: text, 'aria-label': 'Overskrift' });
    const row = h('div', { class: 'ing-heading-row' }, dragHandle(), input,
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Fjern overskrift', onclick: () => { row.remove(); dlgDirty = true; } }, '✕'));
    rows.append(row);
    return row;
  };
  const loadIngredients = (list) => {
    let section = '';
    for (const i of list) {
      if ((i.section || '') !== section) {
        section = i.section || '';
        if (section) addHeading(section);
      }
      addRow(i);
    }
  };
  const mainIngredients = r.ingredients.filter((i) => !i.side);
  loadIngredients(mainIngredients);
  for (let i = mainIngredients.length; i < 3; i++) addRow();

  // Sides: things put on the table, with no amount.
  const sideRows = h('div', { style: 'display:grid;gap:6px' });
  const addSide = (value = '') => {
    const what = suggest(h('input', { placeholder: 'F.eks. tyttebærsyltetøy', value, 'aria-label': 'Tilbehør' }),
      () => knownList, { minChars: 1, max: 6 });
    const row = h('div', { class: 'side-row' }, what,
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Fjern tilbehør', onclick: () => { row.remove(); dlgDirty = true; } }, '✕'));
    sideRows.append(row);
    return row;
  };
  r.ingredients.filter((i) => i.side).forEach((i) => addSide(i.name));

  // Fills the whole form with a recipe fetched from the web. It is saved like any other.
  const fill = (x) => {
    name.value = x.name;
    prep.value = x.prep_min;
    cook.value = x.cook_min;
    servings.value = x.servings;
    instructions.value = x.instructions;
    rows.replaceChildren();
    sideRows.replaceChildren();
    loadIngredients(x.ingredients.filter((i) => !i.side));
    x.ingredients.filter((i) => i.side).forEach((i) => addSide(i.name));
    if (!rows.children.length) addRow();
    dlgDirty = true;
  };
  const web = !recipe && !copyOf && webRecipeSearch(fill, () => Number(servings.value) || 4,
    () => Boolean(name.value.trim() || [...rows.querySelectorAll('input')].some((i) => i.value.trim())));

  const save = () => run(async () => {
    const ingredients = [];
    let section = '';
    for (const row of rows.children) {
      if (row.classList.contains('ing-heading-row')) {
        section = row.querySelector('input').value.trim();
        continue;
      }
      const q = row.querySelector('.ing-qty');
      const n = row.querySelector('.ing-name input').value.trim();
      if (!n) continue;
      ingredients.push({
        quantity: q.value === '' ? null : Number(q.value), unit: row.querySelector('.ing-unit input').value.trim(), name: n,
        note: row.dataset.note || '', section,
      });
    }
    for (const input of sideRows.querySelectorAll('input')) {
      if (input.value.trim()) ingredients.push({ name: input.value.trim(), quantity: null, unit: '', side: true });
    }
    const body = {
      name: name.value, prep_min: Number(prep.value) || 0, cook_min: Number(cook.value) || 0,
      servings: Number(servings.value) || 4, instructions: instructions.value, ingredients,
    };
    if (recipe) await api('PUT', `/recipes/${recipe.id}`, body);
    else await api('POST', '/recipes', body);
    closeDialog();
    await reload();
  });

  openDialog(recipe ? 'Endre oppskrift' : copyOf ? 'Kopier oppskrift' : 'Ny oppskrift', [
    copyOf && h('p', { class: 'muted' }, `En ny oppskrift med alt fra «${copyOf.name}». Gi den et nytt navn og endre det som er annerledes – originalen blir som den er.`),
    web,
    h('form',{ style: 'display:grid;gap:12px', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label', { class: 'field' }, 'Navn', name),
      h('div', { class: 'grid3' },
        h('label', { class: 'field' }, 'Forarbeid (min)', prep),
        h('label', { class: 'field' }, 'Tilberedning (min)', cook),
        h('label', { class: 'field' }, 'Porsjoner', servings)),
      h('div', { class: 'section-title' }, 'Ingredienser'),
      h('p', { class: 'muted' }, 'Bruk samme navn som i basisvarene (for eksempel «Melk»), så vet handlelista at dere allerede har det. Mangler en enhet? Skriv den rett inn, så huskes den til neste gang.'),
      rows,
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'small', onclick: () => addRow().querySelector('.ing-name input').focus() }, '+ Legg til ingrediens'),
        h('button', { type: 'button', class: 'small', title: 'Del ingrediensene i grupper, f.eks. «Råkost». Valgfritt.', onclick: () => addHeading().querySelector('input').focus() }, '+ Legg til overskrift')),
      h('div', { class: 'section-title' }, 'Tilbehør på bordet'),
      h('p', { class: 'muted' }, 'Ting dere setter fram og forsyner dere av, som tyttebærsyltetøy eller flatbrød. Uten mengde. De legges også i basisvarene, så dere kan markere dem som tomme når det må kjøpes mer.'),
      sideRows,
      h('button', { type: 'button', class: 'small', onclick: () => addSide().querySelector('input').focus() }, '+ Legg til tilbehør'),
      h('label', { class: 'field' }, 'Slik gjør du', instructions,
        h('span', { class: 'muted' }, 'Markdown virker: # overskrift, 1. steg, - punkt, **fet**, *kursiv*, > tips, lenker.')),
      h('div', { class: 'row' },
        h('button', { class: 'primary grow', type: 'submit' }, 'Lagre oppskrift'),
        recipe && h('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (!confirm(`Slette «${recipe.name}»? Den fjernes også fra planen.`)) return;
            run(async () => { await api('DELETE', `/recipes/${recipe.id}`); closeDialog(); await reload(); });
          },
        }, 'Slett'))),
  ], { form: true });
  if (!recipe) name.focus();
  if (copyOf) name.select();  // typing replaces the name right away
}

// ------------------------------------------------------------- kitchen view

/** A large, calm view of one recipe to keep open while cooking. `date` adds who cooks and when to start. */
function openCook(recipeId, date) {
  closeDialog();
  location.hash = `#cook/${recipeId}${date ? `/${date}` : ''}`;
}

// Keeps the screen from going dark while the recipe is open (where the browser allows it).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now; the screen just behaves as usual */ }
}

// What has been ticked off, per recipe and day, so it survives the page refreshing.
const cookKey = (recipeId, date) => `cook:${recipeId}:${date || S.today}`;
function loadTicks(key) {
  try { return new Set(JSON.parse(sessionStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveTicks(key, ticks) {
  try { sessionStorage.setItem(key, JSON.stringify([...ticks])); } catch { /* private mode */ }
}

async function renderCook() {
  const [, idText, date] = location.hash.replace('#', '').split('/');
  const r = S.recipes.find((x) => x.id === Number(idText));
  const back = h('button', { class: 'small', onclick: () => { location.hash = `#${lastTab}`; } }, '‹ Tilbake');
  if (!r) {
    view.replaceChildren(back, h('div', { class: 'card empty' }, 'Fant ikke oppskriften. Kanskje den er slettet?'));
    return;
  }
  let plan = null;
  if (date) plan = (await api('GET', `/plan?start=${date}&days=1`))[0] || null;
  keepAwake(true);

  const key = cookKey(r.id, date);
  const ticks = loadTicks(key);
  const tickable = (el, id) => {
    el.classList.add('tick');
    el.classList.toggle('done', ticks.has(id));
    el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;  // let links work
      if (ticks.has(id)) ticks.delete(id); else ticks.add(id);
      el.classList.toggle('done', ticks.has(id));
      saveTicks(key, ticks);
    });
    return el;
  };

  const total = r.prep_min + r.cook_min;
  const cook = plan && memberName(plan.cook_id);
  const meta = [
    date && fmtDay(date),
    cook && `${cook} lager mat`,
    timeText(r),
    total && date === S.today ? `start senest ${startBy(total)}` : '',
    `${r.servings} porsjoner`,
  ].filter(Boolean).join(' · ');

  const main = r.ingredients.filter((i) => !i.side);
  const sides = r.ingredients.filter((i) => i.side);
  const ingredients = h('section', { class: 'card cook-ings' },
    h('div', { class: 'section-title' }, 'Ingredienser'),
    main.length
      ? ingredientGroups(main, (i, n) => {
        const amount = [qtyText(i.quantity), i.unit].filter(Boolean).join(' ');
        return tickable(h('div', { class: 'cook-ing', role: 'button' },
          h('span', { class: 'box', 'aria-hidden': 'true' }),
          h('span', null, amount && h('strong', null, amount + ' '), i.name, i.note && ' ', ingNote(i))), `i${n}`);
      }, 'cook-list')
      : h('div', { class: 'muted' }, 'Ingen ingredienser lagt inn.'),
    sides.length > 0 && h('div', { class: 'section-title', style: 'margin-top:14px' }, 'Tilbehør på bordet'),
    sides.length > 0 && h('div', { class: 'chips' }, sides.map((i) => h('span', { class: 'tag plain' }, i.name))));

  const steps = h('section', { class: 'card cook-steps' }, h('div', { class: 'section-title' }, 'Slik gjør du'));
  if (r.instructions) {
    const md = renderMarkdown(r.instructions);
    [...md.querySelectorAll('li, .md > p')].forEach((el, n) => tickable(el, `s${n}`));
    steps.append(md);
  } else {
    steps.append(h('div', { class: 'muted' }, 'Ingen fremgangsmåte lagt inn.'));
  }

  view.replaceChildren(h('div', { class: 'cook' },
    h('div', { class: 'row' }, back, h('div', { class: 'grow' }),
      h('button', { class: 'small ghost', onclick: () => { ticks.clear(); saveTicks(key, ticks); render(); } }, 'Nullstill'),
      h('button', { class: 'small ghost', onclick: () => openRecipeForm(r) }, '✎ Endre')),
    h('div', null,
      h('h1', { class: 'cook-title' }, r.name),
      meta && h('div', { class: 'muted cook-meta' }, meta),
      plan && plan.note && h('div', { class: 'cook-note' }, plan.note)),
    h('p', { class: 'muted' }, 'Trykk på en ingrediens eller et steg for å krysse det av.'),
    h('div', { class: 'cook-grid' }, ingredients, steps)));
}

// --------------------------------------------------------------- statistics

let statsPeriod = '91';
const sorting = { running: false, error: null };  // Claude Haiku sorting new ingredients
let catOpen = false;
let catSearch = '';
const pct = (x) => `${Math.round(x * 100)} %`;
const kg = (g) => (g < 1000 ? `${Math.round(g)} g` : `${(g / 1000).toFixed(1).replace('.', ',')} kg`);
const WEEKDAYS = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];

/** Hover or tap a mark to see its numbers. The text is set as text, never as HTML. */
const statTip = h('div', { class: 'stat-tip', role: 'tooltip' });
document.body.append(statTip);
function moveTip(e) {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t || currentTab() !== 'stats') { statTip.style.opacity = 0; return; }
  statTip.textContent = t.dataset.tip;
  statTip.style.opacity = 1;
  statTip.style.left = `${Math.max(8, Math.min(e.clientX + 12, innerWidth - statTip.offsetWidth - 8))}px`;
  statTip.style.top = `${e.clientY + 16}px`;
}
document.addEventListener('pointermove', moveTip);
document.addEventListener('pointerdown', moveTip);

async function renderStats() {
  const s = await api('GET', `/stats?period=${statsPeriod}`);
  const label = (g) => s.labels[g];
  const color = (g) => `var(--s${s.protein.indexOf(g) + 1})`;
  const nodes = [];

  nodes.push(h('div', { class: 'row wrap' },
    h('button', { class: 'small', onclick: () => { location.hash = `#${lastTab}`; } }, '‹ Tilbake'),
    h('h2', { class: 'grow' }, 'Statistikk'),
    h('div', { class: 'chips' }, [['30', 'Siste måned'], ['91', 'Siste 3 måneder'], ['year', 'I år'], ['all', 'Alt']].map(([p, text]) =>
      h('button', { class: `chip${statsPeriod === p ? ' on' : ''}`, onclick: () => { statsPeriod = p; render(); } }, text)))));

  // Sorting new ingredients runs by itself; this only says what is going on.
  const unsorted = s.missing.names + s.missing.weights;
  if (unsorted && s.ai && !sorting.running && !sorting.error) {
    sorting.running = true;
    api('POST', '/stats/categorize')
      .catch((e) => { sorting.error = e.message; })
      .finally(() => { sorting.running = false; if (currentTab() === 'stats') render(); });
  }
  if (sorting.running) {
    nodes.push(h('div', { class: 'stat-note' }, 'Claude Haiku sorterer nye ingredienser i matgrupper og anslår vektene … Tallene oppdateres når det er ferdig.'));
  } else if (unsorted && sorting.error) {
    nodes.push(h('div', { class: 'stat-note warn row' }, h('span', { class: 'grow' }, `Noen ingredienser er ikke sortert: ${sorting.error}`),
      h('button', { class: 'small', onclick: () => { sorting.error = null; render(); } }, 'Prøv igjen')));
  } else if (unsorted && !s.ai) {
    nodes.push(h('div', { class: 'stat-note warn' }, 'Noen ingredienser er ikke sortert. Automatisk sortering krever ANTHROPIC_API_KEY på serveren; de kan også sorteres nederst på siden.'));
  }

  if (!s.dinners) {
    nodes.push(h('div', { class: 'card empty' }, statsPeriod === 'all'
      ? 'Ingen middager er registrert ennå. Hver planlagte middag kommer med her dagen etter, så statistikken bygges opp av seg selv.'
      : 'Ingen middager med oppskrift i denne perioden. Prøv en lengre periode.'));
    nodes.push(categoryEditor());
    view.replaceChildren(...nodes);
    return;
  }

  const n = s.dinners;
  nodes.push(h('div', { class: 'kpis' },
    h('div', { class: 'card kpi' }, h('div', { class: 'section-title' }, 'Middager'), h('div', { class: 'v' }, String(n)),
      h('div', { class: 's' }, [`${s.distinct} ulike retter`, statsPeriod !== 'all' && s.new ? `${s.new} ${s.new === 1 ? 'ny' : 'nye'}` : '', s.without_recipe ? `${s.without_recipe} uten oppskrift` : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'card kpi' }, h('div', { class: 'section-title' }, 'Middager med fisk'),
      h('div', { class: 'v' }, s.fish_per_week.toFixed(1).replace('.', ','), h('span', { class: 'unit' }, ' per uke')),
      h('div', { class: 's' }, `${s.fish} middager over ${String(s.weeks).replace('.', ',')} uker`),
      h('span', { class: `goal ${s.fish_per_week >= 2 ? 'ok' : 'under'}` }, `${s.fish_per_week >= 2 ? '✓' : '▼'} Anbefalt 2–3`)),
    h('div', { class: 'card kpi' }, h('div', { class: 'section-title' }, 'Vegetar'), h('div', { class: 'v' }, pct(s.vegetarian / n)),
      h('div', { class: 's' }, `${s.vegetarian} av ${n} middager uten kjøtt, kylling eller fisk`)),
    h('div', { class: 'card kpi' }, h('div', { class: 'section-title' }, 'Ultraprosessert'), h('div', { class: 'v' }, pct(s.ultra / n)),
      h('div', { class: 's' }, `${s.ultra} middager hadde noe ultraprosessert`))));

  if (s.lines_unweighed) {
    nodes.push(h('div', { class: 'stat-note' }, `${s.lines_unweighed} av ${s.lines} ingredienslinjer har ingen mengde eller vekt, og er ikke med i grammene.`));
  }

  // What the dinners are made of, by weight. An ingredient can be in several groups.
  const groups = [...s.groups].sort((a, b) => (a.key === 'ultraprosessert') - (b.key === 'ultraprosessert') || b.grams - a.grams);
  const heaviest = Math.max(1, ...groups.map((g) => g.grams));
  nodes.push(h('div', { class: 'card' },
    h('h3', null, 'Hva middagene er laget av'),
    h('div', { class: 'muted' }, `Vekt per matgruppe, ${kg(s.total_grams)} til sammen uten krydder og basis. En ingrediens kan høre til flere grupper (fiskepinner er både fisk og korn). Ultraprosessert er markert i oransje.`),
    h('div', { class: 'hbars' }, groups.map((g) => h('div', { class: 'hb wide', 'data-tip': `${g.label}: ${kg(g.grams)}\nmed i ${pct(g.share)} av middagene` },
      h('span', null, g.label),
      h('div', { class: 'track' }, h('div', { class: `bar${g.key === 'ultraprosessert' ? ' flag' : ''}`, style: `width:${(g.grams / heaviest) * 100}%` })),
      h('span', { class: 'val' }, kg(g.grams)),
      h('span', { class: 'val muted-val' }, `${pct(g.share)} av middagene`))))));

  // Protein sources over time, stacked by weight.
  const shown = s.protein.filter((g) => s.over_time.some((b) => b.grams[g]));
  const legend = h('div', { class: 'legend' }, shown.map((g) => h('span', null, h('i', { style: `background:${color(g)}` }), label(g))));
  const max = Math.max(1, ...s.over_time.map((b) => s.protein.reduce((a, g) => a + (b.grams[g] || 0), 0)));
  const step = max <= 2000 ? 500 : max <= 5000 ? 1000 : 2000;
  const top = Math.ceil(max / step) * step;
  const every = s.over_time.length > 18 ? 2 : 1;
  nodes.push(h('div', { class: 'card' },
    h('h3', null, s.monthly ? 'Proteinkilder, måned for måned' : 'Proteinkilder, uke for uke'),
    h('div', { class: 'muted' }, 'Vekten av kjøtt, kylling, fisk og belgfrukter i middagene, for hele oppskriften.'),
    legend,
    h('div', { class: 'stat-cols' },
      h('div', { class: 'yax' }, [0, 0.5, 1].map((f) => h('span', { style: `bottom:${f * 100}%` }, f ? kg(top * f) : '0'))),
      h('div', { class: 'plot' }, s.over_time.map((b) => h('div', {
        class: 'col',
        'data-tip': `${s.monthly ? b.label : `Uke ${b.label}`} · ${b.dinners} middager\n${shown.filter((g) => b.grams[g]).map((g) => `${label(g)}: ${kg(b.grams[g])}`).join('\n') || 'Ingen proteinkilder registrert'}`,
      }, shown.filter((g) => b.grams[g]).map((g) => h('b', { style: `height:calc(${(b.grams[g] / top) * 100}% - 2px);background:${color(g)}` })))))),
    h('div', { class: 'xax' }, s.over_time.map((b, i) => h('span', null, i % every ? '' : b.label)))));

  const cooks = s.cooks.filter((c) => c.total);
  nodes.push(h('div', { class: 'two' },
    h('div', { class: 'card' },
      h('h3', null, 'Hvem lager hva'),
      h('div', { class: 'muted' }, 'Proteinkildene i hver kokks middager, etter vekt. Tallet til høyre er antall middager.'),
      legend.cloneNode(true),
      cooks.map((c) => {
        const total = shown.reduce((a, g) => a + (c.grams[g] || 0), 0);
        return h('div', { class: 'cook-row' },
          h('strong', null, c.name || 'Ingen satt'),
          total
            ? h('div', { class: 'seg' }, shown.filter((g) => c.grams[g]).map((g) => {
              const share = c.grams[g] / total;
              return h('b', {
                class: g === 'belgfrukter' ? 'dark' : '', style: `flex:${c.grams[g]};background:${color(g)}`,
                'data-tip': `${c.name || 'Ingen satt'}\n${label(g)}: ${kg(c.grams[g])} (${pct(share)})`,
              }, share >= 0.15 ? pct(share) : '');
            }))
            : h('div', { class: 'muted' }, 'Ingen registrert'),
          h('div', { class: 'num' }, String(c.total)));
      })),
    h('div', { class: 'card' },
      h('h3', null, 'Hvem lager når'),
      h('div', { class: 'muted' }, 'Antall middager per ukedag.'),
      h('div', { class: 'sm' }, cooks.filter((c) => c.name).map((c, _, named) => {
        const most = Math.max(1, ...named.flatMap((x) => x.weekdays));  // one scale for everyone
        return h('div', null, h('h4', null, c.name),
          h('div', { class: 'wk' }, c.weekdays.map((x, d) => h('b', { style: `height:${(x / most) * 100}%`, 'data-tip': `${c.name}, ${WEEKDAYS[d]}: ${x}` }))),
          h('div', { class: 'wkx' }, 'MTOTFLS'.split('').map((d) => h('span', null, d))));
      })))));

  const most = Math.max(1, ...s.top_dishes.map((d) => d.count));
  const mostIng = Math.max(1, ...s.top_ingredients.map((d) => d.count));
  nodes.push(h('div', { class: 'two' },
    h('div', { class: 'card' },
      h('h3', null, 'Mest lagde retter'),
      h('table', { class: 'stat-table' },
        h('thead', null, h('tr', null, ['Rett', 'Ganger', 'Oftest laget av', 'Sist'].map((t) => h('th', null, t)))),
        h('tbody', null, s.top_dishes.map((d) => h('tr', null,
          h('td', null, d.name),
          h('td', { class: 'n' }, h('span', { class: 'mini', style: `width:${(d.count / most) * 48}px` }), String(d.count)),
          h('td', null, d.cook || '–'),
          h('td', { class: 'muted nowrap' }, fmtShort(d.last))))))),
    h('div', { class: 'card' },
      h('h3', null, 'Mest brukte ingredienser'),
      h('div', { class: 'muted' }, 'Antall middager ingrediensen var med i. Krydder og basis er utelatt.'),
      h('div', { class: 'hbars' }, s.top_ingredients.map((i) => h('div', { class: 'hb', 'data-tip': `${i.name}: med i ${i.count} av ${n} middager\n${kg(i.grams)} til sammen` },
        h('span', null, i.name),
        h('div', { class: 'track' }, h('div', { class: 'bar', style: `width:${(i.count / mostIng) * 100}%` })),
        h('span', { class: 'val' }, String(i.count))))))));

  nodes.push(categoryEditor());
  view.replaceChildren(...nodes);
}

/** Admin: the food groups and unit weights of each ingredient. Corrections are never overwritten. */
function categoryEditor() {
  const box = h('details', { class: 'card stat-cats', open: catOpen });
  const body = h('div', { class: 'cat-body' }, h('p', { class: 'muted' }, 'Henter …'));
  box.append(h('summary', null, h('h3', null, 'Matgrupper og vekter')),
    h('p', { class: 'muted' }, 'Claude Haiku foreslår matgrupper for hver ingrediens og hvor mye én enhet veier, som 1 boks mais = 160 g. Det dere endrer her, blir stående.'),
    body);
  const fill = async () => {
    const cats = await api('GET', '/stats/categories');
    const search = h('input', { type: 'search', placeholder: 'Søk etter ingrediens', value: catSearch });
    const onlyOpen = h('input', { type: 'checkbox' });
    const list = h('div', { class: 'list' });
    const save = (path, payload) => run(async () => { await api('PUT', path, payload); toast('Lagret'); await render(); });
    const origin = (manual, known) => h('span', { class: 'cat-origin' }, manual ? 'satt av dere' : known ? 'forslag fra Haiku' : 'ikke sortert');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      catSearch = search.value;
      const shown = cats.ingredients.filter((i) => i.name.toLowerCase().includes(q) && (!onlyOpen.checked || !i.manual || i.units.some((u) => !u.manual)));
      list.replaceChildren(h('div', { class: 'muted' }, `${shown.length} ingredienser`), ...shown.map((i) => {
        const on = new Set(i.groups || []);
        return h('div', { class: 'cat-ing' },
          h('div', null, h('span', { class: 'label' }, i.name), ' ', origin(i.manual, i.groups != null)),
          h('div', { class: 'chips' }, Object.entries(cats.groups).map(([g, text]) => h('button', {
            class: `chip small${on.has(g) ? ' on' : ''}`,
            onclick: () => { if (on.has(g)) on.delete(g); else on.add(g); save('/stats/ingredient', { name: i.name, groups: [...on] }); },
          }, text))),
          i.units.length > 0 && h('div', { class: 'cat-weights' }, i.units.map((u) => {
            const grams = h('input', {
              type: 'number', min: 0, step: 'any', inputMode: 'decimal', value: u.grams ?? '', 'aria-label': `Gram i 1 ${u.unit || 'stk'} ${i.name}`,
              onchange: () => save('/stats/weight', { name: i.name, unit: u.unit, grams: grams.value === '' ? null : Number(grams.value) }),
            });
            return h('label', { class: 'cat-weight' }, `1 ${u.unit || 'stk'} =`, grams, 'g', origin(u.manual, u.known));
          })));
      }));
    };
    search.addEventListener('input', draw);
    onlyOpen.addEventListener('change', draw);
    draw();
    body.replaceChildren(search, h('label', { class: 'row muted', style: 'font-size:.9rem' }, onlyOpen, 'Vis bare det dere ikke har sjekket'), list);
  };
  // Also fires when the box is drawn already open, after the page is redrawn.
  box.addEventListener('toggle', () => { catOpen = box.open; if (box.open) run(fill); });
  return box;
}

// ------------------------------------------------- ingredient rows in the form

const NOTE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path class="dots" d="M8 10.5h.01M12 10.5h.01M16 10.5h.01"/></svg>';

/** A small popup over the recipe form for an ingredient's note. `onSave` gets the new text ('' removes it). */
function editNote(current, ingredient, onSave) {
  const input = h('input', { value: current || '', placeholder: 'F.eks. til steking', 'aria-label': 'Kommentar' });
  const pop = h('dialog', { class: 'note-pop' });
  const close = () => { pop.close(); pop.remove(); };
  pop.append(h('form', {
    class: 'note-form',
    onsubmit: (e) => { e.preventDefault(); onSave(input.value.trim()); close(); },
  },
  h('strong', null, ingredient ? `Kommentar til ${ingredient}` : 'Kommentar'),
  input,
  h('div', { class: 'row' },
    h('button', { class: 'primary grow', type: 'submit' }, 'Lagre'),
    current && h('button', { type: 'button', class: 'danger', onclick: () => { onSave(''); close(); } }, 'Fjern'),
    h('button', { type: 'button', onclick: close }, 'Avbryt'))));
  pop.addEventListener('cancel', (e) => { e.preventDefault(); close(); });  // Esc closes only the popup
  pop.addEventListener('click', (e) => { if (e.target === pop) close(); });
  document.body.append(pop);
  pop.showModal();
  input.focus();
}

/** A handle to drag a row up or down among its siblings. Works with mouse and touch. */
function dragHandle() {
  const handle = h('span', { class: 'drag-handle', title: 'Dra for å flytte', 'aria-hidden': 'true' }, '⠿');
  handle.addEventListener('pointerdown', (e) => {
    const row = handle.parentElement;
    const list = row.parentElement;
    e.preventDefault();
    row.classList.add('dragging');
    const move = (ev) => {
      const y = ev.clientY;
      for (const other of list.children) {
        if (other === row) continue;
        const box = other.getBoundingClientRect();
        if (y < box.top || y > box.bottom) continue;
        const mid = box.top + box.height / 2;
        const otherIsAbove = Boolean(row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING);
        if (otherIsAbove && y < mid) other.before(row);
        else if (!otherIsAbove && y > mid) other.after(row);
        break;
      }
      // Scroll the form when dragging near its top or bottom edge.
      const view = dlg.getBoundingClientRect();
      if (y < view.top + 60) dlg.scrollTop -= 14;
      else if (y > view.bottom - 60) dlg.scrollTop += 14;
    };
    const stop = () => {
      row.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      dlgDirty = true;
    };
    // On the window, not the handle: moving the row in the page would make the handle lose the pointer.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  return handle;
}

/**
 * "Hent fra nettet": search a recipe database and fill the form with the chosen recipe,
 * translated to Norwegian and scaled to the servings in the form.
 */
function webRecipeSearch(fill, getServings, formHasText) {
  const box = h('details', { class: 'card web-search' });
  const summary = h('summary', null, '🌐 Hent oppskrift fra nettet');
  box.append(summary);
  if (!S.web_recipes) {
    box.append(h('p', { class: 'muted' }, 'Nettsøk er ikke satt opp ennå. Den som drifter appen må legge inn SPOONACULAR_API_KEY og ANTHROPIC_API_KEY på serveren.'));
    return box;
  }
  const query = h('input', { type: 'search', placeholder: 'F.eks. adobo, lasagne, kyllingsuppe', 'aria-label': 'Søk etter oppskrift på nettet' });
  const button = h('button', { type: 'submit' }, 'Søk');
  const results = h('div', { class: 'web-results' });
  const status = (text) => results.replaceChildren(h('p', { class: 'muted' }, text));
  let busy = false;

  const pick = async (hit) => {
    if (busy) return;
    if (formHasText() && !confirm('Erstatte det som allerede står i skjemaet?')) return;
    busy = true;
    const servings = getServings();
    status(`Henter «${hit.title}» og oversetter til norsk for ${servings} porsjoner … Det tar noen sekunder.`);
    try {
      fill(await api('POST', '/web-recipes/import', { id: hit.id, servings }));
      box.open = false;
      results.replaceChildren();
      toast('Oppskriften er fylt ut. Se over og trykk «Lagre oppskrift».');
    } catch (e) {
      if (e.status !== 401) status(e.message);
    } finally {
      busy = false;
    }
  };

  const form = h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const q = query.value.trim();
      if (!q || busy) return;
      busy = true;
      button.disabled = true;
      status('Søker …');
      try {
        const res = await api('POST', '/web-recipes/search', { query: q });
        if (!res.results.length) return status(`Fant ingen oppskrifter for «${res.query}». Prøv et annet ord.`);
        results.replaceChildren(
          h('p', { class: 'muted' }, `Søkte etter «${res.query}». Velg en oppskrift, så fylles skjemaet ut på norsk.`),
          ...res.results.map((hit) => h('button', { type: 'button', class: 'web-hit', onclick: () => pick(hit) },
            hit.image ? h('img', { src: hit.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : h('div', { class: 'no-image' }, '🍽'),
            h('span', { class: 'grow' }, h('span', { class: 'web-title' }, hit.title),
              h('span', { class: 'muted', style: 'display:block' }, [hit.minutes ? mins(hit.minutes) : '', hit.servings ? `${hit.servings} porsjoner i originalen` : ''].filter(Boolean).join(' · '))))));
      } catch (err) {
        if (err.status !== 401) status(err.message);
      } finally {
        busy = false;
        button.disabled = false;
      }
    },
  }, h('div', { class: 'grow' }, query), button);
  // Typing a search is not "writing a recipe": don't ask before closing because of it.
  query.addEventListener('input', (e) => e.stopPropagation());

  box.append(
    h('p', { class: 'muted' }, 'Søk på norsk eller engelsk. Oppskriften oversettes, regnes om til porsjonene du har valgt under, og fylles inn i skjemaet. Ingenting lagres før du trykker «Lagre oppskrift».'),
    form, results);
  box.addEventListener('toggle', () => { if (box.open) setTimeout(() => query.focus(), 0); });
  return box;
}

// ------------------------------------------------------------------- pantry

function renderPantry() {
  const name = h('input', { placeholder: 'Legg til en basisvare, f.eks. soyasaus' });
  const NEW = '__new__';
  const category = h('select', { 'aria-label': 'Kategori' });
  const fillCategories = (selected) => {
    category.replaceChildren(
      ...S.settings.categories.map((c) => h('option', { value: c }, c)),
      h('option', { value: NEW }, '+ Ny kategori …'));
    category.value = S.settings.categories.includes(selected) ? selected : (S.settings.categories[0] || NEW);
  };
  fillCategories(pantryCategory);
  category.addEventListener('change', () => {
    if (category.value !== NEW) { pantryCategory = category.value; return; }
    const wanted = (prompt('Hva skal den nye kategorien hete?') || '').trim();
    if (!wanted) return fillCategories(pantryCategory);
    run(async () => {
      await api('PUT', '/settings', { categories: [...S.settings.categories, wanted] });
      await refresh();
      pantryCategory = S.settings.categories.find((c) => c.toLowerCase() === wanted.toLowerCase()) || pantryCategory;
      fillCategories(pantryCategory);
    });
  });
  const nodes = [
    h('form', {
      class: 'card', style: 'display:grid;gap:8px',
      onsubmit: (e) => {
        e.preventDefault();
        if (category.value === NEW) return toast('Velg en kategori først');
        run(async () => { await api('POST', '/pantry', { name: name.value, category: category.value }); await reload(); });
      },
    }, name,
       h('div', { class: 'row' }, h('div', { class: 'grow' }, category),
         h('button', { class: 'primary', type: 'submit' }, 'Legg til'))),
  ];

  if (!S.pantry.length) {
    nodes.push(h('div', { class: 'card empty' },
      'Basisvarer er det dere vanligvis alltid har: krydder, mel, melk, egg. Marker en vare som tom, så havner den på handlelista.',
      h('button', {
        onclick: () => run(async () => {
          await api('POST', '/pantry/bulk', { items: COMMON_STAPLES.map(([n, c]) => ({ name: n, category: c })) });
          await reload();
        }),
      }, 'Start med vanlige basisvarer')));
  }

  const row = (p) => h('div', { class: `item${p.in_stock ? '' : ' out'}` },
    h('div', { class: 'label grow' }, p.name),
    p.in_stock
      ? h('button', { class: 'small', onclick: () => setStock(p, false) }, 'Tomt')
      : h('button', { class: 'small primary', onclick: () => setStock(p, true) }, 'Har igjen'),
    h('button', {
      class: 'small ghost', 'aria-label': `Fjern ${p.name}`,
      onclick: () => { if (confirm(`Fjerne ${p.name} fra basisvarene?`)) run(async () => { await api('DELETE', `/pantry/${p.id}`); await reload(); }); },
    }, '✕'));

  const out = S.pantry.filter((p) => !p.in_stock);
  if (out.length) {
    nodes.push(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'badge out' }, `Tomt: ${out.length}`), h('span', { class: 'muted' }, 'Står på handlelista')),
      h('div', { class: 'list' }, out.map(row))));
  }
  const groups = [...new Set([...S.settings.categories, ...S.pantry.map((p) => p.category)])];
  nodes.push(h('div', { class: 'cards-grid top-aligned' }, groups.map((g) => {
    const items = S.pantry.filter((p) => p.category === g && p.in_stock);
    if (!items.length) return null;
    return h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin:0' }, g), h('div', { class: 'list' }, items.map(row)));
  })));
  view.replaceChildren(...nodes);
}

function setStock(p, inStock) {
  return run(async () => { await api('PATCH', `/pantry/${p.id}`, { in_stock: inStock }); await reload(); });
}

// ----------------------------------------------------------------- shopping

async function renderShopping() {
  const list = await api('GET', `/shopping?days=${shopDays}`);
  const days = h('select', { onchange: () => { shopDays = Number(days.value); render(); } },
    [3, 5, 7, 10, 14].map((n) => h('option', { value: n }, `Middager de neste ${n} dagene`)));
  days.value = shopDays;

  const open = list.dinners.filter((d) => !d.shopped);
  const left = list.buy.filter((i) => !i.checked).length;
  const nodes = [days];

  nodes.push(h('div', { class: 'card' },
    list.dinners.length
      ? [h('div', { class: 'muted' }, `${fmtShort(list.start)} – ${fmtShort(list.end)}`),
         h('div', null, list.dinners.map((d) => d.name + (d.shopped ? ' ✓' : '')).join(', ')),
         open.length < list.dinners.length && h('div', { class: 'muted' }, '✓ = allerede handlet')]
      : h('div', { class: 'muted' }, 'Ingen middager med oppskrift er planlagt disse dagene. Planlegg noen under Uke, så dukker ingrediensene opp her.')));

  nodes.push(h('div', { class: 'row wrap' },
    h('button', { class: 'primary grow', onclick: () => openOda(list) }, '🛒 Fyll Oda-handlekurven'),
    h('button', {
      class: 'grow',
      onclick: () => {
        if (!confirm('Markere alt som kjøpt? Lista tømmes, basisvarene dere var tomme for settes som på lager, og middagene markeres som handlet.')) return;
        run(async () => { await api('POST', `/shopping/finish?days=${shopDays}`); toast('Handelen er ferdig'); await reload(); });
      },
    }, 'Ferdig handlet')));

  const buyRow = (i) => h('label', { class: `item${i.checked ? ' checked' : ''}` },
    h('input', {
      type: 'checkbox', checked: i.checked,
      onchange: (e) => run(async () => { await api('POST', '/shopping/check', { key: i.key, checked: e.target.checked }); await render(); }),
    }),
    h('div', { class: 'grow' },
      h('div', { class: 'label' }, buyText(i)),
      useChips(i),
      buyNote(i) && h('div', { class: 'muted' }, buyNote(i))),
    i.kind === 'extra' && h('button', {
      class: 'small ghost', 'aria-label': `Fjern ${i.name}`,
      onclick: (e) => { e.preventDefault(); run(async () => { await api('DELETE', `/shopping/extra/${i.extra_id}`); await render(); }); },
    }, '✕'));

  const extra = h('input', { placeholder: 'Legg til noe annet, f.eks. dopapir' });
  nodes.push(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Må kjøpes'), h('span', { class: 'badge warn' }, `${left} igjen`)),
    h('p', { class: 'muted' }, 'Kryss av det dere allerede har eller har lagt i kurven.'),
    h('form', {
      class: 'row', style: 'margin:8px 0 4px',
      onsubmit: (e) => {
        e.preventDefault();
        run(async () => { await api('POST', '/shopping/extra', { name: extra.value }); await render(); });
      },
    }, h('div', { class: 'grow' }, extra), h('button', { type: 'submit' }, 'Legg til')),
    list.buy.length
      ? groupBuy(list).map(([group, items]) => [
          h('div', { class: 'buy-group' }, group),
          h('div', { class: 'list' }, items.map((i) => buyRow(i)))])
      : h('div', { class: 'muted', style: 'padding:10px 0' }, 'Ingenting å kjøpe.')));

  if (list.have.length) {
    nodes.push(h('div', { class: 'card' },
      h('h3', null, 'Trengs, men skal finnes hjemme'),
      h('p', { class: 'muted' }, 'Ta en rask sjekk. Trykk «Tomt» for å flytte en vare til lista.'),
      h('div', { class: 'list' }, list.have.map((i) => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'label' }, buyText(i)),
          useChips(i) || h('div', { class: 'muted' }, [i.side ? 'tilbehør' : '', i.recipes.join(', ')].filter(Boolean).join(' · '))),
        h('button', { class: 'small', onclick: () => run(async () => { await api('PATCH', `/pantry/${i.pantry_id}`, { in_stock: false }); await reload(); }) }, 'Tomt'))))));
  }
  view.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------- Oda

function priceText(p) {
  if (p.price == null || p.price === '') return '';
  return /^[\d.,\s]+$/.test(String(p.price)) ? `${p.price} kr` : String(p.price);
}

function odaConnectDialog() {
  openDialog('Koble til Oda', [
    h('p', null, 'Koble til Oda-kontoen én gang, så kan appen finne varene på handlelista og legge dem i handlekurven hos Oda.'),
    h('p', { class: 'muted' }, 'Du logger inn på oda.com og godkjenner tilgangen der. Appen kan bare fylle handlekurven: du ser over og betaler hos Oda selv.'),
    h('a', { class: 'btn primary', href: '/api/oda/connect' }, 'Koble til Oda-konto'),
  ]);
}

async function openOda(list) {
  const items = list.buy.filter((i) => !i.checked);
  if (!items.length) return toast('Ingenting igjen å kjøpe');
  if (!S.oda_connected) return odaConnectDialog();

  openDialog('Fyll Oda-handlekurven', [h('p', { class: 'muted' }, 'Slår opp varene hos Oda …')], { wide: true });
  let found = {};
  try {
    found = await api('POST', '/oda/search', { queries: items.map((i) => i.name) });
  } catch (e) {
    if (e.status === 409) { S.oda_connected = false; return odaConnectDialog(); }
    return openDialog('Fyll Oda-handlekurven', [h('p', null, e.message)]);
  }

  const total = h('strong');
  // Price of what is chosen; it matches the subtotal ("Delsum") at Oda. Oda's own total after
  // adding also has delivery packaging and any small-order fee, and covers the whole cart.
  const kroner = (chosen) => chosen.reduce((s, c) => s + (parseFloat(c.price) || 0) * c.quantity, 0).toFixed(2).replace('.', ',');
  const updateTotal = () => {
    const chosen = rows.map((r) => r.get()).filter(Boolean);
    total.textContent = `${chosen.length} av ${rows.length} valgt · ca. ${kroner(chosen)} kr`;
  };

  const rows = items.map((item) => {
    // The product chosen last time for this ingredient, if any.
    const usual = item.oda && { id: item.oda.product_id, name: item.oda.name, price: item.oda.price, url: item.oda.url, image: item.oda.image };
    let products = [];
    let selected = null;
    let count = packCount(item);
    const cards = h('div', { class: 'products' });
    const state = h('span', { class: 'badge' });

    const card = (p) => {
      const on = p.id === selected;
      const toggle = () => { selected = on ? null : p.id; draw(); };
      const step = (delta) => (e) => { e.stopPropagation(); count = Math.max(1, Math.min(30, count + delta)); draw(); };
      return h('div', {
        class: `product${on ? ' on' : ''}${p.available === false ? ' unavailable' : ''}`,
        role: 'button', tabIndex: 0, 'aria-pressed': String(on),
        onclick: toggle,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
      },
        p.image
          ? h('img', { src: p.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
          : h('div', { class: 'no-image' }, '🛒'),
        on && h('span', { class: 'check' }, '✓'),
        h('div', { class: 'product-name' }, p.name),
        h('div', { class: 'muted product-extra' }, [p.description, p.available === false ? 'ikke tilgjengelig' : ''].filter(Boolean).join(' · ')),
        h('div', { class: 'product-price' }, priceText(p)),
        usual && p.id === usual.id && h('span', { class: 'badge ok' }, 'Deres faste'),
        on && h('div', { class: 'stepper' },
          h('button', { type: 'button', class: 'small', 'aria-label': 'Færre', onclick: step(-1) }, '−'),
          h('span', null, `${count} stk`),
          h('button', { type: 'button', class: 'small', 'aria-label': 'Flere', onclick: step(1) }, '+')));
    };
    const draw = () => {
      cards.replaceChildren(...products.map(card));
      if (!products.length) cards.append(h('p', { class: 'muted' }, 'Fant ingen varer. Prøv et annet søkeord under.'));
      state.className = `badge ${selected == null ? 'warn' : 'ok'}`;
      state.textContent = selected == null ? 'Hoppes over' : 'Valgt';
      updateTotal();
    };
    const setProducts = (list) => {
      products = list;
      if (usual) products = [list.find((p) => p.id === usual.id) || usual, ...list.filter((p) => p.id !== usual.id)];
      const firstAvailable = products.find((p) => p.available !== false);
      selected = usual ? usual.id : (firstAvailable ? firstAvailable.id : null);
    };
    setProducts(found[item.name] || []);

    const term = h('input', { placeholder: 'Søk hos Oda etter noe annet', value: item.name, 'aria-label': `Søk hos Oda for ${item.name}` });
    const el = h('div', { class: 'oda-row' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', null, buyText(item)), useChips(item, { always: true })), state),
      cards,
      h('form', {
        class: 'row oda-search',
        onsubmit: (e) => {
          e.preventDefault();
          const q = term.value.trim();
          if (!q) return;
          run(async () => {
            const res = await api('POST', '/oda/search', { queries: [q] });
            setProducts(res[q] || Object.values(res)[0] || []);
            draw();
            if (!products.length) toast('Oda fant ingenting');
          });
        },
      }, h('div', { class: 'grow' }, term), h('button', { class: 'small', type: 'submit' }, 'Søk')));
    const get = () => {
      const p = products.find((x) => x.id === selected);
      if (!p) return null;
      return { name: item.name, product_id: p.id, product_name: p.name, price: p.price == null ? null : String(p.price), url: p.url || null, image: p.image || null, quantity: count };
    };
    return { el, get, draw };
  });
  rows.forEach((r) => r.draw());

  const send = h('button', { class: 'primary' }, 'Legg i Oda-handlekurven');
  send.addEventListener('click', async () => {
    const chosen = rows.map((r) => r.get()).filter(Boolean);
    if (!chosen.length) return toast('Ingenting valgt');
    send.disabled = true;
    send.textContent = 'Legger til …';
    try {
      const cart = await api('POST', '/oda/cart', { items: chosen });
      openDialog('Lagt i Oda-handlekurven', [
        h('p', null, `${chosen.length} varer ble lagt til, for ca. ${kroner(chosen)} kr.`),
        cart.total != null && h('p', null, `Totalt i handlekurven hos Oda: ${Number(cart.total).toFixed(2).replace('.', ',')} kr`,
          h('span', { class: 'muted', style: 'display:block;font-size:.9rem' },
            'Inkludert leveringsemballasje, eventuelt tillegg for liten bestilling og det som lå i kurven fra før.')),
        cart.messages.length ? h('p', { class: 'muted' }, cart.messages.join(' ')) : null,
        h('p', { class: 'muted' }, 'Se over handlekurven, velg leveringstid og betal hos Oda.'),
        h('a', { class: 'btn primary', href: cart.url || 'https://oda.com/no/cart/', target: '_blank', rel: 'noopener' }, 'Åpne Oda-handlekurven'),
      ]);
    } catch (e) {
      send.disabled = false;
      send.textContent = 'Legg i Oda-handlekurven';
      if (e.status === 409) { S.oda_connected = false; return odaConnectDialog(); }
      toast(e.message);
    }
  });

  openDialog('Fyll Oda-handlekurven', [
    h('p', { class: 'muted' }, 'Trykk på varen dere vil ha. Trykk på den en gang til for å hoppe over. Appen husker valgene til neste gang.'),
    rows.map((r) => h('div', { class: 'card' }, r.el)),
    h('div', { class: 'oda-footer' }, total, send),
  ], { wide: true });
}

// ----------------------------------------------------------------- settings

/** A card for editing one of the household's own lists (units, categories). */
function listEditor(title, hint, key, placeholder) {
  const values = S.settings[key];
  const input = h('input', { placeholder, autocapitalize: 'off' });
  const save = (next) => run(async () => { await api('PUT', '/settings', { [key]: next }); await reload(); openSettings(); });
  return h('div', { class: 'card', style: 'display:grid;gap:8px' },
    h('h3', null, title),
    h('p', { class: 'muted' }, hint),
    h('div', { class: 'chips' }, values.map((v) => h('span', { class: 'tag' }, v,
      h('button', { class: 'tag-x', 'aria-label': `Fjern ${v}`, onclick: () => save(values.filter((x) => x !== v)) }, '✕')))),
    h('form', {
      class: 'row',
      onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) save([...values, input.value]); },
    }, h('div', { class: 'grow' }, input), h('button', { type: 'submit' }, 'Legg til')));
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
}

function openThemes() {
  const current = document.documentElement.dataset.theme || '';
  openDialog('Velg tema', THEMES.map(([id, label, text]) => h('button', {
    class: `theme-choice${id === current ? ' on' : ''}`,
    onclick: () => { applyTheme(id); closeDialog(); },
  }, h('span', { class: `swatch swatch-${id || 'auto'}` }),
     h('span', { class: 'grow' }, h('strong', null, label), h('span', { class: 'muted', style: 'display:block' }, text)),
     id === current ? '✓' : null)));
}
document.getElementById('theme-btn').addEventListener('click', openThemes);

// Google Calendar's fixed event colours (colorId -> name, colour as Google shows it).
const GCAL_COLORS = [
  ['1', 'Lavendel', '#7986cb'], ['2', 'Salvie', '#33b679'], ['3', 'Drue', '#8e24aa'],
  ['4', 'Flamingo', '#e67c73'], ['5', 'Banan', '#f6bf26'], ['6', 'Mandarin', '#f4511e'],
  ['7', 'Påfugl', '#039be5'], ['8', 'Grafitt', '#616161'], ['9', 'Blåbær', '#3f51b5'],
  ['10', 'Basilikum', '#0b8043'], ['11', 'Tomat', '#d50000'],
];

/** Chips for picking a Google event colour. emptyLabel names the "no colour of its own" choice. */
function colorPicker({ current, label, emptyLabel, onPick }) {
  const choice = (id, name, color) => h('button', {
    class: `color-choice${id === current ? ' on' : ''}`, title: name, 'aria-label': name,
    'aria-pressed': String(id === current), onclick: () => id !== current && onPick(id),
  }, color ? h('span', { class: 'color-dot', style: `background:${color}` }) : null, id ? null : emptyLabel);
  return h('div', { style: 'display:grid;gap:6px' },
    h('div', null, `${label}: `,
      h('strong', null, (GCAL_COLORS.find(([id]) => id === current) || [, emptyLabel.toLowerCase()])[1])),
    h('div', { class: 'chips' }, choice('', emptyLabel), GCAL_COLORS.map(([id, name, color]) => choice(id, name, color))));
}

function saveColor(path, body, refreshSettings) {
  return run(async () => {
    const res = await api('PUT', path, body);
    await refreshSettings();
    if (res.gcal_error) toast(`Noe ble ikke oppdatert i kalenderen: ${res.gcal_error}`);
  });
}

// Whether the Google Calendar card is expanded. Kept here because Innstillinger is drawn
// again after every save, which would otherwise close it.
let calendarOpen = false;

/** Google Calendar: which calendar each cook's dinners go to, and the on/off switch.
 * Collapsed until opened; the heading shows whether it is on and if anything failed. */
function calendarCard() {
  const g = S.gcal;
  const status = !g.configured ? 'ikke satt opp'
    : !g.enabled ? 'av'
    : g.errors || g.pending_deletes ? '⚠ på, noe er ikke oppdatert' : 'på';
  const card = h('div', { style: 'display:grid;gap:8px;margin-top:8px' });
  const box = h('details', {
    class: 'card settings-section', open: calendarOpen,
    ontoggle: (e) => { calendarOpen = e.target.open; },
  }, h('summary', null, h('h3', null, 'Google Kalender'), h('span', { class: 'muted' }, status)), card);
  if (!g.configured) {
    card.append(h('p', { class: 'muted' },
      'Ikke satt opp. Serveren trenger nøkkelen til en Google-tjenestekonto (GOOGLE_SERVICE_ACCOUNT_JSON).'));
    return box;
  }
  const refreshSettings = async () => { await reload(); openSettings(); };
  card.append(...[
    h('p', { class: 'muted' },
      'Middagen legges i kalenderen til den som lager mat, fra «start senest» til middagstid. ',
      'Del kalenderen din i Google Kalender med denne adressen, med «Gjøre endringer i aktiviteter»:'),
    h('input', { value: g.service_email, readOnly: true, onfocus: (e) => e.target.select() }),
    S.members.length
      ? h('div', { class: 'list' }, S.members.map((m) => {
          const input = h('input', {
            value: m.gcal_calendar_id || '', placeholder: 'Kalender-ID, ofte e-postadressen', autocapitalize: 'off',
          });
          const form = h('form', {
            class: 'item',
            onsubmit: (e) => {
              e.preventDefault();
              run(async () => {
                const res = await api('PUT', `/members/${m.id}/calendar`, { calendar_id: input.value });
                await refreshSettings();
                toast(res.warning || 'Kalenderen er lagret');
              });
            },
          }, h('div', { class: 'label', style: 'min-width:5em' }, m.name), h('div', { class: 'grow' }, input),
             h('button', { class: 'small', type: 'submit' }, 'Lagre'));
          if (!g.enabled) return form;
          return h('div', { style: 'display:grid;gap:6px' }, form, colorPicker({
            current: m.gcal_color || '', label: `Farge når ${m.name} lager mat`, emptyLabel: 'Standardfargen',
            onPick: (id) => saveColor(`/members/${m.id}/color`, { color: id }, refreshSettings),
          }));
        }))
      : h('p', { class: 'muted' }, 'Legg til hvem som lager mat først.'),
    h('label', { class: 'row' },
      h('input', {
        type: 'checkbox', checked: g.enabled,
        onchange: (e) => run(async () => {
          const res = await api('PUT', '/gcal', { enabled: e.target.checked });
          await refreshSettings();
          if (res.error) toast(`Noe kom ikke inn i kalenderen: ${res.error}`);
        }),
      }),
      h('span', { class: 'grow' }, 'Legg middagene inn i Google Kalender')),
    g.enabled && colorPicker({
      current: S.settings.gcal_color || '', label: 'Standardfarge (for kokker uten egen farge)',
      emptyLabel: 'Kalenderens egen',
      onPick: (id) => saveColor('/settings', { gcal_color: id }, refreshSettings),
    }),
    g.enabled && (g.errors || g.pending_deletes)
      ? h('p', { class: 'gcal-error' },
          [g.errors && `${g.errors} middag(er) er ikke oppdatert i kalenderen.`,
           g.pending_deletes && `${g.pending_deletes} hendelse(r) venter på å bli slettet.`].filter(Boolean).join(' '))
      : null,
    g.enabled && h('button', { onclick: () => retryCalendar(null).then(() => openSettings()) }, 'Synk alle kommende middager'),
  ].filter(Boolean));
  return box;
}

function openSettings() {
  const name = h('input', { placeholder: 'Navn' });
  const time = h('input', {
    type: 'time', value: S.settings.dinner_time,
    onchange: () => run(async () => { await api('PUT', '/settings', { dinner_time: time.value }); await reload(); }),
  });
  openDialog('Innstillinger', [
    h('div', { class: 'card' },
      h('h3', null, 'Hvem lager mat'),
      S.members.length
        ? h('div', { class: 'list' }, S.members.map((m) => h('div', { class: 'item' },
            h('div', { class: 'label grow' }, m.name),
            h('button', { class: 'small ghost', onclick: () => run(async () => { await api('DELETE', `/members/${m.id}`); await reload(); openSettings(); }) }, 'Fjern'))))
        : h('p', { class: 'muted' }, 'Ingen ennå.'),
      h('form', {
        class: 'row', style: 'margin-top:8px',
        onsubmit: (e) => {
          e.preventDefault();
          run(async () => { await api('POST', '/members', { name: name.value }); await reload(); openSettings(); });
        },
      }, h('div', { class: 'grow' }, name), h('button', { type: 'submit' }, 'Legg til'))),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, 'Vi spiser middag klokka', time),
      h('p', { class: 'muted', style: 'margin-top:6px' }, 'Brukes til å vise når matlagingen må starte.')),
    listEditor('Enheter', 'Vises som forslag når dere skriver inn ingredienser.', 'units', 'Ny enhet, f.eks. klype'),
    listEditor('Kategorier for basisvarer', 'Varer som allerede ligger i en kategori dere fjerner, blir liggende der.', 'categories', 'Ny kategori, f.eks. Drikke'),
    calendarCard(),
    h('div', { class: 'card row' },
      h('div', { class: 'grow' }, h('h3', null, 'Statistikk'),
        h('p', { class: 'muted' }, 'Hva dere lager, hvem som lager det, og balansen i middagene over tid.')),
      h('button', { onclick: () => { closeDialog(); location.hash = '#stats'; } }, '📊 Åpne')),
    h('div', { class: 'card', style: 'display:grid;gap:8px' },
      h('h3', null, 'Oda'),
      S.oda_connected
        ? [h('p', { class: 'muted' }, 'Koblet til. Appen kan søke etter varer og fylle handlekurven.'),
           h('button', { class: 'danger', onclick: () => run(async () => { await api('POST', '/oda/disconnect'); await reload(); openSettings(); }) }, 'Koble fra Oda')]
        : [h('p', { class: 'muted' }, 'Ikke koblet til.'),
           h('a', { class: 'btn', href: '/api/oda/connect' }, 'Koble til Oda-konto')]),
  ]);
}

init();

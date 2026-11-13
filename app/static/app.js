'use strict';

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');
const THEMES = [
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
let shopDays = 7;
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

const qtyText = (q) => (q == null ? '' : String(Math.round(q * 100) / 100));
const itemText = (i) => [qtyText(i.quantity), i.unit, i.name].filter(Boolean).join(' ');
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
  return ['week', 'recipes', 'pantry', 'shopping'].includes(t) ? t : 'week';
};

async function refresh() { S = await api('GET', '/state'); }

async function render() {
  if (!S) return;
  const tab = currentTab();
  view.dataset.tab = tab;
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === tab);
  await run({ week: renderWeek, recipes: renderRecipes, pantry: renderPantry, shopping: renderShopping }[tab]);
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
  weekStart = monday(S.today);
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

async function renderWeek() {
  const plan = await api('GET', `/plan?start=${weekStart}&days=7`);
  weekPlan = Object.fromEntries(plan.map((p) => [p.date, p]));
  const isThisWeek = weekStart === monday(S.today);
  const nodes = [
    h('div', { class: 'toolbar' },
      h('button', { class: 'small', onclick: () => { weekStart = addDays(weekStart, -7); render(); } }, '‹ Forrige'),
      h('div', { class: 'grow', style: 'text-align:center;font-weight:700' },
        `${fmtShort(weekStart)} – ${fmtShort(addDays(weekStart, 6))}`),
      h('button', { class: 'small', onclick: () => { weekStart = addDays(weekStart, 7); render(); } }, 'Neste ›')),
  ];
  if (isThisWeek) nodes.push(tonightCard(weekPlan[S.today]));
  else nodes.push(h('button', { class: 'small', onclick: () => { weekStart = monday(S.today); render(); } }, 'Tilbake til denne uka'));
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
    h('div', { class: 'big' }, p.recipe_name || p.note),
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
  card.append(h('button', {
    class: 'dish',
    onclick: () => (p.recipe_id ? openRecipe(p.recipe_id) : openPicker(date)),
  }, p.recipe_name || p.note));
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

function openRecipe(id) {
  const r = S.recipes.find((x) => x.id === id);
  if (!r) return;
  const total = r.prep_min + r.cook_min;
  openDialog(r.name, [
    h('div', { class: 'muted' }, [timeText(r), total ? `${mins(total)} totalt` : '', `${r.servings} porsjoner`].filter(Boolean).join(' · ')),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Ingredienser'),
      r.ingredients.some((i) => !i.side)
        ? h('div', { class: 'list' }, r.ingredients.filter((i) => !i.side).map((i) => h('div', { class: 'item' }, itemText(i))))
        : h('div', { class: 'muted' }, 'Ingen ingredienser lagt inn.')),
    r.ingredients.some((i) => i.side) && h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Tilbehør på bordet'),
      h('div', { class: 'chips' }, r.ingredients.filter((i) => i.side).map((i) => h('span', { class: 'tag plain' }, i.name)))),
    r.instructions && h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Slik gjør du'),
      h('div', { class: 'pre' }, r.instructions)),
    h('button', { onclick: () => openRecipeForm(r) }, 'Endre oppskrift'),
  ]);
}

function openRecipeForm(recipe) {
  const r = recipe || { name: '', prep_min: '', cook_min: '', servings: 4, instructions: '', ingredients: [] };
  const known = new Set(S.pantry.map((p) => p.name));
  for (const x of S.recipes) for (const i of x.ingredients) known.add(i.name);
  const knownList = [...known].sort((a, b) => a.localeCompare(b, 'nb'));

  const name = h('input', { value: r.name, placeholder: 'Taco, fiskesuppe, pannekaker …', required: true });
  const prep = h('input', { type: 'number', min: 0, inputMode: 'numeric', value: r.prep_min });
  const cook = h('input', { type: 'number', min: 0, inputMode: 'numeric', value: r.cook_min });
  const servings = h('input', { type: 'number', min: 1, inputMode: 'numeric', value: r.servings });
  const instructions = h('textarea', { value: r.instructions, placeholder: 'Fremgangsmåte, tips, ovnstemperatur …' });
  const rows = h('div', { style: 'display:grid;gap:6px' });
  const addRow = (ing = {}) => {
    const qty = h('input', { class: 'ing-qty', type: 'number', min: 0, step: 'any', inputMode: 'decimal', placeholder: 'Mengde', value: ing.quantity ?? '', 'aria-label': 'Mengde' });
    const unit = suggest(h('input', { placeholder: 'Enhet', value: ing.unit || '', 'aria-label': 'Enhet', autocapitalize: 'off' }),
      () => S.settings.units, { minChars: 0, max: 40 });
    unit.classList.add('ing-unit');
    const what = suggest(h('input', { placeholder: 'Ingrediens', value: ing.name || '', 'aria-label': 'Ingrediens' }),
      () => knownList, { minChars: 1, max: 6 });
    what.classList.add('ing-name');
    const row = h('div', { class: 'ing-row' }, qty, unit, what,
      h('button', { type: 'button', class: 'ghost ing-del', 'aria-label': 'Fjern ingrediens', onclick: () => { row.remove(); dlgDirty = true; } }, '✕'));
    rows.append(row);
    return row;
  };
  const mainIngredients = r.ingredients.filter((i) => !i.side);
  mainIngredients.forEach(addRow);
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
    x.ingredients.filter((i) => !i.side).forEach(addRow);
    x.ingredients.filter((i) => i.side).forEach((i) => addSide(i.name));
    if (!rows.children.length) addRow();
    dlgDirty = true;
  };
  const web = !recipe && webRecipeSearch(fill, () => Number(servings.value) || 4,
    () => Boolean(name.value.trim() || [...rows.querySelectorAll('input')].some((i) => i.value.trim())));

  const save = () => run(async () => {
    const ingredients = [...rows.children].map((row) => {
      const [q, u, n] = row.querySelectorAll('input');
      return { quantity: q.value === '' ? null : Number(q.value), unit: u.value.trim(), name: n.value.trim() };
    }).filter((i) => i.name);
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

  openDialog(recipe ? 'Endre oppskrift' : 'Ny oppskrift', [
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
      h('button', { type: 'button', class: 'small', onclick: () => addRow().querySelector('.ing-name input').focus() }, '+ Legg til ingrediens'),
      h('div', { class: 'section-title' }, 'Tilbehør på bordet'),
      h('p', { class: 'muted' }, 'Ting dere setter fram og forsyner dere av, som tyttebærsyltetøy eller flatbrød. Uten mengde. De legges også i basisvarene, så dere kan markere dem som tomme når det må kjøpes mer.'),
      sideRows,
      h('button', { type: 'button', class: 'small', onclick: () => addSide().querySelector('input').focus() }, '+ Legg til tilbehør'),
      h('label', { class: 'field' }, 'Slik gjør du', instructions),
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

  const buyRow = (i) => h('label', { class: `item${i.checked ? ' checked' : ''}` },
    h('input', {
      type: 'checkbox', checked: i.checked,
      onchange: (e) => run(async () => { await api('POST', '/shopping/check', { key: i.key, checked: e.target.checked }); await render(); }),
    }),
    h('div', { class: 'grow' },
      h('div', { class: 'label' }, itemText(i)),
      h('div', { class: 'muted' },
        i.kind === 'extra' ? 'Lagt til av deg'
          : [i.recipes.join(', '), i.staple_out ? 'basisvare dere er tomme for' : ''].filter(Boolean).join(' · '))),
    i.kind === 'extra' && h('button', {
      class: 'small ghost', 'aria-label': `Fjern ${i.name}`,
      onclick: (e) => { e.preventDefault(); run(async () => { await api('DELETE', `/shopping/extra/${i.extra_id}`); await render(); }); },
    }, '✕'));

  const extra = h('input', { placeholder: 'Legg til noe annet, f.eks. dopapir' });
  nodes.push(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Må kjøpes'), h('span', { class: 'badge warn' }, `${left} igjen`)),
    h('p', { class: 'muted' }, 'Kryss av det dere allerede har eller har lagt i kurven.'),
    list.buy.length ? h('div', { class: 'list' }, list.buy.map(buyRow)) : h('div', { class: 'muted', style: 'padding:10px 0' }, 'Ingenting å kjøpe.'),
    h('form', {
      class: 'row', style: 'margin-top:10px',
      onsubmit: (e) => {
        e.preventDefault();
        run(async () => { await api('POST', '/shopping/extra', { name: extra.value }); await render(); });
      },
    }, h('div', { class: 'grow' }, extra), h('button', { type: 'submit' }, 'Legg til'))));

  if (list.have.length) {
    nodes.push(h('div', { class: 'card' },
      h('h3', null, 'Trengs, men skal finnes hjemme'),
      h('p', { class: 'muted' }, 'Ta en rask sjekk. Trykk «Tomt» for å flytte en vare til lista.'),
      h('div', { class: 'list' }, list.have.map((i) => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'label' }, itemText(i)), h('div', { class: 'muted' }, [i.side ? 'tilbehør' : '', i.recipes.join(', ')].filter(Boolean).join(' · '))),
        h('button', { class: 'small', onclick: () => run(async () => { await api('PATCH', `/pantry/${i.pantry_id}`, { in_stock: false }); await reload(); }) }, 'Tomt'))))));
  }

  nodes.push(h('div', { class: 'row wrap' },
    h('button', { class: 'primary grow', onclick: () => openOda(list) }, '🛒 Fyll Oda-handlekurven'),
    h('button', {
      class: 'grow',
      onclick: () => {
        if (!confirm('Markere alt som kjøpt? Lista tømmes, basisvarene dere var tomme for settes som på lager, og middagene markeres som handlet.')) return;
        run(async () => { await api('POST', `/shopping/finish?days=${shopDays}`); toast('Handelen er ferdig'); await reload(); });
      },
    }, 'Ferdig handlet')));
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
  const updateTotal = () => {
    const chosen = rows.map((r) => r.get()).filter(Boolean);
    const sum = chosen.reduce((s, c) => s + (parseFloat(c.price) || 0) * c.quantity, 0);
    total.textContent = `${chosen.length} av ${rows.length} valgt · ca. ${sum.toFixed(2).replace('.', ',')} kr`;
  };

  const rows = items.map((item) => {
    // The product chosen last time for this ingredient, if any.
    const usual = item.oda && { id: item.oda.product_id, name: item.oda.name, price: item.oda.price, url: item.oda.url, image: item.oda.image };
    let products = [];
    let selected = null;
    let count = 1;
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
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, itemText(item)), state),
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
        h('p', null, `${chosen.length} varer ble lagt til.` + (cart.total ? ` Handlekurven er nå på ${priceText({ price: cart.total })}.` : '')),
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

function colorPicker(refreshSettings) {
  const current = S.settings.gcal_color || '';
  const pick = (id) => run(async () => {
    const res = await api('PUT', '/settings', { gcal_color: id });
    await refreshSettings();
    if (res.gcal_error) toast(`Noe ble ikke oppdatert i kalenderen: ${res.gcal_error}`);
  });
  const choice = (id, name, color) => h('button', {
    class: `color-choice${id === current ? ' on' : ''}`, title: name, 'aria-label': name,
    'aria-pressed': String(id === current), onclick: () => id !== current && pick(id),
  }, color ? h('span', { class: 'color-dot', style: `background:${color}` }) : null, id ? null : name);
  return h('div', { style: 'display:grid;gap:6px' },
    h('div', null, 'Farge på middagene: ',
      h('strong', null, (GCAL_COLORS.find(([id]) => id === current) || [, 'kalenderens egen'])[1])),
    h('div', { class: 'chips' }, choice('', 'Kalenderens egen'), GCAL_COLORS.map(([id, name, color]) => choice(id, name, color))));
}

/** Google Calendar: which calendar each cook's dinners go to, and the on/off switch. */
function calendarCard() {
  const g = S.gcal;
  const card = h('div', { class: 'card', style: 'display:grid;gap:8px' }, h('h3', null, 'Google Kalender'));
  if (!g.configured) {
    card.append(h('p', { class: 'muted' },
      'Ikke satt opp. Serveren trenger nøkkelen til en Google-tjenestekonto (GOOGLE_SERVICE_ACCOUNT_JSON).'));
    return card;
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
          return h('form', {
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
    g.enabled && colorPicker(refreshSettings),
    g.enabled && (g.errors || g.pending_deletes)
      ? h('p', { class: 'gcal-error' },
          [g.errors && `${g.errors} middag(er) er ikke oppdatert i kalenderen.`,
           g.pending_deletes && `${g.pending_deletes} hendelse(r) venter på å bli slettet.`].filter(Boolean).join(' '))
      : null,
    g.enabled && h('button', { onclick: () => retryCalendar(null).then(() => openSettings()) }, 'Synk alle kommende middager'),
  ].filter(Boolean));
  return card;
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

'use strict';

const view = document.getElementById('view');
const dlg = document.getElementById('dlg');
const CATEGORIES = ['Spices', 'Baking', 'Fridge', 'Bread & grains', 'Cans & jars', 'Freezer', 'Other'];
const UNITS = ['g', 'kg', 'dl', 'l', 'ml', 'ts', 'ss', 'stk', 'pk', 'boks', 'tsp', 'tbsp', 'pcs', 'can'];
const COMMON_STAPLES = [
  ['Salt', 'Spices'], ['Pepper', 'Spices'], ['Paprika', 'Spices'], ['Cumin', 'Spices'],
  ['Oregano', 'Spices'], ['Cinnamon', 'Spices'], ['Garlic powder', 'Spices'],
  ['Flour', 'Baking'], ['Sugar', 'Baking'], ['Baking powder', 'Baking'],
  ['Milk', 'Fridge'], ['Eggs', 'Fridge'], ['Butter', 'Fridge'], ['Cheese', 'Fridge'],
  ['Bread', 'Bread & grains'], ['Rice', 'Bread & grains'], ['Pasta', 'Bread & grains'],
  ['Olive oil', 'Cans & jars'], ['Canned tomatoes', 'Cans & jars'], ['Stock cubes', 'Cans & jars'],
  ['Onions', 'Other'], ['Garlic', 'Other'], ['Potatoes', 'Other'],
];

let S = null;          // household state from /api/state
let weekStart = null;  // Monday of the week on screen
let weekPlan = {};     // date -> plan entry for the week on screen
let shopDays = 7;

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
    const err = new Error('Please log in');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not JSON */ }
    const err = new Error(typeof msg === 'string' ? msg : 'Something went wrong');
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
const fmtDay = (s) => D(s).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
const fmtShort = (s) => D(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function mins(n) {
  if (!n) return '';
  const hrs = Math.floor(n / 60), m = n % 60;
  return hrs ? `${hrs} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

function startBy(total) {
  const [hh, mm] = (S.settings.dinner_time || '17:00').split(':').map(Number);
  const t = ((hh * 60 + mm - total) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function timeText(r) {
  const parts = [];
  if (r.prep_min) parts.push(`${mins(r.prep_min)} prep`);
  if (r.cook_min) parts.push(`${mins(r.cook_min)} cooking`);
  return parts.join(' + ');
}

const qtyText = (q) => (q == null ? '' : String(Math.round(q * 100) / 100));
const itemText = (i) => [qtyText(i.quantity), i.unit, i.name].filter(Boolean).join(' ');
const memberName = (id) => (S.members.find((m) => m.id === id) || {}).name;

function openDialog(title, nodes) {
  document.getElementById('dlg-title').textContent = title;
  document.getElementById('dlg-body').replaceChildren(...[nodes].flat());
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
function closeDialog() { if (dlg.open) dlg.close(); }
document.getElementById('dlg-close').addEventListener('click', closeDialog);
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });

// ------------------------------------------------------------------ routing

const currentTab = () => {
  const t = location.hash.replace('#', '');
  return ['week', 'recipes', 'pantry', 'shopping'].includes(t) ? t : 'week';
};

async function refresh() { S = await api('GET', '/state'); }

async function render() {
  if (!S) return;
  const tab = currentTab();
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
      connected: 'Oda is connected',
      denied: 'Oda was not connected',
      error: 'Could not connect to Oda. Try again.',
    };
    toast(messages[params.get('oda')] || '');
    history.replaceState(null, '', location.pathname + location.hash);
  }
  await render();
}

function showLogin() {
  closeDialog();
  const pw = h('input', { type: 'password', placeholder: 'Household password', autocomplete: 'current-password' });
  view.replaceChildren(h('form', {
    class: 'card', style: 'display:grid;gap:10px',
    onsubmit: (e) => {
      e.preventDefault();
      run(async () => { await api('POST', '/login', { password: pw.value }); await init(); });
    },
  }, h('h2', null, 'Log in'), pw, h('button', { class: 'primary', type: 'submit' }, 'Log in')));
}

// --------------------------------------------------------------------- week

async function renderWeek() {
  const plan = await api('GET', `/plan?start=${weekStart}&days=7`);
  weekPlan = Object.fromEntries(plan.map((p) => [p.date, p]));
  const isThisWeek = weekStart === monday(S.today);
  const nodes = [
    h('div', { class: 'toolbar' },
      h('button', { class: 'small', onclick: () => { weekStart = addDays(weekStart, -7); render(); } }, '‹ Earlier'),
      h('div', { class: 'grow', style: 'text-align:center;font-weight:700' },
        `${fmtShort(weekStart)} – ${fmtShort(addDays(weekStart, 6))}`),
      h('button', { class: 'small', onclick: () => { weekStart = addDays(weekStart, 7); render(); } }, 'Later ›')),
  ];
  if (isThisWeek) nodes.push(tonightCard(weekPlan[S.today]));
  else nodes.push(h('button', { class: 'small', onclick: () => { weekStart = monday(S.today); render(); } }, 'Back to this week'));
  if (!S.members.length) {
    nodes.push(h('div', { class: 'card row' },
      h('div', { class: 'grow muted' }, 'Add who cooks, so every dinner can have a cook assigned.'),
      h('button', { class: 'small', onclick: openSettings }, 'Add cooks')));
  }
  for (let i = 0; i < 7; i++) nodes.push(dayCard(addDays(weekStart, i)));
  view.replaceChildren(...nodes);
}

function tonightCard(p) {
  const planned = p && (p.recipe_id || p.note);
  if (!planned) {
    return h('div', { class: 'card tonight row' },
      h('div', { class: 'grow' }, h('div', { class: 'muted' }, 'Tonight'), h('div', { class: 'big' }, 'Nothing planned yet')),
      h('button', { class: 'primary', onclick: () => openPicker(S.today) }, 'Plan it'));
  }
  const total = (p.prep_min || 0) + (p.cook_min || 0);
  const cook = memberName(p.cook_id);
  return h('div', { class: 'card tonight' },
    h('div', { class: 'muted' }, 'Tonight'),
    h('div', { class: 'big' }, p.recipe_name || p.note),
    h('div', null,
      cook ? `${cook} cooks` : h('span', { class: 'need-cook' }, 'Nobody is assigned to cook yet'),
      total ? ` · ${mins(total)} · start by ${startBy(total)} to eat at ${S.settings.dinner_time}` : ''));
}

function dayCard(date) {
  const p = weekPlan[date];
  const planned = p && (p.recipe_id || p.note);
  const isToday = date === S.today;
  const card = h('div', { class: `card day${isToday ? ' today' : ''}${date < S.today ? ' past' : ''}` });
  card.append(h('div', { class: 'row' },
    h('div', { class: 'day-label grow' }, fmtDay(date) + (isToday ? ' · today' : '')),
    planned && h('button', { class: 'small ghost', onclick: () => openPicker(date) }, 'Change'),
    planned && h('button', { class: 'small ghost', 'aria-label': 'Clear this day', onclick: () => savePlan(date, { recipe_id: null, note: '', cook_id: null }) }, '✕')));

  if (!planned) {
    card.append(h('div', { class: 'row' },
      h('button', { class: 'plan-btn grow', onclick: () => openPicker(date) }, '+ Plan dinner'),
      S.recipes.length > 0 && h('button', { onclick: () => surprise(date), title: 'Pick a recipe for me' }, '🎲')));
    return card;
  }

  const total = (p.prep_min || 0) + (p.cook_min || 0);
  card.append(h('button', {
    class: 'dish',
    onclick: () => (p.recipe_id ? openRecipe(p.recipe_id) : openPicker(date)),
  }, p.recipe_name || p.note));
  const meta = [];
  if (total) meta.push(`${timeText(p)} · start by ${startBy(total)}`);
  if (p.recipe_id && p.note) meta.push(p.note);
  if (meta.length || p.shopped) {
    card.append(h('div', { class: 'muted' }, meta.join(' · '), p.shopped ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, 'shopped') : null));
  }
  if (S.members.length) {
    card.append(h('div', { class: 'chips' },
      S.members.map((m) => h('button', {
        class: `chip${p.cook_id === m.id ? ' on' : ''}`,
        onclick: () => savePlan(date, { cook_id: p.cook_id === m.id ? null : m.id }),
      }, m.name)),
      !p.cook_id && h('span', { class: 'need-cook' }, '← Who cooks?')));
  }
  return card;
}

async function savePlan(date, patch) {
  const cur = weekPlan[date] || {};
  const body = { recipe_id: cur.recipe_id ?? null, note: cur.note || '', cook_id: cur.cook_id ?? null, ...patch };
  await run(async () => {
    await api('PUT', `/plan/${date}`, body);
    closeDialog();
    await reload();
  });
}

function leastRecent(recipes) {
  return [...recipes].sort((a, b) => (a.last_planned || '').localeCompare(b.last_planned || ''));
}

function surprise(date) {
  const used = new Set(Object.values(weekPlan).map((p) => p.recipe_id));
  let pool = S.recipes.filter((r) => !used.has(r.id));
  if (!pool.length) pool = S.recipes;
  if (!pool.length) return toast('Add a recipe first');
  const top = leastRecent(pool).slice(0, 3);
  const pick = top[Math.floor(Math.random() * top.length)];
  savePlan(date, { recipe_id: pick.id, note: '' });
}

function openPicker(date) {
  const listEl = h('div', { style: 'display:grid;gap:6px' });
  const search = h('input', { type: 'search', placeholder: 'Search recipes' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const matches = leastRecent(S.recipes).filter((r) => r.name.toLowerCase().includes(q));
    listEl.replaceChildren(...matches.map((r) => h('button', {
      class: 'pick', onclick: () => savePlan(date, { recipe_id: r.id, note: '' }),
    }, h('span', null, r.name),
       h('span', { class: 'muted' }, mins(r.prep_min + r.cook_min) || ''))));
    if (!matches.length) listEl.append(h('p', { class: 'muted' }, S.recipes.length ? 'No recipe matches.' : 'No recipes yet. Add some under Recipes.'));
  };
  search.addEventListener('input', fill);
  fill();
  const note = h('input', { placeholder: 'Leftovers, takeaway, at grandma’s…', value: (weekPlan[date] || {}).recipe_id ? '' : ((weekPlan[date] || {}).note || '') });
  openDialog(fmtDay(date), [
    S.recipes.length > 0 && h('div', { class: 'row' }, h('div', { class: 'grow' }, search),
      h('button', { onclick: () => surprise(date) }, '🎲 Surprise me')),
    listEl,
    h('div', { class: 'section-title' }, 'Or something without a recipe'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (note.value.trim()) savePlan(date, { recipe_id: null, note: note.value }); } },
      h('div', { class: 'grow' }, note), h('button', { type: 'submit' }, 'Save')),
  ]);
}

// ------------------------------------------------------------------ recipes

function renderRecipes() {
  const nodes = [h('button', { class: 'primary', onclick: () => openRecipeForm() }, '+ New recipe')];
  if (!S.recipes.length) {
    nodes.push(h('div', { class: 'card empty' }, 'No recipes yet. Add the dinners you already make — five or six is enough to start planning.'));
  }
  for (const r of S.recipes) {
    nodes.push(h('button', { class: 'card recipe-card', onclick: () => openRecipe(r.id) },
      h('h3', null, r.name),
      h('div', { class: 'muted' }, [timeText(r), `${r.ingredients.length} ingredients`, `serves ${r.servings}`].filter(Boolean).join(' · '))));
  }
  view.replaceChildren(...nodes);
}

function openRecipe(id) {
  const r = S.recipes.find((x) => x.id === id);
  if (!r) return;
  const total = r.prep_min + r.cook_min;
  openDialog(r.name, [
    h('div', { class: 'muted' }, [timeText(r), total ? `${mins(total)} in total` : '', `serves ${r.servings}`].filter(Boolean).join(' · ')),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'Ingredients'),
      r.ingredients.length
        ? h('div', { class: 'list' }, r.ingredients.map((i) => h('div', { class: 'item' }, itemText(i))))
        : h('div', { class: 'muted' }, 'No ingredients added.')),
    r.instructions && h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin:0 0 6px' }, 'How to make it'),
      h('div', { class: 'pre' }, r.instructions)),
    h('button', { onclick: () => openRecipeForm(r) }, 'Edit recipe'),
  ]);
}

function openRecipeForm(recipe) {
  const r = recipe || { name: '', prep_min: '', cook_min: '', servings: 4, instructions: '', ingredients: [] };
  const known = new Set(S.pantry.map((p) => p.name));
  for (const x of S.recipes) for (const i of x.ingredients) known.add(i.name);

  const name = h('input', { value: r.name, placeholder: 'Taco, fish soup, pancakes…', required: true });
  const prep = h('input', { type: 'number', min: 0, inputMode: 'numeric', value: r.prep_min });
  const cook = h('input', { type: 'number', min: 0, inputMode: 'numeric', value: r.cook_min });
  const servings = h('input', { type: 'number', min: 1, inputMode: 'numeric', value: r.servings });
  const instructions = h('textarea', { value: r.instructions, placeholder: 'Steps, tips, oven temperature…' });
  const rows = h('div', { style: 'display:grid;gap:6px' });
  const addRow = (ing = {}) => {
    const row = h('div', { class: 'ing-row' },
      h('input', { type: 'number', min: 0, step: 'any', inputMode: 'decimal', placeholder: 'Qty', value: ing.quantity ?? '', 'aria-label': 'Quantity' }),
      h('input', { placeholder: 'Unit', value: ing.unit || '', list: 'units', 'aria-label': 'Unit' }),
      h('input', { placeholder: 'Ingredient', value: ing.name || '', list: 'ingredient-names', 'aria-label': 'Ingredient' }),
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Remove ingredient', onclick: () => row.remove() }, '✕'));
    rows.append(row);
    return row;
  };
  r.ingredients.forEach(addRow);
  for (let i = r.ingredients.length; i < 3; i++) addRow();

  const save = () => run(async () => {
    const ingredients = [...rows.children].map((row) => {
      const [q, u, n] = row.querySelectorAll('input');
      return { quantity: q.value === '' ? null : Number(q.value), unit: u.value.trim(), name: n.value.trim() };
    }).filter((i) => i.name);
    const body = {
      name: name.value, prep_min: Number(prep.value) || 0, cook_min: Number(cook.value) || 0,
      servings: Number(servings.value) || 4, instructions: instructions.value, ingredients,
    };
    if (recipe) await api('PUT', `/recipes/${recipe.id}`, body);
    else await api('POST', '/recipes', body);
    closeDialog();
    await reload();
  });

  openDialog(recipe ? 'Edit recipe' : 'New recipe', [
    h('datalist', { id: 'units' }, UNITS.map((u) => h('option', { value: u }))),
    h('datalist', { id: 'ingredient-names' }, [...known].sort().map((n) => h('option', { value: n }))),
    h('form', { style: 'display:grid;gap:12px', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'grid3' },
        h('label', { class: 'field' }, 'Prep (min)', prep),
        h('label', { class: 'field' }, 'Cooking (min)', cook),
        h('label', { class: 'field' }, 'Serves', servings)),
      h('div', { class: 'section-title' }, 'Ingredients'),
      h('p', { class: 'muted' }, 'Use the same name as in your pantry (for example “Milk”) so the shopping list knows you already have it.'),
      rows,
      h('button', { type: 'button', class: 'small', onclick: () => addRow().querySelector('input').focus() }, '+ Add ingredient'),
      h('label', { class: 'field' }, 'How to make it', instructions),
      h('div', { class: 'row' },
        h('button', { class: 'primary grow', type: 'submit' }, 'Save recipe'),
        recipe && h('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (!confirm(`Delete “${recipe.name}”? It is also removed from the plan.`)) return;
            run(async () => { await api('DELETE', `/recipes/${recipe.id}`); closeDialog(); await reload(); });
          },
        }, 'Delete'))),
  ]);
  if (!recipe) name.focus();
}

// ------------------------------------------------------------------- pantry

function renderPantry() {
  const name = h('input', { placeholder: 'Add a staple, e.g. soy sauce' });
  const category = h('select', null, CATEGORIES.map((c) => h('option', { value: c }, c)));
  category.value = 'Other';
  const nodes = [
    h('form', {
      class: 'card', style: 'display:grid;gap:8px',
      onsubmit: (e) => {
        e.preventDefault();
        run(async () => { await api('POST', '/pantry', { name: name.value, category: category.value }); await reload(); });
      },
    }, h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('div', { style: 'width:150px' }, category)),
       h('button', { class: 'primary', type: 'submit' }, 'Add to pantry')),
  ];

  if (!S.pantry.length) {
    nodes.push(h('div', { class: 'card empty' },
      'Staples are things you normally always have: spices, flour, milk, eggs. Mark one as out and it lands on the shopping list.',
      h('button', {
        onclick: () => run(async () => {
          await api('POST', '/pantry/bulk', { items: COMMON_STAPLES.map(([n, c]) => ({ name: n, category: c })) });
          await reload();
        }),
      }, 'Start with common staples')));
  }

  const row = (p) => h('div', { class: `item${p.in_stock ? '' : ' out'}` },
    h('div', { class: 'label grow' }, p.name),
    p.in_stock
      ? h('button', { class: 'small', onclick: () => setStock(p, false) }, 'We’re out')
      : h('button', { class: 'small primary', onclick: () => setStock(p, true) }, 'Got it again'),
    h('button', {
      class: 'small ghost', 'aria-label': `Remove ${p.name}`,
      onclick: () => { if (confirm(`Remove ${p.name} from the pantry?`)) run(async () => { await api('DELETE', `/pantry/${p.id}`); await reload(); }); },
    }, '✕'));

  const out = S.pantry.filter((p) => !p.in_stock);
  if (out.length) {
    nodes.push(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'badge out' }, `Out: ${out.length}`), h('span', { class: 'muted' }, 'On the shopping list')),
      h('div', { class: 'list' }, out.map(row))));
  }
  const groups = [...new Set([...CATEGORIES, ...S.pantry.map((p) => p.category)])];
  for (const g of groups) {
    const items = S.pantry.filter((p) => p.category === g && p.in_stock);
    if (!items.length) continue;
    nodes.push(h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin:0' }, g), h('div', { class: 'list' }, items.map(row))));
  }
  view.replaceChildren(...nodes);
}

function setStock(p, inStock) {
  return run(async () => { await api('PATCH', `/pantry/${p.id}`, { in_stock: inStock }); await reload(); });
}

// ----------------------------------------------------------------- shopping

async function renderShopping() {
  const list = await api('GET', `/shopping?days=${shopDays}`);
  const days = h('select', { onchange: () => { shopDays = Number(days.value); render(); } },
    [3, 5, 7, 10, 14].map((n) => h('option', { value: n }, `Dinners for the next ${n} days`)));
  days.value = shopDays;

  const open = list.dinners.filter((d) => !d.shopped);
  const left = list.buy.filter((i) => !i.checked).length;
  const nodes = [days];

  nodes.push(h('div', { class: 'card' },
    list.dinners.length
      ? [h('div', { class: 'muted' }, `${fmtShort(list.start)} – ${fmtShort(list.end)}`),
         h('div', null, list.dinners.map((d) => d.name + (d.shopped ? ' ✓' : '')).join(', ')),
         open.length < list.dinners.length && h('div', { class: 'muted' }, '✓ = already shopped for')]
      : h('div', { class: 'muted' }, 'No dinners with recipes are planned for these days. Plan some under Week and the ingredients show up here.')));

  const buyRow = (i) => h('label', { class: `item${i.checked ? ' checked' : ''}` },
    h('input', {
      type: 'checkbox', checked: i.checked,
      onchange: (e) => run(async () => { await api('POST', '/shopping/check', { key: i.key, checked: e.target.checked }); await render(); }),
    }),
    h('div', { class: 'grow' },
      h('div', { class: 'label' }, itemText(i)),
      h('div', { class: 'muted' },
        i.kind === 'extra' ? 'Added by you'
          : [i.recipes.join(', '), i.staple_out ? 'pantry staple you’re out of' : ''].filter(Boolean).join(' · '))),
    i.kind === 'extra' && h('button', {
      class: 'small ghost', 'aria-label': `Remove ${i.name}`,
      onclick: (e) => { e.preventDefault(); run(async () => { await api('DELETE', `/shopping/extra/${i.extra_id}`); await render(); }); },
    }, '✕'));

  const extra = h('input', { placeholder: 'Add something else, e.g. toilet paper' });
  nodes.push(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'To buy'), h('span', { class: 'badge warn' }, `${left} left`)),
    h('p', { class: 'muted' }, 'Tick off what you already have or have picked up.'),
    list.buy.length ? h('div', { class: 'list' }, list.buy.map(buyRow)) : h('div', { class: 'muted', style: 'padding:10px 0' }, 'Nothing to buy.'),
    h('form', {
      class: 'row', style: 'margin-top:10px',
      onsubmit: (e) => {
        e.preventDefault();
        run(async () => { await api('POST', '/shopping/extra', { name: extra.value }); await render(); });
      },
    }, h('div', { class: 'grow' }, extra), h('button', { type: 'submit' }, 'Add'))));

  if (list.have.length) {
    nodes.push(h('div', { class: 'card' },
      h('h3', null, 'Needed, but should be in your pantry'),
      h('p', { class: 'muted' }, 'Have a quick look. Tap “We’re out” to move one to the list.'),
      h('div', { class: 'list' }, list.have.map((i) => h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 'label' }, itemText(i)), h('div', { class: 'muted' }, i.recipes.join(', '))),
        h('button', { class: 'small', onclick: () => run(async () => { await api('PATCH', `/pantry/${i.pantry_id}`, { in_stock: false }); await reload(); }) }, 'We’re out'))))));
  }

  nodes.push(h('div', { class: 'row wrap' },
    h('button', { class: 'primary grow', onclick: () => openOda(list) }, '🛒 Fill my Oda cart'),
    h('button', {
      class: 'grow',
      onclick: () => {
        if (!confirm('Mark everything as bought? This clears the list, restocks the staples you were out of and marks these dinners as shopped for.')) return;
        run(async () => { await api('POST', `/shopping/finish?days=${shopDays}`); toast('Shopping done'); await reload(); });
      },
    }, 'Done shopping')));
  view.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------- Oda

function priceText(p) {
  if (p.price == null || p.price === '') return '';
  return /^[\d.,\s]+$/.test(String(p.price)) ? `${p.price} kr` : String(p.price);
}

function productLabel(p) {
  return [[p.name, p.brand].filter(Boolean).join(', '), p.description, priceText(p)].filter(Boolean).join(' · ')
    + (p.available === false ? ' (unavailable)' : '');
}

function odaConnectDialog() {
  openDialog('Connect Oda', [
    h('p', null, 'Connect your Oda account once, and this app can find the products on your shopping list and put them in your Oda cart.'),
    h('p', { class: 'muted' }, 'You sign in on oda.com and approve access there. The app can only fill the cart: you review it and pay at Oda yourself.'),
    h('a', { class: 'btn primary', href: '/api/oda/connect' }, 'Connect Oda account'),
  ]);
}

async function openOda(list) {
  const items = list.buy.filter((i) => !i.checked);
  if (!items.length) return toast('Nothing left to buy');
  if (!S.oda_connected) return odaConnectDialog();

  openDialog('Fill my Oda cart', [h('p', { class: 'muted' }, 'Looking up your items at Oda…')]);
  let found = {};
  try {
    const need = items.filter((i) => !i.oda).map((i) => i.name);
    if (need.length) found = await api('POST', '/oda/search', { queries: need });
  } catch (e) {
    if (e.status === 409) { S.oda_connected = false; return odaConnectDialog(); }
    return openDialog('Fill my Oda cart', [h('p', null, e.message)]);
  }

  const rows = items.map((item) => {
    let products = item.oda
      ? [{ id: item.oda.product_id, name: item.oda.name, price: item.oda.price, url: item.oda.url }]
      : (found[item.name] || []);
    const select = h('select', { 'aria-label': `Oda product for ${item.name}` });
    const qty = h('input', { type: 'number', min: 0, max: 30, inputMode: 'numeric', value: 1, 'aria-label': 'How many' });
    const fill = () => select.replaceChildren(
      ...products.map((p) => h('option', { value: String(p.id) }, productLabel(p))),
      h('option', { value: '' }, products.length ? 'Skip this one' : 'No match found — skip'));
    fill();
    const term = h('input', { placeholder: 'Search Oda for…', value: item.name });
    const el = h('div', { class: 'oda-row' },
      h('div', { class: 'label' }, itemText(item), item.oda ? h('span', { class: 'muted' }, ' · your usual') : null),
      h('div', { class: 'controls' }, select, qty),
      h('details', null, h('summary', { class: 'muted' }, 'Pick a different product'),
        h('form', {
          class: 'row', style: 'margin-top:6px',
          onsubmit: (e) => {
            e.preventDefault();
            const q = term.value.trim();
            if (!q) return;
            run(async () => {
              const res = await api('POST', '/oda/search', { queries: [q] });
              products = res[q] || Object.values(res)[0] || [];
              fill();
              if (!products.length) toast('Oda found nothing for that');
            });
          },
        }, h('div', { class: 'grow' }, term), h('button', { class: 'small', type: 'submit' }, 'Search'))));
    const get = () => {
      const p = products.find((x) => String(x.id) === select.value);
      const n = parseInt(qty.value, 10) || 0;
      if (!p || n <= 0) return null;
      return { name: item.name, product_id: p.id, product_name: p.name, price: p.price == null ? null : String(p.price), url: p.url || null, quantity: n };
    };
    return { el, get };
  });

  const send = h('button', { class: 'primary' }, 'Add to my Oda cart');
  send.addEventListener('click', async () => {
    const chosen = rows.map((r) => r.get()).filter(Boolean);
    if (!chosen.length) return toast('Nothing selected');
    send.disabled = true;
    send.textContent = 'Adding…';
    try {
      const cart = await api('POST', '/oda/cart', { items: chosen });
      openDialog('Added to your Oda cart', [
        h('p', null, `${chosen.length} products were added.` + (cart.total ? ` Your cart is now ${priceText({ price: cart.total })}.` : '')),
        cart.messages.length ? h('p', { class: 'muted' }, cart.messages.join(' ')) : null,
        h('p', { class: 'muted' }, 'Check the cart, choose a delivery time and pay at Oda.'),
        h('a', { class: 'btn primary', href: cart.url || 'https://oda.com/no/cart/', target: '_blank', rel: 'noopener' }, 'Open my Oda cart'),
      ]);
    } catch (e) {
      send.disabled = false;
      send.textContent = 'Add to my Oda cart';
      if (e.status === 409) { S.oda_connected = false; return odaConnectDialog(); }
      toast(e.message);
    }
  });

  openDialog('Fill my Oda cart', [
    h('p', { class: 'muted' }, 'Choose a product and how many packs for each item. The app remembers your choices for next time.'),
    h('div', { class: 'card' }, rows.map((r) => r.el)),
    send,
  ]);
}

// ----------------------------------------------------------------- settings

function openSettings() {
  const name = h('input', { placeholder: 'Name' });
  const time = h('input', {
    type: 'time', value: S.settings.dinner_time,
    onchange: () => run(async () => { await api('PUT', '/settings', { dinner_time: time.value }); await reload(); }),
  });
  openDialog('Settings', [
    h('div', { class: 'card' },
      h('h3', null, 'Who cooks'),
      S.members.length
        ? h('div', { class: 'list' }, S.members.map((m) => h('div', { class: 'item' },
            h('div', { class: 'label grow' }, m.name),
            h('button', { class: 'small ghost', onclick: () => run(async () => { await api('DELETE', `/members/${m.id}`); await reload(); openSettings(); }) }, 'Remove'))))
        : h('p', { class: 'muted' }, 'Nobody yet.'),
      h('form', {
        class: 'row', style: 'margin-top:8px',
        onsubmit: (e) => {
          e.preventDefault();
          run(async () => { await api('POST', '/members', { name: name.value }); await reload(); openSettings(); });
        },
      }, h('div', { class: 'grow' }, name), h('button', { type: 'submit' }, 'Add'))),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, 'We eat dinner at', time),
      h('p', { class: 'muted', style: 'margin-top:6px' }, 'Used to show when cooking has to start.')),
    h('div', { class: 'card', style: 'display:grid;gap:8px' },
      h('h3', null, 'Oda'),
      S.oda_connected
        ? [h('p', { class: 'muted' }, 'Connected. The app can search products and fill your cart.'),
           h('button', { class: 'danger', onclick: () => run(async () => { await api('POST', '/oda/disconnect'); await reload(); openSettings(); }) }, 'Disconnect Oda')]
        : [h('p', { class: 'muted' }, 'Not connected.'),
           h('a', { class: 'btn', href: '/api/oda/connect' }, 'Connect Oda account')]),
  ]);
}

init();

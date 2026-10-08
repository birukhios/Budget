'use strict';
const $ = (id) => document.getElementById(id);
const api = (p, o) => fetch(p, o).then((r) => r.json());
const birr = (n) =>
  'ETB ' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => birr(n).slice(4);
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

let CATS = [];
let period = 'month';
let date = new Date().toISOString().slice(0, 10);

const qs = () => `period=${period}&date=${date}`;

// Label a bucket key: 2026-10-08T14 → 14:00, 2026-10-08 → 08 Oct, 2026-10 → Oct, 2026 → 2026
function bucketLabel(k) {
  if (k.length === 13) return k.slice(11) + ':00';
  if (k.length === 10) return new Date(k).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  if (k.length === 7) return new Date(k + '-02').toLocaleString('en', { month: 'short' });
  return k;
}

function fillPicker(options) {
  const sel = $('when');
  if (period === 'all') { sel.hidden = true; return; }
  sel.hidden = false;
  const list = options[period] || [];
  sel.innerHTML = list.map((k) => {
    const label = period === 'day'
      ? new Date(k).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : period === 'month'
        ? new Date(k + '-02').toLocaleString('en', { month: 'long', year: 'numeric' })
        : k;
    return `<option value="${k}">${label}</option>`;
  }).join('');
  // Keep the current anchor if it exists in this period, else jump to the newest.
  const want = date.slice(0, period === 'day' ? 10 : period === 'month' ? 7 : 4);
  sel.value = list.includes(want) ? want : (list[0] || want);
  date = sel.value.padEnd(10, '-01').slice(0, 10);
}

async function render() {
  const [s, { tx }, ins] = await Promise.all([
    api(`/api/summary?${qs()}`),
    api(`/api/tx?${qs()}`),
    api(`/api/insights?${qs()}`),
  ]);

  fillPicker(s.options);

  $('f-in').textContent = birr(s.income);
  $('f-out').textContent = birr(s.expense);
  $('f-net').textContent = (s.net < 0 ? '−' : '+') + num(Math.abs(s.net));
  $('f-net').className = 'fig ' + (s.net < 0 ? 'out' : 'in');

  const bal = s.balances.map((b) => `${b.bank.toUpperCase()} ${num(b.balance)}`).join('  ·  ');
  $('f-sub').textContent = [`${s.count} transactions`, bal].filter(Boolean).join('  ·  ');

  const peak = Math.max(1, ...s.series.map((d) => d.out));
  $('bars').innerHTML = s.series
    .map((d) => `<span style="height:${Math.round((d.out / peak) * 100)}%" title="${bucketLabel(d.k)}: ${birr(d.out)}"></span>`)
    .join('');

  // savings read-out
  $('tips-wrap').hidden = !ins.suggestions.length;
  $('tips').innerHTML = ins.suggestions
    .map((t) => `<div class="tip ${t.kind}"><b>${esc(t.title)}</b><span>${esc(t.detail)}</span></div>`)
    .join('');

  const top = Math.max(1, ...s.byCategory.map((c) => c.total));
  $('cats-wrap').hidden = s.byCategory.length === 0;
  $('cats').innerHTML = s.byCategory
    .map((c) => `<div class="cat"><div class="nm">${esc(c.category)}
      <div class="meter"><i style="width:${Math.round((c.total / top) * 100)}%"></i></div></div>
      <div class="amt">${birr(c.total)}</div></div>`)
    .join('');

  $('list').innerHTML = tx.length
    ? tx.map((t) => {
        const when = new Date(t.occurred_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        const opts = CATS.map((c) => `<option${c === t.category ? ' selected' : ''}>${c}</option>`).join('');
        return `<div class="tx"><span class="dot ${t.direction}"></span>
          <div class="who"><b>${esc(t.counterparty || t.bank.toUpperCase())}</b>
          <small>${when} · ${t.bank.toUpperCase()}${t.ref ? ' · ' + esc(t.ref) : ''}</small></div>
          <div class="amt" style="color:var(--${t.direction === 'credit' ? 'in' : 'out'})">
            ${t.direction === 'credit' ? '+' : '−'}${num(t.amount)}</div>
          <select data-id="${t.id}">${opts}</select></div>`;
      }).join('')
    : '<div class="empty">No transactions in this period.</div>';
}

$('seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (!b) return;
  period = b.dataset.p;
  [...$('seg').children].forEach((x) => x.classList.toggle('on', x === b));
  render();
});

$('when').addEventListener('change', (e) => {
  date = e.target.value.padEnd(10, '-01').slice(0, 10);
  render();
});

$('list').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-id]');
  if (!sel) return;
  api(`/api/tx/${sel.dataset.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: sel.value }),
  }).then(render);
});

$('send').addEventListener('click', async () => {
  const text = $('paste').value.trim();
  if (!text) return;
  const r = await api('/api/paste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, sender: '' }),
  });
  $('flash').textContent = r.stored
    ? `Added ${r.stored}.` + (r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped[0]}.` : '')
    : `Nothing added — ${r.skipped[0] || 'no match'}.`;
  if (r.stored) $('paste').value = '';
  render();
});

(async () => {
  CATS = (await api('/api/meta')).categories;
  await render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

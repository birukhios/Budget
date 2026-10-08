'use strict';
/**
 * Savings suggestions derived only from the user's own transactions.
 * Every suggestion carries the figures it came from, so nothing is a
 * vague nudge — it either cites real numbers or it isn't shown.
 */

const round = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} a  aggregates for the selected period
 *   { income, expense, byCategory, series, days, prevIncome, prevExpense,
 *     recurring, fees, periodLabel, daysElapsed, daysInPeriod }
 */
function build(a) {
  const out = [];
  const { income, expense, byCategory = [], recurring = [], fees = 0 } = a;

  // 1. Savings rate — the headline number.
  if (income > 0) {
    const rate = ((income - expense) / income) * 100;
    out.push({
      kind: rate >= 20 ? 'good' : rate >= 0 ? 'watch' : 'alert',
      title: `You kept ${round(rate)}% of what came in`,
      detail: rate < 0
        ? `You spent ${round(expense - income)} ETB more than you received. The gap came out of savings or a previous balance.`
        : `${round(income - expense)} ETB of ${round(income)} ETB stayed with you.`
        + (rate < 20 ? ' Holding 20% would mean keeping ' + round(income * 0.2) + ' ETB.' : ''),
    });
  }

  // 2. Biggest category, with what trimming it would be worth.
  const top = byCategory[0];
  if (top && expense > 0) {
    const share = (top.total / expense) * 100;
    if (share >= 15) {
      out.push({
        kind: 'watch',
        title: `${top.category} is ${round(share)}% of your spending`,
        detail: `${round(top.total)} ETB across ${top.n} transaction${top.n === 1 ? '' : 's'}. `
          + `Cutting it by a fifth would free ${round(top.total * 0.2)} ETB.`,
      });
    }
  }

  // 3. Bank fees — small per charge, visible over a year.
  if (fees > 0) {
    out.push({
      kind: 'watch',
      title: `${round(fees)} ETB went to fees and charges`,
      detail: `At this rate that is about ${round(fees * 12 / Math.max(1, a.monthsCovered || 1))} ETB a year. `
        + 'Worth checking which of these are avoidable by changing channel or batching transfers.',
    });
  }

  // 4. Recurring payments — same counterparty, similar amount, repeating.
  for (const r of recurring.slice(0, 3)) {
    out.push({
      kind: 'info',
      title: `${r.counterparty} looks like a repeating payment`,
      detail: `${r.n} payments averaging ${round(r.avg)} ETB — about ${round(r.avg * r.n)} ETB so far. `
        + 'Recurring costs are usually the easiest thing to cancel or renegotiate.',
    });
  }

  // 5. Pace against the period, only for a month that is still running —
  //    on a year view the elapsed days include stretches with no data,
  //    which would understate the daily rate.
  if (a.period === 'month' && a.daysElapsed && a.daysInPeriod
      && a.daysElapsed < a.daysInPeriod && expense > 0) {
    const perDay = expense / a.daysElapsed;
    const projected = perDay * a.daysInPeriod;
    out.push({
      kind: projected > income && income > 0 ? 'alert' : 'info',
      title: `On pace for ${round(projected)} ETB this period`,
      detail: `${round(perDay)} ETB a day over ${a.daysElapsed} days so far.`
        + (income > 0 ? ` Income so far is ${round(income)} ETB.` : ''),
    });
  }

  // 6. Direction of travel against the previous period.
  if (a.prevExpense > 0 && expense > 0) {
    const delta = ((expense - a.prevExpense) / a.prevExpense) * 100;
    if (Math.abs(delta) >= 10) {
      out.push({
        kind: delta > 0 ? 'watch' : 'good',
        title: `Spending is ${delta > 0 ? 'up' : 'down'} ${round(Math.abs(delta))}% on the previous period`,
        detail: `${round(expense)} ETB versus ${round(a.prevExpense)} ETB.`,
      });
    }
  }

  // 7. A concrete target, anchored to what actually happened.
  if (income > 0 && expense > 0 && expense < income) {
    const kept = income - expense;
    out.push({
      kind: 'info',
      title: `A realistic next target: ${round(kept + Math.min(top ? top.total * 0.2 : 0, income * 0.05))} ETB`,
      detail: `You already kept ${round(kept)} ETB without trying. `
        + (top ? `Trimming ${top.category} slightly gets you the rest.` : ''),
    });
  }

  return out;
}

/** Group debits by counterparty to find repeating payments. */
function findRecurring(rows, minCount = 3) {
  const by = new Map();
  for (const r of rows) {
    if (r.direction !== 'debit' || !r.counterparty) continue;
    const k = r.counterparty.toLowerCase();
    if (!by.has(k)) by.set(k, { counterparty: r.counterparty, amounts: [] });
    by.get(k).amounts.push(r.amount);
  }
  const out = [];
  for (const v of by.values()) {
    if (v.amounts.length < minCount) continue;
    const avg = v.amounts.reduce((a, b) => a + b, 0) / v.amounts.length;
    // Only call it recurring if the amounts are fairly stable.
    const spread = Math.max(...v.amounts) - Math.min(...v.amounts);
    if (avg > 0 && spread / avg <= 0.35) out.push({ counterparty: v.counterparty, n: v.amounts.length, avg });
  }
  return out.sort((a, b) => b.avg * b.n - a.avg * a.n);
}

module.exports = { build, findRecurring };

'use strict';
/**
 * SMS parser for Ethiopian bank / wallet alerts.
 *
 * Design: one generic extraction engine + a small, editable rules table.
 * Banks change wording often, so rules are keyword lists — not whole-message
 * regexes. Add a bank by adding a row to BANKS. Nothing else changes.
 */

// ---------------------------------------------------------------------------
// Rules table — edit this, not the engine.
// `senders`  : strings matched case-insensitively against the SMS sender id
// `hints`    : body phrases that identify the bank when the sender is unknown
// ---------------------------------------------------------------------------
const BANKS = [
  { id: 'cbe',       name: 'Commercial Bank of Ethiopia', senders: ['cbe', 'cbebirr'],        hints: ['commercial bank of ethiopia', 'cbe'] },
  { id: 'telebirr',  name: 'telebirr',                    senders: ['telebirr', '127'],       hints: ['telebirr', 'e-money balance'] },
  { id: 'mpesa',     name: 'M-PESA',                      senders: ['m-pesa', 'mpesa', 'safaricom'], hints: ['m-pesa'] },
  { id: 'awash',     name: 'Awash Bank',                  senders: ['awash', 'awashbank'],    hints: ['awash'] },
  { id: 'dashen',    name: 'Dashen Bank',                 senders: ['dashen', 'dashenbank', 'amole'], hints: ['dashen', 'amole'] },
  { id: 'abyssinia', name: 'Bank of Abyssinia',           senders: ['boa', 'abyssinia'],      hints: ['abyssinia'] },
  { id: 'coop',      name: 'Cooperative Bank of Oromia',  senders: ['coopbank', 'coop'],      hints: ['cooperative bank'] },
  { id: 'wegagen',   name: 'Wegagen Bank',                senders: ['wegagen'],               hints: ['wegagen'] },
  { id: 'nib',       name: 'Nib Bank',                    senders: ['nib', 'nibbank'],        hints: ['nib international'] },
  { id: 'enat',      name: 'Enat Bank',                   senders: ['enat'],                  hints: ['enat bank'] },
];

// Direction keywords. Order matters: first match wins, so put the
// unambiguous phrases first. All matched case-insensitively.
const CREDIT = [
  'you have received', 'has been credited', 'credited with', 'deposited',
  'received etb', 'received birr', 'you received', 'transferred to your',
  'has been deposited', 'you have been paid',
];
const DEBIT = [
  'has been debited', 'debited with', 'you have transfered', 'you have transferred',
  'you have sent', 'you have paid', 'withdrawn', 'withdrawal of', 'purchase of',
  'you have bought', 'payment of', 'has been deducted', 'deducted from',
  'service charge', 'atm withdrawal',
];

// ---------------------------------------------------------------------------
// Generic field extractors
// ---------------------------------------------------------------------------
const CCY = '(?:etb|birr|br)';
const NUM = '([\\d,]+(?:\\.\\d{1,2})?)';

const money = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// First money figure that is NOT part of a "balance" phrase.
function extractAmount(body) {
  const re = new RegExp(`${CCY}\\s*\\.?\\s*${NUM}|${NUM}\\s*${CCY}`, 'gi');
  for (const m of body.matchAll(re)) {
    const before = body.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    if (/balance|bal\.?\s*(is|of)?\s*$|available/.test(before)) continue;
    const v = money(m[1] ?? m[2]);
    if (v !== null && v > 0) return v;
  }
  return null;
}

function extractBalance(body) {
  const re = new RegExp(
    `(?:current|available|new|closing|remaining)?\\s*(?:e-money\\s*)?bal(?:ance)?\\.?\\s*(?:is|of|:)?\\s*${CCY}?\\s*\\.?\\s*${NUM}`,
    'i'
  );
  const m = body.match(re);
  return m ? money(m[1]) : null;
}

function extractRef(body) {
  const m = body.match(
    /(?:transaction (?:number|id|ref(?:erence)?)|trx(?:\.|\s)?(?:id|no)?|ref(?:erence)?(?:\s*(?:no|number))?|receipt(?:\s*no)?|FT)\s*(?:is|:|=)?\s*([A-Z0-9][A-Z0-9._-]{4,})/i
  );
  if (m) return m[1].replace(/[.,]$/, '');
  // M-PESA style: leading confirmation code
  const lead = body.match(/^([A-Z0-9]{8,12})\s+confirmed/i);
  return lead ? lead[1] : null;
}

function extractCounterparty(body, direction) {
  const pats = direction === 'credit'
    ? [/\bfrom\s+([A-Za-z][A-Za-z.'’\- ]{2,40}?)(?=\s*(?:on|at|,|\.|\bto\b|\bvia\b|\byour\b|$))/i]
    : [/\b(?:to|at)\s+([A-Za-z][A-Za-z.'’\- ]{2,40}?)(?=\s*(?:on|at|,|\.|\bvia\b|\byour\b|$))/i];
  for (const p of pats) {
    const m = body.match(p);
    if (m) {
      const v = m[1].trim().replace(/\s+/g, ' ');
      if (!/^(your|the|a|an)$/i.test(v)) return v;
    }
  }
  return null;
}

function extractAccount(body) {
  const m = body.match(/\b(\d?\*{2,}\d{2,}|\b\d{4}\*+\d{2,4})\b/);
  return m ? m[1] : null;
}

// dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd, with optional hh:mm(:ss)
function extractDate(body, fallback) {
  const dmy = body.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b(?:\s*(?:at|,)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    let [, d, mo, y, h = 0, mi = 0, s = 0] = dmy;
    y = +y < 100 ? 2000 + +y : +y;
    const dt = new Date(Date.UTC(y, +mo - 1, +d, +h - 3, +mi, +s)); // EAT -> UTC
    if (!isNaN(dt)) return dt.toISOString();
  }
  const ymd = body.match(/\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (ymd) {
    const [, y, mo, d, h, mi, s = 0] = ymd;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h - 3, +mi, +s));
    if (!isNaN(dt)) return dt.toISOString();
  }
  return fallback || new Date().toISOString();
}

function firstHit(body, list) {
  const b = body.toLowerCase();
  let best = null;
  for (const kw of list) {
    const i = b.indexOf(kw);
    if (i !== -1 && (best === null || i < best.i)) best = { i, kw };
  }
  return best;
}

function detectBank(sender = '', body = '') {
  const s = sender.toLowerCase(), b = body.toLowerCase();
  for (const bank of BANKS) if (bank.senders.some((x) => s.includes(x))) return bank;
  for (const bank of BANKS) if (bank.hints.some((x) => b.includes(x))) return bank;
  return null;
}

// ---------------------------------------------------------------------------
// Auto-categorisation — plain keyword buckets, user can override in the UI.
// ---------------------------------------------------------------------------
const CATEGORIES = [
  ['Transport',     ['ride', 'feres', 'taxi', 'fuel', 'petrol', 'benzene', 'zayride', 'bolt']],
  ['Utilities',     ['eeu', 'electric', 'light bill', 'water', 'aawsa', 'utility']],
  ['Telecom',       ['airtime', 'recharge', 'data package', 'package purchase', 'ethio telecom', 'mobile package']],
  ['Food',          ['restaurant', 'cafe', 'coffee', 'supermarket', 'market', 'bakery', 'hotel']],
  ['Transfer out',  ['transfer', 'transfered', 'transferred', 'sent to']],
  ['Cash',          ['atm', 'withdraw', 'cash out']],
  ['Fees',          ['service charge', 'commission', 'fee', 'stamp duty', 'vat']],
  ['Salary',        ['salary', 'payroll', 'wage']],
  ['Income',        ['received', 'credited', 'deposit']],
];

function autoCategory(body, direction) {
  const b = body.toLowerCase();
  for (const [name, kws] of CATEGORIES) {
    if (kws.some((k) => b.includes(k))) {
      if (direction === 'credit' && ['Transport', 'Utilities', 'Telecom', 'Food', 'Cash', 'Transfer out'].includes(name)) continue;
      if (direction === 'debit' && ['Salary', 'Income'].includes(name)) continue;
      return name;
    }
  }
  return direction === 'credit' ? 'Income' : 'Uncategorised';
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
/**
 * @returns {{ok:true, tx:object} | {ok:false, reason:string}}
 */
function parse({ sender = '', body = '', received_at = null, allowUnknownBank = false } = {}) {
  if (!body || !body.trim()) return { ok: false, reason: 'empty body' };
  const clean = body.replace(/\s+/g, ' ').trim();

  // Pasted messages often arrive without the sender id, so callers that
  // trust the input (the paste box) may accept an unidentified bank.
  const bank = detectBank(sender, clean)
    || (allowUnknownBank ? { id: 'other', name: 'Other' } : null);
  if (!bank) return { ok: false, reason: 'unknown sender' };

  // OTP / promo / balance-enquiry noise — no money moved.
  if (/\b(otp|one[- ]time|verification code|password|do not share)\b/i.test(clean)) {
    return { ok: false, reason: 'otp/notice' };
  }

  const c = firstHit(clean, CREDIT);
  const d = firstHit(clean, DEBIT);
  let direction = null;
  if (c && d) direction = c.i < d.i ? 'credit' : 'debit';
  else if (c) direction = 'credit';
  else if (d) direction = 'debit';
  if (!direction) return { ok: false, reason: 'no direction keyword' };

  const amount = extractAmount(clean);
  if (amount === null) return { ok: false, reason: 'no amount' };

  return {
    ok: true,
    tx: {
      bank: bank.id,
      bank_name: bank.name,
      direction,
      amount,
      balance: extractBalance(clean),
      counterparty: extractCounterparty(clean, direction),
      account: extractAccount(clean),
      ref: extractRef(clean),
      occurred_at: extractDate(clean, received_at),
      category: autoCategory(clean, direction),
      raw: clean,
    },
  };
}

module.exports = { parse, BANKS, CATEGORIES, detectBank };

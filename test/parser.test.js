'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../parser');

const S = (sender, body) => parse({ sender, body }).tx;

test('CBE credit', () => {
  const t = S('CBE', 'Dear BIRUK, You have received ETB 1,500.00 from ABEBE KEBEDE on your account 1****4567 on 08/10/2026 at 10:22:11. Your Current Balance is ETB 12,340.55. Thank you for Banking with CBE!');
  assert.equal(t.direction, 'credit');
  assert.equal(t.amount, 1500);
  assert.equal(t.balance, 12340.55);
  assert.equal(t.counterparty, 'ABEBE KEBEDE');
  assert.equal(t.account, '1****4567');
  assert.equal(t.bank, 'cbe');
});

test('CBE debit with FT reference', () => {
  const t = S('CBE', 'Dear BIRUK, You have transfered ETB 500.00 to SELAM TADESSE on 08/10/2026 at 14:05:00 from your account 1****4567. Your Current Balance is ETB 11,840.55. Ref FT25281ABCD9');
  assert.equal(t.direction, 'debit');
  assert.equal(t.amount, 500);
  assert.equal(t.balance, 11840.55);
  assert.equal(t.ref, 'FT25281ABCD9');
  assert.equal(t.category, 'Transfer out');
});

test('telebirr credit keeps e-money balance', () => {
  const t = S('telebirr', 'Dear customer, you have received ETB 100.00 from 251911223344. Your transaction number is CJ2810ABCD. Your current e-money balance is ETB 250.50.');
  assert.equal(t.bank, 'telebirr');
  assert.equal(t.direction, 'credit');
  assert.equal(t.amount, 100);
  assert.equal(t.balance, 250.5);
  assert.equal(t.ref, 'CJ2810ABCD');
});

test('telebirr airtime purchase categorised as Telecom', () => {
  const t = S('telebirr', 'Dear customer, you have paid ETB 25.00 to Ethio Telecom for airtime recharge. Your current e-money balance is ETB 225.50.');
  assert.equal(t.direction, 'debit');
  assert.equal(t.amount, 25);
  assert.equal(t.category, 'Telecom');
});

test('Awash debit phrasing', () => {
  const t = S('AwashBank', 'Your account 013***891 has been debited with ETB 300.00 on 07/10/26 at 09:15. Available balance ETB 4,200.00.');
  assert.equal(t.bank, 'awash');
  assert.equal(t.direction, 'debit');
  assert.equal(t.amount, 300);
  assert.equal(t.balance, 4200);
});

test('M-PESA leading confirmation code', () => {
  const t = S('M-PESA', 'QW12345678 Confirmed. You have sent Birr 200.00 to ALMAZ on 8/10/26 at 7:40 PM. New balance is Birr 1,050.00.');
  assert.equal(t.bank, 'mpesa');
  assert.equal(t.direction, 'debit');
  assert.equal(t.amount, 200);
  assert.equal(t.balance, 1050);
  assert.equal(t.ref, 'QW12345678');
});

test('ATM withdrawal categorised as Cash', () => {
  const t = S('CBE', 'Dear BIRUK, ATM withdrawal of ETB 1,000.00 from your account 1****4567 on 06/10/2026. Your Current Balance is ETB 10,840.55.');
  assert.equal(t.category, 'Cash');
  assert.equal(t.amount, 1000);
});

test('balance figure is never mistaken for the amount', () => {
  const t = S('CBE', 'Dear BIRUK, Your Current Balance is ETB 9,999.99 after you have received ETB 50.00 from KIDUS.');
  assert.equal(t.amount, 50);
  assert.equal(t.balance, 9999.99);
});

test('OTP message is rejected', () => {
  const r = parse({ sender: 'CBE', body: 'Your OTP is 123456. Do not share it with anyone.' });
  assert.equal(r.ok, false);
});

test('unknown sender is rejected', () => {
  const r = parse({ sender: 'PROMO', body: 'Win ETB 1000 now!' });
  assert.equal(r.ok, false);
});

test('known sender without direction keyword is rejected', () => {
  const r = parse({ sender: 'CBE', body: 'Dear customer, our branches will be closed on Monday.' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no direction keyword');
});

test('date parses as EAT and converts to UTC', () => {
  const t = S('CBE', 'You have received ETB 10.00 from X on 08/10/2026 at 12:00:00. Your Current Balance is ETB 1.00');
  assert.equal(t.occurred_at, '2026-10-08T09:00:00.000Z');
});

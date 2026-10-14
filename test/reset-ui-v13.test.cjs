'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let now = Date.parse('2026-10-06T04:45:00Z');
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.classList = { add() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
      return descendants.filter(child => selector === '[data-reset]' && child.dataset.reset);
    }
  }
  const document = { createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) };
  const context = { window: {}, document, Intl, Date: class extends Date { static now() { return now; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/common.js'), 'utf8'), context);
  return { ui: context.window.LimitUI, at: value => { now = Date.parse(value); } };
}

const effectiveReset = '2026-10-06T04:46:00Z';
const quota = { id: 'primary', label: '5시간', usedPercent: 100, remainingPercent: 0, durationMinutes: 300, resetsAt: effectiveReset };
const provider = { id: 'codex-personal', providerId: 'codex', status: 'ok', mode: 'default', windows: [quota] };

test('renderer uses the supplied effective reset boundary without a second offset or assumed refill', () => {
  const { ui, at } = fixture();
  assert.equal(ui.countdown(effectiveReset, provider), '1분 후 초기화');
  assert.equal(ui.used(quota), 100);
  at('2026-10-06T04:45:59.999Z');
  assert.equal(ui.countdown(effectiveReset, provider), '1분 후 초기화');
  assert.equal(ui.used(quota), 100);
  at(effectiveReset);
  assert.equal(ui.countdown(effectiveReset, provider), '초기화 확인 중');
  assert.equal(ui.providerStatus(provider).label, '초기화 확인 중');
  assert.equal(ui.used(quota), null);
  assert.equal(ui.remaining(quota), null);
  assert.equal(ui.providerStatus({ ...provider, stale: true }).label, '이전 기록');
});

test('manual countdowns keep manual provenance when a visible timer crosses the reset boundary', () => {
  const { ui, at } = fixture();
  for (const manual of [{ ...provider, manual: true }, { ...provider, mode: 'manual' }]) {
    at('2026-10-06T04:45:00Z');
    const meter = ui.windowMeter(quota, '5시간', manual);
    const label = meter.querySelectorAll('[data-reset]')[0];
    assert.equal(label.textContent, '1분 후 초기화');
    at(effectiveReset);
    ui.tickCountdowns(meter);
    assert.equal(label.textContent, '기록 갱신 필요');
    assert.equal(ui.providerStatus(manual).label, '직접 입력');
    assert.equal(ui.used(quota), null);
    const fable = ui.windowSummary({ ...quota, label: 'Fable 주간' }, manual);
    assert.match(fable.title, /기록 갱신 필요/);
    assert.doesNotMatch(fable.title, /초기화 확인 중/);
  }
});

test('automatic countdown ticks show confirmation pending and missing times stay unknown', () => {
  const { ui, at } = fixture();
  const meter = ui.windowMeter(quota, '5시간', provider);
  at(effectiveReset);
  ui.tickCountdowns(meter);
  assert.equal(meter.querySelectorAll('[data-reset]')[0].textContent, '초기화 확인 중');
  for (const value of [null, undefined, 'invalid']) assert.equal(ui.countdown(value, provider), '초기화 시간 미제공');
});

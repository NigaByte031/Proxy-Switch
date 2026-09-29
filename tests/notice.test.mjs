import test from 'node:test';
import assert from 'node:assert/strict';

import { SWITCH_NOTICE_ID, buildSwitchNotice, wantsSwitchNotice } from '../src/lib/notice.js';
import { createDefaultState, sanitizeState } from '../src/lib/model.js';
import { MESSAGES } from '../src/lib/i18n.js';

/**
 * The extension's only unprompted message: a failover switch moved the whole browser
 * to another server. The wording is pure, so what the worker will show is testable here.
 */

const PROFILE = { id: 'p2', name: 'Work' };
const stateWith = (settings = {}) => sanitizeState({ settings: { notifyFailover: true, ...settings } });

test('a switch is announced with the name of the server that took over', () => {
  const notice = buildSwitchNotice(stateWith(), PROFILE, null, 'en');

  assert.equal(notice.id, SWITCH_NOTICE_ID);
  assert.equal(notice.title, MESSAGES.en['notice.switched.title']);
  assert.equal(notice.message, 'The active server stopped answering, so Work is now in use.');
  assert.ok(!notice.message.includes('{'), 'the placeholder must be filled in');
});

test('the announcement is translated, and always names the server', () => {
  for (const lang of ['en', 'fa']) {
    const notice = buildSwitchNotice(stateWith(), { id: 'p2', name: 'پروکسی کار' }, null, lang);
    assert.ok(notice.message.includes('پروکسی کار'), `${lang} must name the server`);
    assert.notEqual(notice.title, 'notice.switched.title', `${lang} title`);
    assert.notEqual(notice.message, 'notice.switched.message', `${lang} message`);
    assert.ok(!notice.message.includes('{'), `${lang} placeholder`);
  }
});

test('one notification id, so a later switch replaces the one on screen', () => {
  const first = buildSwitchNotice(stateWith(), { id: 'p1', name: 'Home' }, null, 'en');
  const second = buildSwitchNotice(stateWith(), PROFILE, null, 'en');
  assert.equal(first.id, second.id);
});

test('the notification offers the way back to the server that failed', () => {
  const previous = { id: 'p1', name: 'Home' };
  const notice = buildSwitchNotice(stateWith(), PROFILE, previous, 'en');

  assert.equal(notice.button, 'Back to Home');
  // the body asks a question, the button carries the answer
  assert.ok(notice.message.includes('Work'));

  for (const lang of ['en', 'fa']) {
    const translated = buildSwitchNotice(stateWith(), PROFILE, previous, lang);
    assert.ok(translated.button.includes('Home'), `${lang} button`);
    assert.notEqual(translated.button, 'notice.switched.button', `${lang} button`);
    assert.ok(!translated.button.includes('{'), `${lang} placeholder`);
  }

  // nothing to go back to is not a reason to stay quiet
  const withoutFrom = buildSwitchNotice(stateWith(), PROFILE, null, 'en');
  assert.equal(withoutFrom.button, null);
  assert.ok(withoutFrom.message.includes('Work'));
  assert.equal(buildSwitchNotice(stateWith(), PROFILE, { name: '' }, 'en').button, null);
});

test('turning it off, or having no server to name, means no notification', () => {
  assert.equal(wantsSwitchNotice(stateWith({ notifyFailover: false })), false);
  assert.equal(buildSwitchNotice(stateWith({ notifyFailover: false }), PROFILE, PROFILE), null);

  // a state from before the setting existed still wants to be told
  assert.equal(wantsSwitchNotice({ settings: {} }), true);
  assert.equal(wantsSwitchNotice(undefined), true);

  // nothing to announce without a server, and a nameless server is no answer
  assert.equal(buildSwitchNotice(stateWith(), null, PROFILE), null);
  assert.equal(buildSwitchNotice(stateWith(), { name: '' }, PROFILE), null);
});

test('the default state wants to be told', () => {
  const state = createDefaultState();
  assert.equal(state.settings.notifyFailover, true);
  assert.ok(buildSwitchNotice(state, PROFILE, null), 'a fresh install is announced like any other');
});

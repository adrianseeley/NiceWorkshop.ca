'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate the exact uploadable source with no CommonJS or Node globals.
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../scripts/cloudfront-apex-redirect.js'), 'utf8'), context);
const redirect = (uri, querystring = {}, extras = {}) => context.handler({
  request: { method: 'GET', uri, querystring, headers: {}, ...extras }
});

test('apex root redirects permanently to the fixed HTTPS www origin', () => {
  const result = redirect('/');
  assert.equal(result.statusCode, 308);
  assert.equal(result.statusDescription, 'Permanent Redirect');
  assert.equal(result.headers.location.value, 'https://www.niceworkshop.ca/');
});

test('preserves encoded paths and query values without decoding or double-encoding', () => {
  const result = redirect('/cuts/%E2%9C%93%20birch/%2F', {
    'cut%20name': { value: 'birch+plywood%2Bmaple%26oak' },
    next: { value: '%2Fstaff%3Fpage%3D2' },
    literal: { value: '%252F' }
  });
  assert.equal(result.headers.location.value,
    'https://www.niceworkshop.ca/cuts/%E2%9C%93%20birch/%2F?cut%20name=birch+plywood%2Bmaple%26oak&next=%2Fstaff%3Fpage%3D2&literal=%252F');
});

test('retains repeated parameters in their value order, including empty values', () => {
  const result = redirect('/estimate', {
    shape: { value: 'circle', multiValue: [{ value: 'circle' }, { value: 'rectangle' }, { value: '' }] },
    empty: { value: '' },
    zero: { value: '0' }
  });
  const url = new URL(result.headers.location.value);
  assert.deepEqual(url.searchParams.getAll('shape'), ['circle', 'rectangle', '']);
  assert.equal(url.searchParams.get('empty'), '');
  assert.equal(url.searchParams.get('zero'), '0');
});

test('viewer headers, redirect parameters, and double-slash paths cannot select another host', () => {
  const result = redirect('//elsewhere.example/path', { redirect: { value: 'https%3A%2F%2Fevil.example' } }, {
    headers: { host: { value: 'evil.example' }, 'x-forwarded-host': { value: 'evil.example' } }
  });
  const url = new URL(result.headers.location.value);
  assert.equal(url.origin, 'https://www.niceworkshop.ca');
  assert.equal(url.pathname, '//elsewhere.example/path');
  assert.equal(url.searchParams.get('redirect'), 'https://evil.example');
});

test('uses a method-preserving redirect and does not mutate the incoming event', () => {
  const event = { request: { method: 'POST', uri: '/api/checkout', querystring: { id: { value: 'abc' } }, headers: {} } };
  const before = structuredClone(event);
  const result = context.handler(event);
  assert.equal(result.statusCode, 308);
  assert.deepEqual(event, before);
  assert.equal(result.headers.location.value, 'https://www.niceworkshop.ca/api/checkout?id=abc');
});

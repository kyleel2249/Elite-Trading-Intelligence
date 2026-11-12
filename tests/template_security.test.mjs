import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const payload = '<img src=x onerror="globalThis.hacked=true"> &amp; \' "';
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
function harness(name) {
  const source = fs.readFileSync(new URL('../app/templates/' + name + '.html', import.meta.url), 'utf8');
  // Compile every inline script to catch syntax regressions, without executing page startup.
  for (const match of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {innerHTML:'', textContent:'', querySelectorAll: () => []});
    return elements.get(id);
  };
  const ctx = vm.createContext({$:get});
  const helper = source.match(/function escapeHTML[\s\S]*?\n    }/)[0];
  const start = source.indexOf(name === 'alerts' ? '    function render(' : '    function renderActs(');
  const end = source.indexOf('    function openModal(', start);
  vm.runInContext(helper + '\n' + source.slice(start, end), ctx);
  return {ctx, get, source};
}

for (const name of ['alerts', 'data_intel']) test(name + ' escapes malicious display fields and preserves JSON attributes', () => {
  const {ctx, get, source} = harness(name);
  const alert = Object.fromEntries(['title','summary','ticker','category','severity','investor_name','source_provider','created_at','recommended_action','verification_status','alert_id'].map(key => [key, payload]));
  ctx.records = [alert];
  vm.runInContext(name === 'alerts' ? 'render(records)' : 'renderAlerts(records)', ctx);
  const rendered = get(name === 'alerts' ? 'list' : 'alerts-feed').innerHTML;
  assert.equal(rendered.includes('<img'), false);
  assert.ok(rendered.includes('&lt;img'));
  const json = rendered.match(/data-json='([^']*)'/)[1];
  assert.deepEqual(JSON.parse(decode(json)), alert);
  assert.equal(source.includes("localStorage.setItem('eti_api_key'"), false);
  assert.equal(source.includes("else sessionStorage.removeItem('eti_api_key')"), true);
});

test('activity, consensus, watch and learning renderers escape external strings', () => {
  const {ctx,get} = harness('data_intel');
  ctx.payload = payload;
  for (const [code, id] of [
    ['renderActs([{ticker:payload,investor_name:payload,category:payload,direction:payload,significance:payload}])', 'acts-feed'],
    ['renderConsensus({tickers_with_overlap:[{ticker:payload,research_priority:payload,unique_actors:[payload]}]})','consensus-feed'],
    ['renderWatch({elite_names:[payload]})','watch-feed'],
    ['renderLearn({n:1,by_horizon:{test:payload}})','learn-feed'],
  ]) {
    vm.runInContext(code,ctx);
    assert.equal(get(id).innerHTML.includes('<img'), false);
    assert.ok(get(id).innerHTML.includes('&lt;img'));
  }
});

test('main dashboard scripts compile and authenticated reads include headers', () => {
  const source = fs.readFileSync(new URL('../app/templates/index.html', import.meta.url),'utf8');
  for (const match of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.ok(source.includes("fetch('/api/paper-trading/portfolio',{headers:authHeaders()})"));
  assert.equal(source.includes("localStorage.getItem('eti_api_key')"), false);
});

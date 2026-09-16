import test from 'node:test';
import assert from 'node:assert/strict';
import '../rngoldrush-rules.js';

const G = globalThis.RNGPARTY_GOLDRUSH;

// The odds bar is the whole interface to this game's risk now — players decide
// whether to push on the numbers it prints. These check that what it prints is
// what the wheel actually does, which inspection can't tell you.
test('goldrush wheel: displayed odds are the odds actually drawn', async t => {

  await t.test('odds rows always account for the whole wheel', () => {
    for (const tick of [0, 1, 5, 12, 40]) {
      for (const pot of [0, 1, 250]) {
        const rows = G.wheelOdds(G.buildWheel({ tick, pot, settings: G.defaults() }));
        const sum = rows.reduce((a, r) => a + r.pct, 0);
        assert.ok(Math.abs(sum - 100) < 1e-9, `tick ${tick} pot ${pot} summed to ${sum}`);
      }
    }
  });

  await t.test('the skull percentage shown is the rate you actually bust at', () => {
    // Skull weight is solved back from the requested chance, so this is the
    // property that keeps "4%" in settings honest however the rest of the
    // wheel is configured.
    // mulberry32 — a plain LCG overflows past 2^53 in a JS float and skews its
    // own output, which looks exactly like the wheel being wrong.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    for (const tick of [0, 6, 15]) {
      const wheel = G.buildWheel({ tick, pot: 100, settings: G.defaults() });
      const stated = G.wheelOdds(wheel).find(r => r.key === 'bust').pct;
      let bust = 0;
      const n = 120000;
      for (let i = 0; i < n; i++) if (G.drawTile(wheel, rnd).type === 'bust') bust++;
      const seen = bust / n * 100;
      assert.ok(Math.abs(seen - stated) < 0.8, `tick ${tick}: shows ${stated}%, draws ${seen}%`);
    }
  });

  await t.test('×2 and ½ hold a flat share however long the round runs', () => {
    // The skull is the only thing that escalates. These used to be set as a
    // share of the gold weight, so a climbing skull quietly squeezed them from
    // 5.8% down to 1.2% over a long round without anyone deciding to.
    for (const tick of [0, 3, 8, 15, 22, 25]) {
      const rows = G.wheelOdds(G.buildWheel({ tick, pot: 200, settings: G.defaults() }));
      for (const key of ['x2', 'half']) {
        const pct = rows.find(r => r.key === key).pct;
        assert.ok(Math.abs(pct - G.SPECIAL_PCT) < 1e-9,
          `${key} drifted to ${pct.toFixed(2)}% by spin ${tick + 1}`);
      }
    }
  });

  await t.test('gold keeps a foothold even at the worst skull odds', () => {
    // The specials yield rather than letting a near-certain skull crowd every
    // gold tile off the wheel — a spin has to be able to pay out something.
    const brutal = { skullStartPct: 40, skullGrowthPct: 20, maxNumber: 30, skullsToEnd: 3 };
    const rows = G.wheelOdds(G.buildWheel({ tick: 40, pot: 200, settings: brutal }));
    const gold = rows.filter(r => G.TIERS.some(t => t.key === r.key))
                     .reduce((a, r) => a + r.pct, 0);
    assert.ok(gold >= 4.9, `gold fell to ${gold.toFixed(2)}% of the wheel`);
    assert.ok(rows.reduce((a, r) => a + r.pct, 0) > 99.99, 'wheel must still total 100%');
  });

  await t.test('pot multipliers leave the wheel when there is no pot to multiply', () => {
    const empty = G.buildWheel({ tick: 0, pot: 0, settings: G.defaults() });
    assert.equal(empty.entries.some(e => e.type === 'x2' || e.type === 'half'), false);
    assert.equal(G.wheelOdds(empty).some(r => r.key === 'x2' || r.key === 'half'), false);
    for (let i = 0; i < 5000; i++) {
      const t = G.drawTile(empty).type;
      assert.ok(t !== 'x2' && t !== 'half', `drew ${t} from an empty pot`);
    }
    const funded = G.buildWheel({ tick: 0, pot: 5, settings: G.defaults() });
    assert.ok(G.wheelOdds(funded).some(r => r.key === 'x2'));
  });

  await t.test('skulls start rare, climb every spin, and never reach certainty', () => {
    const s = G.defaults();
    const at = n => G.skullChance(n, s);
    assert.ok(at(0) <= 0.06, 'the first spin should be nearly free');
    for (let i = 1; i < 30; i++) assert.ok(at(i) >= at(i - 1), `chance fell at spin ${i}`);
    assert.ok(at(0) < at(5) && at(5) < at(10), 'odds must actually escalate');
    assert.ok(at(999) <= G.SKULL_CAP_PCT / 100, 'a spin must never be a guaranteed skull');
  });
});

test('goldrush payouts: cashing out takes a share, not the pot', async t => {

  await t.test('a leaver takes their share and the rest rides on', () => {
    // 4 players in, pot 100, one cashes out: they get a quarter, not the lot.
    const share = G.cashOutShare(100, 4);
    assert.equal(share, 25);
    assert.equal(100 - share * 1, 75, 'the other three keep three quarters');
  });

  await t.test('the denominator is everyone in, not just the leavers', () => {
    // Two of four leaving take a quarter each, not a half each — the split is
    // over the table, not over the people walking away.
    assert.equal(G.cashOutShare(100, 4), 25);
    assert.equal(G.cashOutShare(100, 4) * 2, 50, 'two leavers take half between them');
  });

  await t.test('everyone leaving at once empties the pot, and no more', () => {
    for (const [pot, n] of [[100, 4], [7, 3], [1, 2], [999, 7]]) {
      const share = G.cashOutShare(pot, n);
      assert.ok(share * n <= pot, `${n} leavers took more than the ${pot} pot`);
      assert.ok(pot - share * n < n, 'rounding should leave only crumbs behind');
    }
  });

  await t.test('degenerate inputs never mint gold or throw', () => {
    assert.equal(G.cashOutShare(0, 4), 0);
    assert.equal(G.cashOutShare(-50, 4), 0);
    assert.equal(G.cashOutShare(100, 0), 100);   // nobody in: no division by zero
    assert.ok(Number.isFinite(G.cashOutShare(100, 1)));
  });
});

test('goldrush settings: clamped, and rarity bands cover the range', async t => {

  await t.test('settings from a client are clamped, never trusted', () => {
    for (const def of G.SETTINGS) {
      assert.equal(G.clampSettings({ [def.key]: def.max + 500 })[def.key], def.max);
      assert.equal(G.clampSettings({ [def.key]: def.min - 500 })[def.key], def.min);
      assert.equal(G.clampSettings({ [def.key]: 'nonsense' })[def.key], def.def);
    }
    assert.deepEqual(G.clampSettings(undefined), G.defaults());
    assert.deepEqual(G.clampSettings({ dropTable: 1 }), G.defaults());
    // A wheel built from junk still has to be drawable rather than throwing.
    const wheel = G.buildWheel({ tick: -5, pot: -100, settings: { maxNumber: 'x' } });
    assert.ok(wheel.total > 0);
    assert.ok(G.drawTile(wheel).type);
  });

  await t.test('every gold value lands in exactly one tier, at any range', () => {
    for (const maxNumber of [6, 17, 30, 60]) {
      const seen = new Set();
      for (let v = 1; v <= maxNumber; v++) {
        const tier = G.tierOf(v, maxNumber);
        assert.ok(tier, `value ${v} has no tier at max ${maxNumber}`);
        seen.add(tier.key);
        const { lo, hi } = G.tierRange(tier.key, maxNumber);
        assert.ok(v >= lo && v <= hi, `value ${v} outside its own tier range`);
      }
      assert.equal(seen.size, G.TIERS.length, `max ${maxNumber} left a tier unreachable`);
    }
  });

  await t.test('rarer tiers are rarer, and bigger numbers are rarer', () => {
    const wheel = G.buildWheel({ tick: 0, pot: 100, settings: G.defaults() });
    const pct = {};
    for (const r of G.wheelOdds(wheel)) pct[r.key] = r.pct;
    const ladder = G.TIERS.map(t => t.key);
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(pct[ladder[i]] < pct[ladder[i - 1]], `${ladder[i]} is not rarer than ${ladder[i - 1]}`);
    }
    const weightOf = v => wheel.entries.find(e => e.key === 'n' + v).weight;
    assert.ok(weightOf(1) > weightOf(30), 'a 30 should be rarer than a 1');
  });
});

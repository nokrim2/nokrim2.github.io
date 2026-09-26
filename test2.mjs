import {readFileSync} from 'fs';
const J = f => JSON.parse(readFileSync(f, 'utf8'));
import * as dc from './calc.js';
dc.initData(J('data/char_index.json'), J('data/enemy_index.json'),
            J('data/skill_index.json'), J('data/buff_index.json'),
            J('data/skillsetting.json'));
const {cases, out} = J('test_vectors2.json');
let fail = 0;
for (let i = 0; i < cases.length; i++) {
  const cs = cases[i], py = out[i];
  try {
    const atk = dc.build_attacker(cs.cid, cs.lv, {
      weapon: {id: cs.wid, lv: cs.wlv, brk: cs.wbrk, talent: cs.wtal},
      equips: cs.eqs, suit_ids: cs.suit_ids,
      potential_lv: cs.pot, char_break: cs.brk,
      suit_buffs: cs.suit_buffs,
      dyn_buffs: cs.dyn.map(([b, s, bb]) => [b, s, bb])});
    const dfn = dc.build_defender(cs.eid, cs.elv, cs.dbuffs);
    const hits = dc.compute_skill(cs.sid, atk, dfn, {
      skill_level: cs.slv, broken: cs.broken, crit: cs.crit,
      cond: cs.cond, inflict: cs.inflict, inflict_proc: cs.proc,
      inflict_stacks: cs.stacks, manual_mul: cs.mmul});
    if (cs.extra)
      for (const u of dc.suit_extra_hits(cs.suit_ids))
        hits.push(dc.compute_extra_hit(atk, dfn, u.scale, u.dtype, u.mask,
                  {broken: cs.broken, manual_mul: cs.mmul}));
    if (!py.ok) { console.log(i, 'JS ok but PY failed'); fail++; continue; }
    const dmg = hits.map(h => h.damage);
    const bad = Math.abs(atk.atk_final - py.atk) > Math.max(1e-6, Math.abs(py.atk) * 1e-9)
      || dmg.length !== py.dmg.length
      || dmg.some((d, j) => Math.abs(d - py.dmg[j]) > Math.max(1e-6, Math.abs(py.dmg[j]) * 1e-9));
    if (bad) {
      fail++;
      console.log(i, cs.cid, cs.sid, 'atk', atk.atk_final.toFixed(4), 'vs', py.atk.toFixed(4));
      console.log('  js:', dmg.map(d => d.toFixed(2)).join(','));
      console.log('  py:', py.dmg.map(d => d.toFixed(2)).join(','));
      if (fail > 5) break;
    }
  } catch (e) {
    if (py.ok) { fail++; console.log(i, 'JS ERROR:', e.message, cs.cid, cs.sid); }
  }
}
console.log(`done: ${cases.length - fail}/${cases.length} identical`);

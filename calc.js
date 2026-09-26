// damage_calc.py → JS port (Endfield damage calculator engine)

export const ATTR_NAMES = {
 0:'Level',1:'MaxHp',2:'Atk',3:'Def',
 4:'PhysicalDamageTakenScalar',5:'FireDamageTakenScalar',6:'PulseDamageTakenScalar',7:'CrystDamageTakenScalar',
 8:'Weight',9:'CriticalRate',10:'CriticalDamageIncrease',11:'Hatred',12:'NormalAttackRange',13:'MoveSpeedScalar',
 14:'TurnRateScalar',15:'AttackRate',16:'SkillCooldownScalar',17:'NormalAttackDamageIncrease',18:'HpRecoveryPerSec',
 19:'HpRecoveryPerSecByMaxHpRatio',20:'MaxPoise',21:'PoiseRecTime',22:'MaxUltimateSp',
 23:'ComboSkillCooldownFinalAddition',24:'PoiseDamageTakenScalar',25:'PhysicalInflictionDamageScalar',
 26:'PoiseDamageOutputScalar',27:'BreakingAttackDamageTakenScalar',28:'UltimateSkillDamageIncrease',
 29:'HealOutputIncrease',30:'HealTakenIncrease',31:'PoiseRecTimeScalar',32:'NormalSkillDamageIncrease',
 33:'ComboSkillDamageIncrease',34:'KnockDownTimeAddition',35:'FireBurstDamageIncrease',36:'PulseBurstDamageIncrease',
 37:'CrystBurstDamageIncrease',38:'NaturalBurstDamageIncrease',39:'Str',40:'Agi',41:'Wisd',42:'Will',
 43:'LifeSteal',44:'UltimateSpGainScalar',45:'AtbCostAddition',46:'NormalSkillCooldownAddition',
 47:'ComboSkillCooldownScalar',48:'NaturalDamageTakenScalar',49:'IgniteDamageScalar',
 50:'PhysicalDamageIncrease',51:'FireDamageIncrease',52:'PulseDamageIncrease',53:'CrystDamageIncrease',
 54:'NaturalDamageIncrease',55:'EtherDamageIncrease',56:'FireAbnormalDamageIncrease',57:'PulseAbnormalDamageIncrease',
 58:'CrystAbnormalDamageIncrease',59:'NaturalAbnormalDamageIncrease',60:'EtherDamageTakenScalar',
 61:'DamageToBrokenUnitIncrease',62:'WeaknessDmgScalar',63:'ShelterDmgScalar',
 64:'PhysicalEnhancedDmgIncrease',65:'FireEnhancedDmgIncrease',66:'PulseEnhancedDmgIncrease',
 67:'CrystEnhancedDmgIncrease',68:'NaturalEnhancedDmgIncrease',69:'EtherEnhancedDmgIncrease',
 70:'PhysicalVulnerableDmgIncrease',71:'FireVulnerableDmgIncrease',72:'PulseVulnerableDmgIncrease',
 73:'CrystVulnerableDmgIncrease',74:'NaturalVulnerableDmgIncrease',75:'EtherVulnerableDmgIncrease',
 76:'AtkIncreaseFactorFromStr',77:'AtkIncreaseFactorFromAgi',78:'AtkIncreaseFactorFromWisd',79:'AtkIncreaseFactorFromWill',
 80:'PhysicalDmgResistScalar',81:'NaturalDmgResistScalar',82:'CrystDmgResistScalar',83:'PulseDmgResistScalar',
 84:'FireDmgResistScalar',85:'EtherDmgResistScalar',86:'SlowActionSpeedScalar',87:'PhysicalAndSpellInflictionEnhance',
 88:'ShieldOutputIncrease',89:'ShieldTakenIncrease',90:'NormalAttackStartRange',91:'InAirMoveSpeedScalar',
 92:'KeywordSpeedUpScalar',93:'ComboSkillCooldownRecoveryScalar',94:'PhysicalResistance',95:'NaturalResistance',
 96:'CrystResistance',97:'PulseResistance',98:'FireResistance',99:'EtherResistance',100:'ComboSkillCooldownDecrease',
};
export const MOD_TYPE = {0:'Addition',1:'Multiplier',3:'FinalAddition',4:'FinalMultiplier',
                         5:'BaseAddition',6:'BaseMultiplier',7:'BaseFinalAddition',8:'BaseFinalMultiplier'};

export const N2I = {};
for (const [k, v] of Object.entries(ATTR_NAMES)) N2I[v] = +k;

const TYPE_ATTR  = {0:50, 2:51, 3:52, 4:53, 6:54, 7:55};
const TYPE_ENH   = {0:64, 2:65, 3:66, 4:67, 6:68, 7:69};
const TYPE_VUL   = {0:70, 2:71, 3:72, 4:73, 6:74, 7:75};
const TYPE_TAKEN = {0:4, 2:5, 3:6, 4:7, 6:48, 7:60};
export const TYPE_RES  = {0:94, 6:95, 4:96, 3:97, 2:98, 7:99};
const TYPE_RSC   = {0:80, 6:81, 4:82, 3:83, 2:84, 7:85};
const SKILL_ATTR_BITS = [[13, 33], [9, 28], [8, 32]];
const NORMAL_BITS = (1 << 2) | (1 << 7) | (1 << 10) | (1 << 17);
const BURST_ATTR = {22:35, 24:36, 23:37, 25:38};
const ABN_ATTR = {'3,30': 56, '4': 57, '5,27': 58, '20': 59};

const ZONE_ORDER = ['ProdCalcZone', 'NormalCalcZone', 'AbnormalAndBurstIncrease',
                    'EnhancedDmgIncreace', 'ComboCalcZone', 'VulnerableDmgIncreace', 'RaceCalcZone'];
const ZONE_MULTIPLY = new Set(['ProdCalcZone']);
const INJECT = {dmg: 'NormalCalcZone', ignite: 'AbnormalAndBurstIncrease',
                skill: 'NormalCalcZone', broken: 'NormalCalcZone',
                enh: 'EnhancedDmgIncreace', vul: 'VulnerableDmgIncreace'};
const IGNITE_SET = 0xFD00038;
const PHYS_INFLICT = 0x4001C000;

let CHAR, ENEMY, SKILL, BUFF, CHARS, POTS, WPNS, EQUIPS, SUITS, ENEMIES,
    WSKILL_NAMES, TAKEN_LV, INFLICTION, ENH_FORMULA;

const INFLECT_KIND = {airborne: '击飞伤害', knockdown: '倒地伤害', crush: '猛击伤害',
                      fracture: '碎甲伤害', abn_initial: '异常初始伤害倍率',
                      shatter: '碎冰倍率', spellburst: '法术爆发伤害倍率',
                      burning: '燃烧每跳伤害'};
const INFLECT_MASK = {airborne: 1 << 14, knockdown: 1 << 15, crush: 1 << 16,
                      fracture: 1 << 30,
                      abn_initial: 1 << 3, burning: 1 << 25, shatter: 1 << 26,
                      spellburst: 1 << 24};

const MAIN_RATE = 0.005, SUB_RATE = 0.002;
const NO_DEF = new Set([1, 5]);

export function initData(char_index, enemy_index, skill_index, buff_index, skillsetting) {
  CHAR = char_index; ENEMY = enemy_index; SKILL = skill_index; BUFF = buff_index;
  CHARS = CHAR.chars; POTS = CHAR.potentials; WPNS = CHAR.weapons;
  EQUIPS = CHAR.equips; SUITS = CHAR.suits;
  ENEMIES = ENEMY.enemies;
  WSKILL_NAMES = CHAR.wpnSkillNames || {};
  TAKEN_LV = {};
  for (const [k, v] of Object.entries(ENEMY.damageTakenLevel || {})) TAKEN_LV[+k] = v;
  INFLICTION = {};
  for (const d of skillsetting.spellInflictionDataList) INFLICTION[d.key] = d;
  ENH_FORMULA = {};
  for (const f of skillsetting.physicalAndSpellInflictionEnhanceFormulaList) ENH_FORMULA[f.key] = f;
}
export const data = () => ({CHAR, ENEMY, SKILL, BUFF, CHARS, POTS, WPNS, EQUIPS, SUITS,
                            ENEMIES, WSKILL_NAMES, TAKEN_LV});

const g = (o, k, d = 0) => (o && o[k] !== undefined && o[k] !== null) ? o[k] : d;
const isObj = x => typeof x === 'object' && x !== null;

export function infliction_scale(attrs, kind, stacks = 1) {
  const d = INFLICTION[INFLECT_KIND[kind] || kind];
  if (!d) return 1.0;
  let v = d.values[Math.min(Math.max(Math.trunc(stacks), 1), d.values.length) - 1];
  const f = ENH_FORMULA[d.enhanceFormulaKey || ''];
  const x = g(attrs, 87, 0.0);
  if (f) {
    const t = f.formulaType;
    if (t === 1) v *= 1 + f.paramA * x;
    else if (t === 2) v *= 1 + f.paramA * x / (f.paramB + x);
  }
  return v;
}

export function apply_mods(base, mods) {
  const s = {BaseAddition: 0, BaseMultiplier: 0, BaseFinalAddition: 0,
             BaseFinalMultiplier: 0, Addition: 0, Multiplier: 0,
             FinalAddition: 0, FinalMultiplier: 0};
  for (const [a, v, mt] of mods) if (mt in s) s[mt] += v;
  let v = (base + s.BaseAddition) * (1 + s.BaseMultiplier) + s.BaseFinalAddition;
  v *= (1 + s.BaseFinalMultiplier);
  v = (v + s.Addition) * (1 + s.Multiplier) + s.FinalAddition;
  return v * (1 + s.FinalMultiplier);
}

function _bbval(bbref, blackboard) {
  if (isObj(bbref)) return g(blackboard, bbref.key, 0.0);
  return bbref ?? 0.0;
}

let _SRC_BB = null;
function _src_bb(bid) {
  if (_SRC_BB === null) {
    _SRC_BB = {};
    for (const [sid, s] of Object.entries(SKILL)) {
      const lv = Math.max(0, ...Object.keys(s.patch || {}).map(Number));
      const bb = _skill_bb_at_level(sid, lv);
      for (const b of (s.buffs || []).concat(s.createBuffs || [])) {
        const ov = {};
        for (const [k, v] of Object.entries(b.assign || {}))
          ov[k] = isObj(v) ? g(bb, v.from, 0) : v;
        if (!(b.buffId in _SRC_BB)) _SRC_BB[b.buffId] = ov;
      }
    }
    for (let it = 0; it < 4; it++) {
      let progress = false;
      for (const [pb, pdata] of Object.entries(BUFF)) {
        const pbb = {...(pdata.blackboard || {}), ...(_SRC_BB[pb] || {})};
        for (const [child, pairs] of Object.entries(pdata.createAssigns || {})) {
          if (child in _SRC_BB) continue;
          const ov = {};
          for (const [tk, ref] of Object.entries(pairs))
            ov[tk] = typeof ref === 'string' ? g(pbb, ref, 0) : ref;
          _SRC_BB[child] = ov; progress = true;
        }
      }
      if (!progress) break;
    }
  }
  return _SRC_BB[bid] || {};
}

function _key_fallback(key, bid) {
  const pref = bid.startsWith('buff_') ? bid.split('_').slice(1, 4).join('_') : bid;
  let best = 0.0;
  for (const [sid, s] of Object.entries(SKILL)) {
    if (!sid.startsWith(pref)) continue;
    const lv = Math.max(0, ...Object.keys(s.patch || {}).map(Number));
    const v = _skill_bb_at_level(sid, lv)[key];
    if (v) best = v;
  }
  return best;
}

export function buff_mods(bid, mods, zone_adds, bb_override = null, stacks = 1) {
  const b = BUFF[bid];
  if (!b) return;
  const bl = {...(b.blackboard || {}), ...(bb_override || {})};
  if (!bb_override) {
    for (const [k, v] of Object.entries(_src_bb(bid)))
      if (g(bl, k, 0) === 0) bl[k] = v;
    for (const m of (b.attrMods || []).concat((b.damageMods || []).flatMap(dm => dm.procs))) {
      const p = m.param ?? m.addition;
      if (isObj(p) && g(bl, p.key, 0) === 0) {
        const fb = _key_fallback(p.key, bid);
        if (fb) bl[p.key] = fb;
      }
    }
  }
  for (const m of (b.attrMods || []))
    mods.push([N2I[m.attr] ?? m.attr, _bbval(m.param, bl) * stacks, m.modifierType]);
  for (const dm of (b.damageMods || [])) {
    for (const p of dm.procs) {
      if (p.kind === 'DamageScaleProcessor' && p.zone) {
        let side = (p.side === 0) ? 'atk' : 'def';
        if (dm.hasCondition) side += '_cond';
        (zone_adds[side][p.zone] = zone_adds[side][p.zone] || []).push(
          _bbval(p.addition, bl) * stacks);
      }
    }
  }
}

export function talent_buffs_for(cid, char_break) {
  const best = {};
  const nodes = ((CHAR.talentNodes || {})[cid]) || {};
  for (const [nid, n] of Object.entries(nodes)) {
    if (n.reqStage > char_break) continue;
    for (const e of (n.effects || [])) {
      const ab = e.attachBuff || {};
      const bid = ab.buffId;
      if (!bid) continue;
      const bb = {};
      for (const x of (ab.blackboard || [])) bb[x.key] = x.value;
      if (!(bid in best) || n.reqStage >= best[bid][0]) best[bid] = [n.reqStage, bb, nid];
    }
  }
  const out = [];
  for (const [bid, [st, bb, nid]] of Object.entries(best)) {
    const children = (BUFF[bid] || {}).creates || [bid];
    for (const cb of children) {
      const cbdata = BUFF[cb] || {};
      if (!((cbdata.attrMods || []).length || (cbdata.damageMods || []).length)) continue;
      out.push({nid, buffId: cb, container: bid, bb, reqStage: st,
                maxStack: Math.max(1, Math.trunc(((cbdata.stacking || {}).maxStack) || 1))});
    }
  }
  return out;
}

function _apply_effects(effs, mods, zone_adds, skill_bb) {
  for (const eff of effs) {
    const ab = eff.attachBuff || {};
    if (ab.buffId) {
      const ov = {};
      for (const x of (ab.blackboard || [])) ov[x.key] = x.value;
      buff_mods(ab.buffId, mods, zone_adds, ov);
    }
    const am = eff.attrModifier || {};
    if (am.attrType)
      mods.push([am.attrType, g(am, 'attrValue', 0), MOD_TYPE[am.modifierType] || 'Addition']);
    const sk = eff.skillBbModifier || {};
    if (sk.skillId) {
      (skill_bb[sk.skillId] = skill_bb[sk.skillId] || {})[sk.bbKey] =
        [g(sk, 'floatValue', 0), g(sk, 'modifyType', 0)];
    }
  }
}

export function _skill_bb_at_level(sid, level) {
  const s = SKILL[sid];
  if (!s) return {};
  const bb = {...s.blackboard};
  const p = (s.patch || {})[String(Math.trunc(level))];
  if (p) Object.assign(bb, p);
  return bb;
}

export function apply_weapon_skill(sid, level, char, mods, zone_adds, apply_buffs = true, stacks = 1) {
  const s = SKILL[sid];
  if (!s || level <= 0) return;
  const bb = _skill_bb_at_level(sid, level);
  for (const m of (s.cardMods || [])) {
    const p = m.param;
    const val = isObj(p) ? g(bb, p.key, 0) : (p || 0);
    let a = m.attr;
    if (m.modifyAttributeType === 1) a = N2I[char.mainAttr] ?? a;
    else if (m.modifyAttributeType === 2) a = N2I[char.subAttr] ?? a;
    mods.push([a, val, m.modifierType]);
  }
  if (apply_buffs) {
    for (const b of (s.buffs || []).concat(s.createBuffs || [])) {
      const ov = {};
      for (const [k, v] of Object.entries(b.assign || {})) {
        if (!isObj(v)) { ov[k] = v; continue; }
        const fk = v.from;
        let val = g(bb, fk, 0);
        if (val === 0 && stacks !== 1 && String(fk).endsWith('_final'))
          val = g(bb, String(fk).slice(0, -6), 0) * stacks;
        ov[k] = val;
      }
      buff_mods(b.buffId, mods, zone_adds, ov);
    }
  }
}

export function wpn_skill_lv(w, wpn_lv, brk, tal, i) {
  const brow = (brk < w.breakthrough.length) ? w.breakthrough[brk] : {};
  const trow = (0 < tal && tal <= w.talent.length) ? w.talent[tal - 1] : {};
  const bb_ = brow.skillLevelBounds || [];
  const ee_ = trow.skillLevelExtraBounds || [];
  const b = (i < bb_.length) ? bb_[i] : {lowerBound: 0, upperBound: 0};
  const e = (i < ee_.length) ? ee_[i] : {upperBound: 0};
  const stage_lv = brow.lv ?? 1;
  const nxt = (brk + 1 < w.breakthrough.length) ? w.breakthrough[brk + 1].lv : w.maxLv + 1;
  const frac = Math.min(1.0, Math.max(0.0, (wpn_lv - stage_lv) / Math.max(1, nxt - stage_lv)));
  return b.lowerBound + (b.upperBound - b.lowerBound) * frac + e.upperBound;
}

export function build_attacker(cid, level, {weapon = null, equips = [], suit_ids = [],
    potential_lv = 0, buff_ids = [], char_break = 0, talent_nodes = null,
    suit_buffs = true, dyn_buffs = []} = {}) {
  const c = CHARS[cid];
  const row = c.levels[String(level)] || {};
  const base = {};
  for (const [k, v] of Object.entries(row)) base[N2I[k] ?? k] = v;
  if (base[10] === undefined) base[10] = 0.5;
  const mods = [], skill_bb = {};
  const zone_adds = {atk: {}, def: {}, atk_cond: {}, def_cond: {}};
  const wid = (weapon && weapon.id) || c.defaultWeaponId;
  const w = WPNS[wid];
  let wpn_atk = 0;
  const sb = weapon ? weapon.skill_buffs : undefined;
  if (w) {
    wpn_atk = g(w.baseAtkCurve, String((weapon && weapon.lv !== undefined) ? weapon.lv : w.maxLv), 0);
    base[2] = g(base, 2, 0) + wpn_atk;
    const brk = (weapon && weapon.brk) || 0, tal = (weapon && weapon.talent) || 0;
    const slv = (weapon && weapon.skill_levels) || {};
    for (let i = 0; i < (w.weaponSkillList || []).length; i++) {
      const sid = w.weaponSkillList[i];
      let lv = slv[sid];
      if (lv === undefined || lv === null)
        lv = wpn_skill_lv(w, (weapon && weapon.lv !== undefined) ? weapon.lv : w.maxLv, brk, tal, i);
      const n_stk = isObj(sb) ? (sb[sid] ?? 1) : 1;
      const apply_buffs = (sb === undefined || sb === null || sb === true || (isObj(sb) && sid in sb));
      apply_weapon_skill(sid, lv, c, mods, zone_adds, apply_buffs, n_stk);
    }
  }
  for (const [eid, tier] of equips) {
    const e = EQUIPS[eid];
    if (!e) continue;
    for (let j = 0; j < e.modifiers.length; j++) {
      const m = e.modifiers[j];
      const vals = m.values || [0];
      let t = Array.isArray(tier) ? (j < tier.length ? tier[j] : 0) : tier;
      t = Math.min(Math.max(0, Math.trunc(t || 0)), vals.length - 1);
      let a = N2I[m.attr] ?? m.attr;
      if (m.modifyAttributeType === 1) a = N2I[c.mainAttr] ?? a;
      else if (m.modifyAttributeType === 2) a = N2I[c.subAttr] ?? a;
      mods.push([a, vals[t], m.modifierType]);
    }
  }
  for (const sid2 of suit_ids)
    for (const bo of ((SUITS[sid2] || {}).bonuses || []))
      apply_weapon_skill(bo.skillID, bo.skillLv ?? 1, c, mods, zone_adds, suit_buffs);
  for (const p of (POTS[cid] || []))
    if (p.level <= potential_lv) _apply_effects(p.effects || [], mods, zone_adds, skill_bb);
  const tnodes = ((CHAR.talentNodes || {})[cid]) || {};
  for (const [nid, n] of Object.entries(tnodes)) {
    if (talent_nodes !== null) {
      if (!(nid in talent_nodes) && !talent_nodes.has?.(nid)) continue;
    } else if (n.reqStage > char_break) continue;
    for (const m of (n.attrMods || [])) {
      let a = N2I[m.attr] ?? m.attr;
      if (m.modifyAttributeType === 1) a = N2I[c.mainAttr] ?? a;
      else if (m.modifyAttributeType === 2) a = N2I[c.subAttr] ?? a;
      mods.push([a, m.value, m.modifierType]);
    }
    _apply_effects(n.effects || [], mods, zone_adds, skill_bb);
  }
  for (const bid of buff_ids) buff_mods(bid, mods, zone_adds);
  for (const [bid, stacks, bb] of dyn_buffs) buff_mods(bid, mods, zone_adds, bb, stacks);
  const attrs = {};
  const attrIds = new Set(Object.keys(base).map(Number));
  for (const m of mods) attrIds.add(+m[0]);
  for (const a of attrIds)
    attrs[a] = apply_mods(g(base, a, 0.0), mods.filter(m => +m[0] === a));
  attrs[1] = g(attrs, 1, 0) + Math.trunc(g(attrs, 39, 0)) * 5;
  const main = N2I[c.mainAttr] ?? 40, sub = N2I[c.subAttr] ?? 39;
  const atk_final = g(attrs, 2, 0) * (1 + Math.floor(g(attrs, main, 0)) * MAIN_RATE
                    + Math.floor(g(attrs, sub, 0)) * SUB_RATE
                    + [76, 77, 78, 79].reduce((s, x) => s + g(attrs, x, 0), 0));
  return {attrs, atk_final, zone_adds: zone_adds.atk, zone_cond: zone_adds.atk_cond,
          skill_bb, char: c, mods, base, weapon_atk: wpn_atk};
}

export function build_defender(eid, level, extra_buffs = []) {
  const e = ENEMIES[eid];
  const row = e.levels[String(level)] || {};
  const base = {};
  for (const [k, v] of Object.entries({...e.attrs, ...row})) base[N2I[k] ?? k] = v;
  const mods = [];
  const zone_adds = {atk: {}, def: {}, atk_cond: {}, def_cond: {}};
  for (const m of (e.attrModifiers || []))
    mods.push([N2I[m.attr] ?? m.attr, m.value, m.modifierType]);
  for (const item of (e.bornBuffs || []).concat(extra_buffs)) {
    if (Array.isArray(item)) buff_mods(item[0], mods, zone_adds, null, item[1]);
    else buff_mods(item, mods, zone_adds);
  }
  const attrs = {};
  const attrIds = new Set(Object.keys(base).map(Number));
  for (const m of mods) attrIds.add(+m[0]);
  for (const a of attrIds)
    attrs[a] = apply_mods(g(base, a, 0.0), mods.filter(m => +m[0] === a));
  return {attrs, zone_adds: zone_adds.def, zone_cond: zone_adds.def_cond,
          maxPoise: g(attrs, 20, 0), maxResilience: g(e, 'maxResilience', 0)};
}

function skill_attr(mask) {
  for (const [bit, a] of SKILL_ATTR_BITS)
    if (mask & (1 << bit)) return a;
  if (mask & NORMAL_BITS) return 17;
  return null;
}

function _zone_slot(zone, vals) {
  let s = 1.0;
  if (ZONE_MULTIPLY.has(zone)) for (const v of vals) s *= (1 + v);
  else for (const v of vals) s += v;
  return s;
}

export function compute_hit(hit, skill_bb, atk, dfn,
    {broken = false, crit = false, cond = false, weak = false,
     manual_mul = 1.0, inflict = false, skill_mult = 1.0} = {}) {
  const A = atk.attrs, D = dfn.attrs;
  const t = hit.type;
  let mask = hit.mask;
  if (inflict === 'trigger') mask |= 1 << 14;
  const calc = hit.calc;
  const res = (t in TYPE_RES) ? g(D, TYPE_RES[t], 0) : 0;
  const taken = (t in TYPE_TAKEN) ? g(D, TYPE_TAKEN[t], 1) : 1;
  const type_res = (t in TYPE_RES) ? Math.max(0.0, (1 - res / 100) * taken) : 1.0;
  let scale, calc_result;
  if (calc === 'AtkScaleCalculation') {
    scale = g(skill_bb, 'atk_scale', 0) || _bbval(hit.atkScale, skill_bb);
    calc_result = atk.atk_final * scale;
  } else if (calc === 'DefiniteValueCalculation') {
    scale = _bbval(hit.calcValue, skill_bb);
    calc_result = scale;
  } else {
    const raw = hit.atkScale;
    scale = _bbval(raw, skill_bb) || _bbval(hit.calcValue, skill_bb);
    if (typeof raw === 'number') scale *= skill_mult;
    calc_result = atk.atk_final * scale;
  }
  const za = {}, zd = {};
  for (const [z, v] of Object.entries(atk.zone_adds)) za[z] = [...v];
  for (const [z, v] of Object.entries(dfn.zone_adds)) zd[z] = [...v];
  if (cond) {
    for (const [k, v] of Object.entries(atk.zone_cond || {}))
      za[k] = (za[k] || []).concat(v);
    for (const [k, v] of Object.entries(dfn.zone_cond || {}))
      zd[k] = (zd[k] || []).concat(v);
  }
  (za[INJECT.dmg] = za[INJECT.dmg] || []).push((t in TYPE_ATTR) ? g(A, TYPE_ATTR[t], 0) : 0);
  (zd[INJECT.vul] = zd[INJECT.vul] || []).push((t in TYPE_VUL) ? g(D, TYPE_VUL[t], 0) : 0);
  (za[INJECT.enh] = za[INJECT.enh] || []).push((t in TYPE_ENH) ? g(A, TYPE_ENH[t], 0) : 0);
  for (const [bts, a] of Object.entries(ABN_ATTR))
    if (bts.split(',').map(Number).some(b => mask & (1 << b)))
      (za[INJECT.ignite] = za[INJECT.ignite] || []).push(g(A, a, 0));
  for (const [bit, a] of Object.entries(BURST_ATTR))
    if (mask & (1 << +bit)) (za[INJECT.ignite] = za[INJECT.ignite] || []).push(g(A, a, 0));
  const sa = skill_attr(mask);
  if (sa) (za[INJECT.skill] = za[INJECT.skill] || []).push(g(A, sa, 0));
  if (broken) (za[INJECT.broken] = za[INJECT.broken] || []).push(g(A, 61, 0));
  let zone_scale = 1.0;
  for (const z of ZONE_ORDER)
    zone_scale *= Math.max(0.0, _zone_slot(z, za[z] || []) * _zone_slot(z, zd[z] || []));
  const final_atk = calc_result * zone_scale;
  const common = {calcResult: calc_result, zoneScale: zone_scale, finalAtk: final_atk,
                  atkZones: za, defZones: zd, resist: res, taken, type: t,
                  mask, scale};
  if (t === 5) return {...common, damage: final_atk, defTerm: 1.0};
  const d = g(D, 3, 0);
  const def_res = NO_DEF.has(t) ? 1.0 : (d >= 0 ? 1 / (1 + 0.01 * d) : 2 - Math.pow(0.99, Math.abs(d)));
  const dmg = final_atk
      * g(A, 62, 1)
      * (crit ? (1 + g(A, 10, 0.5)) : 1.0)
      * def_res
      * (1 - g(D, 63, 0))
      * type_res
      * ((mask & IGNITE_SET) ? g(A, 49, 1) : 1.0)
      * ((mask & PHYS_INFLICT) ? g(A, 25, 1) : 1.0)
      * (hit.guardReduce ? (1 - hit.guardRatio) : 1.0)
      * manual_mul;
  return {...common, damage: dmg, defTerm: def_res};
}

export function suit_extra_hits(suit_ids) {
  const out = [];
  for (const sid of suit_ids) {
    const suit = SUITS[sid] || {};
    for (const bo of (suit.bonuses || [])) {
      const sk = SKILL[bo.skillID];
      if (!sk) continue;
      const bb = _skill_bb_at_level(bo.skillID, bo.skillLv ?? 1);
      for (const b of (sk.buffs || []).concat(sk.createBuffs || [])) {
        for (const u of ((BUFF[b.buffId] || {}).extraHits || [])) {
          const sc = u.atkScale;
          const val = isObj(sc) ? g(bb, sc.key, 0) : (sc || 0);
          if (val <= 0) continue;
          out.push({suit: sid, name: suit.name || sid,
                    scale: val, dtype: u.damageType ?? 0, mask: u.mask ?? 0});
        }
      }
    }
  }
  return out;
}

export function compute_extra_hit(atk, dfn, scale = 1.0, dtype = 0, mask = 0, kw = {}) {
  const hit = {type: dtype, mask, atkScale: scale};
  const r = compute_hit(hit, {}, atk, dfn, kw);
  r.extra = true;
  return r;
}

export function compute_inflict_proc(atk, dfn, {kind = 'airborne', stacks = 1, dtype = 0,
    crit = false, manual_mul = 1.0, ...kw} = {}) {
  const hit = {type: dtype, mask: INFLECT_MASK[kind] ?? (1 << 14),
               atkScale: infliction_scale(atk.attrs, kind, stacks)};
  const r = compute_hit(hit, {}, atk, dfn, {crit, manual_mul, ...kw});
  r.inflict = 'proc';
  r.inflictKind = kind;
  return r;
}

export function compute_skill(sid, atk, dfn,
    {skill_level = null, inflict_proc = false, ...kw} = {}) {
  const s = SKILL[sid];
  const bb = {...s.blackboard};
  const patch = s.patch || {};
  const pkeys = Object.keys(patch);
  const lv = skill_level ?? (pkeys.length ? pkeys.reduce((a, b) => a > b ? a : b) : null);
  if (lv !== null && String(lv) in patch) Object.assign(bb, patch[String(lv)]);
  let mult = 1.0;
  for (const [k2, op] of Object.entries((atk.skill_bb || {})[sid] || {})) {
    const [v, mt] = Array.isArray(op) ? op : [op, 0];
    if (mt === 2) { bb[k2] = g(bb, k2, 0) * v; mult *= v; }
    else if (mt === 1) bb[k2] = g(bb, k2, 0) + v;
    else bb[k2] = v;
  }
  const crit_sel = kw.crit ?? false;
  const per_hit = (crit_sel instanceof Set) || Array.isArray(crit_sel);
  const hits = [];
  for (let i = 0; i < s.hits.length; i++) {
    const h = s.hits[i];
    const hkw = {...kw};
    if (per_hit) hkw.crit = crit_sel.has ? crit_sel.has(i) : crit_sel.includes(i);
    hits.push(compute_hit(h, bb, atk, dfn, {...hkw, skill_mult: mult}));
  }
  if (inflict_proc) {
    const dtype = hits.length ? hits[0].type : 0;
    const pcrit = per_hit ? (crit_sel.has ? crit_sel.has(hits.length)
                                          : crit_sel.includes(hits.length)) : crit_sel;
    hits.push(compute_inflict_proc(atk, dfn, {
      kind: typeof inflict_proc === 'string' ? inflict_proc : 'airborne',
      stacks: kw.inflict_stacks ?? 1, dtype, crit: pcrit,
      manual_mul: kw.manual_mul ?? 1.0}));
  }
  return hits;
}

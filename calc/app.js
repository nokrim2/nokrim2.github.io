import * as dc from './calc.js?v=5';

const DEC = {0:'불균형',1:'가드회피무시',2:'강공격',3:'열기부착',4:'전기부착',
5:'냉기부착',6:'이상부여',7:'일반공격',8:'배틀스킬',9:'궁극기',10:'낙하공격',
11:'폭탄',12:'약점파괴',13:'연계스킬',14:'강타',15:'띄우기',16:'넘어뜨리기',
17:'대시',18:'회피무시면역',19:'스킬무시면역',20:'자연부착',21:'강력한일격',
22:'열기폭발',23:'냉기폭발',24:'전기폭발',25:'자연폭발',26:'연소',
27:'쇄빙',28:'지속피해',29:'잔류지역',30:'갑옷파괴',31:'재능'};
const TYPENAME = {0:'물리',1:'실수치',2:'열기',3:'전기',4:'냉기',5:'흡혈',6:'자연',7:'초자연'};
const SLOTS = [[0, '방어구'], [1, '보호장갑'], [2, '부품Ⅰ'], [2, '부품Ⅱ']];
const KR_ATTR = {1:'최대 생명력',2:'공격력',3:'방어력',9:'치명타 확률',10:'치명타 피해',
           17:'일반 공격 피해 증가',25:'물리 이상 피해 배율',28:'궁극기 피해 증가',
           32:'배틀 스킬 피해 증가',33:'연계 스킬 피해 증가',
           39:'힘',40:'민첩',41:'지능',42:'의지',49:'이상 피해 배율',
           61:'처형 피해 증가',62:'허약 피해 배율',63:'피해 감소',
           87:'물리·아츠 이상 강화',
           50:'물리 피해 증가',51:'열기 피해 증가',52:'전기 피해 증가',53:'냉기 피해 증가',
           54:'자연 피해 증가',55:'초자연 피해 증가',
           94:'물리 저항',95:'자연 저항',96:'냉기 저항',97:'전기 저항',
           98:'열기 저항',99:'초자연 저항'};
const PCT = new Set([9,10,17,28,32,33,49,61,62,63]);
for (let i = 50; i < 76; i++) PCT.add(i);
for (let i = 80; i < 86; i++) PCT.add(i);
const SKILL_KR = {'attack':'일반 공격','power_attack':'강공격','dash_attack':'대시 공격',
            'dodge':'회피','plunging_attack':'낙하 공격','drop_attack':'낙하 공격',
            'normal_skill':'배틀 스킬','combo_skill':'연계 스킬',
            'ultimate_skill':'궁극기','ult_skill':'궁극기',
            'break_attack':'파괴 공격','execution_attack':'처형 공격',
            'last_combo':'강력한 일격','bomb':'폭탄','projhit':'투사체'};

const mask_names = m => Object.entries(DEC).filter(([b]) => (m >> b) & 1)
                              .map(([, n]) => n).join('|') || '-';
const _id = s => s.includes('[') ? s.split('[').pop().replace(']', '') : s;
const _name = (coll, k) => `${(coll[k] || {}).name || k} [${k}]`;
const _buff_entry = s => {
  const i = s.lastIndexOf('×');
  const st = i >= 0 ? s.slice(i + 1) : '';
  return /^\d+$/.test(st) ? [s.slice(0, i), +st] : [s, 1];
};
const $ = id => document.getElementById(id);
const intv = el => { const v = parseInt(el.value); if (isNaN(v)) throw `숫자 필요: ${el.id}`; return v; };
const fg = v => `${+Number.parseFloat(Number(v).toPrecision(6))}`;

const LISTS = {};   // input id -> 전체 후보 목록
function setList(inputId, vals) { LISTS[inputId] = vals; }

// tkinter Combobox와 동일: 포커스 시 전체 목록, 타이핑 시 필터
function combo(input, listFn, maxItems = 300) {
  const wrap = document.createElement('span'); wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const drop = document.createElement('div'); drop.className = 'drop';
  wrap.appendChild(drop);
  const render = t => {
    const vals = listFn(t);
    drop.innerHTML = '';
    for (const v of vals.slice(0, maxItems)) {
      const d = document.createElement('div');
      d.textContent = v;
      d.addEventListener('pointerdown', e => {
        e.preventDefault();
        input.value = v;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        hide();
      });
      drop.appendChild(d);
    }
    drop.style.display = vals.length ? 'block' : 'none';
  };
  const show = () => render('');
  const hide = () => { drop.style.display = 'none'; };
  input.addEventListener('focus', show);
  input.addEventListener('click', show);
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  input.addEventListener('blur', () => setTimeout(hide, 150));
}
const nameFilter = id => t =>
  (LISTS[id] || []).filter(v => v.toLowerCase().includes(t.toLowerCase()));

const state = { forge: {}, wskLv: {}, wskVar: {}, wskStk: {}, talVar: {}, extraHits: [] };

function equipRows() {
  const D = dc.data();
  const host = $('equip-rows');
  for (let i = 0; i < SLOTS.length; i++) {
    const [pt, pname] = SLOTS[i];
    const row = document.createElement('div'); row.className = 'row';
    const lab = document.createElement('label'); lab.textContent = pname + ' ';
    const inp = document.createElement('input');
    inp.id = 'eq_in' + i;
    const vals = ['(none)', ...Object.keys(D.EQUIPS)
      .filter(k => D.EQUIPS[k].partType === pt)
      .map(k => _name(D.EQUIPS, k))];
    setList('eq_in' + i, vals); inp.value = '(none)';
    inp.addEventListener('input', () => refreshForge(i));
    row.append(lab, inp); host.appendChild(row);
    combo(inp, nameFilter('eq_in' + i));
    const frow = document.createElement('div'); frow.className = 'row'; frow.id = 'forge' + i;
    host.appendChild(frow);
    state.forge[i] = {};
  }
}

function resolveAttr(m, c) {
  let a = m.attr;
  if (m.modifyAttributeType === 1 && c) a = c.mainAttr;
  else if (m.modifyAttributeType === 2 && c) a = c.subAttr;
  return dc.N2I[a] ?? a;
}

function refreshForge(i) {
  const D = dc.data();
  const fr = $('forge' + i); fr.innerHTML = ''; state.forge[i] = {};
  const e = D.EQUIPS[_id($('eq_in' + i).value)];
  if (!e) return;
  const c = D.CHARS[_id($('cid').value)];
  e.modifiers.forEach((m, j) => {
    const vals = m.values || [];
    if (new Set(vals).size <= 1) return;
    const name = KR_ATTR[resolveAttr(m, c)] || m.attr;
    const w = document.createElement('span'); w.className = 'forge';
    const lab = document.createElement('label'); lab.textContent = name;
    const sp = document.createElement('input');
    sp.type = 'number'; sp.min = 0; sp.max = vals.length - 1; sp.value = 0;
    const val = document.createElement('span'); val.className = 'val';
    const upd = () => {
      let t = parseInt(sp.value);
      t = isNaN(t) ? 0 : Math.max(0, Math.min(vals.length - 1, t));
      const v = vals[t];
      const aid = resolveAttr(m, c);
      val.textContent = PCT.has(+aid) ? (v * 100).toFixed(1) + '%' : '+' + fg(v);
    };
    sp.addEventListener('input', upd);
    w.append(lab, sp, val); fr.appendChild(w);
    state.forge[i][j] = sp; upd();
  });
}

function refreshWsk() {
  const D = dc.data();
  const host = $('wsk'); host.innerHTML = '';
  state.wskLv = {}; state.wskVar = {}; state.wskStk = {};
  const w = D.WPNS[_id($('wid').value)];
  if (!w) return;
  const num = id => { const v = parseInt($(id).value); return isNaN(v) ? null : v; };
  const wlv = num('wlv') ?? w.maxLv, brk = num('brk') ?? 0, tal = num('tal') ?? 0;
  (w.weaponSkillList || []).forEach((sid, i) => {
    const s = D.SKILL[sid] || {};
    const row = document.createElement('div'); row.className = 'wsk-row';
    const nm = document.createElement('span'); nm.className = 'wsk-name';
    nm.textContent = D.WSKILL_NAMES[sid] || sid; nm.title = sid;
    const maxlv = Math.max(1, ...Object.keys(s.patch || {}).map(Number));
    const lv0 = Math.max(0, Math.min(maxlv, Math.trunc(dc.wpn_skill_lv(w, wlv, brk, tal, i))));
    const sp = document.createElement('input');
    sp.type = 'number'; sp.min = 0; sp.max = maxlv; sp.value = lv0;
    row.append(nm, sp);
    state.wskLv[sid] = sp;
    const bids = (s.buffs || []).concat(s.createBuffs || []).map(b => b.buffId);
    if (bids.length) {
      const cb = document.createElement('input'); cb.type = 'checkbox';
      const cl = document.createElement('label'); cl.append(cb, ' 버프');
      row.appendChild(cl);
      const mx = Math.trunc((s.blackboard || {}).max_stack || 0);
      if (mx > 0) {
        const st = document.createElement('input');
        st.type = 'number'; st.min = 0; st.max = mx; st.value = mx;
        row.appendChild(st); state.wskStk[sid] = st;
      }
      const bl = document.createElement('span'); bl.className = 'sub';
      bl.textContent = bids.join(','); row.appendChild(bl);
      state.wskVar[sid] = cb;
    }
    host.appendChild(row);
  });
}

function refreshTalents() {
  const D = dc.data();
  const host = $('talents'); host.innerHTML = ''; state.talVar = {};
  const cid = _id($('cid').value) || 'chr_0002_endminm';
  let brk = parseInt($('cbrk').value); if (isNaN(brk)) brk = 4;
  for (const opt of dc.talent_buffs_for(cid, brk)) {
    const row = document.createElement('div'); row.className = 'tal-row';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    const lab = document.createElement('label');
    lab.prepend(cb, ' ', opt.buffId.replace('buff_', ''));
    row.appendChild(lab);
    let sp = null;
    if (opt.maxStack > 1) {
      sp = document.createElement('input');
      sp.type = 'number'; sp.min = 1; sp.max = opt.maxStack; sp.value = opt.maxStack;
      row.appendChild(sp);
    }
    host.appendChild(row);
    state.talVar[opt.buffId] = {cb, sp, opt};
  }
}

function addBuff(input, listbox, stk) {
  const bid = input.value;
  if (!(bid in dc.data().BUFF)) return;
  const n = Math.max(1, parseInt(stk.value) || 1);
  const o = document.createElement('option');
  o.value = bid + (n > 1 ? '×' + n : ''); o.textContent = o.value;
  listbox.appendChild(o);
}

function listEntries(listbox) {
  return [...listbox.options].map(o => _buff_entry(o.value));
}

function charChanged() {
  const D = dc.data();
  const cid = _id($('cid').value) || 'chr_0002_endminm';
  const c = D.CHARS[cid];
  if (!c) return;
  const wid = c.defaultWeaponId;
  $('wid').value = (wid in D.WPNS) ? _name(D.WPNS, wid) : '';
  const sn = c.skillNames || {};
  const vals = Object.keys(D.SKILL)
    .filter(k => k.startsWith(cid) && (D.SKILL[k].hits || []).length)
    .sort()
    .map(s => {
      const tail = s.slice(cid.length + 1);
      const base = sn[s] || Object.entries(SKILL_KR).find(([k2]) => tail.startsWith(k2))?.[1] || tail;
      return `${base} [${s}]`;
    });
  setList('sid', vals);
  if (vals.length && !(LISTS.sid || []).includes($('sid').value))
    $('sid').value = vals[0];
  if (!vals.length) $('sid').value = '';
  for (const i of Object.keys(state.forge)) refreshForge(+i);
  refreshWsk(); refreshTalents();
  run();
}

function zoneDictStr(z) {
  return '{' + Object.entries(z)
    .map(([k, v]) => `${k}: [${v.map(x => fg(x)).join(', ')}]`).join(', ') + '}';
}

function showStats(atk, dfn, suit_ids) {
  const D = dc.data();
  const A = atk.attrs, Df = dfn.attrs;
  const base = atk.base || {}, w_atk = atk.weapon_atk || 0;
  const c = atk.char;
  const main = dc.N2I[c.mainAttr] ?? 40, sub = dc.N2I[c.subAttr] ?? 39;
  const fmt = (v, a) => PCT.has(+a) ? (v * 100).toFixed(1) + '%' : String(Math.trunc(v));
  let t = `■ ${c.name || 'Attacker'}  Lv${$('lv').value} 돌파${$('cbrk').value}\n`;
  t += `최종 공격력  ${Math.trunc(atk.atk_final)}  (${atk.atk_final.toFixed(2)})\n`;
  t += `기초 총 수치  ${Math.trunc(A[2] || 0)}  (${(A[2] || 0).toFixed(2)})\n`;
  t += `  기초 공격력 ${Math.trunc(base[2] || 0)} = 오퍼레이터 ${((base[2] || 0) - w_atk).toFixed(0)} + 무기 ${w_atk.toFixed(0)}\n`;
  t += `  공격력 보너스 ${(((A[2] || 0) - (base[2] || 0)) >= 0 ? '+' : '')}${(((A[2] || 0) - (base[2] || 0))).toFixed(1)}`;
  if (base[2]) t += ` (${(((A[2] || 0) / base[2]) - 1) * 100 < 0 ? '' : ''}${((((A[2] || 0) / base[2]) - 1) * 100).toFixed(1)}%)`;
  t += `\n  ${KR_ATTR[main]} 보너스 +${((A[main] || 0) * 0.5).toFixed(1)}%`;
  t += `   ${KR_ATTR[sub]} 보너스 +${((A[sub] || 0) * 0.2).toFixed(1)}%\n\n`;
  for (const a of [1, 3, 39, 40, 41, 42, 9, 10, 17, 28, 32, 33, 61, 62])
    t += `${(KR_ATTR[a] || dc.ATTR_NAMES[a] || a).padEnd(14)} ${fmt(A[a] || 0, a).padStart(8)}  (${Number(A[a] || 0).toPrecision(4)})\n`;
  for (let a = 50; a < 56; a++)
    if (A[a]) t += `${KR_ATTR[a].padEnd(14)} ${fmt(A[a], a).padStart(8)}\n`;
  if (Object.keys(atk.zone_adds).length) t += `존 보정(공격) ${zoneDictStr(atk.zone_adds)}\n`;
  if (atk.zone_cond && Object.keys(atk.zone_cond).length)
    t += `존 보정(공격,조건부) ${zoneDictStr(atk.zone_cond)}\n`;
  if (suit_ids.length)
    t += '세트 ' + suit_ids.map(s => `${(D.SUITS[s] || {}).name || s}[${s}]`).join(', ') + '\n';
  t += `\n■ ${_name(D.ENEMIES, _id($('eid').value))}  Lv${$('elv').value}\n`;
  t += `생명력 ${(Df[1] || 0).toFixed(0)}  불균형치 ${dfn.maxPoise.toFixed(0)}\n`;
  for (const k of Object.keys(dc.TYPE_RES).map(Number).sort((a, b) => a - b))
    t += `  ${TYPENAME[k].padEnd(9)} 저항 ${(Df[dc.TYPE_RES[k]] || 0).toFixed(0)}%   받는피해 ${(Df[dc.TYPE_TAKEN[k]] ?? 1).toFixed(2)}\n`;
  if (Object.keys(dfn.zone_adds).length) t += `존 보정(방어) ${zoneDictStr(dfn.zone_adds)}\n`;
  if (dfn.zone_cond && Object.keys(dfn.zone_cond).length)
    t += `존 보정(방어,조건부) ${zoneDictStr(dfn.zone_cond)}\n`;
  $('stats').textContent = t;
}

function run() {
  const D = dc.data();
  const cid = _id($('cid').value);
  try {
    const eqs = [];
    for (const p of Object.keys(state.forge)) {
      const inp = $('eq_in' + p);
      if (!inp || inp.value === '(none)') continue;
      const eid2 = _id(inp.value);
      const e2 = D.EQUIPS[eid2];
      if (!e2) continue;
      const tiers = e2.modifiers.map((_, j) =>
        state.forge[p][j] ? (parseInt(state.forge[p][j].value) || 0) : 0);
      eqs.push([eid2, tiers]);
    }
    const suits = {};
    for (const [eid2] of eqs) {
      const s = D.EQUIPS[eid2].suitID;
      if (s) suits[s] = (suits[s] || 0) + 1;
    }
    const suit_ids = Object.keys(suits).filter(s =>
      ((D.SUITS[s] || {}).bonuses || []).some(b => suits[s] >= b.equipCnt));
    const dyn = [];
    for (const {cb, sp, opt} of Object.values(state.talVar))
      if (cb.checked) dyn.push([opt.buffId, sp ? parseInt(sp.value) : 1, opt.bb]);
    for (const [bid, st] of listEntries($('atk_buffs'))) dyn.push([bid, st, null]);
    const skill_buffs = {};
    for (const s of Object.keys(state.wskVar))
      if (state.wskVar[s].checked)
        skill_buffs[s] = state.wskStk[s] ? parseInt(state.wskStk[s].value) || 0 : 1;
    const skill_levels = {};
    for (const s of Object.keys(state.wskLv))
      skill_levels[s] = parseInt(state.wskLv[s].value) || 0;
    const atk = dc.build_attacker(cid, intv($('lv')), {
      weapon: {id: _id($('wid').value), lv: intv($('wlv')), brk: intv($('brk')),
               talent: intv($('tal')), skill_levels, skill_buffs},
      equips: eqs, suit_ids, potential_lv: intv($('pot')),
      char_break: intv($('cbrk')),
      suit_buffs: $('suit_buff').checked, dyn_buffs: dyn});
    const dfn = dc.build_defender(_id($('eid').value), intv($('elv')),
                                  listEntries($('def_buffs')));
    showStats(atk, dfn, suit_ids);
    const tb = $('hits').querySelector('tbody'); tb.innerHTML = '';
    const inflict = {'방어 불능 상태': 'sustained', '이상 발동': 'trigger'}[$('inflict').value] || false;
    const proc_kind = {'띄우기': 'airborne', '넘어뜨리기': 'knockdown',
                       '강타': 'crush', '갑옷 파괴': 'fracture',
                       '이상 초기피해': 'abn_initial', '쇄빙': 'shatter',
                       '아츠 폭발': 'spellburst', '연소 지속': 'burning'}[$('proc').value] || false;
    const ch = $('crit_hits').value.trim();
    const crit = ch ? new Set(ch.split(',').map(x => x.trim())
                              .filter(x => /^\d+$/.test(x)).map(x => +x - 1))
                    : $('crit').checked;
    const kw = {broken: $('broken').checked, crit,
                cond: $('cond').checked, weak: $('weak').checked,
                inflict, inflict_proc: proc_kind,
                inflict_stacks: parseInt($('proc_stacks').value) || 1,
                manual_mul: parseFloat($('mmul').value) || 1};
    const hits = dc.compute_skill(_id($('sid').value), atk, dfn,
                                  {skill_level: intv($('slv')), ...kw});
    state.extraHits = dc.suit_extra_hits(suit_ids);
    $('extra_lbl').textContent = state.extraHits
      .map(u => `${u.name} ×${fg(u.scale)}`).join(' + ') || '(세트 없음)';
    if ($('extra_on').checked) {
      for (const u of state.extraHits) {
        const xkw = {broken: kw.broken, manual_mul: kw.manual_mul,
                     crit: $('crit').checked ||
                           (crit instanceof Set ? crit.has(hits.length) : false)};
        hits.push(dc.compute_extra_hit(atk, dfn, u.scale,
                  u.dtype, u.mask, xkw));
      }
    }
    hits.forEach((h, i) => {
      let tag = h.inflict === 'proc' ? ' [발동타]' : '';
      tag += h.extra ? ' [추가타]' : '';
      const tr = document.createElement('tr');
      const cells = [i + 1, TYPENAME[h.type] ?? h.type,
                     mask_names(h.mask) + tag,
                     Number(h.scale).toPrecision(3),
                     h.calcResult.toFixed(0),
                     h.zoneScale.toPrecision(3),
                     `${Math.trunc(h.damage + 0.5)} (${h.damage.toFixed(1)})`];
      for (const v of cells) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
      tb.appendChild(tr);
    });
  } catch (ex) {
    $('stats').textContent = 'ERROR: ' + (ex && ex.stack || ex);
    console.error(ex);
  }
}

async function boot() {
  try {
    const [char, enemy, skill, buff, ss] = await Promise.all(
      ['char_index.json', 'enemy_index.json', 'skill_index.json',
       'buff_index.json', 'skillsetting.json']
        .map(f => fetch('../data/' + f).then(r => {
          if (!r.ok) throw new Error(f + ' ' + r.status); return r.json();
        })));
    dc.initData(char, enemy, skill, buff, ss);
    const D = dc.data();
    setList('cid', Object.keys(D.CHARS).map(k => _name(D.CHARS, k)));
    setList('wid', Object.keys(D.WPNS).map(k => _name(D.WPNS, k)));
    setList('eid', Object.keys(D.ENEMIES).map(k => _name(D.ENEMIES, k)));
    const buffKeys = Object.keys(D.BUFF).sort();
    const buffFilter = t => buffKeys.filter(b => b.includes(t));
    for (const id of ['cid', 'wid', 'eid', 'sid']) combo($(id), nameFilter(id));
    combo($('buff_in'), buffFilter, 200);
    combo($('dbuff_in'), buffFilter, 200);
    $('buff_add').onclick = () => addBuff($('buff_in'), $('atk_buffs'), $('buff_stk'));
    $('dbuff_add').onclick = () => addBuff($('dbuff_in'), $('def_buffs'), $('dbuff_stk'));
    $('atk_buffs').addEventListener('dblclick', e => e.target.remove());
    $('def_buffs').addEventListener('dblclick', e => e.target.remove());
    const delSel = lb => [...lb.selectedOptions].forEach(o => o.remove());
    $('atk_buff_del').onclick = () => delSel($('atk_buffs'));
    $('def_buff_del').onclick = () => delSel($('def_buffs'));
    $('cid').addEventListener('input', charChanged);
    $('wid').addEventListener('input', refreshWsk);
    $('cbrk').addEventListener('input', refreshTalents);
    $('run').onclick = run;
    for (const id of ['lv','cbrk','pot','wlv','brk','tal','elv','slv','proc_stacks',
                      'mmul','crit_hits','proc','inflict'])
      $(id).addEventListener('input', run);
    for (const id of ['broken','crit','weak','suit_buff','cond','extra_on'])
      $(id).addEventListener('change', run);
    equipRows();
    $('cid').value = _name(D.CHARS, 'chr_0002_endminm');
    const e0 = Object.keys(D.ENEMIES)[0];
    $('eid').value = _name(D.ENEMIES, e0);
    charChanged();
    $('loading').remove();
  } catch (ex) {
    $('loading').innerHTML = `<span class="err">로딩 실패: ${ex}</span>`;
    console.error(ex);
  }
}
boot();

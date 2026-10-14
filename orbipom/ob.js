"use strict";
const OB_VER = "initial_test";
console.log("[ob.js]", OB_VER);
/* ============================================================
 * OrbiPom versus + leaderboard — overlay script (no bundle edits needed here;
 * the bundle exposes __ob store / __obPhys / __obScene / __obW / __srng hook).
 * Supabase Realtime: lobby presence + room broadcast. Same project as rhythm.
 * ============================================================ */

const SB_URL = "https://mwazxeqcdznidrnkxdkx.supabase.co";
const SB_KEY = "sb_publishable_NbOFGTEC9j-19PwMjcZoEw_GuP0Ij0R";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BOARD_MS   = 150;          // board snapshot interval (~7Hz)
const MATCH_MS   = 300 * 1000;   // 5-minute versus window
const PING_N = 5, PING_GAP = 150;
const RESULT_WAIT_MS = 3000;

let _sb = null;
function sb(){
  if(!_sb){
    if(typeof supabase === "undefined") return null;
    _sb = supabase.createClient(SB_URL, SB_KEY);
  }
  return _sb;
}

const OB = {
  on:false, code:null, isHost:false, chan:null,
  me:{ id:null, name:"PLAYER" },
  connId:null,
  opp:null,                       // {id, cid, name}
  offset:0, offErr:9999,          // hostClock ≈ localNow + offset
  oppReady:false, myReady:false,
  mode:"original",                // original | timelimit | attack
  state:"idle",                   // idle | hosting | lobby | playing | done
  pings:[],
  oppBoard:null,                  // latest opponent snapshot {s, b:[[id,lvl,x,y,a]]}
  oppEnd:null, oppEndRx:0, myEnd:null, oppGone:false, lastB:0,
  matchEnd:0, matchStart:0,       // shared match deadline / start (local ms clock)
  atkGauge:0, atkStock:[],        // attack mode: merge gauge + stocked fruit levels
  _swapAtk:false, _freeCast:false,
  winner:null, result:null, resolving:false,
  lastRx:0,                       // last time any broadcast arrived (ghost detection)
  ui:null,
};
let _hbTimer = 0;
function setState(s){
  OB.state = s;
  if(s === "lobby"){              // heartbeat while waiting — presence zombies can't broadcast
    clearInterval(_hbTimer);
    OB.lastRx = Date.now();
    _hbTimer = setInterval(() => {
      if(OB.state !== "lobby" || !OB.chan){ clearInterval(_hbTimer); return; }
      try{ netSend({t:"hb"}); }catch(e){}
      if(Date.now() - OB.lastRx > 6000){
        clearInterval(_hbTimer);
        alert("상대와 연결이 끊겼습니다"); netLeave();
      }
    }, 2000);
  } else clearInterval(_hbTimer);
  if(s === "done"){
    clearDualLayout();
    // match over → retire the room channel once the end-retransmit window passes
    setTimeout(() => {
      if(OB.state === "done" && OB.chan){
        try{ OB.chan.untrack(); sb() && sb().removeChannel(OB.chan); }catch(e){}
        OB.chan = null;
      }
    }, 12000);
  }
  uiRender();
}

/* ---------- identity ---------- */
function netInit(){
  if(!OB.connId) OB.connId = crypto.randomUUID();
  try{
    OB.me.id = localStorage.getItem("ob_pid");
    if(!OB.me.id){ OB.me.id = crypto.randomUUID(); localStorage.setItem("ob_pid", OB.me.id); }
    OB.me.name = localStorage.getItem("ob_name") || "";
    if(!OB.me.name){
      const p = JSON.parse(localStorage.getItem("tt_profile") || "{}");
      OB.me.name = (p.nickname || "PLAYER").toUpperCase().slice(0,12);
    }
  }catch(e){ if(!OB.me.id) OB.me.id = crypto.randomUUID(); }
}
function netSetName(n){
  OB.me.name = (n || "PLAYER").toUpperCase().slice(0, 12);
  try{ localStorage.setItem("ob_name", OB.me.name); }catch(e){}
}

/* ---------- channel plumbing ---------- */
function mkCode(){ let s=""; for(let i=0;i<4;i++) s+=CODE_CHARS[(Math.random()*CODE_CHARS.length)|0]; return s; }
function netSend(o){ if(OB.chan) OB.chan.send({ type:"broadcast", event:"m", payload:o }); }

function netMsg({payload:p}){
  OB.lastRx = Date.now();
  switch(p.t){
    case "hb":    break;          // heartbeat — lastRx already bumped
    case "hello":
      // accept joiners only while actually waiting — a stale channel left open
      // after "done"/"playing" would otherwise swallow them into a ghost lobby
      if(OB.isHost && OB.state === "hosting"){
        if(OB.opp){ netSend({t:"full"}); return; }
        netLobbyClose();
        OB.opp = { id:p.id, cid:p.cid, name:p.name };
        OB.oppReady = OB.myReady = false;         // fresh lobby, fresh ready flags
        netSend({t:"hi", id:OB.me.id, cid:OB.connId, name:OB.me.name, m:OB.mode});
        setState("lobby");
      }
      else if(OB.isHost) netSend({t:"full"});
      break;
    case "hi":
      if(!OB.isHost && !OB.opp && OB.state === "hosting"){
        OB.opp = { id:p.id, cid:p.cid, name:p.name };
        OB.oppReady = OB.myReady = false;
        if(MODES[p.m]) OB.mode = p.m;
        setState("lobby");
        netClockSync();
      }
      break;
    case "mode":  if(!OB.isHost && MODES[p.m]){ OB.mode = p.m; uiRender(); } break;
    case "full":  alert("방이 가득 찼습니다"); netLeave(); break;
    case "ping":  if(OB.isHost) netSend({t:"pong", c:p.c, h:Date.now()}); break;
    case "pong": {
      const now = Date.now(), rtt = now - p.c;
      OB.pings.push({rtt});
      if(rtt <= OB.offErr){ OB.offErr = rtt; OB.offset = p.h + rtt/2 - now; }
      break;
    }
    case "ready": OB.oppReady = !!p.on; uiRender(); break;
    case "start":              // host -> guest: shared start instant
      if(!OB.isHost) vsBegin(p.at - OB.offset, p.m);
      break;
    case "b":     OB.oppBoard = p; OB.lastB = Date.now(); _probeAt = 0; uiOppHud(); break;
    case "rq":    // opponent probing our liveness — answer with real state
      try{ netSend({t:"rs", st:OB.state, end:OB.myEnd}); }catch(e){}
      break;
    case "rs":
      if(p.end) onOppEnd(p.end);                        // they had ended → real data
      else if(OB.state === "playing"){ OB.lastB = Date.now(); _probeAt = 0; }  // alive — reset silence clock
      break;
    case "end":   // opponent topped out → I win by survival: freeze my game too
      onOppEnd(p);
      break;
    case "atk":   // attack-mode packet — dedup the triple-send by seq
      if(OB.state !== "playing" || (p.n|0) <= _atkRx) break;
      _atkRx = p.n|0;
      try{
        if(p.k === "fruit") atkRecvFruit(p.lvl);
        else if(p.k === "wind" || p.k === "shake") atkRecvCast(p.k);
      }catch(e){ console.warn("atk recv:", e); }
      break;
    case "gg":
      // mid-match quit = forfeit (same as a dropped presence), not silent leave
      if(OB.state === "playing" && !OB.result){
        OB.oppGone = true;
        forceEnd();
        uiOppHud();
      } else netLeave();
      break;
  }
}

/* opponent's end arrived — via "end" packet or an "rs" probe reply. Freeze my
 * game and resolve; receipt time doubles as their end instant on MY clock. */
function onOppEnd(end){
  if(!OB.oppEndRx) OB.oppEndRx = Date.now();   // first receipt only — resends mustn't overwrite
  OB.oppEnd = end;
  if(!OB.myEnd) forceEnd();
  netResolve();
}

let _goneTimer = 0;
function netPresence(){
  if(!OB.opp) return;
  const members = Object.keys(OB.chan.presenceState()).length;
  if(members >= 2 || _goneTimer) return;
  _goneTimer = setTimeout(() => {          // debounce transient presence flicker
    _goneTimer = 0;
    if(!OB.opp || OB.oppGone || !OB.chan) return;
    if(Object.keys(OB.chan.presenceState()).length >= 2) return;  // they're back
    OB.oppGone = true;
    if(OB.state === "playing"){
      // forfeit: stop my game too, then resolve with me as winner
      forceEnd();
      uiOppHud();
    }
    else if(OB.state !== "done"){ alert("상대가 나갔습니다"); netLeave(); }
    else netResolve();
  }, 1500);
}

async function netOpen(code, role){
  const c = sb();
  if(!c){ alert("Supabase를 불러오지 못했습니다 (CDN 오프라인?)"); return false; }
  // never leak an old room channel — orphaned subscriptions are what ghost lobbies came from
  if(OB.chan){ try{ OB.chan.untrack(); c.removeChannel(OB.chan); }catch(e){} OB.chan = null; }
  OB.chan = c.channel("ob-vs-" + code);
  OB.chan
    .on("broadcast", { event:"m" }, netMsg)
    .on("presence",  { event:"sync" }, netPresence)
    .on("presence",  { event:"leave" }, netPresence);
  return await new Promise(res => {
    OB.chan.subscribe(async st => {
      if(st === "SUBSCRIBED"){ await OB.chan.track({ role, name:OB.me.name, pid:OB.me.id }); res(true); }
      if(st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") res(false);
    });
  });
}

/* ---------- lobby ---------- */
async function netHost(){
  netInit(); netLobbyClose();
  OB.isHost = true; OB.code = mkCode();
  setState("hosting");
  if(!(await netOpen(OB.code, "host"))){ alert("연결 실패"); setState("idle"); return; }
  netRegister(); netLobbyAdvertise();
}
async function netJoin(code){
  netInit(); netLobbyClose();
  OB.isHost = false; OB.code = code.toUpperCase().trim();
  setState("hosting");
  if(!(await netOpen(OB.code, "guest"))){ alert("연결 실패"); setState("idle"); return; }
  netRegister();
  let waited = 0;
  const t = setInterval(() => {
    if(!OB.chan){ clearInterval(t); return; }
    const host = Object.values(OB.chan.presenceState()).flat().find(m => m.role === "host");
    if(host){ clearInterval(t); netSend({t:"hello", id:OB.me.id, cid:OB.connId, name:OB.me.name}); }
    else if((waited += 200) > 4000){ clearInterval(t); alert("방을 찾지 못했습니다"); netLeave(); }
  }, 200);
}
function netRegister(){
  if(sb()) sb().from("ob_players")
    .upsert({id:OB.me.id, name:OB.me.name, last_seen:new Date().toISOString()})
    .then(({error}) => { if(error) console.warn("ob_players:", error); });
}

/* ---------- open-room lobby (same presence trick as rhythm) ---------- */
let _lobbyChan = null;
function netLobbyAdvertise(){
  const c = sb(); if(!c || _lobbyChan) return;
  _lobbyChan = c.channel("ob-lobby");
  _lobbyChan.subscribe(async st => {
    if(st === "SUBSCRIBED" && _lobbyChan)
      await _lobbyChan.track({code:OB.code, name:OB.me.name, t:Date.now(), m:OB.mode});
  });
}
function netLobbyRetrack(){          // host changed mode while still advertising
  if(_lobbyChan && OB.isHost && OB.state === "hosting")
    _lobbyChan.track({code:OB.code, name:OB.me.name, t:Date.now(), m:OB.mode}).catch(()=>{});
}
function netLobbyClose(){
  if(_lobbyChan && sb()){ try{ sb().removeChannel(_lobbyChan); }catch(e){} }
  _lobbyChan = null;
}
function netLobbyWatch(cb){
  const c = sb(); if(!c || _lobbyChan) return false;
  _lobbyChan = c.channel("ob-lobby");
  _lobbyChan.on("presence", {event:"sync"}, () => {
    const rooms = [];
    for(const pres of Object.values(_lobbyChan.presenceState()).flat())
      if(pres.code && pres.code !== OB.code && Date.now() - (pres.t||0) < 15000)
        rooms.push({code:pres.code, name:pres.name || "???", m:pres.m});
    cb && cb(rooms);
  }).subscribe();
  return true;
}
/* (re)subscribe the lobby channel if it isn't live — the presence cache goes
   stale after netLobbyClose, which is what ghost rooms in the list came from */
function ensureLobbyWatch(){
  if(_lobbyChan) return;
  netLobbyWatch(rooms => { _rooms = rooms;
    if($("obRooms") && OB.state === "idle"){
      $("obRooms").innerHTML = rooms.length
        ? "<b>열린 방</b>" + rooms.map(r => `<button data-c="${r.code}">⚔ ${r.name} · ${r.code}${MODES[r.m] ? " · " + MODES[r.m] : ""}</button>`).join("")
        : "<span style='color:#8a6a3d;font-size:12px'>열린 방 없음</span>";
      for(const b of document.querySelectorAll("#obRooms button"))
        b.onclick = () => netJoin(b.dataset.c);
    }
  });
}

function netClockSync(){
  OB.pings = []; OB.offErr = 9999; let i = 0;
  const t = setInterval(() => {
    if(i++ >= PING_N || !OB.chan){ clearInterval(t); return; }
    netSend({t:"ping", c:Date.now()});
  }, PING_GAP);
}
function netReady(on){ OB.myReady = on; netSend({t:"ready", on}); uiRender(); }
const MODES = {
  original:  "오리지널",
  timelimit: "시간 제한",
  attack:    "공격",
};
const MODE_DESC = {
  original:  "제한 없는 승부 —\n점수가 높은 분이 승리합니다!",
  timelimit: "5분 승부 — 지날수록 낙하 가속\n점수가 높은 쪽이 승리합니다!",
  attack:    "상대 상자에 버블을 떨어뜨려 방해\n게임 오버시키면 승리! (스킬 게이지 획득량 1/2)\n포기·운명:버블 전송 · 부유:상대 부유 · 흔들기:상대 흔들림",
};
function netMode(m){
  if(!MODES[m] || OB.mode === m) return;
  if(OB.state !== "idle" && !OB.isHost) return;   // guests can't pick
  OB.mode = m;
  if(OB.state === "lobby") netSend({t:"mode", m});     // live-sync to guest
  else netLobbyRetrack();                               // update room listing
  uiRender();
}
function netGo(){
  if(!OB.isHost || !OB.opp || OB.state !== "lobby") return;
  const at = Date.now() + 1600;
  netSend({t:"start", at, m:OB.mode});
  vsBegin(at, OB.mode);
}

/* ---------- match flow ---------- */
let _startTimer = 0, _endTimer = 0;

/* ---------- attack mode ----------
 * Native hooks installed once per __obCtl instance:
 *  - phys.spawn with {velocity} = a merge result → every 5th merge's fruit
 *    leaves my box and becomes stocked attack ammo (Suika attack rule)
 *  - phys.remove during a "clear" session = 포기/운명 targeting → the removed
 *    fruit is sent instead of deleted (attack-mode skill remap)
 *  - skillController.settleSkill: _swapAtk pays 운명's 6-charge cost,
 *    _freeCast runs incoming wind/shake FX for free                    */
let _ringSlots0 = 0, _decayMs0 = 0, _dropMs0 = 0, _atkSeq = 0, _atkRx = 0;
function atkPatch(){
  const ctl = window.__obCtl;
  if(!ctl || !ctl.phys || !ctl.skillController) return;
  // mark the PATCHED OBJECTS, not the controller — a remount recreates ctl
  // while phys persists, which would double-wrap (double sends, 2x gauge)
  const phys = ctl.phys, sc = ctl.skillController;
  if(phys._atkPatched && sc._atkPatched) return;
  if(!phys._atkPatched){ phys._atkPatched = 1; atkPatchPhys(phys); }
  if(!sc._atkPatched){ sc._atkPatched = 1; atkPatchSkill(sc); }
}
function atkPatchPhys(phys){
  const _spawn = phys.spawn.bind(phys);
  phys.spawn = function(lvl, x, y, opt){
    const b = _spawn(lvl, x, y, opt);
    if(OB.mode === "attack" && OB.state === "playing" && opt && opt.velocity){
      try{ atkOnMerge(b, lvl); }catch(e){ console.warn("atkOnMerge:", e); }
    }
    return b;
  };
  const _rem = phys.remove.bind(phys);
  phys.remove = function(id, wake){
    if(OB.mode === "attack" && OB.state === "playing" && !OB._suppressRm){
      try{
        const ss = window.__ob && window.__ob.getState().skillSession;
        const w = phys.bodies.get(id);
        if(w && ss && ss.id === "clear"){
          const lvl = w.level || 1;
          if(OB._swapAtk){ OB._swapAtk = false;
            atkSend({t:"atk", k:"fruit", lvl:Math.min(11, lvl+1)}); }
          else atkSend({t:"atk", k:"fruit", lvl});
        }
      }catch(e){ console.warn("atk remove:", e); }
    }
    return _rem(id, wake);
  };
}
function atkPatchSkill(sc){
  const _settle = sc.settleSkill.bind(sc);
  sc.settleSkill = function(id){
    try{
      if(OB._freeCast){ OB._freeCast = false;
        try{ window.__ob.getState().incSkillUse(); }catch(e){}
        return true; }
      if(OB._swapAtk && id === "clear"){
        const st = window.__ob.getState();
        if((st.swapCharge || 0) < 6) return false;
        st.consumeSwapCharge(); st.incSkillUse && st.incSkillUse();
        return true;
      }
    }catch(e){ console.warn("atk settle:", e); }
    return _settle(id);
  };
}
function atkOnMerge(body, lvl){
  OB.atkGauge++;
  if(OB.atkGauge < 5) return;
  OB.atkGauge = 0;
  OB._suppressRm = true;                    // this removal is a stock, not a clear-pick send
  try{ window.__obPhys.remove(body.id, false); }catch(e){}
  finally{ OB._suppressRm = false; }
  OB.atkStock.push(lvl);
  if(OB.atkStock.length > 1) atkFire(OB.atkStock.shift());  // 2nd round → auto-drop
}
function atkFire(lvl){ atkSend({t:"atk", k:"fruit", lvl}); }
function atkSend(p){                       // important packet — triple-send
  // runs inside the engine's merge path via phys.spawn — must never throw
  p.n = ++_atkSeq;
  try{ netSend(p); }catch(e){}
  setTimeout(() => { try{ netSend(p); }catch(e){} }, 120);
  setTimeout(() => { try{ netSend(p); }catch(e){} }, 300);
}
function atkRecvFruit(lvl){
  const phys = window.__obPhys, ey = window.__obEy;
  if(!phys || !phys.spawn || OB.state !== "playing") return;
  lvl = Math.max(1, Math.min(window.__obMax || 11, lvl | 0));
  // jar x-space is 0..container.width (native clampX clamps to that range) —
  // spawn like a drop: a random x that keeps the bubble inside the walls
  const cfg = window.__obCfg && window.__obCfg(lvl);
  const b = cfg && cfg.collision && cfg.collision.bounds;
  const w = (ey && ey.container ? ey.container.width : 230);
  const lo = b ? (4 - b.minX) : 24, hi = b ? (w - b.maxX - 4) : (w - 24);
  const x = Math.max(4, Math.min(w - 4,
    lo + Math.random() * Math.max(1, hi - lo)));
  const y = (ey && ey.dropY != null ? ey.dropY : -10)
          - Math.random() * ((ey && ey.dropZoneHeight) || 90) * 0.5;
  phys.spawn(lvl, x, y);             // no velocity opt → never counts as a merge
}
function atkRecvCast(kind){          // their 부유/흔들기 lands on MY board — free cast
  const sc = window.__obCtl && window.__obCtl.skillController;
  if(!sc || !sc.startInstantCast || OB.state !== "playing") return;
  OB._freeCast = true;
  try{ sc.startInstantCast(kind); }catch(e){ OB._freeCast = false; }
}


function vsBegin(atMs, mode){
  netLobbyClose();                                  // stop advertising during the match
  OB.on = true; OB.oppBoard = null; OB.oppEnd = null; OB.oppEndRx = 0; OB.myEnd = null;
  OB.oppGone = false; OB.winner = null; OB.result = null; OB.resolving = false; OB.lastB = 0;
  if(MODES[mode]) OB.mode = mode;
  // original/attack have no clock — only timelimit keeps the 5-min deadline.
  // Attack resolves by topout alone; a countdown would just kill long fights.
  OB.matchStart = atMs;
  OB.matchEnd = OB.mode === "timelimit" ? atMs + MATCH_MS : Infinity;
  // attack mode: half-rate skill gauge + fresh attack stock/gauge
  if(_ringSlots0 && window.__obEy && window.__obEy.skillPower)
    { window.__obEy.skillPower.ringSlots = _ringSlots0; _ringSlots0 = 0;
      if(_decayMs0){ window.__obEy.skillPower.decayIntervalMs = _decayMs0; _decayMs0 = 0; } }
  if(_dropMs0 && window.__obEy)
    { window.__obEy.dropCooldownMs = _dropMs0; _dropMs0 = 0; }
  OB.atkGauge = 0; OB.atkStock = []; OB._swapAtk = false; OB._freeCast = false;
  OB._suppressRm = false; _atkSeq = 0; _atkRx = 0;
  if(OB.mode === "attack" && window.__obEy && window.__obEy.skillPower){
    // half-rate gauge: double the slots AND the decay tick so progress
    // shrinks at the same proportional pace as solo
    const sp = window.__obEy.skillPower;
    _ringSlots0 = sp.ringSlots; _decayMs0 = sp.decayIntervalMs || 0;
    sp.ringSlots = _ringSlots0 * 2;
    if(_decayMs0) sp.decayIntervalMs = _decayMs0 * 2;
  }
  _probeAt = 0;
  setState("playing");
  _smooth.clear();
  // wipe any in-progress solo board NOW — the run itself restarts at atMs (clock-synced)
  try{
    const c = window.__obCtl;
    if(c){
      c.phys && c.phys.clearBodies();
      c.removedIds && c.removedIds.clear();
      c.pendingMerges = [];
      c.renderer && c.renderer.resetMergeMotions && c.renderer.resetMergeMotions();
    }
    const st0 = window.__ob && window.__ob.getState();
    if(st0 && st0.state === "playing") st0.start();   // also zero the score readout
  }catch(e){}
  let tries = 0;
  const lt = setInterval(() => {                    // canvas appears once GAME scene mounts
    const ok = applyDualLayout(); uiOppHud();
    if(ok || ++tries > 40) clearInterval(lt);       // stop only when layout actually applied
  }, 250);
  uiOppHud();
  // __srng intentionally left unset → each side gets its own random drop sequence
  clearTimeout(_startTimer);
  _startTimer = setTimeout(obStartRun, Math.max(0, atMs - Date.now()));
  clearInterval(_endTimer);
  _endTimer = setInterval(checkTimeout, 500);
}

function obStartRun(){
  try{
    const sc = window.__obScene && window.__obScene.getState();
    if(sc && sc.globalScene !== "GAME") sc.setGlobalScene("GAME");
    setTimeout(() => {
      try{
        // controller start() = full reset (clears bodies, queue, preview);
        // store start() alone leaves solo fruits on the board
        const c = window.__obCtl;
        if(c && typeof c.start === "function") c.start();
        else window.__ob && window.__ob.getState().start();
      }catch(e){}
    }, 250);
  }catch(e){ console.warn("startRun:", e); }
}

let _probeAt = 0;
function checkTimeout(){
  if(!OB.on || OB.state !== "playing") return;
  // timelimit: fruit drop speed ramps up — cooldown 500ms → 250ms over the match
  if(OB.mode === "timelimit" && window.__obEy && OB.matchStart){
    if(!_dropMs0) _dropMs0 = window.__obEy.dropCooldownMs || 500;
    const t = Math.min(1, Math.max(0, (Date.now() - OB.matchStart) / MATCH_MS));
    window.__obEy.dropCooldownMs = Math.round(_dropMs0 * (1 - 0.5 * t));
  }
  if(Date.now() >= OB.matchEnd){
    // 시간 종료 — 현재 점수로 승부. 아직 over 아니면 현재값을 end로 보냄
    if(!OB.myEnd) myEnd(true);
    return;
  }
  // board stream silent >3.5s — probe before assuming they ended: broadcast
  // handlers fire even in throttled tabs, so a live client answers "rs" and
  // we keep playing. No answer → really ended/gone → resolve by survival.
  if(OB.opp && !OB.myEnd && OB.lastB && Date.now() - OB.lastB > 3500){
    if(!_probeAt){ _probeAt = Date.now(); try{ netSend({t:"rq"}); }catch(e){} }
    else if(Date.now() - _probeAt > 2500) forceEnd();
  }
}

/* game store → game-over + score snapshot */
let _obSub = null;
function hookStore(){
  if(_obSub || !window.__ob || !window.__ob.subscribe) return;
  let lastState = null;
  _obSub = window.__ob.subscribe(s => {
    if(OB.on && OB.state === "playing" && s.state === "over" && lastState !== "over")
      myEnd(false);
    lastState = s.state;
  });
}

/* board stream — own bodies → opponent */
function boardTick(){
  if(!OB.on || OB.state !== "playing"){ uiSkillTick(); return; }
  const phys = window.__obPhys;
  if(!phys || !phys.bodies) return;
  if(OB.mode === "attack"){
    atkPatch();                                          // install hooks once per ctl
    if(OB._swapAtk && !(window.__ob && window.__ob.getState().skillSession))
      OB._swapAtk = false;                               // session ended without a pick
  }
  const arr = [];
  for(const [id, w] of phys.bodies){
    const b = w.body;
    if(!b || !b.position) continue;
    const a = b.angle || 0, off = w.renderOffset || {x:0, y:0};
    const ca = Math.cos(a), sa = Math.sin(a);
    arr.push([id, w.level || 1,
      +(b.position.x + off.x*ca - off.y*sa).toFixed(1),
      +(b.position.y + off.x*sa + off.y*ca).toFixed(1),
      +a.toFixed(2)]);
  }
  const st = window.__ob ? window.__ob.getState() : {};
  const px = window.__obCtl && isFinite(window.__obCtl.previewX) ? +window.__obCtl.previewX.toFixed(1) : 0;
  // danger = native lose-countdown. renderer.dangerCountdownMs is ms REMAINING
  // until game over → elapsed = loseCountdownMs - remaining (digit 3→0 over ~5s)
  const rd = window.__obCtl && window.__obCtl.renderer;
  const lcm = (window.__obEy && window.__obEy.loseCountdownMs) || 5000;
  const dgr = rd && rd.dangerCountdownMs != null ? Math.max(0, Math.round(lcm - rd.dangerCountdownMs)) : 0;
  netSend({t:"b", s:st.score||0, c:st.current||1, n:st.next||1, u:st.unlockedMax||1,
           px, d:dgr, m:st.mergeCount||0, lvl:st.maxLevelThisRun||1,
           ge:st.energy||0, gp:st.energyProgress||0, gc:st.swapCharge||0,
           gs:(st.skillSession && st.skillSession.id) || 0,
           ag:OB.atkGauge||0, as:(OB.atkStock && OB.atkStock[0]) || 0, b:arr});
  uiSkillTick();
}

/* forceEnd(): my game was still PLAYING when we had to end it — opponent's
 * end/forfeit, not my topout. The f flag lets decideWinner know "I survived"
 * instead of mistaking receipt-time e for a simultaneous topout → score. */
let _forceEnd = false;
function forceEnd(){
  if(OB.myEnd) return;
  _forceEnd = true;
  try{ const st = window.__ob && window.__ob.getState();
       if(st && st.state === "playing" && window.__obCtl) window.__obCtl.gameOver(); }catch(e){}
  if(!OB.myEnd) myEnd(false);
  _forceEnd = false;
}

function myEnd(timedOut){
  if(OB.myEnd) return;
  const st = window.__ob ? window.__ob.getState() : {};
  OB.myEnd = { s:st.score||0, m:st.mergeCount||0, lvl:st.maxLevelThisRun||1,
               t:timedOut?1:0, f:_forceEnd?1:0, e:Date.now() };
  try{ netSend({ t:"end", ...OB.myEnd }); }catch(e){ console.warn("end send:", e); }
  setState("done");
  clearInterval(_endTimer);
  netResolve();
}

/* pure winner decision — mirrored on both clients so they converge on the
 * same result. Returns the winner object {id,cid} or null for a draw.
 * Cases: both end packets → score compare (any timeout) / survival time;
 * opp forfeit → me; opp still streaming → op; nothing but a last board
 * snapshot → last streamed score, equal-or-unknown → draw. */
function decideWinner(){
  const me = {id:OB.me.id, cid:OB.connId}, op = OB.opp ? {id:OB.opp.id, cid:OB.opp.cid} : null;
  const mine = OB.myEnd, oend = OB.oppEnd;
  const byScore = () => mine.s !== oend.s ? (mine.s > oend.s ? me : op)
    : (mine.lvl !== oend.lvl ? (mine.lvl > oend.lvl ? me : op) : null);
  // original: any board ending resolves by score — survival time is NOT a factor
  if(OB.mode === "original"){
    if(!mine) return null;                          // still playing — no result yet
    const os = oend ? oend.s : (OB.oppBoard ? OB.oppBoard.s : null);
    if(os != null)
      return mine.s !== os ? (mine.s > os ? me : op)
           : (oend ? byScore() : null);             // tie → lvl if we have a real end
  }
  if(mine && oend){
    const oe = OB.oppEndRx || oend.e || 0;        // receipt time ≈ their real end on MY clock
    if(mine.t || oend.t) return byScore();        // any timeout → scores decide
    if(mine.f) return me;                         // my game was ALIVE when they ended → outlived
    if(oend.f) return op;                         // they were alive when I ended
    if(Math.abs(mine.e - oe) < 500) return byScore();
    return mine.e > oe ? me : op;                 // both topped out → outlived wins
  }
  if(OB.oppGone || !op) return me;                // forfeit / no opponent
  // no end packet — a board beat >400ms after my end means they played past
  // the near-simultaneous window → they outlived me, they win
  if(OB.lastB && OB.lastB > mine.e + 400) return op;
  const os = OB.oppBoard ? (OB.oppBoard.s ?? null) : null;
  const scoreCmp = () => (os == null || os === mine.s) ? null : (mine.s > os ? me : op);
  if(mine.t) return scoreCmp();                   // timed out → scores decide
  // stream died = they ended and the packet was lost. Their last beat (lastB)
  // approximates their end instant on MY clock → same survival rule the other
  // side applies with both ends, so a lost packet can't flip the result
  if(OB.lastB && Math.abs(mine.e - OB.lastB) >= 500)
    return mine.e > OB.lastB ? me : op;
  return scoreCmp();
}

async function netResolve(){
  // synchronous re-entry guard: the winner is computed ONCE — a second call
  // arriving mid-await must not overwrite it (that's what flipped WIN→LOSE)
  if(!OB.on || !OB.myEnd || OB.result || OB.resolving) return;
  OB.resolving = true;
  try{
    // near-simultaneous ends: grace window to collect the other side's "end" —
    // keep re-sending ours so a lost packet can't wedge them mid-match
    if(!OB.oppEnd && !OB.oppGone){
      const tW = Date.now(), myE = OB.myEnd.e;
      while(!OB.oppEnd && !OB.oppGone){
        const dt = Date.now() - tW;
        if(dt >= RESULT_WAIT_MS) break;
        // a board beat >400ms AFTER my end = they're playing past the
        // near-simultaneous window → they win by survival; no wait needed
        if(OB.lastB > myE + 400) break;
        // stream already dead before my end and no "end" in 800ms → the
        // packet is lost; fall back to lastB/score comparison now
        if(OB.lastB && OB.lastB <= myE && dt > 800) break;
        // long silence → stream truly dead (throttled tabs need the wide net)
        if(dt > 1200 && OB.lastB && Date.now() - OB.lastB > 2500) break;
        try{ netSend({t:"end", ...OB.myEnd}); }catch(e){}
        await new Promise(r => setTimeout(r, 400));
      }
    }
    const winner = decideWinner();
    OB.winner = winner;
    // keep re-sending our end briefly — a lost packet mustn't leave the opp playing forever
    if(!OB.oppEnd && !OB.oppGone){
      let k = 0;
      const iv = setInterval(() => {
        if(OB.oppEnd || !OB.on || ++k > 12){ clearInterval(iv); return; }
        try{ netSend({t:"end", ...OB.myEnd}); }catch(e){}
      }, 800);
    }
    // freeze my game board visually — match is over
    try{ const st = window.__ob && window.__ob.getState();
         if(st && st.state === "playing" && window.__obCtl) window.__obCtl.gameOver(); }catch(e){}

    OB.result = {win:winner ? winner.id : null, me:OB.myEnd.s, op:OB.oppEnd ? OB.oppEnd.s : null};
    if(sb() && (OB.isHost || OB.oppGone)){
      try{
        const oe = OB.oppEnd || {s:0};
        await sb().from("ob_players").upsert([
          {id:OB.me.id, name:OB.me.name, last_seen:new Date().toISOString()},
          {id:OB.opp.id, name:OB.opp.name, last_seen:new Date().toISOString()},
        ]);
        await sb().from("ob_matches").insert({
          code:OB.code,
          host_id:OB.isHost ? OB.me.id : OB.opp.id,
          guest_id:OB.isHost ? OB.opp.id : OB.me.id,
          host_score:OB.isHost ? OB.myEnd.s : oe.s,
          guest_score:OB.isHost ? oe.s : OB.myEnd.s,
          winner:winner ? winner.id : null,
        });
      }catch(e){ console.warn("match record:", e); }
    }
    uiRender();
  }finally{
    OB.resolving = false;
  }
}

function netLeave(){
  netLobbyClose();
  if(OB.chan){ try{ netSend({t:"gg"}); OB.chan.untrack(); sb() && sb().removeChannel(OB.chan); }catch(e){} }
  clearInterval(_endTimer); clearTimeout(_startTimer); clearInterval(_hbTimer);
  // restore solo skill-gauge rate if attack mode halved it
  if(_ringSlots0 && window.__obEy && window.__obEy.skillPower)
    { window.__obEy.skillPower.ringSlots = _ringSlots0; _ringSlots0 = 0;
      if(_decayMs0){ window.__obEy.skillPower.decayIntervalMs = _decayMs0; _decayMs0 = 0; } }
  if(_dropMs0 && window.__obEy){ window.__obEy.dropCooldownMs = _dropMs0; _dropMs0 = 0; }
  OB.on=false; OB.chan=null; OB.opp=null; OB.code=null; OB.mode="original";
  OB.oppReady=OB.myReady=false; OB.oppBoard=null;
  _smooth.clear(); _dual = false; clearDualLayout();
  setState("idle");
}

/* ---------- solo leaderboard ---------- */
let _scorePosted = false;
function hookLeaderboard(){
  if(!window.__ob || !window.__ob.subscribe) return;
  window.__ob.subscribe(s => {
    if(s.state === "over" && !_scorePosted && s.score > 0){
      _scorePosted = true;
      netInit();
      // highScore = 게임 자체가 tt_profile에 유지하는 최고기록 — 그걸 그대로 upsert
      if(sb()) sb().from("ob_scores").upsert({
        player_id:OB.me.id, name:OB.me.name,
        score:Math.max(s.score, s.highScore||0), merges:s.mergeCount, max_level:s.maxLevelThisRun,
        updated_at:new Date().toISOString(),
      }, {onConflict:"player_id"}).then(({error})=>{
        if(error) console.warn("score:", error);
      });
    }
    if(s.state === "playing") _scorePosted = false;
  });
}

/* ============================================================
 * UI — overlay injected over the game's #root
 * ============================================================ */
const css = `
#obBtn{position:fixed;top:10px;right:10px;z-index:99999;background:#2b2118cc;color:#ffd98a;
  border:2px solid #ffd98a;border-radius:20px;padding:6px 14px;font:bold 14px sans-serif;cursor:pointer}
#obOv{position:fixed;inset:0;z-index:9998;background:#000a;display:flex;align-items:center;
  justify-content:center;font-family:sans-serif;color:#ffe9c4}
#obOv.hidden,#obHud.hidden,#obDual.hidden,#obCenter.hidden,#obMe.hidden,
#obLobby.hidden,#obGo.hidden,#obReady.hidden{display:none}
#obPanel{background:#3a2c1c;border:3px solid #ffb84d;border-radius:14px;padding:18px 22px;
  min-width:280px;max-width:92vw;box-shadow:0 8px 40px #000c}
#obPanel h2{margin:0 0 12px;color:#ffb84d;font-size:18px;text-align:center}
#obPanel input{background:#241a10;border:1px solid #8a6a3d;border-radius:8px;color:#ffe9c4;
  padding:8px 10px;width:100%;box-sizing:border-box;margin-bottom:8px;font-size:15px}
#obPanel button{background:#ffb84d;border:0;border-radius:8px;color:#3a2408;font-weight:bold;
  padding:9px 14px;cursor:pointer;font-size:14px;margin:3px 0;width:100%}
#obPanel button.ghost{background:#57402a;color:#ffd98a}
#obPanel button.sel{outline:3px solid #7CFF9A}
#obRooms{max-height:110px;overflow-y:auto;margin:6px 0;font-size:13px}
#obRooms b{font-size:13px;font-weight:bold}
#obRooms button{font-size:13px;padding:6px}
#obModes{display:flex;gap:4px;margin:8px 0 4px}
#obModes button{flex:1;font-size:12px;padding:7px 2px}
#obModes button[disabled]{opacity:.65;cursor:default}
#obModeDesc{font-size:11px;line-height:1.45;color:#c9a96a;height:48px;overflow:hidden;margin:0 0 8px;padding:0 2px;white-space:pre-line}
#obStatus{text-align:center;font-size:13px;margin:6px 0;min-height:18px;color:#ffd98a}
#obRank{font-size:12px;max-height:130px;overflow-y:auto;margin-top:10px}
#obRank table{width:100%;border-collapse:collapse}
#obRank td{padding:2px 6px;border-bottom:1px solid #57402a}

/* ---- versus dual-board layout (native vs style: my board left, opponent right,
   next/timer/fusion-ring in the center column, green felt background) ---- */
body.vs-dual{background:#7fd4b5 !important}
/* versus: the live game stays mounted + transformed ONLY to keep its input layer
   aligned with our drawn board (toWorldX reads the canvas rect) — it is fully
   invisible via opacity; BOTH boards are drawn by us for a symmetric look. */
body.vs-dual #root{position:fixed !important;left:var(--vsL) !important;top:var(--vsT) !important;
  transform:scale(var(--vsS)) !important;transform-origin:top left !important;
  width:var(--vsW) !important;height:var(--vsH) !important;z-index:2;opacity:0 !important}
body.vs-dual > div:not(#root):not([id^="ob"]),
body.vs-dual > section:not([id^="ob"]),
body.vs-dual > main:not([id^="ob"]){display:none !important}   /* deco portals off */
body.vs-dual #obBtn{display:none !important}
.obtag{font-family:sans-serif;font-weight:bold;font-size:17px;color:#1d3b30}
#obDual,#obMe{position:fixed;z-index:9995;pointer-events:none;text-align:center}
#obDual canvas,#obMe canvas{display:block;margin-top:2px}
#obCenter{position:fixed;top:6px;left:50%;transform:translateX(-50%) scale(1.75);
  transform-origin:top center;z-index:9991;font-family:sans-serif;text-align:center;pointer-events:none}
#obCenter .nrow{display:flex;gap:34px;justify-content:center;align-items:flex-end;margin-top:8px}
#obCenter .ncell{min-width:64px;text-align:center}
#obCenter .banner{display:inline-block;background:url(assets/imgs/banner.b750e3.png) center/contain no-repeat;
  min-width:96px;padding:3px 16px 5px;font-size:14px;font-weight:bold;color:#5a4630}
#obCenter .nstage{position:relative;height:78px;margin-top:2px}
#obCenter .nbubble{position:absolute;left:50%;top:0;width:68px;height:68px;transform:translateX(-50%)}
#obCenter .nfruit{position:absolute;left:50%;top:8px;width:52px;height:52px;transform:translateX(-50%)}
#obCenter .nbase{position:absolute;left:50%;bottom:0;width:76px;height:12px;transform:translateX(-50%)}
#obCenter .obtimer{display:inline-block;font-size:20px;font-weight:bold;color:#1d3b30;
  background:#eafff5;border:2px solid #4aa88a;border-radius:8px;padding:1px 10px;margin:0 4px}
#obCenter .vsscore{font-size:18px;font-weight:bold;color:#1d3b30;margin-top:6px}
/* native-DOM clone stages — when populated, the custom .fb fallback hides itself */
#obCenter .cstage{margin:0 auto;position:relative}
#obCenter .cstage:not(:empty) + .fb{display:none}
#obCenter .cstage > *{transform-origin:top left}
#obCenter .rrow{display:flex;gap:26px;justify-content:center;margin-top:8px}
#obCenter .rcell .lbl{font-size:13px;color:#1d3b30;font-weight:bold}
#obMe{position:fixed;z-index:9990;pointer-events:none;text-align:center}
#obMe .plabel{color:#1d3b30;font-weight:bold;font-size:13px;font-family:sans-serif;margin-top:4px}
/* versus skill bars — one floating above each jar; mine interactive, opp streamed */
.obskbox{position:fixed;z-index:9996;transform:translateX(-50%) scale(1.45);
  transform-origin:top center;display:flex;
  flex-direction:column;align-items:center;gap:4px;font-family:sans-serif}
.obskbox.hidden{display:none}
.obskbox .skname{font-size:11px;font-weight:bold;color:#1d3b30}
.obskbox .obgauge{position:relative;width:150px;height:9px;background:#241a10aa;border-radius:5px;
  border:1px solid #4aa88a;overflow:hidden}
.obskbox .obgauge .fill{position:absolute;inset:0;width:0;background:#ffd23d;border-radius:4px;
  transition:width .25s}
.obskbox .obgauge i{position:absolute;top:0;bottom:0;width:1px;background:#4aa88a88}
.obskbox .obsk{display:flex;gap:8px}
.obskbox .obsk button{position:relative;width:52px;padding:3px 0 4px;background:#241a10dd;
  border:2px solid #8a6a3d;border-radius:12px;cursor:pointer;text-align:center}
.obskbox .obsk button img{width:34px;height:34px;display:block;margin:0 auto}
.obskbox .obsk button .nm{display:block;font-size:10px;font-weight:bold;color:#ffe9c4;line-height:1.1}
.obskbox .obsk button .cost{position:absolute;top:-7px;right:-5px;min-width:16px;height:16px;
  background:#ffb84d;border-radius:9px;font-size:10px;font-weight:bold;color:#3a2408;line-height:16px;
  padding:0 4px}
.obskbox .obsk button.dis{filter:grayscale(.9);opacity:.45;cursor:default}
.obskbox .obsk button.act{border-color:#7CFF9A;box-shadow:0 0 8px #7CFF9A}
#obSkillOpp{pointer-events:none}
#obSkillOpp .obsk button{cursor:default}
#obSkillOpp .skname{color:#7a2d1d}
/* narrow/portrait fallback: mini board */
#obHud{position:fixed;top:10px;right:10px;z-index:9997;background:#241a10dd;border:2px solid #ffb84d;
  border-radius:10px;padding:6px;font-family:sans-serif;color:#ffe9c4;text-align:center;pointer-events:none}
#obHud canvas{display:block;background:#2e241666;border-radius:6px}
#obHud .oppname{color:#FF9A3D;font-weight:bold;font-size:12px}
#obHud .oppscore{font-size:16px;font-weight:bold}
#obHud .obtimer{font-size:11px;color:#ffd98a}
#obRes{position:fixed;top:38%;left:50%;transform:translate(-50%,-50%);z-index:9999;
  background:#3a2c1cee;border:3px solid #ffb84d;border-radius:14px;padding:16px 30px;
  text-align:center;font-family:sans-serif;color:#ffe9c4}
`;

/* versus skill bar — native skill engine (__obCtl.activateSkill) driven by our
 * own buttons because the game root is invisible in dual layout. Gauge state
 * comes straight from the __ob store: energy(0-3) + energyProgress(0-12 slots)
 * = the native 3-point ring, swapCharge(0-6) for 운명 체인지. */
const OB_SKILLS = [
  {id:"clear", cost:1, ko:"포기",   img:"assets/imgs/clear.221334.png",
   desc:"선택한 버블 1개를 제거", adesc:"선택한 버블을 상대에게 전송"},
  {id:"wind",  cost:2, ko:"부유",   img:"assets/imgs/wind.92bf25.png",
   desc:"버블을 띄워 압력 해소",   adesc:"상대 버블을 띄워 라인 압박"},
  {id:"shake", cost:3, ko:"흔들기", img:"assets/imgs/shake.d8b409.png",
   desc:"항아리를 흔들어 재배치", adesc:"상대 항아리를 흔듦"},
  {id:"swap",  charge:6, ko:"운명", img:"assets/imgs/swap.bc5f84.png",
   desc:"버블 2개 위치 교환",      adesc:"선택 버블 +1 진화 후 상대에게 전송"},
];
function uiSkillTick(){
  const me = $("obSkillMe"), op = $("obSkillOpp");
  if(!me || !op) return;
  const show = _dual && OB.on && OB.state === "playing";
  me.classList.toggle("hidden", !show);
  op.classList.toggle("hidden", !show);
  if(!show) return;
  const st = window.__ob ? window.__ob.getState() : {};
  const ss = st.skillSession;
  const busy = !!st.paused || st.state !== "playing" || !!(ss && ss.phase === "casting");
  skillBox(me, st.energy||0, st.energyProgress||0, st.swapCharge||0,
           OB._swapAtk ? "swap" : (ss && ss.id), busy,
           {g:OB.atkGauge, s:OB.atkStock && OB.atkStock[0]});
  const o = OB.oppBoard || {};   // streamed gauge state — ge/gp/gc/gs + ag/as
  skillBox(op, o.ge||0, o.gp||0, o.gc||0, o.gs||0, false, {g:o.ag||0, s:o.as||0});
}
function skillBox(box, e, p, c, activeId, busy, atk){
  if(!box) return;
  const slots = (window.__obEy && window.__obEy.skillPower && window.__obEy.skillPower.ringSlots) || 12;
  box.querySelector(".obgauge .fill").style.width =
    Math.min(100, (e + Math.min(1, p/slots)) / 3 * 100) + "%";
  box.querySelectorAll(".obsk button").forEach(b => {
    if(b.classList.contains("atkB")){                    // attack slot — stock + gauge
      const on = OB.mode === "attack" && atk;
      b.style.display = on ? "" : "none";
      if(on){
        b.querySelector(".cost").textContent = (atk.g || 0) + "/5";
        const img = b.querySelector("img");
        const want = atk.s ? fruitSrc(atk.s) : RING_LOCK;
        if(img._cur !== want){ img.src = want; img._cur = want; }
        b.classList.toggle("dis", !atk.s);
      }
      return;
    }
    const d = OB_SKILLS[+b.dataset.i];
    if(!d) return;
    // attack mode remaps every skill to an offensive effect — tooltip says which
    b.title = (OB.mode === "attack" ? d.adesc : d.desc) || "";
    const afford = d.charge ? c >= d.charge : e >= d.cost;
    b.classList.toggle("dis", busy || !afford);
    b.classList.toggle("act", activeId === d.id);
    if(d.charge) b.querySelector(".cost").textContent = Math.min(6, c) + "/6";
  });
}
function fruitSrc(lvl){
  const fi = window.__obImg && window.__obImg(lvl);
  return fi && fi.src ? fi.src : RING_LOCK;
}

let _uiBuilt = false;
function buildUI(){
  if(_uiBuilt) return; _uiBuilt = true;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const btn = document.createElement("button");
  btn.id = "obBtn"; btn.textContent = "⚔ 대전";
  btn.onclick = () => {
    try{
      netInit();
      if(OB.state === "done"){
        // match over → leave the room entirely; reopening shows a fresh lobby
        netLeave();
        const res = $("obRes"); res && res.remove();
      } else if(OB.state === "lobby"){
        // stale lobby: opp actually gone but their leave signal was lost
        let alone = true;
        try{ alone = !OB.chan || Object.keys(OB.chan.presenceState()).length < 2; }catch(e){}
        if(alone || !OB.opp) netLeave();
      }
    }catch(e){ console.warn("obBtn:", e); }
    if(OB.state === "idle"){ _rooms = []; if($("obRooms")) $("obRooms").innerHTML = "<span style='color:#8a6a3d;font-size:12px'>방 검색 중…</span>"; }
    ensureLobbyWatch();
    $("obOv").classList.remove("hidden"); uiRender(); refreshRank();
  };
  document.body.appendChild(btn);

  const ov = document.createElement("div");
  ov.id = "obOv"; ov.className = "hidden";
  ov.innerHTML = `<div id="obPanel">
    <h2>⚔ 온라인 대전 <span id="obVer" style="font-size:10px;color:#8a6a3d;float:right;font-weight:normal"></span></h2>
    <input id="obName" maxlength="12" placeholder="닉네임">
    <div id="obModes"></div>
    <div id="obModeDesc"></div>
    <button id="obHost">방 만들기</button>
    <input id="obCode" maxlength="4" placeholder="방 코드">
    <div style="display:flex;gap:6px">
      <button id="obJoin" style="flex:1">코드 입장</button>
      <button id="obQuick" class="ghost" style="flex:1">빠른 입장</button>
    </div>
    <div id="obRooms"></div>
    <div id="obStatus"></div>
    <div id="obLobby" class="hidden" style="text-align:center">
      <button id="obReady">준비</button>
      <button id="obGo" class="hidden">시작!</button>
      <button id="obExit" class="ghost">방 나가기</button>
    </div>
    <div id="obRank"></div>
    <button id="obClose" class="ghost">닫기</button>
  </div>`;
  document.body.appendChild(ov);
  $("obVer").textContent = OB_VER;

  const hud = document.createElement("div");
  hud.id = "obHud"; hud.className = "hidden";
  hud.innerHTML = `<div class="oppname">???</div><canvas id="obBoard" width="115" height="140"></canvas>
    <div class="oppscore">0</div><div class="obtimer">5:00</div>`;
  document.body.appendChild(hud);

  // dual-board layout pieces (landscape versus) — native screen structure:
  // me left / opponent right / next+timer+rings center
  const dual = document.createElement("div");
  dual.id = "obDual"; dual.className = "hidden";
  dual.innerHTML = `<canvas id="obBoardBig" width="360" height="440"></canvas>`;
  document.body.appendChild(dual);

  const boxHtml = () =>
    `<div class="skname">나</div>` +
    `<div class="obgauge"><div class="fill"></div>` +
    `<i style="left:33.3%"></i><i style="left:66.6%"></i></div><div class="obsk">` +
    OB_SKILLS.map((d,i) =>
      `<button data-i="${i}"><span class="cost">${d.charge ? "0/"+d.charge : d.cost}</span>` +
      `<img src="${d.img}" alt=""><span class="nm">${d.ko}</span></button>`).join("") +
    `<button class="atkB"><span class="cost">0/5</span>` +
    `<img src="${RING_LOCK}" alt=""><span class="nm">공격</span></button>` +
    `</div>`;
  const skMe = document.createElement("div");
  skMe.id = "obSkillMe"; skMe.className = "obskbox hidden"; skMe.innerHTML = boxHtml();
  document.body.appendChild(skMe);
  const skOp = document.createElement("div");
  skOp.id = "obSkillOpp"; skOp.className = "obskbox hidden"; skOp.innerHTML = boxHtml();
  skOp.querySelector(".skname").textContent = "상대";
  document.body.appendChild(skOp);
  skMe.querySelectorAll(".obsk button").forEach(b => b.onclick = () => {
    const c = window.__obCtl;
    if(b.classList.contains("atkB")){                          // attack stock → fire
      if(OB.atkStock && OB.atkStock.length) atkFire(OB.atkStock.shift());
      return;
    }
    const d = OB_SKILLS[+b.dataset.i];
    if(!c) return;
    const st = window.__ob.getState(), ss = st.skillSession || null;
    if(ss && ss.phase !== "casting"){ OB._swapAtk = false; c.cancelSkill(); return; }  // any session → cancel
    if(b.classList.contains("dis")) return;
    if(OB.mode === "attack"){
      if(d.id === "clear"){ c.activateSkill("clear"); return; }   // 포기 → 선택 과일 전송
      if(d.id === "swap"){                                        // 운명 → +1 진화 전송
        OB._swapAtk = true;
        st.setSkillSession({id:"clear", phase:"selecting", hoverBodyId:null,
                            selectedBodyIds:[], startedAt:performance.now(), endsAt:null});
        return;
      }
      if(st.spendEnergy(d.cost, {deduct:true})){                  // 부유/흔들기 → 상대에게
        st.incSkillUse && st.incSkillUse();
        atkSend({t:"atk", k:d.id});
      }
      return;
    }
    c.activateSkill(d.id);
  });

  const center = document.createElement("div");
  center.id = "obCenter"; center.className = "hidden";
  center.innerHTML = `
    <div class="nrow">
      <div class="ncell"><div class="cstage" id="obClNextM"></div>
        <div class="fb"><div class="banner">다음</div>
          <div class="nstage"><img class="nbubble" src="assets/imgs/next-bg.1d6a27.png">
            <img class="nfruit" id="obMyN"><img class="nbase" src="assets/imgs/next-base.60e0ff.png"></div></div></div>
      <div class="ncell"><div class="obtimer">5:00</div></div>
      <div class="ncell"><div class="cstage" id="obClNextO"></div>
        <div class="fb"><div class="banner">다음</div>
          <div class="nstage"><img class="nbubble" src="assets/imgs/next-bg.1d6a27.png">
            <img class="nfruit" id="obOpN"><img class="nbase" src="assets/imgs/next-base.60e0ff.png"></div></div></div>
    </div>
    <div class="vsscore"></div>
    <div class="rrow">
      <div class="rcell"><div class="cstage" id="obClRingM"></div>
        <div class="fb"><div class="banner">융합 도감</div><canvas id="obRingM" width="170" height="170"></canvas></div></div>
    </div>`;
  document.body.appendChild(center);

  const me = document.createElement("div");
  me.id = "obMe"; me.className = "hidden";
  me.innerHTML = `<canvas id="obBoardMe" width="360" height="440"></canvas>`;
  document.body.appendChild(me);

  $("obName").value = OB.me.name;
  $("obClose").onclick = () => {
    // closing the lobby = leaving the room (playing/done just hides the panel)
    if(OB.state === "playing") $("obOv").classList.add("hidden");
    else { netLeave(); $("obOv").classList.add("hidden"); }
    uiRender();
  };
  $("obHost").onclick = netHost;
  $("obJoin").onclick = () => { const c = $("obCode").value.trim(); if(c.length===4) netJoin(c); };
  $("obQuick").onclick = () => { if(_rooms.length) netJoin(_rooms[(Math.random()*_rooms.length)|0].code); };
  $("obModes").innerHTML = Object.keys(MODES).map(m =>
    `<button data-m="${m}">${MODES[m]}</button>`).join("");
  $("obModes").querySelectorAll("button").forEach(b => {
    b.onclick = () => netMode(b.dataset.m);
  });
  $("obReady").onclick = () => netReady(!OB.myReady);
  $("obExit").onclick = () => { netLeave(); uiRender(); };
  $("obGo").onclick = () => {
    if(!OB.opp){ st0("상대가 없습니다"); return; }
    if(!OB.oppReady){ st0("상대가 준비 중입니다"); return; }
    netGo();
  };
  $("obName").onchange = e => netSetName(e.target.value);
}
const $ = id => document.getElementById(id);
const st0 = t => { $("obStatus").innerHTML = t; };
let _rooms = [];

function uiRender(){
  if(!_uiBuilt) return;
  // result banner — independent of lobby overlay visibility (it's hidden during play)
  let res = $("obRes");
  if(OB.state === "done" && OB.myEnd){
    if(!res){
      res = document.createElement("div"); res.id = "obRes"; document.body.appendChild(res);
      setTimeout(()=>res.remove(), 10000);
    }
    const w = OB.winner, iWon = w && w.cid === OB.connId;
    // oppEnd is ideal; fall back to the last streamed snapshot — it now carries
    // merge/maxLv too, so a lost "end" packet no longer renders "?"
    const o = OB.oppEnd || (OB.oppBoard ? {s:OB.oppBoard.s, m:OB.oppBoard.m ?? "?", lvl:OB.oppBoard.lvl ?? "?"} : null);
    res.innerHTML = OB.result
      ? `<h3 style="margin:0 0 8px;color:${iWon?"#7CFF9A":w?"#f66":"#ffd98a"}">
           ${w ? (iWon?"YOU WIN":"YOU LOSE") : "DRAW"}</h3>
         <table style="margin:auto;border-collapse:collapse">
           <tr><td style="padding:2px 14px;color:#17EEFF">${OB.me.name}</td>
               <td style="padding:2px 14px;color:#FF9A3D">${OB.opp ? OB.opp.name : "???"}</td></tr>
           <tr><td style="font-size:22px;font-weight:bold">${OB.myEnd.s}</td>
               <td style="font-size:22px;font-weight:bold">${o ? o.s : "?"}</td></tr></table>
         ${o ? `<div style="font-size:11px;margin-top:6px;color:#ffd98a">merge ${OB.myEnd.m} vs ${o.m} · maxLv ${OB.myEnd.lvl} vs ${o.lvl}</div>` : ""}`
      : `<h3 style="margin:0">결과 대기 중…</h3>`;
  } else if(res) res.remove();
  $("obName").value = OB.me.name;
  const ov = $("obOv");
  if(ov.classList.contains("hidden")) return;
  $("obLobby").classList.toggle("hidden", OB.state !== "lobby");
  if(OB.state === "lobby"){
    const opp = OB.opp ? OB.opp.name : "???";
    st0(`상대: <b>${opp}</b> — 코드 <b>${OB.code}</b>`);
    $("obGo").classList.toggle("hidden", !OB.isHost);
    $("obReady").classList.toggle("hidden", OB.isHost);
    $("obReady").textContent = OB.myReady ? "준비 해제" : "준비";
    $("obReady").classList.toggle("sel", OB.myReady);
    if(OB.isHost) $("obGo").textContent = OB.oppReady ? "시작!" : "상대 준비 대기…";
  } else if(OB.state === "hosting"){
    st0(OB.isHost ? `대기 중 — 코드 <b>${OB.code||"…"}</b> 공유` : "방 확인 중…");
  } else if(OB.state === "idle"){
    st0("");                                    // clear stale lobby text
    $("obReady").textContent = "준비";
  } else if(OB.state === "playing" || OB.state === "done"){
    ov.classList.add("hidden");
  }
  // mode picker: selectable in idle (sets the mode my future room advertises)
  // and for the host; read-only highlight for guests
  const canPick = OB.state === "idle" || OB.isHost;
  $("obModes").querySelectorAll("button").forEach(b => {
    b.disabled = !canPick;
    b.classList.toggle("sel", b.dataset.m === OB.mode);
  });
  const md = $("obModeDesc");
  if(md) md.textContent = MODE_DESC[OB.mode] || "";
}

/* ---------- versus dual-board layout ---------- */
let _dual = false, _gameCanvas = null, _jarRect = null;
function pickGameCanvas(root){
  // jar canvas ≈ 0.82 aspect; ignore tiny/hidden canvases; fall back to widest
  const cvs = [...root.querySelectorAll("canvas")]
    .map(c => ({c, r: c.getBoundingClientRect()}))
    .filter(o => o.r.width > 80 && o.r.height > 80);
  if(!cvs.length) return null;
  const jar = cvs.find(o => { const a = o.r.width / o.r.height; return a > 0.6 && a < 1.05; });
  return (jar || cvs.sort((a,b) => b.r.width - a.r.width)[0]).c;
}
function applyDualLayout(){
  const root = document.getElementById("root");
  _dual = innerWidth >= innerHeight * 1.15;   // landscape only; portrait → mini fallback
  if(!root || !_dual) return false;
  const board = pickGameCanvas(root);
  if(!board) return false;
  _gameCanvas = board;                                 // live canvas we mirror onto obBoardMe
  // if already transformed, getBoundingClientRect returns post-transform coords — normalize back
  const cs = getComputedStyle(document.documentElement);
  const applied = document.body.classList.contains("vs-dual");
  const s0 = applied ? (parseFloat(cs.getPropertyValue("--vsS")) || 1) : 1;
  const rr = root.getBoundingClientRect(), cr = board.getBoundingClientRect();
  const crw = cr.width / s0, crh = cr.height / s0;                       // canvas size in root-local units
  const px = (cr.left - rr.left) / s0 + crw / 2;                         // canvas center in root coords
  const py = (cr.top  - rr.top ) / s0 + crh / 2;
  const s = Math.min(0.92, innerWidth * 0.42 / crw, innerHeight * 0.88 / crh);
  const rs = document.documentElement.style;
  rs.setProperty("--vsS", s);
  rs.setProperty("--vsW", (rr.width / s0) + "px");
  rs.setProperty("--vsH", (rr.height / s0) + "px");
  // transform-origin top-left: a root-local point (px,py) lands at vsL + px*s — park the
  // board's center at 26% viewport width / slightly below vertical center
  const vsL = innerWidth * 0.22 - px * s;
  const vsT = innerHeight * 0.54 - py * s;
  rs.setProperty("--vsL", Math.round(vsL) + "px");
  rs.setProperty("--vsT", Math.round(vsT) + "px");
  document.body.classList.add("vs-dual");
  // our board canvases sit exactly where the (invisible) game canvas landed —
  // pointer coords then hit the game's input layer with matching rects
  const bx = vsL + (px - crw/2) * s, by = vsT + (py - crh/2) * s;
  const bw = Math.round(crw * s), bh = Math.round(crh * s);
  const cvM = $("obBoardMe"), cvO = $("obBoardBig");
  cvM.width = bw; cvM.height = bh; cvO.width = bw; cvO.height = bh;
  // measure the REAL frame/glass img rects inside the game container so the
  // opponent jar renders pixel-identical in size/position to mine
  _jarRect = null;
  try{
    const box = board.parentElement;
    const fr2 = box && box.querySelector('img[data-tutorial-id="game-container"]');
    const gl2 = box && box.querySelector('img.hkmeqG');
    const rel = el => el && { x:(el.getBoundingClientRect().left - cr.left) / cr.width,
                              y:(el.getBoundingClientRect().top - cr.top) / cr.height,
                              w:el.getBoundingClientRect().width / cr.width,
                              h:el.getBoundingClientRect().height / cr.height };
    _jarRect = { frame: rel(fr2), glass: rel(gl2) };
  }catch(e){}
  const dm = $("obMe"), d = $("obDual");
  dm.style.left = bx + "px";  dm.style.top = by + "px";          // canvas = first child
  d.style.left = (innerWidth * 0.82 - bw / 2) + "px"; d.style.top = by + "px";
  // center column lives in the ACTUAL gap between boards, vertically centered
  // on the jars — scale to fit so it never overlaps regardless of window size
  const myR = bx + bw, opL = innerWidth * 0.82 - bw / 2;
  const gap = Math.max(60, opL - myR - 24);
  const ce = $("obCenter");
  ce.style.left = ((myR + opL) / 2) + "px";
  ce.style.top = (by + bh / 2) + "px";          // vertically centered on the jars
  const fitGap = innerWidth * 0.52 - bw - 24;   // old 26%/78% spacing — v51 moved
                                                // boards out for looks only, so
                                                // size the column off the old gap
  ce.style.transform = `translate(-50%,-50%) scale(${Math.min(5, fitGap / 200, innerHeight / 520)})`;
  for(const id of ["obDual","obCenter","obMe"]) $(id).classList.remove("hidden");
  // skill bars float centered above each jar
  const skM = $("obSkillMe"), skO = $("obSkillOpp");
  const skY = Math.max(4, by - 104);
  if(skM){ skM.style.left = (bx + bw/2) + "px"; skM.style.top = skY + "px"; }
  if(skO){ skO.style.left = (innerWidth * 0.82) + "px"; skO.style.top = skY + "px"; }
  return true;
}
function clearDualLayout(){
  _dual = false; _gameCanvas = null;
  document.body.classList.remove("vs-dual");
  for(const id of ["obDual","obCenter","obMe","obHud","obSkillMe","obSkillOpp"]){ const e = $(id); e && e.classList.add("hidden"); }
}

/* opponent board — latest snapshot lerped onto a canvas */
const _smooth = new Map();   // id -> {x,y,a}
function uiOppHud(){
  const playing = OB.state === "playing";
  $("obHud") && $("obHud").classList.toggle("hidden", _dual || !playing);   // mini = portrait fallback only
  if(_dual){
    $("obDual") && $("obDual").classList.toggle("hidden", !playing);
    $("obCenter") && $("obCenter").classList.toggle("hidden", !playing);
    $("obMe") && $("obMe").classList.toggle("hidden", !playing);
  } else {
    for(const id of ["obDual","obCenter","obMe","obSkillMe","obSkillOpp"]){ const e = $(id); e && e.classList.add("hidden"); }
  }
  const s = OB.oppBoard, name = OB.opp ? OB.opp.name : "???";
  const osc = $("obHud").querySelector(".oppname"); if(osc) osc.textContent = name;
  const sc = $("obHud").querySelector(".oppscore"); if(sc) sc.textContent = s ? s.s : 0;
  const st = window.__ob ? window.__ob.getState() : {};
  const vs = $("obCenter") && $("obCenter").querySelector(".vsscore");
  if(vs) vs.innerHTML = `<span style="color:#1d7a4f">${OB.me.name}</span> <b>${st.score||0}</b>
    <span style="color:#888">vs</span> <b>${s ? s.s : 0}</b> <span style="color:#c06010">${name}</span>`;
  // next-piece previews — mine from local store, opponent's from stream
  if(_dual){
    const myImg = window.__obImg && st.next ? window.__obImg(st.next) : null;
    if(myImg && myImg.src && $("obMyN").src !== myImg.src) $("obMyN").src = myImg.src;
    const opImg = window.__obImg && s && s.n ? window.__obImg(s.n) : null;
    if(opImg && opImg.src && $("obOpN").src !== opImg.src) $("obOpN").src = opImg.src;
  }
}

/* world→canvas mapping — mirrors the game canvas layout:
   logical canvas = [padX | container | padX] × [padTop+dropZone | container | padBottom] */
function boardGeom(cv){
  const ey = window.__obEy || {};
  const cw = ey.container ? ey.container.width : 230, ch = ey.container ? ey.container.height : 280;
  const pX = ey.canvasPadX || 0, pT = (ey.canvasPadTop || 0) + (ey.dropZoneHeight || 0);
  const logW = cw + 2 * pX, logH = pT + ch + (ey.canvasPadBottom || 0);
  return {cw, ch, pX, pT, logW, logH, sc: cv.width / logW};
}
function drawBodies(ctx, cv, list, lerp){
  const g = boardGeom(cv);
  const seen = new Set();
  for(const [id,lvl,x,y,a] of list){
    seen.add(id);
    let dx = x, dy = y, da = a;
    if(lerp){
      let sm = _smooth.get(id);
      if(!sm){ sm = {x,y,a}; _smooth.set(id,sm); }
      sm.x += (x-sm.x)*0.35; sm.y += (y-sm.y)*0.35; sm.a += (a-sm.a)*0.35;
      dx = sm.x; dy = sm.y; da = sm.a;
    }
    const img = window.__obImg && window.__obImg(lvl);
    const size = (window.__obCfg ? window.__obCfg(lvl).size : 40) * g.sc;
    ctx.save();
    ctx.translate((dx+g.pX)*g.sc, (dy+g.pT)*g.sc); ctx.rotate(da);
    if(img && img.complete && img.naturalWidth){
      // native: scale so the LONGEST side equals collision size — keep aspect
      const l = size / Math.max(img.naturalWidth, img.naturalHeight);
      const w = img.naturalWidth*l, h = img.naturalHeight*l;
      ctx.drawImage(img, -w/2, -h/2, w, h);
    }
    else{ ctx.fillStyle="#ffb84d"; ctx.beginPath(); ctx.arc(0,0,size/2,0,7); ctx.fill(); }
    ctx.restore();
  }
  if(lerp) for(const id of _smooth.keys()) if(!seen.has(id)) _smooth.delete(id);
}
/* aim preview: ghost fruit + drop line at world x */
function drawPreview(ctx, cv, worldX, lvl){
  const g = boardGeom(cv);
  const size = (window.__obCfg ? window.__obCfg(lvl).size : 40) * g.sc;
  const gx = Math.max(g.pX*g.sc + size/2, Math.min((g.pX+g.cw)*g.sc - size/2, (worldX + g.pX) * g.sc));
  const gy = g.pT*g.sc + size/2 + 4;                      // ghost sits just inside the jar rim
  ctx.save();
  ctx.strokeStyle = "#ffffff90"; ctx.lineWidth = 2; ctx.setLineDash([6,6]);
  ctx.beginPath(); ctx.moveTo(gx, gy + size/2); ctx.lineTo(gx, g.pT*g.sc + g.ch*g.sc); ctx.stroke();
  ctx.setLineDash([]);
  const img = window.__obImg && window.__obImg(lvl);
  ctx.globalAlpha = .8;
  if(img && img.complete && img.naturalWidth) ctx.drawImage(img, gx-size/2, gy-size/2, size, size);
  ctx.restore();
}

/* opponent danger visuals — native assets, same positions as drawRedLine/
   drawDangerOverlay/drawDangerCountdown in the game renderer */
const DG_SRC = {
  line:"assets/imgs/danger-line.7a9c83.png",
  overlay:"assets/imgs/danger-overlay.f6bf14.png",
  cd0:"assets/imgs/countdown-0.2c76dc.png", cd1:"assets/imgs/countdown-1.2b6c88.png",
  cd2:"assets/imgs/countdown-2.b57407.png", cd3:"assets/imgs/countdown-3.9370d0.png",
};
const _dg = {};
function dgImg(k){ if(!_dg[k]){ _dg[k] = new Image(); _dg[k].src = DG_SRC[k]; } return _dg[k]; }
function drawDanger(ctx, cv, elapsed){
  const g = boardGeom(cv), ey = window.__obEy || {};
  const lw = (ey.danger && ey.danger.lineWidth) || 192;
  const lh = (ey.danger && ey.danger.lineHeight) || 3.5;
  const oh = (ey.danger && ey.danger.overlayHeight) || 45;
  const cdh = (ey.danger && ey.danger.countdownHeight) || 52;
  const rly = ey.redLineY != null ? ey.redLineY : 8;
  // red overlay zone under the line — pulses like the native danger overlay
  const ov = dgImg("overlay");
  ctx.save(); ctx.globalAlpha = .55 + .3 * Math.sin(Date.now() / 300);
  if(ov.complete && ov.naturalWidth)
    ctx.drawImage(ov, g.pX*g.sc, (rly-1+g.pT)*g.sc, g.cw*g.sc, oh*g.sc);
  else{ ctx.fillStyle = "#f33"; ctx.globalAlpha = .3;
        ctx.fillRect(g.pX*g.sc, (rly-1+g.pT)*g.sc, g.cw*g.sc, oh*g.sc); }
  ctx.restore();
  const li = dgImg("line"), lx = g.pX + (g.cw - lw) / 2;
  if(li.complete && li.naturalWidth)
    ctx.drawImage(li, lx*g.sc, (rly-lh/2+g.pT)*g.sc, lw*g.sc, lh*g.sc);
  else{
    ctx.save(); ctx.strokeStyle = "#f44"; ctx.lineWidth = 3; ctx.setLineDash([8,6]);
    ctx.beginPath();
    ctx.moveTo(g.pX*g.sc, (rly+g.pT)*g.sc); ctx.lineTo((g.pX+g.cw)*g.sc, (rly+g.pT)*g.sc);
    ctx.stroke(); ctx.restore();
  }
  // countdown digit 3→0 — native sI(): each step 1100ms, 100ms gap hides it
  const t = Math.floor(elapsed / 1100),
        dig = (t < 0 || t > 3) ? null : (elapsed % 1100 < 1000 ? 3 - t : null);
  if(dig != null){
    const im = dgImg("cd" + dig);
    const cx = (g.pX + g.cw/2)*g.sc, cy = (rly - .15*cdh + cdh/2 + g.pT)*g.sc;
    if(im.complete && im.naturalWidth){
      const w = cdh*g.sc*(im.naturalWidth/im.naturalHeight);
      ctx.drawImage(im, cx - w/2, cy - cdh*g.sc/2, w, cdh*g.sc);
    }else{
      ctx.save(); ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `bold ${cdh*g.sc*.8}px sans-serif`; ctx.fillText(dig, cx, cy); ctx.restore();
    }
  }
}

/* pointer → world x via our own board rect (works even if __obCtl unavailable) */
let _aimX = null;
addEventListener("pointermove", e => {
  if(!_dual){ _aimX = null; return; }
  const cv = $("obBoardMe"); if(!cv) return;
  const r = cv.getBoundingClientRect();
  if(e.clientX < r.left - 30 || e.clientX > r.right + 30 || e.clientY > r.bottom + 40){ _aimX = null; return; }
  const g = boardGeom(cv);
  const lvl = (window.__ob ? window.__ob.getState().current : 1) || 1;
  const sz = window.__obCfg ? window.__obCfg(lvl).size : 40;
  _aimX = Math.max(sz/2, Math.min(g.cw - sz/2, (e.clientX - r.left) / g.sc - g.pX));
}, {passive:true});

function myBodiesArr(){
  const phys = window.__obPhys; if(!phys || !phys.bodies) return [];
  const arr = [];
  for(const [id, w] of phys.bodies){
    const b = w.body; if(!b || !b.position) continue;
    const a = b.angle || 0, off = w.renderOffset || {x:0,y:0}, ca = Math.cos(a), sa = Math.sin(a);
    arr.push([id, w.level || 1,
      b.position.x + off.x*ca - off.y*sa,
      b.position.y + off.x*sa + off.y*ca, a]);
  }
  return arr;
}

let _jarImg = null, _frameImg = null, _dzBack = null, _dzFront = null;
function jarImg(){
  if(!_jarImg){ _jarImg = new Image(); _jarImg.src = "assets/imgs/box-glass.8791ba.png"; }
  return _jarImg;
}
function frameImg(){
  if(!_frameImg){ _frameImg = new Image(); _frameImg.src = "assets/imgs/box-frame.13d9df.png"; }
  return _frameImg;
}
// drop-zone = animated 12-frame sprite: back layer (bag+admins) + front mouth piece.
// idle pose = last frame; anchors come straight from ey.dropZone config.
function dzBack(){
  if(!_dzBack){ _dzBack = new Image(); _dzBack.src = "assets/imgs/12.4ebf48.png"; }
  return _dzBack;
}
function dzFront(){
  if(!_dzFront){ _dzFront = new Image(); _dzFront.src = "assets/imgs/12.811675.png"; }
  return _dzFront;
}
/* native drop-zone — mirrors renderer.drawDzImage math, world coords + pX/pT
   offsets exactly like drawBodies. Order: back → aim → bodies → tuan → front. */
function drawDZBack(ctx, cv, px){   // bag+admins back frame + dashed aim line
  const g = boardGeom(cv), ey = window.__obEy || {};
  const dzY = ey.dropY != null ? ey.dropY : 0, W = g.sc;
  const X = px + 1, Y = dzY - 45;
  const bk = dzBack();
  if(bk.complete && bk.naturalWidth){
    const f = 186 / bk.naturalWidth;
    ctx.drawImage(bk, (X - bk.naturalWidth*f/2 + g.pX)*W, (Y - bk.naturalHeight*f/2 + g.pT)*W,
                      bk.naturalWidth*f*W, bk.naturalHeight*f*W);
  }
  ctx.save();
  ctx.strokeStyle = "#ffffff90"; ctx.lineWidth = 1.5*W; ctx.setLineDash([6*W,8*W]);
  ctx.beginPath();
  ctx.moveTo((px+g.pX)*W, (dzY+30+g.pT)*W);
  ctx.lineTo((px+g.pX)*W, ((ey.container?ey.container.height:280)+g.pT)*W);
  ctx.stroke(); ctx.restore();
}
function drawDZFront(ctx, cv, px, lvl){   // preview tuan in the mouth + mouth cover
  const g = boardGeom(cv), ey = window.__obEy || {};
  const dzY = ey.dropY != null ? ey.dropY : 0, W = g.sc;
  const size = (window.__obCfg ? window.__obCfg(lvl).size : 40) * 0.92 * W;
  const img = window.__obImg && window.__obImg(lvl);
  // native sV(): x = px - collision-primary.x, y = dropY + vOffset(center=3) - boundsCenterY
  let ax = 0, ay = 0;
  try{
    const col = window.__obCfg && window.__obCfg(lvl).collision;
    if(col && col.bounds) ay = (col.bounds.min.y + col.bounds.max.y) / 2;
    if(col && col.primary && col.primary.position) ax = col.primary.position.x;
  }catch(e){}
  const fx = (px - ax + g.pX)*W, fy = (dzY + 3 - ay + g.pT) * W;
  ctx.save(); ctx.globalAlpha = .95;
  if(img && img.complete && img.naturalWidth){
    const l = size / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth*l, h = img.naturalHeight*l;
    ctx.drawImage(img, fx-w/2, fy-h/2, w, h);
  }
  else{ ctx.fillStyle="#ffb84d"; ctx.beginPath(); ctx.arc(fx,fy,size/2,0,7); ctx.fill(); }
  ctx.restore();
  const mf = dzFront();
  if(mf.complete && mf.naturalWidth){
    const f = 186/558, X = px + 1, Y = dzY - 45;
    ctx.drawImage(mf, 188,228,180,147,
      (X - 558*f/2 + 188*f + g.pX)*W, (Y - 419*f/2 + 228*f + g.pT)*W, 180*f*W, 147*f*W);
  }
}
function drawGlass(ctx, cv){
  const g = boardGeom(cv);
  ctx.clearRect(0,0,cv.width,cv.height);
  const j = jarImg();
  if(j.complete && j.naturalWidth)
    ctx.drawImage(j, g.pX*g.sc, g.pT*g.sc, g.cw*g.sc, g.ch*g.sc);
}

/* ---------- native-DOM clones for the versus center column ----------
   MY side: live cloneNode of the game's own next-card (.oMF2xJ) and
   collection ring (.sagf7p). OPP side: clone the same structure once,
   then patch fruit/unlock icons from the stream (n = next, u = unlocked). */
const RING_ICONS = ["01.b52f68","02.b75123","03.fe93f9","04.eda41e","05.8309c1",
  "06.fd79e3","07.8a6708","08.244739","09.b97561","10.8a730b","11.7cf4c5"]
  .map(f => "assets/imgs/" + f + ".png");
const RING_LOCK = "assets/imgs/q-small.6dc89e.png";
let _cloneAt = 0;
function fitClone(host, src, tw, th){
  const w = src.offsetWidth || tw, h = src.offsetHeight || th;
  const k = Math.min(tw / w, th / h), c = host.firstChild;
  if(c) c.style.transform = `scale(${k})`;
  host.style.width = (w * k) + "px"; host.style.height = (h * k) + "px";
}
function copyCanvases(src, dst){
  // cloneNode drops canvas bitmaps — banner labels ("다음"/"융합 도감") are
  // canvas-drawn by the rx text renderer, so copy each canvas by index
  if(!src || !dst) return;
  const sc = src.querySelectorAll("canvas"), dc = dst.querySelectorAll("canvas");
  sc.forEach((s, i) => {
    const d = dc[i];
    if(d && s.width && s.height){
      if(d.width !== s.width) d.width = s.width;
      if(d.height !== s.height) d.height = s.height;
      try{ d.getContext("2d").drawImage(s, 0, 0); }catch(e){}
    }
  });
}
function cloneFull(src){
  const c = src.cloneNode(true);
  copyCanvases(src, c);
  return c;
}
function cloneInto(host, src, tw, th){
  if(!host) return;
  const h = src.outerHTML;
  if(host._h === h){ copyCanvases(src, host.firstChild); return; }  // bitmap refresh
  host._h = h; host.innerHTML = "";
  host.appendChild(cloneFull(src));
  fitClone(host, src, tw, th);
}
function syncNativeClones(){
  if(OB.state !== "playing" || !_dual) return;
  const now = Date.now();
  if(now - _cloneAt < 250) return;
  _cloneAt = now;
  const srcN = document.querySelector("#root .oMF2xJ");
  const srcR = document.querySelector("#root .sagf7p");
  const s = OB.oppBoard;
  const sizeOf = lvl => {                        // preview fruit ∝ real collision size
    const c = lvl && window.__obCfg ? window.__obCfg(lvl) : null;
    return c && c.size ? c.size / 52 : 1;
  };
  if(srcN){
    cloneInto($("obClNextM"), srcN, 180, 230);
    const st = window.__ob && window.__ob.getState ? window.__ob.getState() : {};
    const mI = $("obClNextM") && $("obClNextM").querySelector("img.shhBcA");
    if(mI) mI.style.transform = `scale(${sizeOf(st.next)})`;
    const o = $("obClNextO");
    if(o){
      if(!o.firstChild){ o.appendChild(cloneFull(srcN)); fitClone(o, srcN, 180, 230); }
      const im = o.querySelector("img.shhBcA"), n = s && s.n;
      if(im && o._n !== n){
        o._n = n;
        const fi = n && window.__obImg ? window.__obImg(n) : null;
        if(fi && fi.src) im.src = fi.src;
        im.style.opacity = n ? "" : "0";
      }
      if(im) im.style.transform = `scale(${sizeOf(n)})`;
    }
  }
  if(srcR){
    cloneInto($("obClRingM"), srcR, 300, 300);
    // show the FULL fusion chart — every level icon (normalized to one visual
    // size) + the level-11 fruit in the center instead of "?"
    patchRing($("obClRingM"));
  }
}
function patchRing(el){
  if(!el) return;
  el.querySelectorAll("img.iAdD8q").forEach((im, i) => {
    if(RING_ICONS[i] && !im.src.endsWith(RING_ICONS[i])) im.src = RING_ICONS[i];
  });
  const c = el.querySelector("img.HwQpFM");         // center "???" → lv11 fruit
  if(c && !c.src.endsWith(RING_ICONS[10])) c.src = RING_ICONS[10];
}

let _ringImg = null;
function ringImg(){
  if(!_ringImg){ _ringImg = new Image(); _ringImg.src = "assets/imgs/collection-bg.4dc2a2.png"; }
  return _ringImg;
}
/* fusion codex ring: levels 1..__obMax on the circular arrow, locked = "?" */
function drawRing(cv, unlocked){
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H);
  const bg = ringImg();
  if(bg.complete && bg.naturalWidth) ctx.drawImage(bg, 0, 0, W, H);
  const max = (window.__obMax || 11), R = W * 0.36, cx = W/2, cy = H/2;
  for(let i = 0; i < max; i++){
    const lvl = i + 1;
    const a = -Math.PI/2 + (i / max) * Math.PI * 2;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    if(lvl <= unlocked){
      const img = window.__obImg && window.__obImg(lvl);
      const sz = (window.__obCfg ? window.__obCfg(lvl).size : 30) * 0.34;
      if(img && img.complete && img.naturalWidth){ ctx.drawImage(img, x-sz/2, y-sz/2, sz, sz); continue; }
    }
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7);
    ctx.fillStyle = "#c8e4d8"; ctx.fill();
    ctx.fillStyle = "#5a8a74"; ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("?", x, y);
  }
}

let _relayout = 0;
function drawOppBoard(){
  const playing = OB.state === "playing";
  if(_dual && playing && Date.now() - _relayout > 500){ _relayout = Date.now(); applyDualLayout(); }  // self-heal as scene settles
  syncNativeClones();
  // timer — both layouts
  if(playing){
    // timelimit counts DOWN to the deadline; original/attack count UP (elapsed)
    const left = isFinite(OB.matchEnd)
      ? Math.max(0, OB.matchEnd - Date.now())
      : Date.now() - OB.matchStart;
    const txt = `${(left/60000)|0}:${("0"+((left/1000)|0)%60).slice(-2)}`;
    const t1 = document.querySelector("#obCenter .obtimer");
    const t2 = document.querySelector("#obHud .obtimer");
    if(t1) t1.textContent = txt;
    if(t2) t2.textContent = txt;
  }
  if(_dual){
    const cvM = $("obBoardMe"), cvO = $("obBoardBig"); if(!cvM || !cvO) return;
    const st = window.__ob ? window.__ob.getState() : {};
    const fr = frameImg();
    // MY board — composite the real container's layers: imgs (frame+glass) under,
    // canvases on top → fruits/aim/bag render FRONT-MOST like the opponent board
    const cm = cvM.getContext("2d");
    const gc = _gameCanvas;
    let mirrored = false;
    if(gc && gc.isConnected && gc.width && gc.height && gc.parentElement){
      const cr = gc.getBoundingClientRect();
      if(cr.width > 20){
        const kx = cvM.width / cr.width, ky = cvM.height / cr.height;
        cm.clearRect(0,0,cvM.width,cvM.height);
        const els = [];
        const collect = el => {
          for(const ch of el.children){
            if(ch.dataset && ch.dataset.interactive === "true") continue;   // skip input layer
            if(ch.tagName === "IMG" || ch.tagName === "CANVAS"){
              // skip nodes animated to invisible — a faded-out element keeps its
              // canvas bitmap/rect, so without this the COMBO counter stays forever
              let hid = false;
              for(let p = ch; p && p !== gc.parentElement; p = p.parentElement){
                const st = p.style;
                if((st.opacity !== "" && parseFloat(st.opacity) < 0.05)
                   || st.display === "none" || st.visibility === "hidden"){ hid = true; break; }
              }
              if(!hid) els.push(ch);
            }
            else collect(ch);                                             // recurse into wrappers
          }
        };
        collect(gc.parentElement);
        els.sort((a,b) => (a.tagName === "CANVAS") - (b.tagName === "CANVAS"));  // stable: imgs first, canvases last
        for(const el of els){
          if(el.tagName === "CANVAS" || (el.complete && el.naturalWidth)){
            const r = el.getBoundingClientRect();
            if(r.width > 0 && r.height > 0)
              try{ cm.drawImage(el, (r.left-cr.left)*kx, (r.top-cr.top)*ky, r.width*kx, r.height*ky); }catch(e){}
          }
        }
        mirrored = true;
      }
    }
    if(!mirrored){   // fallback: manual render from physics, and re-acquire the real canvas
      // native order: frame → bag back → aim → fruits → preview → mouth → glass
      const gm = boardGeom(cvM), jm = jarImg();
      cm.clearRect(0,0,cvM.width,cvM.height);
      if(fr.complete && fr.naturalWidth)
        cm.drawImage(fr, gm.pX*gm.sc, gm.pT*gm.sc, gm.cw*gm.sc, gm.ch*gm.sc);
      const aimX = (window.__obCtl && isFinite(window.__obCtl.previewX)) ? window.__obCtl.previewX : _aimX;
      const apx = aimX != null ? aimX : gm.cw/2;
      drawDZBack(cm, cvM, apx);
      if(jm.complete && jm.naturalWidth)
        cm.drawImage(jm, gm.pX*gm.sc, gm.pT*gm.sc, gm.cw*gm.sc, gm.ch*gm.sc);
      drawBodies(cm, cvM, myBodiesArr(), false);
      drawDZFront(cm, cvM, apx, st.current || 1);
      _gameCanvas = pickGameCanvas(document.getElementById("root") || document.body);
    }
    // OPPONENT board — frame → bag back → aim → glass → fruits (front-most) →
    // preview tuan + mouth cover on top
    const co = cvO.getContext("2d"), go = boardGeom(cvO), jo = jarImg();
    co.clearRect(0,0,cvO.width,cvO.height);
    // jar images at the REAL element rects (fractions of the game canvas) —
    // identical size/position to my mirrored jar
    const fR = _jarRect && _jarRect.frame, gR = _jarRect && _jarRect.glass;
    if(fr.complete && fr.naturalWidth)
      fR ? co.drawImage(fr, fR.x*cvO.width, fR.y*cvO.height, fR.w*cvO.width, fR.h*cvO.height)
         : co.drawImage(fr, go.pX*go.sc, go.pT*go.sc, go.cw*go.sc, go.ch*go.sc);
    const opx = OB.oppBoard && isFinite(OB.oppBoard.px) ? OB.oppBoard.px : go.cw/2;
    drawDZBack(co, cvO, opx);
    if(jo.complete && jo.naturalWidth)
      gR ? co.drawImage(jo, gR.x*cvO.width, gR.y*cvO.height, gR.w*cvO.width, gR.h*cvO.height)
         : co.drawImage(jo, go.pX*go.sc, go.pT*go.sc, go.cw*go.sc, go.ch*go.sc);
    drawBodies(co, cvO, (OB.oppBoard && OB.oppBoard.b) || [], true);
    if(OB.oppBoard && OB.oppBoard.d) drawDanger(co, cvO, OB.oppBoard.d);
    drawDZFront(co, cvO, opx, (OB.oppBoard && OB.oppBoard.c) || 1);
    drawRing($("obRingM"), st.unlockedMax || 1);
  } else {
    const cv = $("obBoard"); if(!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0,0,cv.width,cv.height);
    drawBodies(ctx, cv, (OB.oppBoard && OB.oppBoard.b) || [], true);
    if(OB.oppBoard && OB.oppBoard.d) drawDanger(ctx, cv, OB.oppBoard.d);
  }
}

/* ---------- leaderboard display ---------- */
async function refreshRank(){
  const el = $("obRank"); if(!el || !sb()) return;
  const {data} = await sb().from("ob_scores")
    .select("name, score, max_level").order("score", {ascending:false}).limit(10);
  el.innerHTML = data && data.length
    ? "<b style='font-size:13px'>🏆 랭킹</b><table>" + data.map((r,i) =>
        `<tr><td>${i+1}</td><td>${r.name||"???"}</td><td style="text-align:right"><b>${r.score}</b></td><td>Lv${r.max_level}</td></tr>`).join("") + "</table>"
    : "";
}

/* ---------- boot ---------- */
function boot(){
  buildUI();
  if(!window.__ob){ setTimeout(boot, 500); return; }
  hookStore(); hookLeaderboard();
  setInterval(boardTick, BOARD_MS);                    // network send ~7Hz
  (function raf(){ drawOppBoard(); requestAnimationFrame(raf); })();   // render 60fps + lerp
  ensureLobbyWatch();
}
if(document.readyState === "loading") addEventListener("DOMContentLoaded", boot);
else boot();

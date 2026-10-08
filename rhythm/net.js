"use strict";
/* ============================================================
 * RHYTHM versus — Supabase Realtime transport + Postgres records
 * Room code = channel name. Presence = lobby membership + disconnect detect.
 * Score sync = broadcast snapshots (server-relayed, ~100-300ms is fine).
 * ============================================================ */

const SB_URL = "https://mwazxeqcdznidrnkxdkx.supabase.co";   // ← Supabase 프로젝트 URL
const SB_KEY = "sb_publishable_NbOFGTEC9j-19PwMjcZoEw_GuP0Ij0R";                      // ← anon public key
const NET_CFG_OK = SB_URL.indexOf("YOUR_") < 0;

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O/1/I/L
const SNAP_MS = 500;                                  // score snapshot interval
const PING_N = 5, PING_GAP = 150;
const RESULT_WAIT_MS = 6000;

let _sb = null;
function sb(){
  if(!_sb){
    if(!NET_CFG_OK || typeof supabase === "undefined") return null;
    _sb = supabase.createClient(SB_URL, SB_KEY);
  }
  return _sb;
}

const NET = {
  on:false, code:null, isHost:false, chan:null,
  me:{ id:null, name:"PLAYER" },
  connId:null,                       // per-page-load id — winner compare uses this
  opp:null,                          // {id, cid, name}
  offset:0, offErr:9999,             // hostClock ≈ localNow + offset
  sid:null, oppReady:false, myReady:false,
  oppSnap:null, oppEnd:null, myEnd:null, oppGone:false, oppFail:false,
  state:"idle",                      // idle | hosting | lobby | countdown | playing | done
  pings:[], lastSnap:0, log:[], verified:false,
  ui:null,                           // index.html sets: NET.ui = state => render
};
function setState(s){ NET.state = s; if(NET.ui) NET.ui(s); }

/* ---------- identity ---------- */
function netInit(){
  if(!NET.connId) NET.connId = crypto.randomUUID();   // fresh per tab — same-origin
                                                    // tabs share localStorage pid
  try{
    NET.me.id = localStorage.getItem("rhythm_pid");
    if(!NET.me.id){
      NET.me.id = crypto.randomUUID();
      localStorage.setItem("rhythm_pid", NET.me.id);
    }
    NET.me.name = localStorage.getItem("rhythm_name") || "PLAYER";
  }catch(e){
    if(!NET.me.id) NET.me.id = crypto.randomUUID();
  }
}
function netSetName(n){
  NET.me.name = (n || "PLAYER").toUpperCase().slice(0, 12);
  try{ localStorage.setItem("rhythm_name", NET.me.name); }catch(e){}
}

/* ---------- channel plumbing ---------- */
function mkCode(){
  let s = "";
  for(let i = 0; i < 4; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return s;
}
function netSend(o){
  if(NET.chan) NET.chan.send({ type:"broadcast", event:"m", payload:o });
}

function netMsg({payload:p}){
  switch(p.t){
    case "hello":       // guest -> host: identity + chart hash
      if(NET.isHost){
        if(NET.opp) { netSend({t:"full"}); return; }
        NET.opp = { id:p.id, cid:p.cid, name:p.name };
        netSend({t:"hi", id:NET.me.id, cid:NET.connId, name:NET.me.name});   // host -> guest identity
        setState("lobby");
      }
      break;
    case "hi":          // host -> guest
      if(!NET.isHost && !NET.opp){
        NET.opp = { id:p.id, cid:p.cid, name:p.name };
        setState("lobby");
        netClockSync();
      }
      break;
    case "full":        alert("방이 가득 찼습니다"); netLeave(); break;
    case "ping":        if(NET.isHost) netSend({t:"pong", c:p.c, h:Date.now()}); break;
    case "pong": {      // guest: estimate clock offset from the fastest sample
      const now = Date.now(), rtt = now - p.c;
      NET.pings.push({rtt, off: p.h + rtt / 2 - now});
      if(rtt <= NET.offErr){ NET.offErr = rtt; NET.offset = p.h + rtt / 2 - now; }
      break;
    }
    case "pick":   NET.sid = p.sid; setState("lobby"); break;
    case "ready":  NET.oppReady = !!p.on; setState("lobby"); break;
    case "start":  // host -> guest: play sid, trackpos=0 at shared instant `at`
      if(!NET.isHost){
        NET.sid = p.sid;
        const atLocal = p.at - NET.offset;      // host time -> guest time
        vsBegin(NET.sid, atLocal);
      }
      break;
    case "s":      NET.oppSnap = p; netDrawOpp(); break;
    case "fail":   NET.oppFail = true; break;
    case "end":    NET.oppEnd = p; netResolve(); break;
    case "log":    NET.oppLog = p; netResolve(); break;
    case "verify": NET.oppVerified = !!p.ok; netResolve(); break;
    case "gg":     netLeave(); break;           // clean hangup
  }
}

function netPresence(){
  const st = NET.chan.presenceState();
  // detect opponent leaving mid-lobby/mid-game
  const members = Object.keys(st).length;
  if(NET.opp && members < 2){
    NET.oppGone = true;
    if(NET.state === "playing") netDrawOpp();   // HUD shows disconnect
    else if(NET.state !== "done"){ alert("상대가 나갔습니다"); netLeave(); }
  }
}

async function netOpen(code, role){
  const c = sb();
  if(!c){ alert("Supabase 미설정 — net.js의 SB_URL/SB_KEY를 입력하세요"); return false; }
  NET.chan = c.channel("rhythm-vs-" + code);
  NET.chan
    .on("broadcast", { event:"m" }, netMsg)
    .on("presence",  { event:"sync" }, netPresence)
    .on("presence",  { event:"leave" }, netPresence);
  return await new Promise(res => {
    NET.chan.subscribe(async (st, err) => {
      if(st === "SUBSCRIBED"){
        await NET.chan.track({ role, name:NET.me.name, pid:NET.me.id });
        res(true);
      }
      if(st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED"){
        console.warn("vs subscribe failed:", st, err);
        NET.failReason = st + (err ? " — " + (err.message || err) : "");
        res(false);
      }
    });
  });
}

/* ---------- lobby ---------- */
async function netHost(){
  netInit();
  NET.isHost = true; NET.code = mkCode();
  setState("hosting");
  if(!(await netOpen(NET.code, "host"))){ alert("연결 실패: " + (NET.failReason || "")); setState("idle"); return; }
  netRegister();   // player row exists from lobby time — matches FKs depend on it
  // host waits for a guest's hello (sent when guest sees host presence)
}

async function netJoin(code){
  netInit();
  NET.isHost = false; NET.code = code.toUpperCase().trim();
  setState("hosting");
  if(!(await netOpen(NET.code, "guest"))){ alert("연결 실패: " + (NET.failReason || "")); setState("idle"); return; }
  netRegister();
  // wait for host presence, then announce
  let waited = 0;
  const t = setInterval(() => {
    if(!NET.chan){ clearInterval(t); return; }
    const st = NET.chan.presenceState();
    const host = Object.values(st).flat().find(m => m.role === "host");
    if(host){ clearInterval(t); netSend({t:"hello", id:NET.me.id, cid:NET.connId, name:NET.me.name}); }
    else if((waited += 200) > 4000){ clearInterval(t); alert("방을 찾지 못했습니다"); netLeave(); }
  }, 200);
}

function netRegister(){   // upsert own player row (FK target for matches/match_logs)
  if(sb()) sb().from("players")
    .upsert({id:NET.me.id, name:NET.me.name, last_seen:new Date().toISOString()})
    .then(({error}) => { if(error) console.warn("player upsert:", error); });
}

function netClockSync(){   // guest side
  NET.pings = []; NET.offErr = 9999;
  let i = 0;
  const t = setInterval(() => {
    if(i++ >= PING_N || !NET.chan){ clearInterval(t); return; }
    netSend({t:"ping", c:Date.now()});
  }, PING_GAP);
}

function netReady(on){ NET.myReady = on; netSend({t:"ready", on}); setState("lobby"); }
function netPick(sid){ if(NET.isHost){ NET.sid = sid; netSend({t:"pick", sid}); setState("lobby"); } }

function netGo(){   // host: both sides start at a shared future instant
  if(!NET.isHost || !NET.opp || !NET.sid) return;
  const at = Date.now() + 1600;
  netSend({t:"start", sid:NET.sid, at});
  vsBegin(NET.sid, at);   // host clock == local clock
}

/* ---------- in-game ---------- */
function vsBegin(sid, atMs){
  NET.on = true; NET.log = []; NET.oppSnap = null; NET.oppEnd = null;
  NET.oppGone = false; NET.oppFail = false; NET.oppLog = null;
  NET.oppVerified = false; NET.verified = false; NET.lastSnap = 0;
  setState("countdown");
  // `atMs` is on the Date.now() clock — convert to performance.now() space
  const atPerf = performance.now() + (atMs - Date.now());
  start(sid, { at: atPerf });
}

function netSnapTick(){   // called every frame from update()
  if(!NET.on || NET.state !== "playing") return;
  const now = performance.now();
  if(now - NET.lastSnap < SNAP_MS) return;
  NET.lastSnap = now;
  netSend({ t:"s", p:G.points, f:G.fame, c:G.combo,
            prog:Math.min(1, G.trackpos / Math.max(1, G.song.length || 999)) });
}

/* ---------- finish / records ---------- */
function netResult(failed){
  return { p:G.points, great:G.great, good:G.good, miss:G.miss,
           maxCombo:G.maxCombo, failed:!!failed, prog:+G.trackpos.toFixed(3) };
}

function netFinish(failed){   // called from end() when NET.on
  NET.myEnd = netResult(failed);
  if(failed) netSend({t:"fail"});
  netSend({ t:"end", ...NET.myEnd });
  netSend({ t:"log", log:G.log, offset_ms:Math.round(G.offset * 1000) });
  setState("done");
  netResolve();
}

function netWinner(){
  const me = {id:NET.me.id, cid:NET.connId}, op = {id:NET.opp.id, cid:NET.opp.cid};
  let w = null;
  if(NET.oppGone || !NET.oppEnd) w = me;                       // forfeit/disconnect
  else if(NET.oppFail && !NET.myEnd.failed) w = me;
  else if(NET.myEnd.failed && !NET.oppEnd.failed) w = op;
  else if(NET.myEnd.failed && NET.oppEnd.failed)
    w = NET.myEnd.prog >= NET.oppEnd.prog ? me : op;
  else if(NET.myEnd.p !== NET.oppEnd.p) w = NET.myEnd.p > NET.oppEnd.p ? me : op;
  else if(NET.myEnd.great !== NET.oppEnd.great)
    w = NET.myEnd.great > NET.oppEnd.great ? me : op;
  return w;   // {id, cid} or null = draw
}

let _resolving = false;
async function netResolve(){
  if(_resolving || !NET.on || !NET.myEnd) return;
  if(!NET.oppEnd && !NET.oppGone && !NET.oppFail) return;   // still waiting for opp end
  if(!NET.oppEnd){   // opp disconnected before ending — check once more briefly
    const tW = Date.now();
    while(!NET.oppEnd && Date.now() - tW < RESULT_WAIT_MS && !NET.oppGone)
      await new Promise(r => setTimeout(r, 100));
  }
  _resolving = true;
  const t0 = Date.now();
  // give the input log a moment to arrive
  while(!NET.oppLog && Date.now() - t0 < RESULT_WAIT_MS && !NET.oppGone)
    await new Promise(r => setTimeout(r, 100));
  // plausibility check on the opponent's claimed result (full replay sim later)
  let myVerify = false;
  if(NET.oppLog && Array.isArray(NET.oppLog.log)){
    const n = G.notes.length;
    const g = NET.oppEnd;
    myVerify = !g.failed
      ? (g.great + g.good + g.miss <= n + 4 && g.p <= n * 400)   // holds add chain pts — loose bound vs absurd claims
      : true;
  }
  netSend({t:"verify", ok:myVerify});
  // wait briefly for the other side's verdict
  const t1 = Date.now();
  while(NET.oppVerified === false && NET.oppLog && Date.now() - t1 < 1500 && !NET.oppGone)
    await new Promise(r => setTimeout(r, 100));
  NET.verified = myVerify && NET.oppVerified !== false;
  const winner = netWinner();
  // host persists normally; if the host vanished, the surviving guest writes instead
  if(sb() && (NET.isHost || NET.oppGone)){
    const hostRes = NET.isHost ? NET.myEnd : NET.oppEnd;
    const guestRes = NET.isHost ? NET.oppEnd : NET.myEnd;
    try{
      // players must exist first — matches/match_logs have FKs into players
      await sb().from("players").upsert([
        {id:NET.me.id, name:NET.me.name, last_seen:new Date().toISOString()},
        {id:NET.opp.id, name:NET.opp.name, last_seen:new Date().toISOString()},
      ]);
      const {data} = await sb().from("matches").insert({
        code:NET.code, song_id:NET.sid,
        host_id:NET.isHost ? NET.me.id : NET.opp.id,
        guest_id:NET.isHost ? NET.opp.id : NET.me.id,
        host_result:hostRes, guest_result:guestRes,
        winner: winner ? winner.id : null, verified:NET.verified,
      }).select("id").single();
      const mid = data && data.id;
      if(mid){
        const rows = [{ match_id:mid, player_id:NET.me.id,
                        log:G.log, offset_ms:Math.round(G.offset * 1000) }];
        if(NET.oppLog) rows.push({ match_id:mid, player_id:NET.opp.id,
                        log:NET.oppLog.log, offset_ms:NET.oppLog.offset_ms || 0 });
        await sb().from("match_logs").insert(rows);
      }
    }catch(e){ console.warn("match record failed:", e); /* records are best-effort */ }
  }
  NET.winner = winner;               // {id, cid} — cid decides "YOU WIN" locally
  if(NET.ui) NET.ui("result");
  _resolving = false;
}

/* ---------- leave / cleanup ---------- */
function netLeave(){
  if(NET.chan){ try{ netSend({t:"gg"}); NET.chan.untrack(); sb().removeChannel(NET.chan); }catch(e){} }
  NET.on = false; NET.chan = null; NET.opp = null; NET.code = null;
  NET.oppReady = NET.myReady = false; NET.oppSnap = null;
  setState("idle");
}

/* ---------- opponent HUD ---------- */
function netDrawOpp(){
  const el = $("opp");
  if(!el) return;
  if(!NET.on || G.mode !== "play"){ el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  if(NET.oppGone){ el.innerHTML = `<span style="color:#f66">상대 연결 끊김</span>`; return; }
  const s = NET.oppSnap;
  const name = NET.opp ? NET.opp.name : "???";
  if(!s){ el.innerHTML = `${name} …`; return; }
  const famePct = Math.max(0, Math.min(100, Math.round(s.f / FAME_MAX * 100)));
  el.innerHTML =
    `${name} <b>${s.p}</b> · fame ${famePct}%` +
    (NET.oppFail ? ' · <span style="color:#f66">FAILED</span>' : "") +
    ` · ${Math.round((s.prog || 0) * 100)}%`;
}

/* ---------- records UI data ---------- */
async function netRecords(){
  const c = sb(); if(!c || !NET.me.id) return null;
  const {data:recent} = await c.from("matches")
    .select("played_at, song_id, winner, host_id, guest_id, host_result, guest_result, verified")
    .or(`host_id.eq.${NET.me.id},guest_id.eq.${NET.me.id}`)
    .order("played_at", {ascending:false}).limit(10);
  const {data:top} = await c.from("leaderboard").select("*").limit(20);
  return { recent:recent || [], top:top || [] };
}

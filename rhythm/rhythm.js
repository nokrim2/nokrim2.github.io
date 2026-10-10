"use strict";
/* DELTARUNE ch5 rhythm minigame — JS port.
 * Faithful to obj_rhythmgame lead chart mechanics (orig fixed 30fps; atu=1/30):
 *   window ±0.12s, GREAT |dt|<atu*1.6=±53ms -> 100, else GOOD -> 50
 *   press stays armed 3 frames=100ms (pressedtimer<=room_speed/10), 2-frame debounce
 *   miss when note passes trackpos-0.12 -> combo break + melody drop;
 *     fame -= (fame<=2000?100:200)*fame_mul, but only when invc<=0 (2s immunity)
 *   fame gains scaled by fame_mul = 80/maxnote
 *   holds: chainPoints = floor(len/(notespacing*4)*4)*10, x2 on full hold
 */
const $ = id => document.getElementById(id);
const cv = $("cv"), ctx = cv.getContext("2d");
const W = 520, H = 680;                 // logical size; canvas is 2x for crispness
ctx.scale(cv.width / W, cv.height / H);

const NOTE_COLORS = ["#01EA9E", "#17EEFF"];          // lead lanes 0/1
// rainbow_mode (orig scr_rhythmgame_get_rainbow_color): hue spins 180deg/s of
// trackpos, phase offset i*0.1s per element; sin-based pastel channels
function rainbowCol(i, tp){
  const h = (((tp + i * 0.1) * 180) % 360) * Math.PI / 180;
  const c = k => ((Math.sin(h + k) + 1) * 0.5 * 0.7 + 0.3) * 255 | 0;
  return `rgb(${c(0)},${c(2.094)},${c(4.189)})`;   // sin(h+120deg),(h+240deg)
}
const HIT_WINDOW = 0.12;
const FAME0 = 6000, FAME_MAX = 12000;

let SONGS = {}, CHARTS = {}, LYRICS = {};

/* ---------- game state ---------- */
const G = {
  mode: "menu",            // menu | play | done | fail
  song: null, notes: [],
  trackpos: 0, minnote: 0,
  combo: 0, maxCombo: 0, points: 0,
  great: 0, good: 0, miss: 0,
  fame: FAME0, lastJudge: "", judgeT: 0, lastLaneHit: [0,0],
  pressedT: [9,9], buffer: [0,0], invc: 0,  // frames-ish timers in seconds
  hold: [{start:0,end:0,on:false},{start:0,end:0,on:false}],
  laneHeld: [false,false],
  lyric: "", lyricIdx: 0,
  t0: 0, audio: null, ac: null, synth: null, lat: 0, offset: 0,
  solo: null, srcs: [], errs: [], errSum: 0, lastErr: 0,
};

function roundToBeat(t, bpm, div=4, off=0){
  const mps = 60/bpm/div; return Math.round((t-off)/mps)*mps+off;
}

/* ---------- audio: WebAudio buffers for sample-accurate dual-stem sync ---------- */
function actx(){
  if(!G.ac) G.ac = new (window.AudioContext||window.webkitAudioContext)();
  return G.ac;
}
async function loadBuf(name){
  try{
    const r = await fetch(`audio/${name}.ogg`);
    if(!r.ok) return null;
    return await actx().decodeAudioData(await r.arrayBuffer());
  }catch(e){ return null; }
}

function makeSynth(bpm){
  const ac = actx();
  const spb = 60/bpm, meter = spb*4;
  const master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
  const melGain = ac.createGain(); melGain.gain.value = 0; melGain.connect(master);
  const scale = [0,3,5,7,10,12,12,10,7,5,3,0]; const base = 220;
  let nextBeat = 0, beatN = 0, nextMel = 0, melN = 0;
  function tick(pos){ // schedule ahead of trackpos
    // suspended context (no user gesture yet): fast-forward counters, don't schedule
    if(ac.state !== "running"){ nextBeat = nextMel = Math.max(pos + 0.1, nextBeat); return; }
    const now = ac.currentTime, horizon = pos + 0.25;
    while(nextBeat < horizon){
      const dt = nextBeat - pos; if(dt < -0.05){ nextBeat += spb; beatN++; continue; }
      const t = Math.max(now, now + dt);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "square"; o.frequency.value = beatN % 4 == 0 ? 110 : 165;
      g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t+0.09);
      o.connect(g); g.connect(master); o.start(t); o.stop(t+0.1);
      nextBeat += spb; beatN++;
    }
    while(nextMel < horizon){
      const dt = nextMel - pos; if(dt < -0.05){ nextMel += spb/2; melN++; continue; }
      const t = Math.max(now, now + dt);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "triangle";
      o.frequency.value = base * Math.pow(2, scale[melN % scale.length]/12) * 2;
      g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t+spb*0.45);
      o.connect(g); g.connect(melGain); o.start(t); o.stop(t+spb*0.5);
      nextMel += spb/2; melN++;
    }
  }
  return { tick, setMelody(on){ melGain.gain.linearRampToValueAtTime(on?0.9:0, ac.currentTime+0.03); },
           resume(){ ac.resume(); } };
}

/* ---------- flow ---------- */
const RANK_NAMES = ["Z","C","B","A","S","T"];
const RANK_COLS  = ["#666","#9ADCFF","#7CFF9A","#FFED72","#FF9A3D","#FF5AD0"];

async function start(sid, vs){
  stopPreview(); selSid = null;
  const s = SONGS[sid];
  G.song = s; G.sid = sid;
  G.devPlay = !!(vs && vs.chart);
  const chart = (vs && vs.chart) || (CHARTS[sid] && CHARTS[sid].lead ? CHARTS[sid].lead : []);
  // dynamic solo (song 0): only the main section loads now; the chosen solo
  // + finale are merged in at decision time, like scr_rhythmgame_notechart_lead_solo
  let noteSrc = chart;
  G.solo = null;
  if(chart.dynamic){
    noteSrc = chart.main;
    G.solo = {con:0, diff:-1, ts:s.ts, solo:chart.solo, finale:chart.finale, tAudioNext:null};
  }
  G.notes = noteSrc.map(n => ({t:n[0], lane:n[1], end:n[2], anim:n[3], alive:true, score:0}));
  G.fameMul = 80 / Math.max(1, G.notes.length);   // orig: fame_mul = 80/maxnote
  // side boards (drums x=170 / vocals x=470 in the original 640-wide room):
  // auto-played visual accompaniment; flat [t,lane,end,anim] lists
  G.side = null;
  {
    const mk = raw => raw && raw.length ? {notes: raw.map(a => ({t:a[0], lane:a[1], end:a[2]})),
                                           min:0, hitT:[0,0,0], holds:[]} : null;
    const d = mk(CHARTS[sid] && CHARTS[sid].drums), v = mk(CHARTS[sid] && CHARTS[sid].vocals);
    if(d || v) G.side = {drums:d, vocals:v};
  }
  // chart event lines (BPM/TS/NS) — each instrument file may carry its own;
  // beat grid uses lead's tempo map, scroll speed is per-board
  const EV = CHARTS[sid].events || {};
  G.evNs  = (EV.lead   && EV.lead.ns)   || null;
  G.evNsD = (EV.drums  && EV.drums.ns)  || null;
  G.evNsV = (EV.vocals && EV.vocals.ns) || null;
  G.grid = buildGrid(s, EV.lead || {});
  G.trackpos = s.trackstart;
  G.minnote = 0; G.combo = 0; G.maxCombo = 0; G.points = 0;
  G.great = 0; G.good = 0; G.miss = 0; G.fame = FAME0; G.totalFame = FAME0;
  G.lastJudge = ""; G.judgeT = 0; G.pressedT = [9,9]; G.buffer = [0,0]; G.invc = 0;
  G.hold = [{on:false},{on:false}]; G.laneHeld = [false,false];
  G.lyric = ""; G.lyricIdx = 0;
  G.errs = []; G.errSum = 0; G.lastErr = 0; G.newOffset = null;
  G.log = [];                       // input record for versus verification
  // tr1=backing, tr2=full mix / guitar stem. Decoded as buffers for sample-accurate sync.
  // Decode BEFORE the clock starts so trackpos never jumps back.
  G.mode = "loading";
  try{ history.pushState({rg:1}, ""); }catch(e){}   // back button -> popstate -> openMenu
  $("loadmsg").textContent = "LOADING...";
  G.bufA = await loadBuf(s.tr2);
  G.bufB = s.tr1 !== s.tr2 ? await loadBuf(s.tr1) : null;
  if(G.mode === "menu"){ $("loadmsg").textContent = ""; return; }  // backed out during load
  G.mode = "play";
  $("menuBtn").classList.remove("hidden");
  $("loadmsg").textContent = "";
  if(typeof NET !== "undefined" && NET.on) NET.state = "playing";
  // versus: both sides anchor trackpos to a shared future instant (negative lead-in)
  G.t0 = ((vs && vs.at) || performance.now()) / 1000 - s.trackstart;
  G.audioStarted = false; G.srcA = null; G.srcB = null; G.srcs = [];
  if(G.bufA){
    actx().resume();
    const ac = actx();
    G.gainA = ac.createGain(); G.gainA.connect(ac.destination);
    G.gainB = G.bufB ? ac.createGain() : null;
    if(G.gainB) G.gainB.connect(ac.destination);
    // initial mix: oaat -> tr2 only; layered -> both on
    G.gainA.gain.value = 1;
    if(G.gainB) G.gainB.gain.value = (s.oaat === false) ? 1 : 0;
  } else {
    G.synth = makeSynth(s.bpm); G.synth.resume();
  }
  $("menu").classList.add("hidden"); $("result").classList.add("hidden");
}

function setGain(g, v){ // near-instant but click-free (mus_volume(_, _, 0) equivalent)
  if(g) g.gain.setTargetAtTime(v, actx().currentTime, 0.008);
}
function mixPlay(){ // hit -> tr2 on; tr1 on only for layered mode (song2)
  if(!G.gainA) return;
  setGain(G.gainA, 1);
  setGain(G.gainB, (G.song.oaat === false) ? 1 : 0);
}
function mixMiss(){ // miss -> tr1 on, tr2 off (same in both modes)
  if(!G.gainA) return;
  setGain(G.gainA, 0);
  setGain(G.gainB, 1);
}

// spawn a synced stem pair on the shared gains; sample-aligned with `off` at `at`
function startPair(off, at){
  const ac = actx();
  const a = ac.createBufferSource(); a.buffer = G.bufA; a.connect(G.gainA); a.start(at, off);
  G.srcs.push(a);
  let b = null;
  if(G.bufB){ b = ac.createBufferSource(); b.buffer = G.bufB; b.connect(G.gainB); b.start(at, off); G.srcs.push(b); }
  return [a, b];
}

function stopAudio(){
  for(const src of G.srcs){ try{ src.stop(); }catch(e){} }
  G.srcs = []; G.srcA = G.srcB = null; G.audioStarted = false;
}

function saveOffset(){
  try{ localStorage.setItem("rhythm_offset", String(G.offset)); }catch(e){}
}

function end(fail){
  G.mode = fail ? "fail" : "done";
  $("menuBtn").classList.add("hidden");
  $("opp") && $("opp").classList.add("hidden");
  stopAudio();
  const s = G.song;
  // tutorial = calibration song: apply mean hit error to the offset
  if(!fail && G.sid === "3" && G.errs.length >= 5){
    const mean = G.errSum / G.errs.length;              // acc = n.t - tpJudge (late -> negative)
    G.offset = Math.round((G.offset - mean) * 1000) / 1000;
    G.newOffset = G.offset;
    saveOffset();
  }
  if(NET.on){   // versus: swap the solo result screen for the scoreboard once both report
    $("rank").textContent = "…"; $("rank").style.color = "#888";
    $("result").classList.remove("hidden");
    netFinish(fail);
    return;
  }
  if(G.sid === "3"){
    // calibration: no rank/score — just hit stats and the applied offset
    $("rank").textContent = fail ? "중단됨" : "CALIBRATION";
    $("rank").style.color = "#9ADCFF";
    $("rSong").textContent = "OFFSET CALIBRATION";
    const mean = G.errs.length ? Math.round(G.errSum / G.errs.length * 1000) : 0;
    $("rStats").innerHTML =
      `GREAT ${G.great} · GOOD ${G.good} · MISS ${G.miss}<br>`+
      `평균 오차 ${mean}ms`+
      (G.newOffset != null ? `<br>OFFSET 적용: ${Math.round(G.newOffset*1000)}ms`
                           : (G.errs.length < 5 ? "<br>히트 수 부족 — 오프셋 미적용" : ""));
    $("result").classList.remove("hidden");
    return;
  }
  const th = s.rank, p = G.points;
  const rank = fail ? 0 : (p >= th[4] ? 5 : th.findIndex(x => p < x));
  if(!fail && !G.devPlay){          // best rank shown on the song door (localStorage)
    try{
      const k = "rhythm_best_" + G.sid;
      const prev = JSON.parse(localStorage.getItem(k) || "null");
      if(!prev || G.points > prev.p) localStorage.setItem(k, JSON.stringify({p: G.points, rank}));
    }catch(e){}
  }
  $("rank").textContent = RANK_NAMES[rank] + "-RANK";
  $("rank").style.color = RANK_COLS[rank];
  $("rSong").textContent = s.name.toUpperCase();
  $("rStats").innerHTML =
    `SCORE ${G.points}<br>GREAT ${G.great} · GOOD ${G.good} · MISS ${G.miss}<br>`+
    `MAX COMBO ${G.maxCombo}${fail ? "<br>— SONG FAILED —" : ""}`;
  $("result").classList.remove("hidden");
}

/* ---------- input ---------- */
function press(l){
  if(G.mode !== "play") return;
  if(G.buffer[l] > 0) return;   // 2-frame input debounce (orig buffer[i]=2)
  G.pressedT[l] = 0; G.laneHeld[l] = true;
  G.buffer[l] = (G.avgdt || 1/60) * 2;
  if(G.log) G.log.push([+G.trackpos.toFixed(4), l, 1]);
}
function release(l){
  G.laneHeld[l] = false;
  if(G.log && G.mode === "play") G.log.push([+G.trackpos.toFixed(4), l, 0]);
}

function openMenu(){
  $("menu").classList.remove("hidden"); $("result").classList.add("hidden");
  $("menuBtn").classList.add("hidden");
  if(typeof NET !== "undefined" && NET.on) netLeave();
  $("opp") && $("opp").classList.add("hidden");
  $("retry") && $("retry").classList.remove("hidden");
  G.mode = "menu"; stopAudio(); if(G.synth) G.synth.setMelody(0);
  if(_rebuildStrip) _rebuildStrip();   // refresh rank badges earned during play
}
// mobile back button: entering play pushes a history entry; back = menu (not page exit)
addEventListener("popstate", () => {
  if(G.mode === "play" || G.mode === "loading" || G.mode === "done") openMenu();
});

addEventListener("keydown", e => {
  if(e.repeat) return;
  const k = e.key.toLowerCase();
  if(k === "arrowleft" || k === "z" || k === "d" || k === "f") press(0);
  else if(k === "arrowright" || k === "x" || k === "k" || k === "j") press(1);
  else if(k === "-" || k === "_"){ G.offset = Math.round((G.offset - 0.01)*1000)/1000; saveOffset(); }
  else if(k === "=" || k === "+"){ G.offset = Math.round((G.offset + 0.01)*1000)/1000; saveOffset(); }
  else if(k === "escape") openMenu();
});
addEventListener("keyup", e => {
  const k = e.key.toLowerCase();
  if(k === "arrowleft" || k === "z" || k === "d" || k === "f") release(0);
  if(k === "arrowright" || k === "x" || k === "k" || k === "j") release(1);
});

const laneAt = x => { const r = cv.getBoundingClientRect(); return (x - r.left) / r.width < 0.5 ? 0 : 1; };
cv.addEventListener("pointerdown", e => { press(laneAt(e.clientX)); cv.setPointerCapture(e.pointerId); });
cv.addEventListener("pointerup",   e => release(laneAt(e.clientX)));
cv.addEventListener("pointercancel", e => release(laneAt(e.clientX)));
// autoplay policy: dev test-play navigates without a user gesture, leaving the
// AudioContext suspended — resume it on the first real input anywhere
const resumeAudio = () => { if(G.ac && G.ac.state !== "running") G.ac.resume(); };
document.addEventListener("pointerdown", resumeAudio);
document.addEventListener("keydown", resumeAudio);

/* ---------- per-frame update (ported from Step_0) ---------- */
function update(dt){
  const s = G.song;
  // clock: negative lead-in on perf clock; audio starts when trackpos crosses 0
  // (AudioContext clock is sample-accurate; both stems start on the same tick)
  if(G.bufA && G.audioStarted)
    G.trackpos = actx().currentTime - G.tAudio;
  else
    G.trackpos = performance.now()/1000 - G.t0;
  if(G.bufA && !G.audioStarted && G.trackpos >= 0 && actx().state === "running"){
    const ac = actx(), at = ac.currentTime + 0.02;
    const off = Math.max(0, G.trackpos);               // resume mid-song if needed
    [G.srcA, G.srcB] = startPair(off, at);
    G.tAudio = at - off; G.audioStarted = true;
  }
  // adopt scheduled section-swap: the new stem starts at offset `to` exactly at
  // ac-time `at`, so the virtual anchor (tAudio) just moves — no gap, no phase drift
  const so = G.solo;
  if(so && so.tAudioNext && actx().currentTime >= so.tAudioNext.at){
    G.tAudio = so.tAudioNext.tAudio; so.tAudioNext = null;
  }

  const tp = G.trackpos;

  // ---- dynamic solo state machine (song 0; Step_0 solo_con port) ----
  // con0->1: at ts[0]-2 pick difficulty by fame, schedule swap to solo stems
  // con1->2: at ts[0] the swap lands; trackpos continues at ts[diff]
  // con2->3: at ts[diff+1]-2 schedule swap back to main stems at ts[3]
  // con3->4: at ts[diff+1] the swap lands; trackpos continues at ts[3]
  if(so){
    if(so.con === 0 && tp >= so.ts[0] - 2){
      so.diff = G.fame >= 10000 ? 2 : G.fame >= 6000 ? 1 : 0;
      const extra = so.solo[so.diff].concat(so.finale)
        .map(n => ({t:n[0], lane:n[1], end:n[2], anim:n[3], alive:true, score:0}));
      G.notes = G.notes.concat(extra).sort((a,b) => a.t - b.t);
      G.fameMul = 80 / G.notes.length;   // recalc on merged chart (orig: 80/maxnote)
      if(G.bufA && G.audioStarted){
        const tS = actx().currentTime + (so.ts[0] - tp);
        const oldA = G.srcA, oldB = G.srcB;
        [G.srcA, G.srcB] = startPair(so.ts[so.diff], tS);
        try{ oldA && oldA.stop(tS); oldB && oldB.stop(tS); }catch(e){}
        so.tAudioNext = {at: tS, tAudio: tS - so.ts[so.diff]};
      }
      so.flash = 3; so.con = 1;
    }
    else if(so.con === 1 && tp >= so.ts[0]){
      if(!G.bufA) G.t0 -= (so.ts[so.diff] - so.ts[0]);    // synth path: jump the perf clock
      so.con = 2;
    }
    else if(so.con === 2 && tp >= so.ts[so.diff + 1] - 2){
      if(G.bufA && G.audioStarted){
        const tM = actx().currentTime + (so.ts[so.diff + 1] - tp);
        const oldA = G.srcA, oldB = G.srcB;
        [G.srcA, G.srcB] = startPair(so.ts[3], tM);
        try{ oldA && oldA.stop(tM); oldB && oldB.stop(tM); }catch(e){}
        so.tAudioNext = {at: tM, tAudio: tM - so.ts[3]};
      }
      so.con = 3;
    }
    else if(so.con === 3 && tp >= so.ts[so.diff + 1]){
      if(!G.bufA) G.t0 -= (so.ts[3] - so.ts[so.diff + 1]);
      so.con = 4;
    }
    if(so.flash > 0) so.flash -= dt;
  }
  // original ran at fixed room_speed=30 -> atu = one 1/30s frame.
  // fixed value (not measured dt) so judgment is identical at any refresh rate
  const avgdt = 1/30;
  G.avgdt = avgdt;
  G.greatWin = avgdt * 1.6;   // ±53.3ms
  // judged position: notes hit the line when the player HEARS them ->
  // shift the hit clock by output latency + manual calibration
  const lat = (G.ac ? (G.ac.outputLatency||0) + (G.ac.baseLatency||0) : 0) + G.offset;
  G.lat = lat;
  const tpJudge = tp - lat;
  if(G.synth){ G.synth.tick(tp); G.synth.setMelody(G.combo > 0); }

  G.pressedT[0] += dt; G.pressedT[1] += dt;
  G.buffer[0] -= dt; G.buffer[1] -= dt;
  if(G.invc > 0) G.invc -= dt;

  // collect notes in window from minnote
  const target = []; let idx = G.minnote;
  while(idx < G.notes.length){
    const d = G.notes[idx].t - tpJudge;
    if(Math.abs(d) <= HIT_WINDOW && G.notes[idx].alive) target.push(idx++);
    else if(d > HIT_WINDOW) break;
    else idx++; // passed but not yet drawn-dead; draw pass marks miss
  }

  // lyrics
  const L = LYRICS[G.sid];
  if(L){ while(G.lyricIdx < L.length && tpJudge > L[G.lyricIdx].t){ G.lyric = L[G.lyricIdx].x; G.lyricIdx++; } }

  for(let i = 0; i < 2; i++){
    // hold release / completion
    const h = G.hold[i];
    if(h.on){
      if(h.end < tpJudge || !G.laneHeld[i]){
        const holdpos = (tpJudge >= h.end - avgdt*3) ? Math.max(h.end, tpJudge) : tpJudge;
        const ns = 60/s.bpm, span = ns*4;
        let chain = Math.floor(((Math.min(h.end, holdpos) - h.start)/span)*4)*10;
        if(holdpos >= h.end) chain *= 2;   // completed hold -> score_scale=4, x2
        else mixMiss();                    // early release drops melody stem (orig: tr2->0)
        G.points += chain;
        G.fame = Math.min(FAME_MAX, G.fame + chain*G.fameMul);
        G.totalFame += chain*G.fameMul;
        h.on = false;
        G.maxCombo = Math.max(G.combo, G.maxCombo);
      }
    }

    // press -> judge first alive matching-lane note in window
    // press stays armed for 3 frames (orig pressedtimer <= room_speed/10)
    if(G.pressedT[i] <= avgdt*3){
      for(const ni of target){
        const n = G.notes[ni];
        if(n.lane !== i || !n.alive) continue;
        const acc = n.t - tpJudge;
        G.errs.push(acc); G.errSum += acc; G.lastErr = acc;
        const score = Math.abs(acc) < avgdt*1.6 ? 100 : 50;
        n.alive = false; n.score = score;
        G.points += score;
        // fame gain scaled by fame_mul = 80/maxnote (orig: fame += _famegain * fame_mul)
        G.fame = Math.min(FAME_MAX, G.fame + (score >= 100 ? 100 : (G.fame < 5950 ? 60 : 50)) * G.fameMul);
        G.totalFame += (score >= 100 ? 100 : (G.fame < 5950 ? 60 : 50)) * G.fameMul;
        if(score >= 100){ G.great++; G.lastJudge = "GREAT"; }
        else { G.good++; G.lastJudge = "GOOD"; }
        G.combo++; G.maxCombo = Math.max(G.combo, G.maxCombo);
        G.judgeT = 0.8; G.lastLaneHit[i] = 6/60;
        mixPlay();
        if(n.end > 0){ G.hold[i] = {start:n.t, end:n.end, on:true}; }
        G.pressedT[i] = avgdt*3 + 0.001;   // consume press
        break;
      }
    }
  }

  // misses: notes that passed below the window while alive
  while(G.minnote < G.notes.length && G.notes[G.minnote].t < tpJudge - 0.12){
    const n = G.notes[G.minnote];
    if(n.alive && n.score <= 0){
      // orig (obj_rhythmgame_Draw_0 missnotecon consumer):
      //   combo break + melody drop on EVERY miss (even during invc)
      //   fame penalty only when invc<=0: (fame<=2000?100:200)*difficulty(1)*fame_mul
      //   then invc=60 frames (2s penalty immunity); fame<0 -> lose
      n.alive = false; G.miss++; G.combo = 0;
      G.lastJudge = "MISS"; G.judgeT = 0.8;
      if(G.synth) G.synth.setMelody(0);
      mixMiss();
      if(G.invc <= 0){
        const pen = (G.fame <= 2000 ? 100 : 200) * G.fameMul;
        G.fame -= pen; G.totalFame -= pen;
        G.invc = 2;
        if(G.fame < 0 && G.sid !== "3"){ G.fame = 0; end(true); return; }
        if(G.fame < 0) G.fame = 0;
      }
    }
    G.minnote++;
  }

  if(typeof NET !== "undefined" && NET.on) netSnapTick();
  if(tp >= s.length) end(false);
}

/* ---------- draw ---------- */
const CX = W/2, BOTTOM_Y = H - 130;
const LANE_W = 40;               // game units: lanes at cx±20 in 80px panel -> scaled x2
const laneX = i => CX + (i === 0 ? -LANE_W : LANE_W);

function rrect(x, y, w, h, r){
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Beat-grid table for BPM/TS event segments (draw_backing's per-segment
// _posoffset logic, precomputed): each segment anchors beats at its start
// time, bars every `signature` beats within the segment.
function buildGrid(s, ev){
  const bpmEv = ev.bpm || [], tsEv = ev.ts || [];
  const cuts = [...new Set([0, ...bpmEv.map(e=>e[0]), ...tsEv.map(e=>e[0])])].sort((a,b)=>a-b);
  const grid = [];
  let bpm = s.bpm, sig = 4;
  const tEnd = s.length + 10;
  for(let i = 0; i < cuts.length; i++){
    const t0 = cuts[i], t1 = i+1 < cuts.length ? cuts[i+1] : tEnd;
    for(const [t,v] of bpmEv) if(Math.abs(t - t0) < 1e-9) bpm = v;
    for(const [t,v] of tsEv)  if(Math.abs(t - t0) < 1e-9) sig = v;
    const spb = 60/bpm;
    for(let k = Math.floor((Math.min(0, s.trackstart) - 4*spb - t0)/spb); t0 + k*spb < t1; k++){
      grid.push({t: t0 + k*spb, bar: ((k % sig) + sig) % sig === 0});
    }
  }
  return grid.sort((a,b)=>a.t-b.t);
}
// current scroll speed: NS events rescale the whole field instantly,
// same as the original (notey uses the live notespeed each frame)
function speedAt(ev, tp, dflt){
  let v = dflt;
  if(ev) for(const [t, s] of ev){ if(tp >= t) v = s; else break; }
  return v;
}

// scr_rhythmgame_noteskip port: shift note times across a pending/done section
// jump so the chart scrolls continuously instead of vanishing / teleporting.
function noteskip(t, tp){
  const so = G.solo;
  if(!so || so.diff < 0) return t;
  const ts = so.ts;
  if(so.diff < 2){
    const skip = ts[3] - ts[so.diff + 1], sd = ts[so.diff + 1];
    if(tp <= sd && t >= ts[3]) return t - skip;
    if(tp >= ts[3] && t <= sd) return t + skip;
  }
  if(so.diff > 0){
    const skip = ts[so.diff] - ts[0], sd = ts[so.diff];
    if(tp <= ts[0] && t >= sd) return t - skip;
    if(tp >= sd && t <= ts[0]) return t + skip;
  }
  return t;
}

// side board centers: original 640-wide room has drums=170 / vocals=470
const SIDE_OFF = 175, SIDE_HALF = 42;
const SIDE_COLORS = ["#01EA9E", "#17EEFF", "#FF9A3D"];   // drums lanes 0/1, vocals 0/1/2
const sideLaneX = (cx, kind, l) =>
  kind === "vocals" ? cx + (l - 1) * 30 : cx + (l ? 20 : -20);

function drawSide(cx, kind, tr, tpDraw, ns){
  const half = SIDE_HALF;
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(cx-half, BOTTOM_Y-400, half*2, 450);
  for(const gl of G.grid){
    const y = BOTTOM_Y - (gl.t - tpDraw)*ns;
    if(y < BOTTOM_Y-400) break;
    if(y > BOTTOM_Y+50) continue;
    ctx.fillStyle = gl.bar ? "#777" : "#3a3a3a";
    ctx.fillRect(cx-half, y-1, half*2, gl.bar ? 2 : 1);
  }
  ctx.strokeStyle = "#17EEFF"; ctx.lineWidth = 2;
  ctx.strokeRect(cx-half, BOTTOM_Y-400, half*2, 450);

  // auto-play: consume notes as their raw time passes the line
  while(tr.min < tr.notes.length && tr.notes[tr.min].t < tpDraw - 0.12){
    const n = tr.notes[tr.min++];
    tr.hitT[Math.min(n.lane, 2)] = 0.18;
    if(n.end > n.t) tr.holds.push(n);
  }
  tr.holds = tr.holds.filter(n => n.end > tpDraw);

  // receptors
  if(kind === "drums"){
    for(let i = 0; i < 2; i++){
      const x = sideLaneX(cx, kind, i), hit = tr.hitT[i] > 0;
      ctx.strokeStyle = hit ? "#FFED72" : SIDE_COLORS[i];
      ctx.lineWidth = hit ? 3 : 2;
      rrect(x-19, BOTTOM_Y-9, 38, 18, 6); ctx.stroke();
      if(hit){ ctx.fillStyle = "rgba(255,237,114,0.3)"; rrect(x-19, BOTTOM_Y-9, 38, 18, 6); ctx.fill(); }
    }
    if(tr.hitT[2] > 0){   // kick hit flashes the whole board line
      ctx.fillStyle = "rgba(255,154,61,0.35)";
      ctx.fillRect(cx-half, BOTTOM_Y-10, half*2, 20);
    }
  } else {
    ctx.fillStyle = "#000"; ctx.fillRect(cx-half+2, BOTTOM_Y-4, half*2-4, 8);
    ctx.fillStyle = "#FF9A3D"; ctx.fillRect(cx-half+2, BOTTOM_Y-2, half*2-4, 4);
    for(let i = 0; i < 3; i++) if(tr.hitT[i] > 0){
      ctx.fillStyle = "rgba(255,237,114,0.85)";
      const x = sideLaneX(cx, kind, i);
      rrect(x-11, BOTTOM_Y-8, 22, 16, 5); ctx.fill();
    }
  }
  for(let i = 0; i < 3; i++) if(tr.hitT[i] > 0) tr.hitT[i] -= 1/60;

  ctx.save();
  ctx.beginPath(); ctx.rect(cx-half, BOTTOM_Y-400, half*2, 450); ctx.clip();
  const drawSideNote = (n, y) => {
    const l = Math.min(n.lane, 2);
    ctx.fillStyle = SIDE_COLORS[l];
    if(kind === "drums"){
      if(l === 2){ ctx.fillRect(cx-half+3, y-3, half*2-6, 6); return; } // kick bar
      const x = sideLaneX(cx, kind, l);
      rrect(x-19, y-6, 38, 12, 6); ctx.fill();
    } else {
      const x = sideLaneX(cx, kind, l);
      if(n.end > n.t){ rrect(x-11, y-6, 22, 12, 6); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI*2); ctx.fill(); } // clap
    }
  };
  for(let i = tr.min; i < tr.notes.length; i++){
    const n = tr.notes[i];
    const y = BOTTOM_Y - (noteskip(n.t, tpDraw) - tpDraw)*ns;
    if(y < BOTTOM_Y-430) break;
    if(y > BOTTOM_Y+70) continue;
    if(n.end > n.t){
      const yEnd = BOTTOM_Y - (noteskip(n.end, tpDraw) - tpDraw)*ns;
      const x = sideLaneX(cx, kind, Math.min(n.lane, 2));
      ctx.fillStyle = "#e8a000";
      ctx.fillRect(x-4, yEnd, 8, y - yEnd);
      ctx.fillStyle = "#FFED72";
      rrect(x-11, yEnd-5, 22, 10, 5); ctx.fill();
    }
    drawSideNote(n, y);
  }
  for(const n of tr.holds){
    const yEnd = BOTTOM_Y - (noteskip(n.end, tpDraw) - tpDraw)*ns;
    const x = sideLaneX(cx, kind, Math.min(n.lane, 2));
    ctx.fillStyle = "#FFED72";
    ctx.fillRect(x-4, yEnd, 8, BOTTOM_Y - yEnd);
    rrect(x-11, yEnd-5, 22, 10, 5); ctx.fill();
  }
  ctx.restore();
}

function draw(){
  ctx.fillStyle = "#06060c"; ctx.fillRect(0,0,W,H);
  // stage backdrop tint by fame
  const f = G.fame / FAME_MAX;
  ctx.fillStyle = `rgba(${20+f*30|0},${10+f*20|0},${40+f*60|0},1)`;
  ctx.fillRect(0,0,W,H*0.55);

  if(G.mode === "play" || G.mode === "done" || G.mode === "fail"){
    const s = G.song;
    const tpDraw = G.trackpos - G.lat;   // notes line up with what you HEAR
    const ns = speedAt(G.evNs, tpDraw, s.notespeed);
    const so = G.solo;

    // --- backing: beat grid (draw_backing port) ---
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(CX-80, BOTTOM_Y-400, 160, 450);
    for(const gl of G.grid){
      const y = BOTTOM_Y - (gl.t - tpDraw)*ns;
      if(y < BOTTOM_Y-400) break;
      if(y > BOTTOM_Y+50) continue;
      ctx.fillStyle = gl.bar ? "#777" : "#3a3a3a";
      ctx.fillRect(CX-80, y-1, 160, gl.bar ? 2 : 1);
    }
    // panel border (cyan like in-game)
    ctx.strokeStyle = "#17EEFF"; ctx.lineWidth = 2;
    ctx.strokeRect(CX-80, BOTTOM_Y-400, 160, 450);

    // --- note receptors: outlined rounded rects at hit line (in-game look) ---
    const rb = s.rainbow != null && tpDraw >= s.rainbow;   // rainbow_mode event
    for(let i = 0; i < 2; i++){
      const x = laneX(i), hit = G.lastLaneHit[i] > 0;
      ctx.strokeStyle = hit ? "#FFED72" : (rb ? rainbowCol(i, tpDraw) : NOTE_COLORS[i]);
      ctx.lineWidth = hit ? 3 : 2;
      rrect(x-30, BOTTOM_Y-10, 60, 20, 6); ctx.stroke();
      if(hit){
        ctx.fillStyle = "rgba(255,237,114,0.25)";
        rrect(x-30, BOTTOM_Y-10, 60, 20, 6); ctx.fill();
      }
      if(G.lastLaneHit[i] > 0) G.lastLaneHit[i] -= 1/60;
    }

    // --- side boards (auto-played, like obj_rhythmgame_chart instances) ---
    if(G.side){
      if(G.side.drums)  drawSide(CX - SIDE_OFF, "drums",  G.side.drums,  tpDraw, speedAt(G.evNsD, tpDraw, s.notespeed));
      if(G.side.vocals) drawSide(CX + SIDE_OFF, "vocals", G.side.vocals, tpDraw, speedAt(G.evNsV, tpDraw, s.notespeed));
    }

    // --- notes (clipped to panel) ---
    ctx.save();
    ctx.beginPath(); ctx.rect(CX-80, BOTTOM_Y-400, 160, 450); ctx.clip();
    for(let i = Math.max(0, G.minnote-4); i < G.notes.length; i++){
      const n = G.notes[i];
      const dt0 = noteskip(n.t, tpDraw);
      const y = BOTTOM_Y - (dt0 - tpDraw)*ns;
      if(y < BOTTOM_Y-430) break;
      if(y > BOTTOM_Y+70) continue;
      const x = laneX(n.lane);
      if(n.end > 0 && n.alive){
        const yEnd = BOTTOM_Y - (noteskip(n.end, tpDraw) - tpDraw)*ns;
        ctx.fillStyle = "#e8a000";                       // hold bar
        ctx.fillRect(x-5, yEnd, 10, y - yEnd);
        ctx.fillStyle = "#FFED72";                        // end cap
        rrect(x-30, yEnd-6, 60, 12, 6); ctx.fill();
      }
      if(!n.alive && n.score > 0) continue;
      let col = n.alive ? NOTE_COLORS[n.lane] : "#555";
      if(n.score >= 100) col = "#FFED72";
      else if(n.score >= 30 && !n.alive) col = "#e8a000";
      ctx.fillStyle = col;
      // in-game note = horizontal rounded bar
      rrect(x-32, y-7, 64, 14, 7); ctx.fill();
    }
    // active hold bars anchored to hit line
    for(let i = 0; i < 2; i++){
      const h = G.hold[i];
      if(h.on && h.end > tpDraw){
        const x = laneX(i);
        const yEnd = BOTTOM_Y - (noteskip(h.end, tpDraw) - tpDraw)*ns;
        ctx.fillStyle = "#FFED72";
        ctx.fillRect(x-5, yEnd, 10, BOTTOM_Y - yEnd);
        rrect(x-30, yEnd-6, 60, 12, 6); ctx.fill();
        rrect(x-32, BOTTOM_Y-7, 64, 14, 7); ctx.fill();
      }
    }
    ctx.restore();

    // HUD (score hidden on the calibration song)
    ctx.fillStyle = rb ? rainbowCol(3, tpDraw) : "#fff";
    ctx.font = "32px DRText, monospace"; ctx.textAlign = "left";
    if(G.sid !== "3") ctx.fillText("SCORE " + G.points, 16, 38);
    if(G.combo > 1){
      ctx.font = "bold 60px DRText, monospace"; ctx.textAlign = "center";
      ctx.fillStyle = rb ? rainbowCol(4, tpDraw) : "#ccc";
      ctx.fillText(G.combo, CX, BOTTOM_Y-310);
      ctx.font = "24px DRText, monospace"; ctx.fillText("COMBO", CX, BOTTOM_Y-282);
    }
    // fame meter
    ctx.fillStyle = "#222"; ctx.fillRect(16, 52, 140, 12);
    ctx.fillStyle = rb ? rainbowCol(2, tpDraw)
                     : (G.fame > 4000 ? "#01EA9E" : (G.fame > 2000 ? "#FFED72" : "#FF5A5A"));
    ctx.fillRect(16, 52, 140 * (G.fame / FAME_MAX), 12);
    ctx.strokeStyle = "#555"; ctx.strokeRect(16, 52, 140, 12);
    ctx.fillStyle = "#888"; ctx.font = "20px DRText, monospace"; ctx.textAlign = "left";
    ctx.fillText("FAME", 16, 88);
    ctx.fillText(`OFFSET ${Math.round(G.lat*1000)}ms  (- / = 조정)`, 16, 114);
    ctx.fillText(`GREAT 윈도우 ±${Math.round(G.greatWin*1000)}ms`, 16, 140);

    // dynamic solo indicator (song 0): chosen difficulty flashes, stays while in solo
    if(so && so.diff >= 0 && (so.flash > 0 || (so.con >= 1 && so.con <= 3))){
      const names = ["EASY", "NORMAL", "HARD"], cols = ["#7CFF9A", "#FFED72", "#FF5A5A"];
      ctx.font = "bold 36px DRText, monospace"; ctx.textAlign = "center";
      ctx.fillStyle = cols[so.diff];
      ctx.fillText("SOLO: " + names[so.diff], CX, 64);
    }

    // judge popup (+ hit error in ms)
    if(G.judgeT > 0){
      G.judgeT -= 1/60;
      ctx.font = "bold 44px DRText, monospace"; ctx.textAlign = "center";
      ctx.fillStyle = G.lastJudge === "GREAT" ? "#FFED72" : G.lastJudge === "GOOD" ? "#FF9A3D" : "#FF5A5A";
      ctx.fillText(G.lastJudge, CX, BOTTOM_Y-450);
      if(G.lastJudge !== "MISS"){
        const ms = Math.round(G.lastErr * 1000);
        ctx.font = "24px DRText, monospace"; ctx.fillStyle = "#bbb";
        ctx.fillText(`${ms > 0 ? "+" : ""}${ms}ms ${ms > 0 ? "빠름" : "늦음"}`, CX, BOTTOM_Y-418);
      }
    }
    // calibration mode (tutorial): running mean error
    if(G.sid === "3" && G.errs.length){
      const m = Math.round(G.errSum / G.errs.length * 1000);
      ctx.font = "20px DRText, monospace"; ctx.textAlign = "right"; ctx.fillStyle = "#9ADCFF";
      ctx.fillText(`CALIBRATION · 평균 오차 ${m}ms`, W-16, 36);
      ctx.textAlign = "left";
    }
    // lyric (karaoke song)
    if(G.lyric){
      ctx.font = "32px DRText, monospace"; ctx.textAlign = "center"; ctx.fillStyle = "#9ADCFF";
      ctx.fillText(G.lyric.replace(/\[\d+:?[^\]]*\]/g,""), CX, H - 30);
    }
    if(G.trackpos < 0){
      ctx.fillStyle = "#888"; ctx.font = "26px DRText, monospace"; ctx.textAlign = "center";
      ctx.fillText("READY...", CX, BOTTOM_Y + 30);
    }
    if(G.ac && G.ac.state !== "running"){
      ctx.fillStyle = "#FF9A3D"; ctx.font = "20px DRText, monospace"; ctx.textAlign = "right";
      ctx.fillText("AUDIO OFF — 아무 입력이나 하면 소리 켜짐", W-16, H-16);
    }
  }
}

/* ---------- loop ---------- */
let last = performance.now();
function frame(now){
  const dt = Math.min(0.1, (now - last)/1000); last = now;
  if(G.mode === "play") update(dt);
  draw();
  requestAnimationFrame(frame);
}

/* ---------- song preview: fusionmenu-style, loops *_preview.ogg ---------- */
let previewEl = null, previewSid = null, selSid = null, _rebuildStrip = null;
const CAN_HOVER = matchMedia("(hover: hover) and (pointer: fine)").matches;
function startPreview(sid){
  const s = SONGS[sid]; if(!s || G.mode !== "menu") return;
  stopPreview();
  const el = new Audio(`audio/${s.pv || s.tr2}.ogg?v=20`);
  el.loop = true; el.volume = 0.75;
  el.play().catch(() => {});
  previewEl = el; previewSid = sid;
}
function stopPreview(){
  if(previewEl){ previewEl.pause(); previewEl.src = ""; previewEl = null; }
  previewSid = null;
}
function markSel(){
  for(const b of document.querySelectorAll("#songlist .songcard"))
    b.classList.toggle("sel", b.dataset.sid === selSid);
}
// touch: tapping outside the list clears the selection + preview
document.addEventListener("pointerdown", e => {
  if(!CAN_HOVER && selSid && !e.target.closest("#songlist .songcard")){
    selSid = null; markSel(); stopPreview();
  }
});

/* ---------- menu ---------- */
async function boot(){
  try{ G.offset = parseFloat(localStorage.getItem("rhythm_offset")) || 0; }catch(e){}
  try{ await document.fonts.load('32px DRText'); }catch(e){}
  [SONGS, CHARTS, LYRICS] = await Promise.all([
    fetch("songs.json?v=21").then(r=>r.json()),
    fetch("charts.json?v=21").then(r=>r.json()),
    fetch("lyrics.json?v=21").then(r=>r.json()).catch(()=>({})),
  ]);
  const list = $("songlist");
  // horizontal song doors, ordered like scr_rhythmgame_songlist (ord field),
  // grouped into franchise tabs (cat field, like the fusion menu albums)
  const order = Object.entries(SONGS)
    .filter(([sid]) => sid !== "3" && CHARTS[sid] && CHARTS[sid].lead)   // sid 3 = calibration tool
    .sort((a, b) => (a[1].ord ?? 999) - (b[1].ord ?? 999) || a[1].name.localeCompare(b[1].name));
  const cats = [...new Set(order.map(([, s]) => s.cat || "MISC"))];
  const tabs = document.createElement("div"); tabs.id = "cattabs";
  const strip = document.createElement("div"); strip.id = "songstrip";
  list.append(tabs, strip);
  const buildStrip = cat => {
    strip.innerHTML = "";
    for(const [sid, s] of order){
      if((s.cat || "MISC") !== cat) continue;
      const b = document.createElement("button");
      b.className = "songcard";
      const lc = CHARTS[sid].lead;
      const nNotes = lc.dynamic ? lc.main.length + lc.solo[1].length + lc.finale.length : lc.length;
      let best = null;
      try{ best = JSON.parse(localStorage.getItem("rhythm_best_" + sid)); }catch(e){}
      b.innerHTML =
        `<div class="rk" style="color:${best ? RANK_COLS[best.rank] : "#333"}">${best ? RANK_NAMES[best.rank] : "─"}</div>`+
        `<div class="nm">${s.name.toUpperCase()}</div>`+
        `<div class="mt">${s.bpm} BPM · ${nNotes}${lc.dynamic ? "~" : ""}</div>`;
      b.dataset.sid = sid;
      b.addEventListener("pointerenter", e => {
        if(e.pointerType !== "touch") startPreview(sid);
      });
      b.addEventListener("pointerleave", e => {
        if(e.pointerType !== "touch") stopPreview();
      });
      b.onclick = () => {
        // touch devices (no hover): first tap selects + previews, second tap starts
        if(!CAN_HOVER && selSid !== sid){
          selSid = sid; markSel(); startPreview(sid); return;
        }
        selSid = null; markSel(); start(sid);
      };
      strip.appendChild(b);
    }
    markSel();
  };
  let curCat = cats[0];
  for(const c of cats){
    const t = document.createElement("button");
    t.className = "cattab" + (c === cats[0] ? " sel" : "");
    t.textContent = c;
    t.onclick = () => {
      curCat = c;
      for(const x of tabs.children) x.classList.toggle("sel", x === t);
      buildStrip(c);
    };
    tabs.appendChild(t);
  }
  buildStrip(curCat);
  _rebuildStrip = () => buildStrip(curCat);
  strip.addEventListener("wheel", e => {   // vertical wheel scrolls the strip sideways
    e.preventDefault();
    strip.scrollLeft += e.deltaY + e.deltaX;
  }, {passive: false});
  $("calib").onclick = () => start("3");
  const offin = $("offin");
  offin.value = Math.round(G.offset * 1000);
  $("offset_set").onclick = () => {
    const ms = parseFloat(offin.value);
    if(!isNaN(ms)){ G.offset = Math.round(ms) / 1000; saveOffset(); }
  };
  requestAnimationFrame(t => { last = t; frame(t); });
  // dev chart test-play: editor.html stashes {sid, song, lead} and lands here via ?play=<sid>
  try{
    const raw = sessionStorage.getItem("rhythm_dev_chart");
    const want = new URLSearchParams(location.search).get("play");
    if(raw && want){
      const dev = JSON.parse(raw);
      if(dev.sid === want){
        if(dev.song && !SONGS[want]){ SONGS[want] = dev.song; CHARTS[want] = CHARTS[want] || {}; }
        if(dev.song) CHARTS[want].events = CHARTS[want].events || {};
        start(want, {chart: dev.lead});
      }
    }
  }catch(e){ console.error("[devtest] failed:", e); }
}
$("retry").onclick = () => start(G.sid);
$("back").onclick = () => { $("result").classList.add("hidden"); $("menu").classList.remove("hidden"); G.mode = "menu"; markSel(); };
$("menuBtn").onclick = openMenu;
boot();

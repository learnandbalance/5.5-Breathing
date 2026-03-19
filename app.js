const PHASE_LEN = 5.5;
const CYCLE_LEN = PHASE_LEN * 2; // 11s
const PRE_ROLL = 3.0;

const MIN_SCALE = 0.78;
const MAX_SCALE = 1.08;

let durationMin = 5;
let plannedSec = 5 * 60;

let running = false;
let rafId = null;

let audioCtx = null;
let audioReady = false;
let soundOn = true;

let master = null;
let inhaleBus = null;
let exhaleBus = null;

let t0 = 0;
let pausedElapsed = 0;
let lastPhase = "idle";

let endingMode = false;
let prevCycleIndex = 0;

let guideCyclesRemaining = 3;
let guidePrevCycleIndex = 0;

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function easeInOut(t){ return t * t * (3 - 2 * t); }

function fmtMMSS(totalSec){
  totalSec = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function setOrbScale(scale){
  document.documentElement.style.setProperty("--scale", scale.toFixed(4));
}
function setHueForPhase(phase){
  const hue = (phase === "inhale") ? "0deg" : "-60deg";
  document.documentElement.style.setProperty("--hue", hue);
}

function computeBreath(elapsed){
  const inCycle = elapsed % CYCLE_LEN;
  let phase, phaseProgress;

  if (inCycle < PHASE_LEN){
    phase = "inhale";
    phaseProgress = inCycle / PHASE_LEN;
  } else {
    phase = "exhale";
    phaseProgress = (inCycle - PHASE_LEN) / PHASE_LEN;
  }
  return { phase, phaseProgress };
}

/* ---------------- AUDIO ---------------- */
function ensureAudio(){
  if (!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  if (!audioReady){
    buildAudioGraph();
    audioReady = true;
  }
}

function buildAudioGraph(){
  const now = audioCtx.currentTime;

  master = audioCtx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.connect(audioCtx.destination);

  const delay = audioCtx.createDelay(0.35);
  delay.delayTime.value = 0.18;

  const fb = audioCtx.createGain();
  fb.gain.value = 0.18;

  const fbLP = audioCtx.createBiquadFilter();
  fbLP.type = "lowpass";
  fbLP.frequency.value = 1200;
  fbLP.Q.value = 0.7;

  delay.connect(fbLP);
  fbLP.connect(fb);
  fb.connect(delay);

  const wet = audioCtx.createGain();
  wet.gain.value = 0.22;

  delay.connect(wet);
  wet.connect(master);

  inhaleBus = createChordBus({ freqs: [220.00, 277.18, 329.63], warmth: 1400 });
  exhaleBus = createChordBus({ freqs: [293.66, 369.99, 440.00], warmth: 1700 });

  inhaleBus.out.connect(master);
  exhaleBus.out.connect(master);
  inhaleBus.out.connect(delay);
  exhaleBus.out.connect(delay);

  inhaleBus.gain.gain.setValueAtTime(0.0001, now);
  exhaleBus.gain.gain.setValueAtTime(0.0001, now);
}

function createChordBus({ freqs, warmth }){
  const now = audioCtx.currentTime;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);

  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(warmth, now);
  lp.Q.setValueAtTime(0.85, now);

  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 0.18;
  lfoGain.gain.value = 3.0;
  lfo.connect(lfoGain);

  const mix = audioCtx.createGain();
  mix.gain.value = 1.0;

  freqs.forEach((f, i) => {
    const s = audioCtx.createOscillator();
    s.type = "sine";
    s.frequency.setValueAtTime(f, now);
    s.detune.setValueAtTime((i - 1) * 1.5, now);
    lfoGain.connect(s.detune);

    const w = audioCtx.createOscillator();
    w.type = "sawtooth";
    w.frequency.setValueAtTime(f, now);
    w.detune.setValueAtTime((1 - i) * 1.0, now);
    lfoGain.connect(w.detune);

    const gS = audioCtx.createGain();
    const gW = audioCtx.createGain();
    gS.gain.value = 0.33 + (i === 1 ? 0.05 : 0.0);
    gW.gain.value = 0.05;

    s.connect(gS); w.connect(gW);
    gS.connect(mix); gW.connect(mix);

    s.start(now); w.start(now);
  });

  lfo.start(now);
  mix.connect(lp);
  lp.connect(gain);

  return { out: gain, gain };
}

function setPhaseAudio(phase){
  if (!audioReady) return;
  const now = audioCtx.currentTime;
  const FADE = 0.22;

  if (!soundOn){
    inhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.06);
    exhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.06);
    master.gain.setTargetAtTime(0.0001, now, 0.06);
    return;
  }

  master.gain.setTargetAtTime(0.22, now, 0.08);

  if (phase === "inhale"){
    inhaleBus.gain.gain.setTargetAtTime(0.22, now, FADE);
    exhaleBus.gain.gain.setTargetAtTime(0.0001, now, FADE);
  } else {
    inhaleBus.gain.gain.setTargetAtTime(0.0001, now, FADE);
    exhaleBus.gain.gain.setTargetAtTime(0.22, now, FADE);
  }
}

function stopAudioSoft(){
  if (!audioReady) return;
  const now = audioCtx.currentTime;
  inhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.07);
  exhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.07);
  master.gain.setTargetAtTime(0.0001, now, 0.09);
}

/* ---------------- APP ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  const phaseLabel = document.getElementById("phaseLabel");
  const hintLine = document.getElementById("hintLine");
  const countOverlay = document.getElementById("countOverlay");
  const cornerLabel = document.getElementById("cornerLabel");
  const countdown = document.getElementById("countdown");

  const panel = document.getElementById("sidePanel");
  const toggle = document.getElementById("panelToggle");

  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const resetBtn = document.getElementById("resetBtn");
  const soundBtn = document.getElementById("soundBtn");

  const durBtns = [...document.querySelectorAll(".durBtn")];

  function setPhaseText(text, visible=true){
    phaseLabel.textContent = text;
    phaseLabel.style.opacity = visible ? "1" : "0";
  }

  function showHint(text, on=true){
    hintLine.textContent = text || "";
    hintLine.classList.toggle("visible", !!on && !!text);
  }

  function pulseCountNumber(n){
    if (!n || n < 1) {
      countOverlay.classList.remove("show");
      countOverlay.classList.add("fade");
      return;
    }
    countOverlay.textContent = String(n);
    countOverlay.classList.add("show");
    countOverlay.classList.remove("fade");
    setTimeout(() => {
      countOverlay.classList.add("fade");
      countOverlay.classList.remove("show");
    }, 260);
  }

  function isPanelCollapsed(){
    return panel.classList.contains("collapsed");
  }

  function setPanelCollapsed(collapsed){
    panel.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.textContent = collapsed ? "▶" : "◀";
  }

  // ✅ Mobile default: if CSS has it collapsed, sync toggle icon
  setPanelCollapsed(isPanelCollapsed());

  toggle.addEventListener("click", () => {
    setPanelCollapsed(!isPanelCollapsed());
  });

  function setDuration(min){
    durationMin = min;
    plannedSec = durationMin * 60;

    cornerLabel.textContent = `${durationMin} MIN • 5.5 Breathing`;
    countdown.textContent = fmtMMSS(plannedSec);

    durBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.min) === durationMin));

    resetSession(true);

    // ✅ duration seçince panel gizlensin (mobil kolaylık)
    setPanelCollapsed(true);
  }

  function resetSession(silent=false){
    running = false;
    cancelAnimationFrame(rafId);

    pausedElapsed = 0;
    lastPhase = "idle";

    endingMode = false;
    prevCycleIndex = 0;

    guideCyclesRemaining = 3;
    guidePrevCycleIndex = 0;

    try { stopAudioSoft(); } catch(e){}

    startBtn.textContent = "Start";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resetBtn.disabled = true;

    setHueForPhase("inhale");
    setOrbScale(0.84);

    showHint("Nasal breathing only.", true);
    setPhaseText("Ready", true);

    countdown.textContent = fmtMMSS(plannedSec);

    // ✅ reset sonrası panel geri gelsin (süre seçmek kolay olsun)
    setPanelCollapsed(false);

    if (!silent) { /* no-op */ }
  }

  function endSession(){
    running = false;
    cancelAnimationFrame(rafId);

    try { stopAudioSoft(); } catch(e){}

    setHueForPhase("exhale");
    setOrbScale(MIN_SCALE);

    showHint("", false);
    setPhaseText("", false);

    startBtn.textContent = "Start";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resetBtn.disabled = false;

    countdown.textContent = "00:00";
  }

  function start(){
    if (running) return;

    try { ensureAudio(); } catch(e) {}

    running = true;
    lastPhase = "idle";

    endingMode = false;
    prevCycleIndex = 0;

    guideCyclesRemaining = 3;
    guidePrevCycleIndex = 0;

    showHint("Nasal breathing only.", true);
    setPhaseText("Ready", true);

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    resetBtn.disabled = false;

    // ✅ Start/Resume ile panel gizlensin
    setPanelCollapsed(true);

    t0 = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function pause(){
    if (!running) return;

    running = false;
    cancelAnimationFrame(rafId);

    const now = performance.now();
    pausedElapsed += (now - t0) / 1000;

    try { stopAudioSoft(); } catch(e){}

    startBtn.textContent = "Resume";
    startBtn.disabled = false;
    pauseBtn.disabled = true;

    // pause olunca paneli otomatik açmıyorum (istersen açtırırız)
  }

  function resume(){
    if (running) return;

    try { ensureAudio(); } catch(e) {}
    running = true;

    startBtn.disabled = true;
    pauseBtn.disabled = false;

    // ✅ Resume ile panel gizlensin
    setPanelCollapsed(true);

    t0 = performance.now();
    lastPhase = "idle";
    rafId = requestAnimationFrame(loop);
  }

  let lastCountShown = null;

  function loop(){
    if (!running) return;

    const now = performance.now();
    const elapsedTotal = pausedElapsed + (now - t0) / 1000;

    if (elapsedTotal < PRE_ROLL){
      setOrbScale(0.84);
      setHueForPhase("inhale");
      countdown.textContent = fmtMMSS(plannedSec);

      const secLeft = Math.ceil(PRE_ROLL - elapsedTotal);
      if (secLeft !== lastCountShown && secLeft >= 1){
        lastCountShown = secLeft;
        pulseCountNumber(secLeft);
      }

      rafId = requestAnimationFrame(loop);
      return;
    }

    const breathElapsed = elapsedTotal - PRE_ROLL;

    const remaining = plannedSec - breathElapsed;
    countdown.textContent = fmtMMSS(remaining);

    if (!endingMode && breathElapsed >= plannedSec){
      endingMode = true;
      prevCycleIndex = Math.floor(breathElapsed / CYCLE_LEN);
    }

    const cycleIndex = Math.floor(breathElapsed / CYCLE_LEN);
    if (endingMode && cycleIndex > prevCycleIndex){
      endSession();
      return;
    }
    prevCycleIndex = cycleIndex;

    if (cycleIndex > guidePrevCycleIndex){
      guidePrevCycleIndex = cycleIndex;
      guideCyclesRemaining = Math.max(0, guideCyclesRemaining - 1);
      if (guideCyclesRemaining === 0){
        showHint("", false);
      }
    }

    const { phase, phaseProgress } = computeBreath(breathElapsed);

    if (phase !== lastPhase){
      setHueForPhase(phase);

      if (guideCyclesRemaining > 0){
        if (phase === "inhale") showHint("Breathe in through your nose.", true);
        else showHint("Breathe out through your nose.", true);
      }

      setPhaseText(phase === "inhale" ? "Inhale" : "Exhale", true);

      try { setPhaseAudio(phase); } catch(e){}
      lastPhase = phase;
    }

    const t = easeInOut(clamp(phaseProgress, 0, 1));
    const s = (phase === "inhale")
      ? (MIN_SCALE + (MAX_SCALE - MIN_SCALE) * t)
      : (MAX_SCALE - (MAX_SCALE - MIN_SCALE) * t);

    setOrbScale(s);
    rafId = requestAnimationFrame(loop);
  }

  // Duration buttons
  durBtns.forEach(btn => btn.addEventListener("click", () => setDuration(Number(btn.dataset.min))));

  // Controls
  startBtn.addEventListener("click", () => {
    if (!running && startBtn.textContent === "Resume") resume();
    else start();
  });

  pauseBtn.addEventListener("click", pause);
  resetBtn.addEventListener("click", () => resetSession(false));

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? "Sound: On" : "Sound: Off";
    soundBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");

    if (!soundOn) { try { stopAudioSoft(); } catch(e){} }
    else if (audioReady && running && lastPhase !== "idle") { try { setPhaseAudio(lastPhase); } catch(e){} }
  });

  // Init
  setDuration(5);
});

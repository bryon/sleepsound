// Keep VERSION in sync with CACHE_NAME in service-worker.js
const VERSION = 'v6';

let audioContext = null;
let bufferSource = null;
let filterNode = null;
let gainNode = null;
let limiterNode = null;
let isPlaying = false;
let currentType = 'brown';
let timerMinutes = 480; // 8 hours default
let timerEndTime = null;
let timerInterval = null;
let fadeScheduled = false;
const FADE_DURATION_MIN = 5;
const MAX_GAIN = 2.5; // limiter catches the peaks above 1.0
const LOOP_SECONDS = 60;
const CROSSFADE_SECONDS = 0.05; // 50ms self-loop crossfade

// --- Noise generation (runs on main thread, once per type change) ---

function generateWhite(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1;
  return out;
}

function generatePink(n) {
  const out = new Float32Array(n);
  const rows = new Float64Array(6);
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const v = Math.random() * 2 - 1;
    rows[i] = v;
    sum += v;
  }
  for (let i = 0; i < n; i++) {
    let row = 0;
    let m = i;
    while (row < 5 && (m & 1) === 0) {
      row++;
      m >>= 1;
    }
    sum -= rows[row];
    const nv = Math.random() * 2 - 1;
    rows[row] = nv;
    sum += nv;
    out[i] = sum / 6;
  }
  return out;
}

function generateBrown(n) {
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    if (last > 0.285) last = 0.285;
    else if (last < -0.285) last = -0.285;
    out[i] = last * 3.5;
  }
  return out;
}

// Generate a seamless-loop buffer by crossfading the beginning with an
// extended tail — so the transition from end-of-loop back to start is
// statistically identical to continuous generation (no click).
function buildLoopBuffer(type, sampleRate) {
  const loopSamples = Math.floor(LOOP_SECONDS * sampleRate);
  const xfadeSamples = Math.floor(CROSSFADE_SECONDS * sampleRate);
  const totalSamples = loopSamples + xfadeSamples;

  let raw;
  switch (type) {
    case 'white': raw = generateWhite(totalSamples); break;
    case 'pink':  raw = generatePink(totalSamples); break;
    case 'brown': raw = generateBrown(totalSamples); break;
    default:      raw = generateBrown(totalSamples);
  }

  const buf = audioContext.createBuffer(1, loopSamples, sampleRate);
  const ch = buf.getChannelData(0);

  // Crossfade zone: blend raw[i] (fading in) with raw[loopSamples + i] (fading out).
  // At i=0: ch[0] = raw[loopSamples], which is the natural "next sample" after raw[loopSamples-1].
  for (let i = 0; i < xfadeSamples; i++) {
    const t = i / xfadeSamples;
    ch[i] = raw[i] * t + raw[loopSamples + i] * (1 - t);
  }
  for (let i = xfadeSamples; i < loopSamples; i++) {
    ch[i] = raw[i];
  }
  return buf;
}

// --- Audio Setup ---

async function initAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  filterNode = audioContext.createBiquadFilter();
  filterNode.type = 'lowpass';
  filterNode.frequency.value = toneToFrequency(document.getElementById('tone').value);
  filterNode.Q.value = 0.7;
  gainNode = audioContext.createGain();
  gainNode.gain.value = getVolumeSliderValue();
  limiterNode = audioContext.createDynamicsCompressor();
  limiterNode.threshold.value = -3;
  limiterNode.knee.value = 0;
  limiterNode.ratio.value = 20;
  limiterNode.attack.value = 0.003;
  limiterNode.release.value = 0.25;
  filterNode.connect(gainNode);
  gainNode.connect(limiterNode);
  limiterNode.connect(audioContext.destination);

  startSource(currentType);
}

function startSource(type) {
  const buf = buildLoopBuffer(type, audioContext.sampleRate);
  const src = audioContext.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(filterNode);
  src.start(0);

  if (bufferSource) {
    try { bufferSource.stop(); } catch (_) {}
    try { bufferSource.disconnect(); } catch (_) {}
  }
  bufferSource = src;
}

async function play() {
  await initAudio();
  await audioContext.resume();
  isPlaying = true;
  fadeScheduled = false;
  updatePlayButton();
  updateMediaSession();
  startTimer();
}

function pause() {
  if (!audioContext) return;
  audioContext.suspend();
  isPlaying = false;
  updatePlayButton();
  clearTimerInterval();
  if (fadeScheduled) {
    gainNode.gain.cancelScheduledValues(audioContext.currentTime);
    gainNode.gain.setValueAtTime(getVolumeSliderValue(), audioContext.currentTime);
    fadeScheduled = false;
  }
  updateMediaSession();
}

function stop() {
  pause();
  timerEndTime = null;
  updateTimerDisplay();
}

function setNoiseType(type) {
  currentType = type;
  if (audioContext) {
    startSource(type);
  }
  document.querySelectorAll('.noise-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  updateMediaSession();
}

function getVolumeSliderValue() {
  return (document.getElementById('volume').value / 100) * MAX_GAIN;
}

// Map slider (0-100) to filter cutoff (100Hz–20kHz) on a log scale
function toneToFrequency(val) {
  const minLog = Math.log10(100);
  const maxLog = Math.log10(20000);
  return Math.pow(10, minLog + (val / 100) * (maxLog - minLog));
}

function setTone(val) {
  if (!filterNode) return;
  filterNode.frequency.setTargetAtTime(toneToFrequency(val), audioContext.currentTime, 0.02);
}

function setVolume(val) {
  if (!gainNode) return;
  const v = (val / 100) * MAX_GAIN;
  gainNode.gain.cancelScheduledValues(audioContext.currentTime);
  gainNode.gain.setTargetAtTime(v, audioContext.currentTime, 0.02);
}

// --- Timer ---

function setTimerDuration(minutes) {
  timerMinutes = minutes;
  document.getElementById('timer-selected').textContent = formatDurationLabel(minutes);
  document.getElementById('infinity-btn').classList.toggle('active', minutes === 0);
  if (isPlaying) {
    clearTimerInterval();
    if (fadeScheduled) {
      gainNode.gain.cancelScheduledValues(audioContext.currentTime);
      gainNode.gain.setValueAtTime(getVolumeSliderValue(), audioContext.currentTime);
      fadeScheduled = false;
    }
    startTimer();
  } else {
    if (minutes === 0) {
      document.getElementById('timer-display').textContent = '∞';
    } else {
      document.getElementById('timer-display').textContent = formatTime(minutes * 60);
    }
  }
}

function formatDurationLabel(minutes) {
  if (minutes === 0) return '∞';
  if (minutes === 30) return '30m';
  return `${minutes / 60}h`;
}

function startTimer() {
  clearTimerInterval();
  if (timerMinutes === 0) {
    timerEndTime = null;
    document.getElementById('timer-display').textContent = '∞';
    return;
  }

  timerEndTime = Date.now() + timerMinutes * 60 * 1000;

  const fadeSeconds = Math.min(FADE_DURATION_MIN * 60, timerMinutes * 60);
  const fadeStartTime = audioContext.currentTime + (timerMinutes * 60 - fadeSeconds);
  const fadeEndTime = audioContext.currentTime + timerMinutes * 60;

  gainNode.gain.cancelScheduledValues(audioContext.currentTime);
  gainNode.gain.setValueAtTime(getVolumeSliderValue(), audioContext.currentTime);
  gainNode.gain.setValueAtTime(getVolumeSliderValue(), fadeStartTime);
  gainNode.gain.linearRampToValueAtTime(0, fadeEndTime);
  fadeScheduled = true;

  updateTimerDisplay();
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, timerEndTime - Date.now());
    if (remaining <= 0) {
      stop();
      return;
    }
    updateTimerDisplay();
  }, 1000);
}

function clearTimerInterval() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  const el = document.getElementById('timer-display');
  if (!timerEndTime || timerMinutes === 0) {
    el.textContent = timerMinutes === 0 ? '∞' : formatTime(timerMinutes * 60);
    return;
  }
  const remaining = Math.max(0, Math.ceil((timerEndTime - Date.now()) / 1000));
  el.textContent = formatTime(remaining);
}

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// --- UI ---

function updatePlayButton() {
  const btn = document.getElementById('play-btn');
  btn.textContent = isPlaying ? '⏸' : '▶';
  btn.classList.toggle('playing', isPlaying);
}

// --- MediaSession ---

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const typeLabel = currentType.charAt(0).toUpperCase() + currentType.slice(1);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${typeLabel} Noise`,
    artist: 'Sleep Sound Machine',
    album: 'Sleep Sounds'
  });
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('stop', stop);
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.noise-btn').forEach((btn) => {
    btn.addEventListener('click', () => setNoiseType(btn.dataset.type));
  });

  document.getElementById('play-btn').addEventListener('click', () => {
    isPlaying ? pause() : play();
  });

  document.getElementById('volume').addEventListener('input', (e) => {
    setVolume(e.target.value);
  });

  document.getElementById('tone').addEventListener('input', (e) => {
    setTone(e.target.value);
  });

  document.getElementById('timer-slider').addEventListener('input', (e) => {
    setTimerDuration(Math.round(parseFloat(e.target.value) * 60));
  });
  document.getElementById('infinity-btn').addEventListener('click', () => {
    if (timerMinutes === 0) {
      const hours = parseFloat(document.getElementById('timer-slider').value);
      setTimerDuration(Math.round(hours * 60));
    } else {
      setTimerDuration(0);
    }
  });

  setNoiseType(currentType);
  setTimerDuration(timerMinutes);
  document.getElementById('version').textContent = VERSION;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
  }
});

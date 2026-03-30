let audioContext = null;
let workletNode = null;
let gainNode = null;
let isPlaying = false;
let currentType = 'brown';
let timerMinutes = 480; // 8 hours default
let timerEndTime = null;
let timerInterval = null;
let fadeScheduled = false;
const FADE_DURATION_MIN = 5;

// --- Audio Setup ---

async function initAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule('noise-processor.js');
  workletNode = new AudioWorkletNode(audioContext, 'noise-generator');
  gainNode = audioContext.createGain();
  gainNode.gain.value = 0.7;
  workletNode.connect(gainNode);
  gainNode.connect(audioContext.destination);
  workletNode.port.postMessage({ type: currentType });
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
  // Cancel any scheduled fade
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
  if (workletNode) {
    workletNode.port.postMessage({ type });
  }
  document.querySelectorAll('.noise-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  updateMediaSession();
}

function getVolumeSliderValue() {
  return document.getElementById('volume').value / 100;
}

function setVolume(val) {
  if (!gainNode) return;
  const v = val / 100;
  gainNode.gain.cancelScheduledValues(audioContext.currentTime);
  gainNode.gain.setTargetAtTime(v, audioContext.currentTime, 0.02);
}

// --- Timer ---

function setTimerDuration(minutes) {
  timerMinutes = minutes;
  document.querySelectorAll('.timer-btn').forEach((btn) => {
    const m = parseInt(btn.dataset.minutes);
    btn.classList.toggle('active', m === minutes);
  });
  // If playing, restart timer with new duration
  if (isPlaying) {
    clearTimerInterval();
    if (fadeScheduled) {
      gainNode.gain.cancelScheduledValues(audioContext.currentTime);
      gainNode.gain.setValueAtTime(getVolumeSliderValue(), audioContext.currentTime);
      fadeScheduled = false;
    }
    startTimer();
  } else {
    // Update display to show selected duration
    if (minutes === 0) {
      document.getElementById('timer-display').textContent = '\u221e';
    } else {
      document.getElementById('timer-display').textContent = formatTime(minutes * 60);
    }
  }
}

function startTimer() {
  clearTimerInterval();
  if (timerMinutes === 0) {
    timerEndTime = null;
    document.getElementById('timer-display').textContent = '\u221e';
    return;
  }

  timerEndTime = Date.now() + timerMinutes * 60 * 1000;

  // Schedule fade-out on the audio thread
  const fadeSeconds = Math.min(FADE_DURATION_MIN * 60, timerMinutes * 60);
  const fadeStartTime = audioContext.currentTime + (timerMinutes * 60 - fadeSeconds);
  const fadeEndTime = audioContext.currentTime + timerMinutes * 60;

  gainNode.gain.cancelScheduledValues(audioContext.currentTime);
  gainNode.gain.setValueAtTime(getVolumeSliderValue(), audioContext.currentTime);
  gainNode.gain.setValueAtTime(getVolumeSliderValue(), fadeStartTime);
  gainNode.gain.linearRampToValueAtTime(0, fadeEndTime);
  fadeScheduled = true;

  // UI countdown — recalculates from timerEndTime to handle drift
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
    el.textContent = timerMinutes === 0 ? '\u221e' : formatTime(timerMinutes * 60);
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
  btn.textContent = isPlaying ? '\u23F8' : '\u25B6';
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
  // Noise type buttons
  document.querySelectorAll('.noise-btn').forEach((btn) => {
    btn.addEventListener('click', () => setNoiseType(btn.dataset.type));
  });

  // Play button
  document.getElementById('play-btn').addEventListener('click', () => {
    isPlaying ? pause() : play();
  });

  // Volume
  document.getElementById('volume').addEventListener('input', (e) => {
    setVolume(e.target.value);
  });

  // Timer buttons
  document.querySelectorAll('.timer-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTimerDuration(parseInt(btn.dataset.minutes)));
  });

  // Set initial UI state
  setNoiseType(currentType);
  setTimerDuration(timerMinutes);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js');
  }
});

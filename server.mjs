import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 3000;
const SAMPLE_RATE = 24000; // 24 kHz baseband audio from rtl_fm

// Exact 22 FRS Channels from your Onn Model #36018121 Manual
const CHANNELS = [
  { ch: 1, freq: 462.5625 },  { ch: 2, freq: 462.5875 },
  { ch: 3, freq: 462.6125 },  { ch: 4, freq: 462.6375 },
  { ch: 5, freq: 462.6625 },  { ch: 6, freq: 462.6875 },
  { ch: 7, freq: 462.7125 },  { ch: 8, freq: 467.5625 },
  { ch: 9, freq: 467.5875 },  { ch: 10, freq: 467.6125 },
  { ch: 11, freq: 467.6375 }, { ch: 12, freq: 467.6625 },
  { ch: 13, freq: 467.6875 }, { ch: 14, freq: 467.7125 },
  { ch: 15, freq: 462.5500 }, { ch: 16, freq: 462.5750 },
  { ch: 17, freq: 462.6000 }, { ch: 18, freq: 462.6250 },
  { ch: 19, freq: 462.6500 }, { ch: 20, freq: 462.6750 },
  { ch: 21, freq: 462.7000 }, { ch: 22, freq: 462.7250 }
];

// Codes 1 - 38: Standard EIA/TIA-603 CTCSS Tones (Hz)
const CTCSS_TONES = [
  67.0, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8,
  97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8,
  136.5, 141.3, 146.2, 151.4, 156.7, 162.2, 167.9, 173.8, 179.9, 186.2,
  192.8, 203.5, 210.7, 218.1, 225.7, 233.6, 241.8, 250.3
];

// Codes 39 - 121: Standard 83 DCS Octal Codes
const DCS_OCTALS = [
  23, 25, 26, 31, 32, 43, 47, 51, 54, 65, 71, 72, 73, 74, 114, 115, 116, 125, 131, 132,
  134, 143, 152, 155, 156, 162, 165, 172, 174, 205, 223, 226, 243, 244, 245, 251, 261,
  263, 265, 271, 306, 311, 315, 331, 343, 346, 351, 364, 365, 371, 411, 412, 413, 423,
  431, 432, 445, 464, 465, 466, 503, 506, 516, 532, 546, 565, 606, 612, 624, 627, 631,
  632, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754
];

// Reverse 23-bit integer to match LSB-first over-the-air DCS transmission
function reverse23(val) {
  let rev = 0;
  for (let i = 0; i < 23; i++) {
    if ((val >> i) & 1) rev |= (1 << (22 - i));
  }
  return rev;
}

// Precompute 23-bit Golay (23,12) codewords for DCS matching
const DCS_LOOKUP = new Map();
function buildGolayTable() {
  const POLY = 0xC75;
  for (let idx = 0; idx < DCS_OCTALS.length; idx++) {
    const octalStr = DCS_OCTALS[idx].toString().padStart(3, '0');
    const c9 = parseInt(octalStr, 8);
    const data12 = (0b100 << 9) | c9;

    let rem = data12 << 11;
    for (let i = 22; i >= 11; i--) {
      if ((rem >> i) & 1) rem ^= (POLY << (i - 11));
    }
    const cw23 = (rem << 12) | data12;

    for (let s = 0; s < 23; s++) {
      const shifted = ((cw23 >> s) | (cw23 << (23 - s))) & 0x7FFFFF;
      const revShifted = reverse23(shifted);

      for (const candidate of [shifted, revShifted]) {
        DCS_LOOKUP.set(candidate, { privacyCode: idx + 39, octal: octalStr, inverted: false });
        DCS_LOOKUP.set((~candidate) & 0x7FFFFF, { privacyCode: idx + 39, octal: octalStr, inverted: true });
      }
    }
  }
}
buildGolayTable();

let currentChannelIdx = 2; // Default to Channel 3
let scanMode = false;
let squelchThreshold = 1100;
let rtlProcess = null;
let lastActiveTime = 0;
let leftoverByte = null;

const sseClients = new Set();

const channelState = CHANNELS.map(c => ({
  ...c,
  rms: 0,
  active: false,
  mode: 'NONE',
  privacyCode: 0,
  detail: 'Idle',
  lastSeen: null
}));

function goertzelMag(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const omega = (2.0 * Math.PI * targetFreq) / sampleRate;
  const coeff = 2.0 * Math.cos(omega);
  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < N; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    q0 = coeff * q1 - q2 + samples[i] * win;
    q2 = q1;
    q1 = q0;
  }
  return (Math.sqrt(q1 * q1 + q2 * q2 - q1 * q2 * coeff) * 4.0) / N;
}

// Sub-audible DSP filter & clock-recovery state
let dcMean = 0;
let lpf1 = 0, lpf2 = 0;
let prevSample = 0;
let dcsPhase = 0, dcsShiftReg = 0, prevBit = 0;
let dcsBitsSinceMatch = 0, dcsLockCount = 0, lockedDcs = null;

// 500ms window (12,000 samples)
const WINDOW_SIZE = SAMPLE_RATE / 2;
let analysisBuffer = new Float32Array(WINDOW_SIZE);
let rawWindow = new Int16Array(WINDOW_SIZE);
let highFreqNoiseEnergy = 0;
let bufPtr = 0;

function processPcmChunk(chunk) {
  let alignedBuf = chunk;
  if (leftoverByte !== null) {
    alignedBuf = Buffer.concat([leftoverByte, chunk]);
    leftoverByte = null;
  }
  if (alignedBuf.length % 2 !== 0) {
    leftoverByte = alignedBuf.subarray(alignedBuf.length - 1);
    alignedBuf = alignedBuf.subarray(0, alignedBuf.length - 1);
  }
  if (alignedBuf.length === 0) return;

  const b64Audio = alignedBuf.toString('base64');
  for (const res of sseClients) {
    res.write(`event: audio\ndata: ${b64Audio}\n\n`);
  }

  const sampleCount = alignedBuf.length / 2;
  const int16 = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    int16[i] = alignedBuf.readInt16LE(i * 2);
  }

  const dcAlpha = 1 - Math.exp((-2 * Math.PI * 4) / SAMPLE_RATE);
  const lpfAlpha = 1 - Math.exp((-2 * Math.PI * 240) / SAMPLE_RATE);
  const samplesPerBit = SAMPLE_RATE / 134.4;

  for (let i = 0; i < int16.length; i++) {
    const raw = int16[i];

    const diff = raw - prevSample;
    prevSample = raw;
    highFreqNoiseEnergy += diff * diff;

    dcMean += dcAlpha * (raw - dcMean);
    const ac = raw - dcMean;
    lpf1 += lpfAlpha * (ac - lpf1);
    lpf2 += lpfAlpha * (lpf1 - lpf2);

    const currentPol = lpf2 >= 0 ? 1 : 0;
    if (currentPol !== prevBit) {
      prevBit = currentPol;
      const phaseErr = dcsPhase - (samplesPerBit * 0.5);
      dcsPhase -= phaseErr * 0.25;
    }

    dcsPhase += 1.0;
    if (dcsPhase >= samplesPerBit) {
      dcsPhase -= samplesPerBit;
      const bit = lpf2 >= 0 ? 1 : 0;
      dcsShiftReg = ((dcsShiftReg << 1) | bit) & 0x7FFFFF;
      dcsBitsSinceMatch++;

      const match = DCS_LOOKUP.get(dcsShiftReg);
      if (match) {
        if (lockedDcs && lockedDcs.privacyCode === match.privacyCode) {
          if (dcsBitsSinceMatch <= 24) {
            dcsLockCount = Math.min(dcsLockCount + 1, 15);
          }
        } else if (dcsLockCount === 0) {
          lockedDcs = match;
          dcsLockCount = 1;
        }
        dcsBitsSinceMatch = 0;
      } else if (dcsBitsSinceMatch > 46) {
        dcsLockCount = Math.max(0, dcsLockCount - 1);
        if (dcsLockCount === 0) lockedDcs = null;
      }
    }

    analysisBuffer[bufPtr] = lpf2;
    rawWindow[bufPtr] = raw;
    bufPtr++;

    if (bufPtr >= WINDOW_SIZE) {
      bufPtr = 0;
      evaluateWindow();
      highFreqNoiseEnergy = 0;
    }
  }
}

function evaluateWindow() {
  let sumSq = 0, subSq = 0;
  for (let i = 0; i < WINDOW_SIZE; i++) {
    sumSq += rawWindow[i] * rawWindow[i];
    subSq += analysisBuffer[i] * analysisBuffer[i];
  }
  const rms = Math.round(Math.sqrt(sumSq / WINDOW_SIZE));
  const subRms = Math.round(Math.sqrt(subSq / WINDOW_SIZE));
  const hfRms = Math.round(Math.sqrt(highFreqNoiseEnergy / WINDOW_SIZE));

  const hissRatio = rms > 0 ? hfRms / rms : 2.0;
  const hasRfCarrier = hissRatio < 0.72 || rms > squelchThreshold;

  if (!hasRfCarrier) {
    dcsLockCount = 0;
    lockedDcs = null;
    const st = channelState[currentChannelIdx];
    st.rms = rms;
    st.active = false;
    broadcastState();
    return;
  }

  const mags = new Float32Array(CTCSS_TONES.length);
  let maxMag = 0, bestIdx = -1;
  for (let i = 0; i < CTCSS_TONES.length; i++) {
    const m = goertzelMag(analysisBuffer, CTCSS_TONES[i], SAMPLE_RATE);
    mags[i] = m;
    if (m > maxMag) {
      maxMag = m;
      bestIdx = i;
    }
  }

  const sortedMags = Float32Array.from(mags).sort();
  const medianMag = sortedMags[Math.floor(sortedMags.length / 2)] || 1;
  const peakToMedian = maxMag / medianMag;
  const tonePurity = subRms > 0 ? (maxMag * 0.7071) / subRms : 0;

  const isPureCtcss = peakToMedian > 5.5 && tonePurity > 0.58 && subRms > 40;
  const isLockedDcs = dcsLockCount >= 3 && lockedDcs !== null;

  console.log(
    `[TX CH ${CHANNELS[currentChannelIdx].ch}] RMS:${rms} SubRMS:${subRms} Hiss:${hissRatio.toFixed(2)} | ` +
    `CTCSS: #${bestIdx + 1} (${CTCSS_TONES[bestIdx]}Hz) SNR:${peakToMedian.toFixed(1)}x Purity:${(tonePurity * 100).toFixed(0)}% | ` +
    `DCSLock:${dcsLockCount} ${lockedDcs ? `(Code ${lockedDcs.privacyCode} D${lockedDcs.octal})` : ''}`
  );

  const st = channelState[currentChannelIdx];
  st.rms = rms;
  st.active = true;
  lastActiveTime = Date.now();
  st.lastSeen = new Date().toLocaleTimeString();

  if (isPureCtcss && !isLockedDcs) {
    st.mode = 'CTCSS';
    st.privacyCode = bestIdx + 1;
    st.detail = `Code ${bestIdx + 1} • CTCSS ${CTCSS_TONES[bestIdx].toFixed(1)} Hz`;
  } else if (isLockedDcs) {
    st.mode = 'DCS';
    st.privacyCode = lockedDcs.privacyCode;
    st.detail = `Code ${lockedDcs.privacyCode} • DCS D${lockedDcs.octal}${lockedDcs.inverted ? 'I' : 'N'}`;
  } else if (isPureCtcss) {
    st.mode = 'CTCSS';
    st.privacyCode = bestIdx + 1;
    st.detail = `Code ${bestIdx + 1} • CTCSS ${CTCSS_TONES[bestIdx].toFixed(1)} Hz`;
  } else {
    st.mode = 'CLEAR';
    st.privacyCode = 0;
    st.detail = 'Code 0 (Carrier / Voice)';
  }

  broadcastState();
}

let isTransitioning = false;
let pendingChannelIdx = null;

function stopRtlProcess() {
  return new Promise((resolve) => {
    if (!rtlProcess) return resolve();

    const proc = rtlProcess;
    rtlProcess = null;
    proc.stdout.removeAllListeners('data');

    const forceKillTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 800);

    proc.once('close', () => {
      clearTimeout(forceKillTimer);
      setTimeout(resolve, 150);
    });

    proc.kill('SIGINT');
  });
}

async function tuneToChannel(index) {
  if (isTransitioning) {
    pendingChannelIdx = index;
    return;
  }

  isTransitioning = true;
  currentChannelIdx = index;
  dcsLockCount = 0;
  lockedDcs = null;
  dcsBitsSinceMatch = 0;
  bufPtr = 0;
  highFreqNoiseEnergy = 0;
  leftoverByte = null;

  await stopRtlProcess();

  if (pendingChannelIdx !== null && pendingChannelIdx !== currentChannelIdx) {
    const next = pendingChannelIdx;
    pendingChannelIdx = null;
    isTransitioning = false;
    return tuneToChannel(next);
  }
  pendingChannelIdx = null;

  const ch = CHANNELS[currentChannelIdx];
  const freqHz = Math.round(ch.freq * 1e6);

  console.log(`\n🔄 Tuning SDR to Channel ${ch.ch} (${ch.freq} MHz)...`);

  rtlProcess = spawn('rtl_fm', [
    '-f', String(freqHz),
    '-M', 'fm',
    '-s', String(SAMPLE_RATE),
    '-g', '20',
    '-'
  ]);

  rtlProcess.stdout.on('data', processPcmChunk);
  rtlProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[rtl_fm] ${msg}`);
  });
  rtlProcess.on('error', (err) => {
    console.error('❌ Failed to spawn rtl_fm:', err.message);
  });

  isTransitioning = false;
  broadcastState();
}

setInterval(() => {
  if (!scanMode || isTransitioning) return;
  if (Date.now() - lastActiveTime < 2500) return;
  const nextIdx = (currentChannelIdx + 1) % CHANNELS.length;
  tuneToChannel(nextIdx);
}, 1500);

process.on('SIGINT', async () => {
  console.log('\n🛑 Releasing SDR USB interface and shutting down...');
  await stopRtlProcess();
  process.exit(0);
});

function broadcastState() {
  const payload = JSON.stringify({
    currentChannel: CHANNELS[currentChannelIdx].ch,
    scanMode,
    squelchThreshold,
    channels: channelState
  });
  for (const res of sseClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>FRS Walkie-Talkie & CTCSS/DCS Monitor</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --accent: #38bdf8; --active: #22c55e; --text: #f8fafc; --muted: #94a3b8; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: var(--bg); color: var(--text); margin: 0; padding: 24px; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #334155; }
  h1 { margin: 0; font-size: 1.4rem; display: flex; align-items: center; gap: 10px; }
  .controls { display: flex; align-items: center; gap: 16px; background: var(--card); padding: 10px 16px; border-radius: 10px; border: 1px solid #334155; }
  button { background: #334155; color: var(--text); border: 1px solid #475569; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; transition: 0.15s; }
  button.on { background: var(--accent); color: #0f172a; border-color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap: 14px; }
  .ch-card { background: var(--card); border: 2px solid #334155; border-radius: 10px; padding: 14px; cursor: pointer; transition: 0.15s; position: relative; }
  .ch-card:hover { border-color: #64748b; }
  .ch-card.tuned { border-color: var(--accent); box-shadow: 0 0 12px rgba(56, 189, 248, 0.25); }
  .ch-card.tx { border-color: var(--active); background: rgba(34, 197, 94, 0.12); box-shadow: 0 0 18px rgba(34, 197, 94, 0.35); }
  .ch-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .ch-num { font-size: 1.2rem; font-weight: 700; }
  .ch-freq { color: var(--muted); font-size: 0.85rem; }
  .badge { display: inline-block; padding: 4px 8px; border-radius: 5px; font-size: 0.8rem; font-weight: 700; margin: 6px 0; background: #0f172a; color: var(--muted); }
  .badge.CTCSS { background: #a855f7; color: #fff; }
  .badge.DCS { background: #f59e0b; color: #0f172a; }
  .badge.CLEAR { background: #10b981; color: #0f172a; }
  .meter { height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; margin-top: 8px; }
  .meter-fill { height: 100%; background: var(--accent); width: 0%; transition: width 0.15s; }
  .tx .meter-fill { background: var(--active); }
  .meta { font-size: 0.72rem; color: var(--muted); margin-top: 6px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <header>
    <h1>📻 Onn FRS 22-Channel SDR Decoder</h1>
    <div class="controls">
      <button id="scanBtn" onclick="toggleScan()">Auto-Scan: OFF</button>
      <button id="audioBtn" onclick="toggleAudio()">🔇 Live Audio: OFF</button>
      <label style="font-size:0.85rem;">Voice Squelch (RMS): <input type="range" id="sqSlider" min="300" max="3000" step="50" value="1100" onchange="updateSquelch(this.value)"> <span id="sqVal">1100</span></label>
    </div>
  </header>
  <div class="grid" id="grid"></div>

<script>
  let state = { currentChannel: 3, scanMode: false, channels: [] };
  let audioCtx = null, hpfNode = null, audioPlaying = false, nextAudioTime = 0;

  function selectChannel(ch) {
    fetch('/api/tune?ch=' + ch, { method: 'POST' });
  }
  function toggleScan() {
    fetch('/api/scan?enable=' + (!state.scanMode), { method: 'POST' });
  }
  function updateSquelch(val) {
    document.getElementById('sqVal').textContent = val;
    fetch('/api/squelch?val=' + val, { method: 'POST' });
  }

  async function toggleAudio() {
    const btn = document.getElementById('audioBtn');
    if (audioPlaying) {
      audioPlaying = false;
      if (audioCtx) await audioCtx.close();
      audioCtx = null;
      btn.textContent = '🔇 Live Audio: OFF';
      btn.classList.remove('on');
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    await audioCtx.resume();

    hpfNode = audioCtx.createBiquadFilter();
    hpfNode.type = 'highpass';
    hpfNode.frequency.value = 300;
    hpfNode.connect(audioCtx.destination);

    nextAudioTime = audioCtx.currentTime;
    audioPlaying = true;
    btn.textContent = '🔊 Live Audio: ON (300Hz HPF)';
    btn.classList.add('on');
  }

  function render() {
    const scanBtn = document.getElementById('scanBtn');
    scanBtn.textContent = 'Auto-Scan: ' + (state.scanMode ? 'ON' : 'OFF');
    scanBtn.classList.toggle('on', state.scanMode);

    const grid = document.getElementById('grid');
    grid.innerHTML = state.channels.map(c => {
      const isTuned = c.ch === state.currentChannel;
      const pct = Math.min(100, Math.round((c.rms / 3000) * 100));
      return \`
        <div class="ch-card \${isTuned ? 'tuned' : ''} \${c.active ? 'tx' : ''}" onclick="selectChannel(\${c.ch})">
          <div class="ch-top">
            <span class="ch-num">CH \${c.ch}</span>
            <span class="ch-freq">\${c.freq.toFixed(4)} MHz</span>
          </div>
          <div class="badge \${c.mode}">\${c.detail}</div>
          <div class="meter"><div class="meter-fill" style="width:\${pct}%"></div></div>
          <div class="meta">
            <span>RMS: \${c.rms}</span>
            <span>\${c.lastSeen ? 'Last TX: ' + c.lastSeen : 'Idle'}</span>
          </div>
        </div>\`;
    }).join('');
  }

  const es = new EventSource('/api/events');
  es.onmessage = (e) => { state = JSON.parse(e.data); render(); };

  es.addEventListener('audio', (e) => {
    if (!audioPlaying || !audioCtx) return;

    const rawStr = atob(e.data);
    const sampleCount = Math.floor(rawStr.length / 2);
    const f32 = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      const lo = rawStr.charCodeAt(i * 2);
      const hi = rawStr.charCodeAt(i * 2 + 1);
      let val = (hi << 8) | lo;
      if (val & 0x8000) val -= 0x10000;
      f32[i] = val / 32768.0;
    }

    const buf = audioCtx.createBuffer(1, sampleCount, 24000);
    buf.getChannelData(0).set(f32);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(hpfNode);

    if (nextAudioTime < audioCtx.currentTime || nextAudioTime > audioCtx.currentTime + 0.4) {
      nextAudioTime = audioCtx.currentTime + 0.04;
    }
    src.start(nextAudioTime);
    nextAudioTime += buf.duration;
  });
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HTML_UI);
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    sseClients.add(res);
    broadcastState();
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/tune' && req.method === 'POST') {
    const ch = Number(url.searchParams.get('ch'));
    const idx = CHANNELS.findIndex(c => c.ch === ch);
    if (idx !== -1) {
      scanMode = false;
      tuneToChannel(idx);
    }
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    scanMode = url.searchParams.get('enable') === 'true';
    broadcastState();
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/squelch' && req.method === 'POST') {
    squelchThreshold = Number(url.searchParams.get('val')) || 1100;
    broadcastState();
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`🚀 FRS SDR Dashboard running at http://localhost:${PORT}`);
  tuneToChannel(2);
});

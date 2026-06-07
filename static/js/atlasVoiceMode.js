// Atlas OS — Voice Assistant V4 (Home overlay + Conversation Mode)

import { prepareSpeechText } from './atlasVoiceTts.js';

const DEFAULT_WAKE_PHRASES = [
  'hey atlas',
  'atlas are you awake',
  "atlas what's up",
  'atlas whats up',
  'atlas are you there',
  'atlas what are you up to',
];

const STORAGE_KEY = 'atlas_voice_prefs';
const DEFAULT_SILENCE_MS = 2000;
const DEFAULT_FOLLOW_UP_MS = 30000;
const SELF_TRANSCRIPT_COOLDOWN_MS = 700;
const RESPONSE_TIMEOUT_MS = 60000;
const COMMAND_START_TIMEOUT_MS = 5000;
const WAKE_RESTART_DELAY_MS = 120;

let _silenceSubmitMs = DEFAULT_SILENCE_MS;
let _followUpTimeoutMs = DEFAULT_FOLLOW_UP_MS;
let _eventsBound = false;
let _lastSubmittedText = '';
let _lastSubmittedAt = 0;

const RECOGNITION_ERROR_HINTS = {
  network: 'Browser/cloud speech service unreachable. Switch to Local Whisper below.',
  'not-allowed': 'Microphone permission denied.',
  'service-not-allowed': 'Speech recognition blocked by browser or page policy.',
  'audio-capture': 'No microphone detected or capture failed.',
  'start-failed': 'Recognition could not start. Check microphone permissions.',
  command_listen_failed: 'Command listening did not start after wake phrase. Returning to wake listening.',
  no_transcript: 'Microphone is active but Chrome SpeechRecognition returned no transcript. Try Test Recognition or switch to Local Whisper.',
  unknown: 'Unspecified speech recognition failure.',
};

// Conversation state machine phases
// idle | wake-listening | greeting | command-listening | processing | speaking | returning-standby
// whisper: recording | uploading | transcribing | transcript-ready

let _deps = {};
let _phase = 'idle';
let _sttMode = 'browser';
let _recognition = null;
let _listenMode = null;
let _wakeModeEnabled = false;
let _speakReplies = true;
let _autoSubmit = true;
let _selectedVoice = '';
let _ttsRate = 0.8;
let _ttsPitch = 1.0;
let _wakePhrases = [...DEFAULT_WAKE_PHRASES];
let _transcript = '';
let _finalTranscript = '';
let _open = false;
let _micPaused = false;
let _submitting = false;
let _commandSilenceTimer = null;
let _responseTimeout = null;
let _whisperAvailable = null;
let _manualListen = false;
let _homeDeps = null;
let _homeConversationActive = false;
let _followUpMode = false;
let _followUpTimer = null;
let _lastSpokenText = '';
let _lastSpokenAt = 0;
let _voiceReplyStyle = 'brief';
let _interruptionEnabled = true;

let _mediaRecorder = null;
let _mediaStream = null;
let _audioChunks = [];
let _recording = false;
let _recognitionActive = false;
let _wakeSessionText = '';
let _wakeHandling = false;
let _debugInterim = '';
let _debugFinal = '';
let _debugLastWake = '';
let _commandStartTimer = null;
let _wakeRestartTimer = null;
let _testRec = null;
let _testTimer = null;
let _noTranscriptTimer = null;
let _engineSnapshot = null;
let _diag = {
  permission: 'unknown',
  counts: { onstart: 0, onaudiostart: 0, onspeechstart: 0, onresult: 0, onend: 0, onerror: 0 },
  lastError: '',
  lastNormalized: '',
  testMode: false,
};

const NO_TRANSCRIPT_WARN_MS = 8000;
const TEST_RECOGNITION_MS = 8000;

function _el(id) {
  return document.getElementById(id);
}

function _isDebugEnabled() {
  try {
    return localStorage.getItem('atlas_voice_debug') === 'true';
  } catch (_) {
    return false;
  }
}

function _debug(event, ...args) {
  if (!_isDebugEnabled()) return;
  const tag = typeof event === 'string' ? event : 'log';
  console.log(`[atlas-voice] [${tag}]`, ...args);
}

function _diagLog(event, detail = '') {
  const map = {
    start: 'onstart', onstart: 'onstart',
    audiostream: 'onaudiostart', onaudiostart: 'onaudiostart',
    speechstart: 'onspeechstart', onspeechstart: 'onspeechstart',
    result: 'onresult', onresult: 'onresult',
    end: 'onend', onend: 'onend',
    error: 'onerror', onerror: 'onerror',
    'state-change': null, 'wake-match': null, 'no-transcript': null,
  };
  const key = map[event] ?? event;
  if (key && _diag.counts[key] !== undefined) _diag.counts[key] += 1;
  _debug(event, detail);
  _updateLiveDebug();
}

async function _refreshMicPermission() {
  _diag.permission = 'unknown';
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'microphone' });
      _diag.permission = status.state;
      status.onchange = () => {
        _diag.permission = status.state;
        _updateLiveDebug();
      };
    }
  } catch (_) {
    _diag.permission = 'unavailable';
  }
  _updateLiveDebug();
}

function _clearNoTranscriptTimer() {
  if (_noTranscriptTimer) {
    clearTimeout(_noTranscriptTimer);
    _noTranscriptTimer = null;
  }
}

function _startNoTranscriptWatchdog() {
  _clearNoTranscriptTimer();
  if (_diag.testMode) return;
  let hadResult = false;
  _noTranscriptTimer = setTimeout(() => {
    _noTranscriptTimer = null;
    if (hadResult) return;
    if (!_recognitionActive && !_testRec) return;
    const msg = 'Microphone is active but Chrome SpeechRecognition returned no transcript. Try Test Recognition or switch to Local Whisper.';
    _diagLog('no-transcript', msg);
    _showRecognitionDebug('no_transcript', msg);
  }, NO_TRANSCRIPT_WARN_MS);
  _noTranscriptTimer._markResult = () => { hadResult = true; _clearNoTranscriptTimer(); };
}

function _loadHomeSettings() {
  try {
    const raw = localStorage.getItem('atlas_voice_settings');
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function _loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.speakReplies === 'boolean') _speakReplies = p.speakReplies;
      if (typeof p.autoSubmit === 'boolean') _autoSubmit = p.autoSubmit;
      if (p.voice) _selectedVoice = p.voice;
      if (typeof p.ttsRate === 'number') _ttsRate = p.ttsRate;
      if (typeof p.ttsPitch === 'number') _ttsPitch = p.ttsPitch;
      if (p.sttMode === 'browser' || p.sttMode === 'whisper') _sttMode = p.sttMode;
      if (Array.isArray(p.wakePhrases) && p.wakePhrases.length) _wakePhrases = p.wakePhrases;
    }
  } catch (_) {}
  const home = _loadHomeSettings();
  if (typeof home.speak_replies === 'boolean') _speakReplies = home.speak_replies;
  if (typeof home.conversation_mode_enabled === 'boolean') _wakeModeEnabled = home.conversation_mode_enabled;
  if (typeof home.auto_submit === 'boolean') _autoSubmit = home.auto_submit;
  if (home.voice_reply_style) _voiceReplyStyle = home.voice_reply_style;
  if (typeof home.interruption_enabled === 'boolean') _interruptionEnabled = home.interruption_enabled;
  if (typeof home.rate === 'number') _ttsRate = home.rate;
  if (typeof home.pitch === 'number') _ttsPitch = home.pitch;
  if (home.selected_voice) _selectedVoice = home.selected_voice;
  if (typeof home.silence_submit_delay_ms === 'number') _silenceSubmitMs = home.silence_submit_delay_ms;
  if (typeof home.follow_up_timeout_ms === 'number') _followUpTimeoutMs = home.follow_up_timeout_ms;
}

function _savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      speakReplies: _speakReplies,
      autoSubmit: _autoSubmit,
      voice: _selectedVoice,
      ttsRate: _ttsRate,
      ttsPitch: _ttsPitch,
      sttMode: _sttMode,
      wakePhrases: _wakePhrases,
    }));
  } catch (_) {}
}

function _speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function _isWhisperMode() {
  return _sttMode === 'whisper';
}

function _isConversationActive() {
  return _wakeModeEnabled && !_isWhisperMode();
}

function _clearCommandTimer() {
  if (_commandSilenceTimer) {
    clearTimeout(_commandSilenceTimer);
    _commandSilenceTimer = null;
  }
}

function _setMicPaused(paused) {
  _micPaused = paused;
  if (paused) _setMicIndicator(false);
}

function _setMicIndicator(active) {
  const dot = _el('atlas-voice-mic-indicator');
  if (!dot) return;
  dot.classList.toggle('atlas-voice-mic-indicator--active', active && !_micPaused);
  dot.setAttribute('aria-hidden', active && !_micPaused ? 'false' : 'true');
  dot.title = active && !_micPaused ? 'Microphone active' : 'Microphone inactive';
}

function _setStatus(status) {
  const prev = _phase;
  _phase = status;
  if (prev !== status) _diagLog('state-change', `${prev} → ${status}`);
  const labels = {
    idle: 'Standby',
    'wake-listening': 'Wake listening',
    'wake-detected': 'Wake detected',
    greeting: 'Speaking',
    'command-listening': 'Command listening',
    recording: 'Recording',
    uploading: 'Uploading audio',
    transcribing: 'Transcribing locally',
    'transcript-ready': 'Transcript ready',
    processing: 'Processing',
    speaking: 'Speaking',
    'returning-standby': 'Returning to standby',
    paused: 'Paused',
    error: 'Error',
    listening: 'Listening',
  };
  const label = labels[status] || status;
  const pill = _el('atlas-voice-status');
  if (pill) {
    pill.textContent = label;
    pill.dataset.status = status;
  }
  const micOn = ['wake-listening', 'command-listening', 'listening', 'recording'].includes(status);
  _setMicIndicator(micOn && !_micPaused);
  _updateLiveDebug();
  _updatePrivacyText();
  _syncHomeChip(status, label);
}

function _syncHomeChip(status, label) {
  if (!window.homeModule?.isHomeActive?.()) return;
  if (_homeDeps?.isPaused?.()) {
    _notifyStatus('paused', 'Paused');
    return;
  }
  const convOn = _homeConversationActive || _wakeModeEnabled || _homeDeps?.isConversationEnabled?.();
  if (convOn) {
    const chipLabel = status === 'command-listening' ? 'Listening' : label;
    _notifyStatus(status, chipLabel);
  } else if (status === 'idle' || !convOn) {
    _notifyStatus('idle', label || 'Standby');
  }
}

function _normalizeTranscript(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u0060']/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _findWakePhrase(text) {
  const norm = _normalizeTranscript(text);
  if (!norm) return null;
  for (const p of _wakePhrases) {
    const phrase = _normalizeTranscript(p);
    if (phrase && norm.includes(phrase)) return p;
  }
  return null;
}

function _matchesWakePhrase(text) {
  return !!_findWakePhrase(text);
}

function _updateLiveDebug() {
  const set = (id, val) => { const el = _el(id); if (el) el.textContent = val ?? '—'; };
  set('atlas-voice-debug-state', _phase || 'idle');
  set('atlas-voice-debug-supported', String(_speechSupported()));
  set('atlas-voice-debug-instance', String(!!(_recognition || _testRec)));
  set('atlas-voice-debug-running', String(!!(_recognitionActive || _testRec)));
  set('atlas-voice-debug-permission', _diag.permission);
  set('atlas-voice-debug-interim', _debugInterim || '—');
  set('atlas-voice-debug-final', _debugFinal || '—');
  set('atlas-voice-debug-normalized', _diag.lastNormalized || '—');
  set('atlas-voice-debug-wake', _debugLastWake || '—');
  set('atlas-voice-debug-code', _diag.lastError || 'none');
  const c = _diag.counts;
  set('atlas-voice-debug-events', `start=${c.onstart} audio=${c.onaudiostart} speech=${c.onspeechstart} result=${c.onresult} end=${c.onend} err=${c.onerror}`);
  set('atlas-voice-debug-locks', [
    `micPaused=${_micPaused}`,
    `speaking=${_phase === 'speaking'}`,
    `submitting=${_submitting}`,
    `wakeListening=${_listenMode === 'wake'}`,
    `commandListening=${_listenMode === 'command'}`,
    `wake=${_wakeModeEnabled}`,
    `home=${_homeConversationActive}`,
  ].join(' '));
}

function _updatePrivacyText() {
  const el = _el('atlas-voice-privacy-browser');
  if (!el || _isWhisperMode()) return;
  const active = _wakeModeEnabled || _homeConversationActive;
  el.textContent = active
    ? "Conversation Mode is active. Atlas is listening for the wake phrase. Say 'Hey Atlas'."
    : 'Microphone is off until you start listening or enable Conversation Mode.';
}

function _clearCommandStartTimer() {
  if (_commandStartTimer) {
    clearTimeout(_commandStartTimer);
    _commandStartTimer = null;
  }
}

function _clearWakeRestartTimer() {
  if (_wakeRestartTimer) {
    clearTimeout(_wakeRestartTimer);
    _wakeRestartTimer = null;
  }
}

function _stripMarkdownForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[-*]\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _truncateForVoice(text, maxSentences = 4) {
  const clean = _stripMarkdownForSpeech(text);
  if (!clean) return '';
  const parts = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  return parts.slice(0, maxSentences).join(' ').trim();
}

function _pickDefaultVoice(voices) {
  const en = voices.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
  const ukMale = en.find(v => v.name.includes('Google UK English Male'));
  if (ukMale) return ukMale.name;
  const prefer = [
    'Google UK English Male',
    'Microsoft David', 'Microsoft Mark', 'Microsoft Ryan',
    'Google US English', 'Daniel', 'George',
  ];
  for (const name of prefer) {
    const m = en.find(v => v.name.includes(name));
    if (m) return m.name;
  }
  const maleish = en.find(v => /male|david|mark|ryan|george|daniel/i.test(v.name));
  return maleish?.name || en[0]?.name || voices[0]?.name || '';
}

function _populateVoices() {
  const sels = [_el('atlas-voice-tts-voice'), _el('atlas-home-tts-voice')].filter(Boolean);
  if (!sels.length || !window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (!_selectedVoice && voices.length) {
    _selectedVoice = _pickDefaultVoice(voices);
    _savePrefs();
  }
  const html = '<option value="">System default</option>' + voices.map(v => `
    <option value="${v.name.replace(/"/g, '&quot;')}"${_selectedVoice === v.name ? ' selected' : ''}>${v.name} (${v.lang})</option>
  `).join('');
  sels.forEach(sel => { sel.innerHTML = html; });

  const hint = _el('atlas-voice-tts-hint');
  if (hint) {
    const enCount = voices.filter(v => (v.lang || '').startsWith('en')).length;
    hint.classList.toggle('hidden', enCount >= 3);
  }
}

function _notifyStatus(phase, label) {
  if (_homeDeps?.setStatus) _homeDeps.setStatus(phase, label);
}

function _isLikelySelfTranscription(text) {
  const low = (text || '').toLowerCase().trim();
  if (!low || !_lastSpokenText) return false;
  if (Date.now() - _lastSpokenAt > 8000) return false;
  const spoken = _lastSpokenText.toLowerCase();
  if (low.length < 4) return false;
  return spoken.includes(low) || low.includes(spoken.slice(0, Math.min(24, spoken.length)));
}

function _handleControlCommand(text) {
  const low = text.toLowerCase().trim();
  if (/never\s*mind/.test(low)) {
    _finalTranscript = '';
    _updateTranscript('');
    _stopRecognition();
    if (_homeConversationActive) _startFollowUpOrWake();
    else _setStatus('idle');
    return true;
  }
  if (/stop\s*talking/.test(low)) {
    window.speechSynthesis?.cancel();
    _setMicPaused(false);
    if (_interruptionEnabled) _startCommandCapture();
    return true;
  }
  if (/hey\s+atlas\s+take\s+a\s+break/.test(low) || /atlas\s+take\s+a\s+break/.test(low)) {
    speakText('Understood sir. I will stand by.', { short: false, onEnd: () => {
      _homeDeps?.setPaused?.(true);
      _setStatus('paused');
    }});
    return true;
  }
  if (/hey\s+atlas\s+stop\s+listening/.test(low) || /atlas\s+stop\s+listening/.test(low)) {
    stopHomeConversation();
    if (_deps.showToast) _deps.showToast('Conversation Mode disabled');
    return true;
  }
  if (/hey\s+atlas\s+are\s+you\s+there/.test(low) || /atlas\s+are\s+you\s+there/.test(low)) {
    speakText('Always sir.', { short: false, onEnd: () => _startCommandCapture() });
    return true;
  }
  return false;
}

function _clearFollowUpTimer() {
  if (_followUpTimer) {
    clearTimeout(_followUpTimer);
    _followUpTimer = null;
  }
}

function _startFollowUpWindow() {
  _clearFollowUpTimer();
  if (!_homeConversationActive && !_wakeModeEnabled) return;
  _followUpMode = true;
  _followUpTimer = setTimeout(() => {
    _followUpMode = false;
    _debug('follow-up window ended → wake listening');
    if (_homeConversationActive || _wakeModeEnabled) _startWakeListening();
  }, _followUpTimeoutMs);
  _startCommandCapture({ fromFollowUp: true });
}

export function enterFollowUpListening() {
  if (_homeDeps?.isPaused?.()) return;
  _startFollowUpWindow();
}

function _startFollowUpOrWake() {
  if (_homeConversationActive || _wakeModeEnabled) {
    _startFollowUpWindow();
  } else {
    _setStatus('idle');
  }
}

export function speakText(text, { onEnd, short = true, style } = {}) {
  if (!text || !window.speechSynthesis) {
    if (onEnd) onEnd();
    return Promise.resolve();
  }
  window.speechSynthesis.cancel();
  const replyStyle = style || _voiceReplyStyle || 'brief';
  const spoken = short
    ? prepareSpeechText(text, replyStyle)
    : prepareSpeechText(text, 'normal');
  _lastSpokenText = spoken;
  _lastSpokenAt = Date.now();
  if (!spoken) {
    if (onEnd) onEnd();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const utt = new SpeechSynthesisUtterance(spoken.slice(0, 4000));
    if (_selectedVoice) {
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find(v => v.name === _selectedVoice);
      if (match) utt.voice = match;
    }
    utt.rate = _ttsRate;
    utt.pitch = _ttsPitch;
    _setMicPaused(true);
    _setStatus('speaking');
    utt.onstart = () => {
      _setStatus('speaking');
      _notifyStatus('speaking', 'Speaking');
    };
    const done = () => {
      setTimeout(() => {
        _setMicPaused(false);
        if (onEnd) onEnd();
        resolve();
      }, SELF_TRANSCRIPT_COOLDOWN_MS);
    };
    utt.onend = done;
    utt.onerror = done;
    window.speechSynthesis.speak(utt);
  });
}

function _showRecognitionDebug(code, message) {
  const panel = _el('atlas-voice-debug');
  const msgEl = _el('atlas-voice-debug-msg');
  const hasError = !!code && code !== 'none' && code !== 'test';
  if (hasError && code) _diag.lastError = code;
  if (panel) panel.classList.toggle('atlas-voice-debug--error', hasError);
  const hint = RECOGNITION_ERROR_HINTS[code] || '';
  if (msgEl) {
    msgEl.textContent = message || (hasError ? (hint || code) : 'No recognition errors yet.');
  }
  _updateLiveDebug();
}

function _clearRecognitionDebug() {
  _showRecognitionDebug('none', 'No recognition errors yet.');
}

function _showSwitchWhisper(show) {
  const btn = _el('atlas-voice-switch-whisper');
  if (btn) btn.classList.toggle('hidden', !show);
}

function _handleRecognitionError(code) {
  _diag.lastError = code;
  _showRecognitionDebug(code, RECOGNITION_ERROR_HINTS[code] || `Speech error: ${code}`);
  _stopRecognition();
  if (code === 'network') {
    _wakeModeEnabled = false;
    _homeConversationActive = false;
    const wakeToggle = _el('atlas-voice-wake-mode');
    if (wakeToggle) wakeToggle.checked = false;
    _homeDeps?.saveSettings?.({ conversation_mode_enabled: false });
    _setStatus('error');
    _showSwitchWhisper(true);
    if (_deps.showToast) _deps.showToast('Browser speech unavailable. Switch to Local Whisper.');
    return;
  }
  _setStatus('error');
  if (_deps.showToast) _deps.showToast(`Speech error: ${code}`);
}

function _updateModeUI() {
  const browserPrivacy = _el('atlas-voice-privacy-browser');
  const whisperPrivacy = _el('atlas-voice-privacy-whisper');
  const wakeNote = _el('atlas-voice-wake-whisper-note');
  const wakeToggleWrap = document.querySelector('.atlas-voice-wake-toggle');
  const modeSel = _el('atlas-voice-stt-mode');
  const startBtn = _el('atlas-voice-start-btn');
  const stopBtn = _el('atlas-voice-stop-btn');
  const pttBtn = _el('atlas-voice-ptt-btn');
  const setupNote = _el('atlas-voice-whisper-setup');
  const convNote = _el('atlas-voice-conversation-note');

  if (modeSel) modeSel.value = _sttMode;
  if (browserPrivacy) browserPrivacy.classList.toggle('hidden', _isWhisperMode());
  if (whisperPrivacy) whisperPrivacy.classList.toggle('hidden', !_isWhisperMode());
  if (wakeNote) wakeNote.classList.toggle('hidden', !_isWhisperMode());
  if (wakeToggleWrap) wakeToggleWrap.classList.toggle('hidden', _isWhisperMode());
  if (convNote) convNote.classList.toggle('hidden', _isWhisperMode());
  if (setupNote) setupNote.classList.toggle('hidden', !_isWhisperMode() || _whisperAvailable !== false);

  const whisper = _isWhisperMode();
  if (startBtn) startBtn.classList.toggle('hidden', whisper);
  if (stopBtn) stopBtn.classList.toggle('hidden', whisper);
  if (pttBtn) pttBtn.classList.toggle('hidden', !whisper);

  if (whisper) {
    if (pttBtn) pttBtn.textContent = _recording ? 'Stop & Send' : 'Click to Talk';
    _showSwitchWhisper(false);
  } else {
    if (startBtn) startBtn.textContent = _wakeModeEnabled ? 'Restart Conversation' : 'Start Listening';
    if (stopBtn) stopBtn.textContent = 'Stop Listening';
  }

  const rate = _el('atlas-voice-tts-rate');
  const pitch = _el('atlas-voice-tts-pitch');
  if (rate) rate.value = String(_ttsRate);
  if (pitch) pitch.value = String(_ttsPitch);

  _syncControlState();
  _updatePrivacyText();
}

function _syncControlState() {
  const startBtn = _el('atlas-voice-start-btn');
  const stopBtn = _el('atlas-voice-stop-btn');
  const pttBtn = _el('atlas-voice-ptt-btn');
  const wakeToggle = _el('atlas-voice-wake-mode');
  const modeSel = _el('atlas-voice-stt-mode');
  const autoToggle = _el('atlas-voice-auto-submit');
  const busy = ['processing', 'speaking', 'greeting', 'wake-detected', 'uploading', 'transcribing', 'returning-standby'].includes(_phase);

  if (autoToggle) autoToggle.checked = _autoSubmit;

  if (_isWhisperMode()) {
    if (pttBtn) pttBtn.disabled = busy && !_recording;
    if (wakeToggle) { wakeToggle.disabled = true; wakeToggle.checked = false; }
    if (modeSel) modeSel.disabled = _recording || busy;
    return;
  }

  const sttOk = _speechSupported();
  const listening = !!_listenMode;
  if (startBtn) startBtn.disabled = !sttOk || listening || busy || _wakeModeEnabled;
  if (stopBtn) stopBtn.disabled = !sttOk || (!listening && !_wakeModeEnabled) || busy;
  if (wakeToggle) {
    wakeToggle.disabled = !sttOk || busy;
    wakeToggle.checked = _wakeModeEnabled;
  }
  if (modeSel) modeSel.disabled = listening || _wakeModeEnabled || busy;
}

function _updateTranscript(text) {
  _transcript = text;
  const ta = _el('atlas-voice-transcript');
  if (ta) ta.value = text;
}

async function _refreshWhisperStatus() {
  try {
    const res = await fetch('/api/atlas/voice/status', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    _whisperAvailable = !!data.whisper_available;
    const setupNote = _el('atlas-voice-whisper-setup');
    if (setupNote) setupNote.classList.toggle('hidden', !_isWhisperMode() || _whisperAvailable !== false);
  } catch (_) {
    _whisperAvailable = null;
  }
}

async function _refreshDesktopStatus() {
  try {
    const res = await fetch('/api/atlas/desktop/status', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    const el = _el('atlas-voice-desktop-status');
    if (el) el.textContent = data.label || 'Desktop Control: Disabled';
  } catch (_) {}
}

function _stopRecognition({ keepMode = false } = {}) {
  _clearCommandTimer();
  _clearWakeRestartTimer();
  _clearNoTranscriptTimer();
  _recognitionActive = false;
  if (_recognition) {
    try { _recognition.stop(); } catch (_) {}
    _recognition.onresult = null;
    _recognition.onend = null;
    _recognition.onerror = null;
    _recognition.onaudiostart = null;
    _recognition.onspeechstart = null;
    _recognition.onstart = null;
    _recognition = null;
  }
  if (!keepMode) _listenMode = null;
  _manualListen = false;
  _updateLiveDebug();
  _syncControlState();
}

function _stopTestRecognition() {
  if (_testTimer) {
    clearTimeout(_testTimer);
    _testTimer = null;
  }
  _diag.testMode = false;
  if (_testRec) {
    try { _testRec.stop(); } catch (_) {}
    _testRec = null;
  }
  _updateLiveDebug();
}

function _restoreEngineAfterTest() {
  const snap = _engineSnapshot;
  _engineSnapshot = null;
  if (!snap) return;
  _homeConversationActive = snap.home;
  _wakeModeEnabled = snap.wake;
  if (snap.home || snap.wake) {
    if (snap.mode === 'wake') _startWakeListening();
    else if (snap.mode === 'command') _startCommandCapture();
    else _startWakeListening();
  } else if (snap.phase && snap.phase !== 'idle') {
    _setStatus(snap.phase);
  }
}

function _stopMediaTracks() {
  if (_mediaStream) {
    _mediaStream.getTracks().forEach(t => t.stop());
    _mediaStream = null;
  }
}

function _stopRecording() {
  _recording = false;
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    try { _mediaRecorder.stop(); } catch (_) {}
  } else {
    _stopMediaTracks();
  }
  _updateModeUI();
}

function _recorderMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function _scheduleCommandFinish() {
  _clearCommandTimer();
  if (!['command-listening', 'listening'].includes(_phase) || _micPaused || _submitting) return;
  _commandSilenceTimer = setTimeout(() => {
    _commandSilenceTimer = null;
    if (['command-listening', 'listening'].includes(_phase)) _finishCommandCapture();
  }, _silenceSubmitMs);
}

function _finishCommandCapture() {
  _clearCommandTimer();
  _stopRecognition();
  const text = (_el('atlas-voice-transcript')?.value || '').trim();
  if (!text) {
    if (_homeConversationActive || _wakeModeEnabled) {
      speakText('I did not catch that, sir.', { onEnd: () => _startFollowUpOrWake() });
    } else {
      _setStatus('idle');
    }
    return;
  }
  if (_handleControlCommand(text)) return;
  _submitToAssistant();
}

async function _onWakeDetected(matchedPhrase = '') {
  if (_wakeHandling) return;
  _wakeHandling = true;
  _debugLastWake = matchedPhrase || 'hey atlas';
  _debug('wake detected', _debugLastWake);
  _updateLiveDebug();

  _stopRecognition();
  _wakeSessionText = '';
  _setMicPaused(true);
  _setStatus('wake-detected');

  const online = _el('atlas-voice-wake-indicator');
  if (online) {
    online.classList.add('atlas-voice-wake-indicator--active');
    online.textContent = 'Wake phrase detected';
  }

  _finalTranscript = '';
  _updateTranscript('');

  _clearCommandStartTimer();
  _commandStartTimer = setTimeout(() => {
    if (!['command-listening', 'listening'].includes(_phase)) {
      _debug('command_listen_failed timeout');
      _showRecognitionDebug('command_listen_failed', 'Command listening failed to start after wake phrase.');
      _setStatus('error');
      _wakeHandling = false;
      _setMicPaused(false);
      _startWakeListening();
    }
  }, COMMAND_START_TIMEOUT_MS);

  try {
    await speakText('Yes sir?', { short: false });
    const started = _startCommandCapture();
    if (!started) {
      _showRecognitionDebug('command_listen_failed', 'Could not start command listening after greeting.');
      _setStatus('error');
      _setMicPaused(false);
      _startWakeListening();
    }
  } catch (err) {
    _debug('wake flow error', err?.message);
    _showRecognitionDebug('command_listen_failed', err?.message || 'Wake flow failed');
    _setStatus('error');
    _setMicPaused(false);
    _startWakeListening();
  } finally {
    _wakeHandling = false;
  }
}

export function simulateWakePhrase() {
  _onWakeDetected('hey atlas (simulated)');
}

function _canRunHomeEngine() {
  return _homeConversationActive || _wakeModeEnabled || _followUpMode;
}

function _startCommandCapture({ fromFollowUp = false } = {}) {
  if (_submitting) return false;
  if (_micPaused) _setMicPaused(false);
  _syncHomeEngineFlags();
  if (!_open && !_canRunHomeEngine()) return false;
  if (_homeDeps?.isPaused?.()) return false;
  _finalTranscript = '';
  _updateTranscript('');
  if (!fromFollowUp) _followUpMode = false;
  _setStatus('command-listening');
  _startRecognition({ mode: 'command', conversation: true });
  _clearCommandStartTimer();
  return true;
}

function _startWakeListening() {
  if (!_speechSupported() || _submitting) return;
  if (_homeDeps?.isPaused?.()) return;
  _syncHomeEngineFlags();
  if (_micPaused) _setMicPaused(false);
  _followUpMode = false;
  _manualListen = false;
  _wakeSessionText = '';
  _finalTranscript = '';
  _updateTranscript('');
  _debugInterim = '';
  _debugFinal = '';
  _startRecognition({ mode: 'wake', conversation: true });
}

function _syncHomeEngineFlags() {
  if (_homeDeps?.isConversationEnabled?.() && window.homeModule?.isHomeActive?.()) {
    _homeConversationActive = true;
    _wakeModeEnabled = true;
    const toggle = _el('atlas-voice-wake-mode');
    if (toggle) toggle.checked = true;
  }
}

function _shouldRestartWake() {
  _syncHomeEngineFlags();
  return _listenMode === 'wake'
    && (_wakeModeEnabled || _homeConversationActive)
    && _phase === 'wake-listening'
    && !_micPaused
    && !_submitting
    && !_wakeHandling
    && !_homeDeps?.isPaused?.();
}

function _scheduleWakeRestart() {
  _clearWakeRestartTimer();
  _wakeRestartTimer = setTimeout(() => {
    _wakeRestartTimer = null;
    if (_shouldRestartWake()) _startWakeListening();
  }, WAKE_RESTART_DELAY_MS);
}

function _handleWakeResult(interim, final) {
  if (_wakeHandling || ['wake-detected', 'greeting', 'speaking', 'processing'].includes(_phase)) return false;

  if (interim) _debugInterim = interim.trim();
  if (final) {
    _debugFinal = final.trim();
    _wakeSessionText = `${_wakeSessionText} ${final}`.trim();
  } else if (interim) {
    _wakeSessionText = `${_wakeSessionText} ${interim}`.trim();
  }
  if (_wakeSessionText.length > 240) {
    _wakeSessionText = _wakeSessionText.slice(-240);
  }
  _updateLiveDebug();

  const candidates = [
    final?.trim(),
    interim?.trim(),
    _wakeSessionText,
    `${_wakeSessionText} ${interim || ''}`.trim(),
  ].filter(Boolean);

  for (const c of candidates) {
    const hit = _findWakePhrase(c);
    if (hit) {
      _diag.lastNormalized = _normalizeTranscript(c);
      _debugLastWake = hit;
      _diagLog('wake-match', `${hit} ← "${c}"`);
      try { _recognition?.stop(); } catch (_) {}
      _onWakeDetected(hit);
      return true;
    }
    if (c) _diag.lastNormalized = _normalizeTranscript(c);
  }
  _updateLiveDebug();
  return false;
}

function _bindRecognitionHandlers(rec, { conversation = false } = {}) {
  rec.onstart = () => {
    _recognitionActive = true;
    _diagLog('onstart', _listenMode);
    _startNoTranscriptWatchdog();
  };

  rec.onaudiostart = () => {
    _diagLog('onaudiostart');
  };

  rec.onspeechstart = () => {
    _diagLog('onspeechstart');
  };

  rec.onresult = (e) => {
    if (_noTranscriptTimer?._markResult) _noTranscriptTimer._markResult();
    _diagLog('onresult', `idx=${e.resultIndex} len=${e.results.length}`);

    if (_submitting) return;

    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }

    const listenMode = _listenMode;
    const allowWhilePaused = listenMode === 'wake' || listenMode === 'command';
    if (_micPaused && !allowWhilePaused) return;

    if (listenMode === 'wake') {
      _handleWakeResult(interim, final);
      return;
    }

    if (final) {
      const chunk = final.trim();
      if (_isLikelySelfTranscription(chunk)) return;
      _debugFinal = chunk;
      _diag.lastNormalized = _normalizeTranscript(chunk);
      const next = `${_finalTranscript} ${chunk}`.trim();
      if (next === _finalTranscript) return;
      _finalTranscript = next;
      _updateTranscript(_finalTranscript);
      _updateLiveDebug();
      if (conversation) _scheduleCommandFinish();
    } else if (interim) {
      if (!_isLikelySelfTranscription(interim)) {
        _debugInterim = interim.trim();
        _diag.lastNormalized = _normalizeTranscript(interim);
        _updateTranscript(`${_finalTranscript} ${interim}`.trim());
        _updateLiveDebug();
      }
    }
  };

  rec.onerror = (ev) => {
    const code = ev.error || 'unknown';
    _diag.lastError = code;
    _recognitionActive = false;
    _diagLog('onerror', code);
    _clearNoTranscriptTimer();
    if (code === 'no-speech') {
      if (_shouldRestartWake()) _scheduleWakeRestart();
      return;
    }
    if (code === 'aborted') return;
    _handleRecognitionError(code);
  };

  rec.onend = () => {
    _recognitionActive = false;
    const endedMode = _listenMode;
    const endedConversation = conversation;
    if (_recognition === rec) _recognition = null;
    _diagLog('onend', endedMode);
    _clearNoTranscriptTimer();
    _updateLiveDebug();

    if (_micPaused || _submitting || _wakeHandling || _diag.testMode) return;

    if (endedMode === 'wake' && _shouldRestartWake()) {
      _scheduleWakeRestart();
      return;
    }

    if (endedMode === 'command' && endedConversation
        && (_phase === 'command-listening' || _phase === 'listening')) {
      if (_followUpMode && !_finalTranscript.trim()) {
        _startCommandCapture();
        return;
      }
      _scheduleCommandFinish();
      return;
    }

    if (_followUpMode && _canRunHomeEngine() && !_homeDeps?.isPaused?.()) {
      _startCommandCapture();
      return;
    }

    if (endedMode === 'command' && _manualListen) {
      setTimeout(() => {
        if (_listenMode === 'command' && _manualListen) {
          _startRecognition({ mode: 'command', conversation: false });
        }
      }, WAKE_RESTART_DELAY_MS);
      return;
    }

    if (!_wakeModeEnabled && !_homeConversationActive) {
      _setStatus('idle');
      _syncControlState();
    }
  };
}

function _startRecognition({ mode = 'command', conversation = false } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (_diag.testMode) _stopTestRecognition();
  if (_micPaused && mode === 'wake') _setMicPaused(false);

  _stopRecognition({ keepMode: true });
  _listenMode = mode;
  _manualListen = !conversation && mode === 'command';

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-GB';

  _bindRecognitionHandlers(rec, { conversation });
  _recognition = rec;

  if (mode === 'wake') {
    _wakeSessionText = '';
    _setStatus('wake-listening');
  } else if (conversation) {
    _setStatus(_followUpMode ? 'listening' : 'command-listening');
  } else {
    _setStatus('listening');
  }

  _syncControlState();

  try {
    rec.start();
    _diagLog('start', `recognition.start() mode=${mode}`);
  } catch (err) {
    _recognitionActive = false;
    _recognition = null;
    _diag.lastError = err?.message || 'start-failed';
    _updateLiveDebug();
    _handleRecognitionError('start-failed');
    if (_deps.showToast) _deps.showToast(`Could not start microphone: ${err?.message || 'unknown'}`);
    if (_shouldRestartWake()) _scheduleWakeRestart();
  }
}

export function runTestRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    _showRecognitionDebug('start-failed', 'SpeechRecognition not supported in this browser.');
    return;
  }

  _stopTestRecognition();
  _engineSnapshot = {
    home: _homeConversationActive,
    wake: _wakeModeEnabled,
    mode: _listenMode,
    phase: _phase,
  };
  _stopRecognition();

  _diag.testMode = true;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-GB';
  _testRec = rec;

  rec.onstart = () => {
    _recognitionActive = true;
    _diagLog('onstart', 'test');
    _showRecognitionDebug('test', 'Test Recognition running — speak now (8 seconds).');
  };
  rec.onaudiostart = () => _diagLog('onaudiostart', 'test');
  rec.onspeechstart = () => _diagLog('onspeechstart', 'test');
  rec.onresult = (e) => {
    _diagLog('onresult', 'test');
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interim) _debugInterim = interim.trim();
    if (final) _debugFinal = final.trim();
    const combined = (final || interim).trim();
    if (combined) {
      _diag.lastNormalized = _normalizeTranscript(combined);
      _updateTranscript(combined);
    }
    _updateLiveDebug();
  };
  rec.onerror = (ev) => {
    _diag.lastError = ev.error || 'unknown';
    _diagLog('onerror', `test: ${ev.error}`);
    _showRecognitionDebug(ev.error, RECOGNITION_ERROR_HINTS[ev.error] || ev.error);
  };
  rec.onend = () => {
    _diagLog('onend', 'test');
    _testRec = null;
    _recognitionActive = false;
    _updateLiveDebug();
  };

  try {
    rec.start();
    _setStatus('listening');
    _testTimer = setTimeout(() => {
      _stopTestRecognition();
      _showRecognitionDebug('test', 'Test Recognition ended (8s). Restoring prior engine state.');
      _restoreEngineAfterTest();
    }, TEST_RECOGNITION_MS);
  } catch (err) {
    _diag.testMode = false;
    _testRec = null;
    _showRecognitionDebug('start-failed', err?.message || 'Test Recognition could not start.');
    _restoreEngineAfterTest();
  }
}

export function forceCommandMode() {
  _stopTestRecognition();
  _wakeHandling = false;
  _homeConversationActive = true;
  _wakeModeEnabled = true;
  const toggle = _el('atlas-voice-wake-mode');
  if (toggle) toggle.checked = true;
  _homeDeps?.saveSettings?.({ conversation_mode_enabled: true });
  _followUpMode = true;
  _setMicPaused(false);
  _diagLog('state-change', 'force command mode');
  _startCommandCapture();
}

async function _startWhisperRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    _setStatus('error');
    return;
  }
  _stopRecognition();
  _audioChunks = [];
  _finalTranscript = '';
  _updateTranscript('');

  try {
    _mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = _recorderMimeType();
    _mediaRecorder = new MediaRecorder(_mediaStream, mimeType ? { mimeType } : {});
    _mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) _audioChunks.push(e.data);
    };
    _mediaRecorder.onstop = () => _uploadWhisperRecording();
    _mediaRecorder.start(250);
    _recording = true;
    _setStatus('recording');
    _updateModeUI();
  } catch (err) {
    _setStatus('error');
    if (_deps.showToast) _deps.showToast(`Microphone denied: ${err?.message || 'unknown'}`);
  }
}

async function _uploadWhisperRecording() {
  _stopMediaTracks();
  _recording = false;
  _updateModeUI();

  if (!_audioChunks.length) {
    _setStatus('idle');
    return;
  }

  const mimeType = _mediaRecorder?.mimeType || 'audio/webm';
  const blob = new Blob(_audioChunks, { type: mimeType });
  _audioChunks = [];
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('audio', blob, `voice.${ext}`);
  form.append('language', 'en');

  _setStatus('uploading');
  try {
    const res = await fetch('/api/atlas/voice/transcribe', {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    _setStatus('transcribing');
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      _whisperAvailable = data.error === 'whisper_not_installed' ? false : _whisperAvailable;
      _updateModeUI();
      _setStatus('error');
      _showRecognitionDebug(data.error || 'transcribe_failed', data.message || 'Transcription failed');
      if (_deps.showToast) _deps.showToast(data.message || 'Transcription failed');
      return;
    }

    const text = (data.text || '').trim();
    _finalTranscript = text;
    _updateTranscript(text);
    _setStatus('transcript-ready');

    if (_autoSubmit && text) {
      _submitToAssistant();
    }
  } catch (err) {
    _setStatus('error');
    _showRecognitionDebug('upload_failed', err?.message || 'Upload failed');
  } finally {
    _syncControlState();
  }
}

function _togglePtt() {
  if (_recording) _stopRecording();
  else _startWhisperRecording();
}

function _startManualListening() {
  if (!_speechSupported()) {
    _setStatus('error');
    return;
  }
  if (_homeDeps?.isConversationEnabled?.() || _homeConversationActive || _wakeModeEnabled) {
    _syncHomeEngineFlags();
    _startWakeListening();
    return;
  }
  _finalTranscript = '';
  _updateTranscript('');
  _startRecognition({ mode: 'command', conversation: false });
}

function _stopManualListening() {
  _stopRecognition();
  const text = (_el('atlas-voice-transcript')?.value || '').trim();
  if (text) _submitToAssistant();
  else {
    _setStatus('idle');
    _syncControlState();
  }
}

async function _returnToWakeStandby() {
  if (_isWhisperMode()) {
    _setStatus('idle');
    _syncControlState();
    return;
  }
  if (_homeDeps?.isPaused?.()) {
    _setStatus('paused');
    _syncControlState();
    return;
  }
  if (!_homeConversationActive && !_wakeModeEnabled) {
    _setStatus('idle');
    _syncControlState();
    return;
  }
  _debug('enter follow-up listening');
  _setMicPaused(false);
  _startFollowUpWindow();
}

export function recoverAfterProcessing() {
  _submitting = false;
  _clearResponseTimeout();
  _setMicPaused(false);
  if (_homeDeps?.isPaused?.()) {
    _setStatus('paused');
    return;
  }
  if (_homeConversationActive || _wakeModeEnabled) {
    _startFollowUpWindow();
  } else {
    _setStatus('idle');
  }
}

function _clearResponseTimeout() {
  if (_responseTimeout) {
    clearTimeout(_responseTimeout);
    _responseTimeout = null;
  }
}

function _handleAssistantResponse(text, { failed = false } = {}) {
  _clearResponseTimeout();
  _submitting = false;
  _debug('assistant response', { failed, len: (text || '').length });

  if (failed || !(text || '').trim()) {
    speakText("Sorry sir, I couldn't complete that request.", {
      onEnd: () => _returnToWakeStandby(),
    });
    return;
  }

  if (_speakReplies) {
    speakText(text, {
      onEnd: () => _returnToWakeStandby(),
    });
  } else {
    _returnToWakeStandby();
  }
}

function _submitToAssistant() {
  const text = (_el('atlas-voice-transcript')?.value || '').trim();
  if (!text || _submitting) {
    if (!text) _returnToWakeStandby();
    return;
  }
  if (text === _lastSubmittedText && Date.now() - _lastSubmittedAt < 4000) {
    _debug('duplicate submit blocked', text.slice(0, 40));
    return;
  }
  _lastSubmittedText = text;
  _lastSubmittedAt = Date.now();

  _submitting = true;
  _setStatus('processing');
  _setMicPaused(true);
  _stopRecognition();
  _stopRecording();

  _clearResponseTimeout();
  _responseTimeout = setTimeout(() => {
    if (_submitting) _handleAssistantResponse('', { failed: true });
  }, RESPONSE_TIMEOUT_MS);

  const onDone = (responseText) => {
    _clearResponseTimeout();
    const failed = !(responseText || '').trim();
    try {
      _handleAssistantResponse(responseText, { failed });
    } finally {
      _submitting = false;
    }
  };

  const useHome = (_homeConversationActive || (_homeDeps?.submitMessage && window.homeModule?.isHomeActive?.()));
  if (useHome && _homeDeps?.submitMessage) {
    _homeDeps.submitMessage(text, {
      onComplete: onDone,
      onError: () => onDone(''),
    }).catch(() => onDone(''));
  } else if (_deps.openAssistant) {
    const stayOnHome = useHome;
    _deps.openAssistant(text, {
      submit: true,
      stayOnHome,
      onComplete: onDone,
    });
  } else {
    _handleAssistantResponse('', { failed: true });
  }

  _finalTranscript = '';
  _updateTranscript('');
}

function _setWakeMode(enabled) {
  if (_isWhisperMode()) return;
  _wakeModeEnabled = enabled;
  const toggle = _el('atlas-voice-wake-mode');
  if (toggle) toggle.checked = enabled;
  const homeConv = _el('atlas-home-conv-mode');
  if (homeConv) homeConv.checked = enabled;
  _homeDeps?.saveSettings?.({ conversation_mode_enabled: enabled });

  if (!enabled) {
    _homeConversationActive = false;
    _followUpMode = false;
    _stopRecognition();
    const online = _el('atlas-voice-wake-indicator');
    if (online) {
      online.classList.remove('atlas-voice-wake-indicator--active');
      online.textContent = '';
    }
    _setStatus('idle');
    _syncControlState();
    return;
  }

  if (!_speechSupported()) {
    _wakeModeEnabled = false;
    if (toggle) toggle.checked = false;
    _setStatus('error');
    return;
  }

  _speakReplies = true;
  const speakToggle = _el('atlas-voice-speak-replies');
  if (speakToggle) speakToggle.checked = true;
  _savePrefs();

  if (window.homeModule?.isHomeActive?.()) {
    _homeConversationActive = true;
  }
  if (_deps.showToast) _deps.showToast('Conversation mode — say a wake phrase');
  const online = _el('atlas-voice-wake-indicator');
  if (online) {
    online.textContent = 'Say “Hey Atlas”…';
  }
  _startWakeListening();
}

function _setSttMode(mode) {
  if (mode !== 'browser' && mode !== 'whisper') return;
  if (_sttMode === mode) return;

  const wasHomeEngine = _homeConversationActive || _wakeModeEnabled;
  _sttMode = mode;
  if (mode === 'whisper') _autoSubmit = true;
  _savePrefs();

  if (mode === 'whisper') {
    _stopRecognition();
    _stopRecording();
  }

  const homeStt = _el('atlas-home-stt-mode');
  if (homeStt) homeStt.value = mode;
  _updateModeUI();

  if (wasHomeEngine && mode === 'browser' && _homeDeps?.isConversationEnabled?.() && !_homeDeps?.isPaused?.()) {
    _homeConversationActive = true;
    _wakeModeEnabled = true;
    _startWakeListening();
  } else if (mode === 'whisper' && wasHomeEngine) {
    _setStatus('idle');
  }
}

export function setSttMode(mode) {
  _setSttMode(mode);
}

export function getSttMode() {
  return _sttMode;
}

function _switchToWhisperMode() {
  _setSttMode('whisper');
  _clearRecognitionDebug();
  if (_deps.showToast) _deps.showToast('Local Whisper — Click to Talk');
}

export function openVoiceMode({ startListening = false, sttMode = null } = {}) {
  _open = true;
  if (sttMode === 'browser' || sttMode === 'whisper') _sttMode = sttMode;

  const modal = _el('atlas-voice-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  _clearRecognitionDebug();
  _populateVoices();
  _refreshWhisperStatus();
  _refreshDesktopStatus();

  const speakToggle = _el('atlas-voice-speak-replies');
  if (speakToggle) speakToggle.checked = _speakReplies;
  const autoToggle = _el('atlas-voice-auto-submit');
  if (autoToggle) autoToggle.checked = _autoSubmit;

  const wakeToggle = _el('atlas-voice-wake-mode');
  if (wakeToggle) wakeToggle.checked = _wakeModeEnabled || _homeConversationActive;

  _renderWakePhrases();
  _updateModeUI();
  _refreshMicPermission();
  _updateLiveDebug();

  const engineRunning = _recognitionActive || _homeConversationActive || _wakeModeEnabled;
  if (!engineRunning) {
    _setStatus('idle');
  } else {
    _updatePrivacyText();
    _syncControlState();
  }

  if (startListening) {
    setTimeout(() => {
      if (_isWhisperMode()) _startWhisperRecording();
      else if (_speechSupported()) _startManualListening();
    }, 120);
  }
}

export function closeVoiceMode() {
  _open = false;
  const settingsOn = _homeDeps?.isConversationEnabled?.() ?? false;
  const keepEngine = (_homeConversationActive || _wakeModeEnabled || settingsOn)
    && !_homeDeps?.isPaused?.()
    && window.homeModule?.isHomeActive?.()
    && !_isWhisperMode();

  const modal = _el('atlas-voice-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  if (keepEngine) {
    _debug('modal closed — engine keeps running');
    _syncHomeEngineFlags();
    const wakeToggle = _el('atlas-voice-wake-mode');
    if (wakeToggle) wakeToggle.checked = true;
    _syncControlState();
    return;
  }

  _wakeModeEnabled = false;
  _homeConversationActive = false;
  _submitting = false;
  _setMicPaused(false);
  _clearCommandTimer();
  _clearResponseTimeout();
  _stopRecognition();
  _stopRecording();
  window.speechSynthesis?.cancel();

  const online = _el('atlas-voice-wake-indicator');
  if (online) {
    online.classList.remove('atlas-voice-wake-indicator--active');
    online.textContent = '';
  }
  const wakeToggle = _el('atlas-voice-wake-mode');
  if (wakeToggle) wakeToggle.checked = false;
  _setStatus('idle');
  _syncControlState();
}

function _renderWakePhrases() {
  const el = _el('atlas-voice-wake-phrases');
  if (!el) return;
  el.innerHTML = _wakePhrases.map(p => `<span class="atlas-voice-wake-chip">${p}</span>`).join('');
}

function _bindEvents() {
  if (_eventsBound) return;
  _eventsBound = true;

  const modal = _el('atlas-voice-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-atlas-voice-close]')) closeVoiceMode();
    });
  }

  _el('atlas-voice-start-btn')?.addEventListener('click', () => {
    if (_wakeModeEnabled) _startWakeListening();
    else _startManualListening();
  });

  _el('atlas-voice-stop-btn')?.addEventListener('click', () => {
    if (_wakeModeEnabled || _homeConversationActive) {
      stopHomeConversation();
      if (_deps.showToast) _deps.showToast('Conversation Mode disabled');
      return;
    }
    _stopManualListening();
  });

  _el('atlas-voice-ptt-btn')?.addEventListener('click', () => _togglePtt());
  _el('atlas-voice-submit-btn')?.addEventListener('click', () => _submitToAssistant());

  _el('atlas-voice-speak-replies')?.addEventListener('change', (e) => {
    _speakReplies = e.target.checked;
    _savePrefs();
    _homeDeps?.saveSettings?.({ speak_replies: _speakReplies });
  });

  _el('atlas-voice-auto-submit')?.addEventListener('change', (e) => {
    _autoSubmit = e.target.checked;
    _savePrefs();
    _homeDeps?.saveSettings?.({ auto_submit: _autoSubmit });
  });

  _el('atlas-voice-tts-voice')?.addEventListener('change', (e) => {
    _selectedVoice = e.target.value;
    _savePrefs();
    _homeDeps?.saveSettings?.({ selected_voice: _selectedVoice });
  });

  _el('atlas-voice-tts-rate')?.addEventListener('input', (e) => {
    _ttsRate = parseFloat(e.target.value) || 0.95;
    _savePrefs();
    _homeDeps?.saveSettings?.({ rate: _ttsRate });
  });

  _el('atlas-voice-tts-pitch')?.addEventListener('input', (e) => {
    _ttsPitch = parseFloat(e.target.value) || 1;
    _savePrefs();
    _homeDeps?.saveSettings?.({ pitch: _ttsPitch });
  });

  _el('atlas-voice-tts-test')?.addEventListener('click', () => {
    speakText('Good evening, Sir. Atlas is online and ready.', { short: false });
  });

  _el('atlas-voice-wake-mode')?.addEventListener('change', (e) => {
    _setWakeMode(e.target.checked);
  });

  _el('atlas-voice-settings-interrupt')?.addEventListener('change', (e) => {
    _interruptionEnabled = e.target.checked;
    _homeDeps?.saveSettings?.({ interruption_enabled: _interruptionEnabled });
  });

  _el('atlas-voice-settings-style')?.addEventListener('change', (e) => {
    _voiceReplyStyle = e.target.value || 'brief';
    _homeDeps?.saveSettings?.({ voice_reply_style: _voiceReplyStyle });
  });

  _el('atlas-voice-stt-mode')?.addEventListener('change', (e) => {
    _setSttMode(e.target.value);
    const homeStt = _el('atlas-home-stt-mode');
    if (homeStt) homeStt.value = e.target.value;
  });

  _el('atlas-voice-switch-whisper')?.addEventListener('click', () => {
    _switchToWhisperMode();
  });

  _el('atlas-voice-debug-simulate-wake')?.addEventListener('click', () => {
    simulateWakePhrase();
  });

  _el('atlas-voice-debug-test')?.addEventListener('click', () => {
    runTestRecognition();
  });

  _el('atlas-voice-debug-force-cmd')?.addEventListener('click', () => {
    forceCommandMode();
  });

  _el('atlas-voice-fallback-whisper')?.addEventListener('click', () => {
    _switchToWhisperMode();
    if (_deps.showToast) _deps.showToast('Local Whisper — Click to Talk');
  });

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = _populateVoices;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _open) closeVoiceMode();
  });
}

export function initAtlasVoiceMode(deps = {}) {
  _deps = deps;
  _loadPrefs();
  _bindEvents();
  _updateModeUI();
  _refreshMicPermission();
  _updateLiveDebug();
  _populateVoices();
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener('voiceschanged', _populateVoices);
  }
}

export function initHomeConversation(homeDeps = {}) {
  _homeDeps = homeDeps;
  const s = homeDeps.settings?.() || {};
  applySettings(s);
}

export function applySettings(s = {}) {
  if (typeof s.speak_replies === 'boolean') _speakReplies = s.speak_replies;
  if (typeof s.auto_submit === 'boolean') _autoSubmit = s.auto_submit;
  if (s.voice_reply_style) _voiceReplyStyle = s.voice_reply_style;
  if (typeof s.interruption_enabled === 'boolean') _interruptionEnabled = s.interruption_enabled;
  if (typeof s.rate === 'number') _ttsRate = s.rate;
  if (typeof s.pitch === 'number') _ttsPitch = s.pitch;
  if (s.selected_voice) _selectedVoice = s.selected_voice;
  if (typeof s.silence_submit_delay_ms === 'number') _silenceSubmitMs = s.silence_submit_delay_ms;
  if (typeof s.follow_up_timeout_ms === 'number') _followUpTimeoutMs = s.follow_up_timeout_ms;
  if (typeof s.conversation_mode_enabled === 'boolean') {
    _wakeModeEnabled = s.conversation_mode_enabled;
    if (s.conversation_mode_enabled && window.homeModule?.isHomeActive?.()) {
      _homeConversationActive = true;
    }
  }
}

export function startHomeConversation() {
  if (_homeDeps?.isPaused?.()) return;
  _homeConversationActive = true;
  _wakeModeEnabled = true;
  const toggle = _el('atlas-voice-wake-mode');
  if (toggle) toggle.checked = true;
  _debug('start home conversation');
  _refreshMicPermission();
  if (_speechSupported() && !_micPaused && !_submitting) _startWakeListening();
  else _syncHomeChip('wake-listening', 'Wake listening');
}

export function stopHomeConversation() {
  _homeConversationActive = false;
  _wakeModeEnabled = false;
  _followUpMode = false;
  _clearFollowUpTimer();
  _stopRecognition();
  const toggle = _el('atlas-voice-wake-mode');
  if (toggle) toggle.checked = false;
  _homeDeps?.saveSettings?.({ conversation_mode_enabled: false });
  _notifyStatus('idle', 'Standby');
}

export function pauseHomeConversation() {
  _micPaused = true;
  _stopRecognition();
  _notifyStatus('paused', 'Paused');
}

export function resumeHomeConversation() {
  _micPaused = false;
  if (_homeConversationActive || _wakeModeEnabled) startHomeConversation();
}

const atlasVoiceMode = {
  initAtlasVoiceMode,
  initHomeConversation,
  applySettings,
  startHomeConversation,
  stopHomeConversation,
  pauseHomeConversation,
  resumeHomeConversation,
  enterFollowUpListening,
  recoverAfterProcessing,
  openVoiceMode,
  closeVoiceMode,
  speakText,
  simulateWakePhrase,
  runTestRecognition,
  forceCommandMode,
  setSttMode,
  getSttMode,
};

export default atlasVoiceMode;

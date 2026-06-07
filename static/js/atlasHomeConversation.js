// Atlas OS — Home conversation log + embedded voice panel (stay on Home)

import atlasVoiceMode from './atlasVoiceMode.js';

const SETTINGS_KEY = 'atlas_voice_settings';
const SETTINGS_VERSION = 3;
const MAX_MESSAGES = 5;
const PROCESSING_TIMEOUT_MS = 60000;

const PREFERRED_VOICE = 'Google UK English Male';

const DEFAULT_SETTINGS = {
  settings_version: SETTINGS_VERSION,
  conversation_mode_enabled: true,
  speak_replies: true,
  auto_submit: true,
  selected_voice: PREFERRED_VOICE,
  rate: 0.8,
  pitch: 1.0,
  voice_reply_style: 'brief',
  interruption_enabled: true,
  follow_up_timeout_ms: 30000,
  silence_submit_delay_ms: 2000,
};

let _deps = {};
let _settings = { ...DEFAULT_SETTINGS };
let _paused = false;
let _messages = [];
let _eventsBound = false;

function _el(id) {
  return document.getElementById(id);
}

function _debug(...args) {
  try {
    if (localStorage.getItem('atlas_voice_debug') === 'true') {
      console.log('[atlas-voice-home]', ...args);
    }
  } catch (_) {}
}

export function loadVoiceSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    if (!stored.settings_version || stored.settings_version < SETTINGS_VERSION) {
      merged.conversation_mode_enabled = true;
      merged.speak_replies = true;
      merged.auto_submit = true;
      merged.rate = DEFAULT_SETTINGS.rate;
      merged.voice_reply_style = DEFAULT_SETTINGS.voice_reply_style;
      merged.follow_up_timeout_ms = DEFAULT_SETTINGS.follow_up_timeout_ms;
      merged.silence_submit_delay_ms = DEFAULT_SETTINGS.silence_submit_delay_ms;
      merged.settings_version = SETTINGS_VERSION;
    }
    return merged;
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveVoiceSettings(patch = {}) {
  _settings = { ..._settings, ...patch, settings_version: SETTINGS_VERSION };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
  } catch (_) {}
  atlasVoiceMode.applySettings?.(_settings);
  _syncSettingsUI();
  return _settings;
}

export function getVoiceSettings() {
  return { ..._settings };
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _timeLabel() {
  try {
    return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function _syncStatusChip(status, label) {
  const chip = _el('atlas-voice-status-chip');
  if (chip) {
    chip.dataset.status = status || 'idle';
    const text = chip.querySelector('.atlas-voice-status-chip-text');
    if (text) text.textContent = label || 'Standby';
  }
  const panelStatus = _el('atlas-home-voice-status');
  if (panelStatus) {
    panelStatus.dataset.status = status || 'idle';
    panelStatus.textContent = label || 'Standby';
  }
  const micOn = ['wake-listening', 'command-listening', 'listening', 'recording'].includes(status);
  const dot = _el('atlas-home-voice-mic-dot');
  if (dot) dot.classList.toggle('atlas-home-voice-mic-dot--active', micOn);
}

export function setVoiceStatus(status, label) {
  _syncStatusChip(status, label);
}

function _trimMessages() {
  while (_messages.length > MAX_MESSAGES) _messages.shift();
}

function _pushMessage(role, text, { processing = false } = {}) {
  if (role === 'user') {
    if (!text) return;
    _messages.push({ role: 'user', text, time: _timeLabel() });
  } else if (processing) {
    const last = _messages[_messages.length - 1];
    if (last?.role === 'atlas' && last?.processing) return;
    _messages.push({ role: 'atlas', text: '', time: _timeLabel(), processing: true });
  } else {
    const procIdx = _messages.findIndex(m => m.role === 'atlas' && m.processing);
    if (procIdx >= 0) {
      _messages[procIdx] = { role: 'atlas', text: text || '', time: _timeLabel(), processing: false };
    } else if (text) {
      const last = _messages[_messages.length - 1];
      if (last?.role === 'atlas' && last.text === text) return;
      _messages.push({ role: 'atlas', text, time: _timeLabel() });
    }
  }
  _trimMessages();
  _renderConversation();
}

function _renderConversation() {
  const log = _el('atlas-conv-log');
  if (!log) return;
  if (!_messages.length) {
    log.innerHTML = '';
    return;
  }
  log.innerHTML = _messages.map(m => {
    const roleLabel = m.role === 'user' ? 'You' : 'Atlas';
    const body = m.processing
      ? '<span class="atlas-conv-spinner"></span> Processing…'
      : _esc(m.text);
    return `
      <div class="atlas-conv-entry atlas-conv-entry--${m.role}${m.processing ? ' atlas-conv-entry--processing' : ''}">
        <span class="atlas-conv-entry-role">${roleLabel}</span>
        <span class="atlas-conv-entry-text">${body}</span>
        ${m.processing ? '' : `<span class="atlas-conv-entry-time">${_esc(m.time)}</span>`}
      </div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}

export function showOverlay({ user = '', reply = '', processing = false } = {}) {
  if (user) _pushMessage('user', user);
  if (processing) _pushMessage('atlas', '', { processing: true });
  else if (reply) _pushMessage('atlas', reply);
}

export function hideOverlay() {}

export function updateOverlayReply(text, { processing = false } = {}) {
  if (processing) _pushMessage('atlas', '', { processing: true });
  else _pushMessage('atlas', text || '');
}

export function clearOverlay() {
  _messages = [];
  _renderConversation();
}

export async function submitHomeMessage(text, { onComplete, onError, skipUi = false } = {}) {
  const msg = (text || '').trim();
  if (!msg || _paused) return false;

  if (!skipUi) {
    _pushMessage('user', msg);
    _pushMessage('atlas', '', { processing: true });
  }
  setVoiceStatus('processing', 'Processing');
  _debug('submit', msg.slice(0, 80));

  if (!_deps.submitChat) {
    setVoiceStatus('error', 'Error');
    if (!skipUi) _pushMessage('atlas', "Sorry sir, chat isn't available.");
    if (onError) onError('Chat pipeline unavailable');
    return false;
  }

  let settled = false;
  const processingTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    _debug('processing timeout');
    if (!skipUi) _pushMessage('atlas', "Sorry sir, that took too long.");
    setVoiceStatus('error', 'Error');
    if (onComplete) onComplete('');
    else atlasVoiceMode.recoverAfterProcessing?.();
    if (onError) onError('timeout');
  }, PROCESSING_TIMEOUT_MS);

  try {
    const reply = await _deps.submitChat(msg, {
      speak: false,
      voiceSettings: _settings,
    });
    if (settled) return false;
    settled = true;
    clearTimeout(processingTimer);

    if (!skipUi) _pushMessage('atlas', reply || '');
    _debug('reply', (reply || '').slice(0, 80));

    if (onComplete) {
      onComplete(reply || '');
      return true;
    }

    if (_settings.speak_replies && reply) {
      setVoiceStatus('speaking', 'Speaking');
      await atlasVoiceMode.speakText?.(reply, { style: _settings.voice_reply_style });
    }
    if (_settings.conversation_mode_enabled && !_paused) {
      atlasVoiceMode.enterFollowUpListening?.();
    } else {
      setVoiceStatus('idle', 'Standby');
    }
    return true;
  } catch (err) {
    if (!settled) {
      settled = true;
      clearTimeout(processingTimer);
      if (!skipUi) _pushMessage('atlas', "Sorry sir, I couldn't complete that request.");
      setVoiceStatus('error', 'Error');
      _debug('submit error', err?.message);
      if (onComplete) onComplete('');
      else atlasVoiceMode.recoverAfterProcessing?.();
      if (onError) onError(err?.message || 'Request failed');
    }
    return false;
  }
}

function _syncSettingsUI() {
  const convIds = ['atlas-voice-wake-mode', 'atlas-home-conv-mode'];
  convIds.forEach(id => {
    const el = _el(id);
    if (el) el.checked = !!_settings.conversation_mode_enabled;
  });
  const speakIds = ['atlas-voice-speak-replies', 'atlas-home-speak-replies'];
  speakIds.forEach(id => {
    const el = _el(id);
    if (el) el.checked = !!_settings.speak_replies;
  });
  const auto = _el('atlas-voice-auto-submit');
  if (auto) auto.checked = !!_settings.auto_submit;
  const interrupt = _el('atlas-voice-settings-interrupt');
  if (interrupt) interrupt.checked = !!_settings.interruption_enabled;
  const style = _el('atlas-voice-settings-style');
  if (style) style.value = _settings.voice_reply_style || 'brief';
  const rate = _el('atlas-voice-tts-rate');
  if (rate) rate.value = String(_settings.rate ?? 0.8);
  const sttIds = ['atlas-voice-stt-mode', 'atlas-home-stt-mode'];
  const sttVal = atlasVoiceMode.getSttMode?.() || 'browser';
  sttIds.forEach(id => {
    const el = _el(id);
    if (el) el.value = sttVal;
  });
  _syncPauseButton();
}

function _syncPauseButton() {
  const btn = _el('atlas-home-voice-pause');
  if (!btn) return;
  btn.textContent = _paused ? 'Resume' : 'Pause';
}

function _bindEvents() {
  if (_eventsBound) return;
  _eventsBound = true;

  _el('atlas-conv-open-assistant')?.addEventListener('click', () => {
    if (_deps.openFullAssistant) _deps.openFullAssistant();
  });

  _el('atlas-conv-clear')?.addEventListener('click', () => clearOverlay());

  _el('atlas-voice-status-chip')?.addEventListener('click', () => {
    atlasVoiceMode.openVoiceMode?.();
  });

  _el('atlas-home-voice-advanced')?.addEventListener('click', () => {
    atlasVoiceMode.openVoiceMode?.();
  });

  const onConvChange = (checked) => {
    saveVoiceSettings({ conversation_mode_enabled: checked });
    if (checked && !_paused) {
      atlasVoiceMode.startHomeConversation?.();
      setVoiceStatus('wake-listening', 'Wake listening');
    } else if (!checked) {
      atlasVoiceMode.stopHomeConversation?.();
      setVoiceStatus('idle', 'Standby');
    }
  };

  _el('atlas-home-conv-mode')?.addEventListener('change', (e) => onConvChange(e.target.checked));

  _el('atlas-home-speak-replies')?.addEventListener('change', (e) => {
    saveVoiceSettings({ speak_replies: e.target.checked });
  });

  _el('atlas-home-voice-restart')?.addEventListener('click', () => {
    _paused = false;
    _syncPauseButton();
    saveVoiceSettings({ conversation_mode_enabled: true });
    atlasVoiceMode.startHomeConversation?.();
    setVoiceStatus('wake-listening', 'Wake listening');
  });

  _el('atlas-home-voice-pause')?.addEventListener('click', () => {
    setPaused(!_paused);
  });

  _el('atlas-home-stt-mode')?.addEventListener('change', (e) => {
    atlasVoiceMode.setSttMode?.(e.target.value);
    const modal = _el('atlas-voice-stt-mode');
    if (modal) modal.value = e.target.value;
  });

  _el('atlas-home-tts-voice')?.addEventListener('change', (e) => {
    saveVoiceSettings({ selected_voice: e.target.value });
    const modal = _el('atlas-voice-tts-voice');
    if (modal) modal.value = e.target.value;
  });
}

export function onHomeShown() {
  _syncSettingsUI();
  if (_settings.conversation_mode_enabled && !_paused) {
    atlasVoiceMode.startHomeConversation?.();
    setVoiceStatus('wake-listening', 'Wake listening');
  } else if (_paused) {
    setVoiceStatus('paused', 'Paused');
  } else {
    setVoiceStatus('idle', 'Standby');
  }
}

export function setPaused(paused) {
  if (_paused === paused) return;
  _paused = paused;
  _syncPauseButton();
  if (_paused) {
    atlasVoiceMode.pauseHomeConversation?.();
    setVoiceStatus('paused', 'Paused');
  } else if (_settings.conversation_mode_enabled) {
    atlasVoiceMode.resumeHomeConversation?.();
    setVoiceStatus('wake-listening', 'Wake listening');
  }
}

export function isPaused() {
  return _paused;
}

export function initAtlasHomeConversation(deps = {}) {
  _deps = deps;
  _settings = loadVoiceSettings();
  if (!_settings.selected_voice) {
    _settings.selected_voice = PREFERRED_VOICE;
  }
  saveVoiceSettings(_settings);
  _syncSettingsUI();
  _bindEvents();
  atlasVoiceMode.initHomeConversation?.({
    settings: () => _settings,
    saveSettings: saveVoiceSettings,
    submitMessage: submitHomeMessage,
    setStatus: setVoiceStatus,
    showOverlay,
    updateOverlayReply,
    isPaused: () => _paused,
    setPaused,
    isConversationEnabled: () => _settings.conversation_mode_enabled,
  });

  if (_settings.conversation_mode_enabled && window.homeModule?.isHomeActive?.()) {
    requestAnimationFrame(() => onHomeShown());
  }
}

const atlasHomeConversation = {
  initAtlasHomeConversation,
  submitHomeMessage,
  showOverlay,
  hideOverlay,
  clearOverlay,
  updateOverlayReply,
  setVoiceStatus,
  getVoiceSettings,
  saveVoiceSettings,
  onHomeShown,
  setPaused,
  isPaused,
};

export default atlasHomeConversation;

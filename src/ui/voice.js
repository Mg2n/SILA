// Voice capture with the Web Speech API. The microphone is requested only when the user presses Start
// (recognition.start() triggers the browser's permission prompt). Every failure maps to a clear message and the
// typed path keeps working. Audio is never stored by SILA; only the text the user keeps.
//
// Test seam for verification: set globalThis.__silaSpeechOverride = null to simulate a browser without the API,
// or to a constructor (e.g. a fake that emits an error) to simulate permission denial or network failure.

import { t } from '../i18n.js';
import { h, nextUid } from './dom.js';
import { icon } from './icons.js';

const ERROR_KEY = {
  'not-allowed': 'voice.denied', 'service-not-allowed': 'voice.denied', 'no-speech': 'voice.noSpeech',
  network: 'voice.network', 'audio-capture': 'voice.noMic',
};

export function speechImpl() {
  if ('__silaSpeechOverride' in globalThis) return globalThis.__silaSpeechOverride;
  return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
}

/**
 * createVoice({ lang, onFinal(text), onInterim(text), onState(listening), onError(messageKey) }) → { supported, start, stop }
 */
export function createVoice({ lang, onFinal, onInterim, onState, onError }) {
  const Impl = speechImpl();
  if (!Impl) return { supported: false, start: () => onError('voice.unsupported'), stop() {} };
  let rec = null;
  let listening = false;
  const setListening = (v) => { listening = v; onState(v); };
  return {
    supported: true,
    start() {
      if (listening) return;
      try {
        rec = new Impl();
        rec.lang = lang;
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = (e) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) onFinal(r[0].transcript.trim());
            else interim += r[0].transcript;
          }
          onInterim(interim.trim());
        };
        rec.onerror = (e) => {
          if (e.error === 'aborted') return;
          onError(ERROR_KEY[e.error] ?? 'voice.failed');
        };
        rec.onend = () => { onInterim(''); setListening(false); };
        rec.start();
        setListening(true);
      } catch {
        setListening(false);
        onError('voice.failed');
      }
    },
    stop() {
      try { rec?.stop(); } catch { /* already stopped */ }
      setListening(false);
    },
  };
}

// ---------- Shared Start/Stop panel (citizen description and crew notes) ----------
// One recognizer at a time; the panel that started it shows its listening state and any error.

const live = { key: null, listening: false, interim: '', errorKey: null, voice: null };

export function stopVoice() {
  live.voice?.stop();
}

/** voicePanel({ key, lang, onFinal(text), rerender, label }) → the Start/Stop row, live status, error and privacy note. */
export function voicePanel({ key, lang, onFinal, rerender, label }) {
  const mine = live.key === key;
  const listening = mine && live.listening;
  const errorKey = mine ? live.errorKey : null;
  const errId = nextUid('voice-error');
  const start = () => {
    live.voice?.stop();
    Object.assign(live, { key, errorKey: null, interim: '' });
    live.voice = createVoice({
      lang,
      onFinal: (text) => { onFinal(text); rerender(); },
      onInterim: (text) => { live.interim = text; rerender(); },
      onState: (on) => { live.listening = on; rerender(); },
      onError: (k) => { live.errorKey = k; live.listening = false; rerender(); },
    });
    live.voice.start();
  };
  return h('section', { class: 'panel voice-panel', 'aria-label': label },
    speechImpl()
      ? h('div', { class: 'voice-row' },
        h('button', { type: 'button', class: ['btn', 'big', listening ? 'danger' : 'primary'], 'data-focus-key': `voice-toggle:${key}`,
          'aria-describedby': errorKey ? errId : null, onclick: () => (listening ? live.voice?.stop() : start()) },
        icon('mic', { size: 20 }), listening ? t('voice.stop') : t('voice.start')),
        h('p', { class: ['voice-status', listening && 'on'], role: 'status' },
          h('span', { class: 'dot', 'aria-hidden': 'true' }), listening ? t('voice.listening') : t('voice.idle'),
          listening && live.interim ? h('em', { text: ` “${live.interim}”` }) : null))
      : h('p', { class: 'notice warn' }, icon('mic', { size: 18 }), h('span', { text: t('voice.unsupported') })),
    errorKey ? h('p', { class: 'form-error', id: errId, role: 'alert', text: t(errorKey) }) : null,
    h('p', { class: 'small muted', text: t('voice.privacy') }));
}

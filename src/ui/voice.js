// Voice capture with the Web Speech API. The microphone is requested only when the user presses Start
// (recognition.start() triggers the browser's permission prompt). Every failure maps to a clear message and the
// typed path keeps working. Audio is never stored by SILA; only the text the user keeps.
//
// Test seam for verification: set globalThis.__silaSpeechOverride = null to simulate a browser without the API,
// or to a constructor (e.g. a fake that emits an error) to simulate permission denial or network failure.

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

'use strict';

/*
 * Lernpodcast – PDF rein, bildlich erklärter Lern-Podcast raus.
 * Läuft komplett im Browser: PDF lesen (pdf.js), Texte schreiben (Gemini oder OpenAI),
 * vorlesen (Gemini, OpenAI oder ElevenLabs), alles gespeichert in IndexedDB.
 */

// pdf.js 3.11.174 und lamejs 1.2.1 liegen selbst gehostet in vendor/ – so geht beim Laden keine IP an Dritte.
const PDFJS = 'vendor/';
const LAMEJS = 'vendor/lame.min.js';
const OPENAI = 'https://api.openai.com/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const ELEVEN = 'https://api.elevenlabs.io/v1';
const MAX_DOC_CHARS = 400000;
const TTS_CHUNK = 3500;
const GEMINI_TTS_CHUNK = 3000;
const MAX_CHAPTERS = 40;
const RATES = [0.8, 1, 1.15, 1.3, 1.5];
const OPENAI_VOICES = ['coral', 'marin', 'cedar', 'nova', 'shimmer', 'sage', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'];
const GEMINI_VOICES = [
  ['Sulafat', 'warm'], ['Achird', 'freundlich'], ['Sadachbia', 'lebendig'], ['Puck', 'fröhlich'], ['Kore', 'bestimmt'],
  ['Charon', 'informativ'], ['Sadaltager', 'kenntnisreich'], ['Aoede', 'locker'], ['Callirrhoe', 'entspannt'], ['Iapetus', 'klar'],
  ['Erinome', 'klar'], ['Vindemiatrix', 'sanft'], ['Achernar', 'weich'], ['Algieba', 'geschmeidig'], ['Despina', 'geschmeidig'],
  ['Schedar', 'ausgeglichen'], ['Gacrux', 'reif'], ['Zephyr', 'hell'], ['Fenrir', 'aufgeregt'], ['Leda', 'jugendlich'], ['Orus', 'bestimmt'],
];

const VOICE_STYLE = 'Sprich Deutsch wie ein warmer, begeisterter Podcast-Host, der einem Freund beim Laufen etwas erklärt: lebendig, natürlich, mit kleinen Pausen an den richtigen Stellen, nicht zu schnell.';
const GEMINI_TTS_STYLE = 'warm, lebendig und natürlich, wie ein begeisterter Podcast-Host, der einem Freund etwas erklärt; ruhiges Tempo';

const SAMPLE_TEXT = 'Heute nehme ich meine Stimme auf, damit mir mein Lernpodcast später alles so erklärt, als würde ich selbst sprechen. Ich lese ruhig, deutlich und ganz natürlich, so wie ich mit einem guten Freund reden würde. Stell dir vor, du stehst früh am Morgen an der Haustür. Die Luft ist kühl, die Straße ist noch leer, und irgendwo singt ein Vogel. Du ziehst die Schuhe fest, atmest tief ein und läufst los. Mit jedem Schritt wird der Kopf ein bisschen freier. Genau in solchen Momenten lernt man oft am besten: Wenn der Körper beschäftigt ist, hört der Kopf aufmerksam zu. Zahlen wie siebzehn, zweihundertfünfzig oder drei Komma fünf klingen dann gar nicht mehr trocken. Fragen wie „Warum ist das so?“ oder „Was passiert eigentlich, wenn …?“ tauchen ganz von selbst auf. Manchmal bin ich begeistert, manchmal nachdenklich, und manchmal muss ich einfach lachen. Und am Ende jeder Runde weiß ich ein kleines Stück mehr als vorher.';

const SYSTEM_PROMPT = `Du bist Autor und Sprecher eines deutschsprachigen Lern-Podcasts. Dein Hörer ist beim Laufen und hat nur die Ohren frei: Er kann nichts sehen, nichts nachlesen und keine Formeln anschauen. Deine Aufgabe ist es, den Inhalt eines Dokuments vollständig, fachlich korrekt und so bildlich zu erklären, dass man ihn wirklich versteht und behält.`;

const SPOKEN_RULES = `Regeln für den Sprechtext:
- Schreib so, wie man spricht: natürliches, lebendiges Deutsch in der Du-Form, wie ein guter Freund, der begeistert erklärt.
- Erkläre alles aus dem Kapitelinhalt ausführlich und fachlich korrekt, gestützt auf das Dokument. Erfinde keine Fakten. Ergänzungen zur Veranschaulichung müssen stimmen.
- Mach es bildlich: Gib jedem wichtigen Begriff ein anschauliches Bild, eine Analogie aus dem Alltag oder eine kleine Szene („Stell dir vor, …“), damit Bilder im Kopf entstehen.
- Gib Halt: Kündige an, worum es geht, mach kurze Zwischenfazits und wiederhole Schlüsselbegriffe.
- Nur für die Ohren: keine Überschriften, keine Aufzählungszeichen, keine Tabellen, kein Markdown, keine Emojis. Formeln, Zahlen, Einheiten, Abkürzungen und Symbole sprichst du aus (zum Beispiel „a hoch zwei“). Tabellen und Abbildungen beschreibst du in Worten.
- Gib nur den Sprechtext aus, sonst nichts.`;

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
const fmtMin = (sec) => Math.max(1, Math.round(sec / 60)) + ' Min.';

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- Speicher (IndexedDB) ---------- */

const db = (() => {
  let opening;
  const open = () => opening || (opening = new Promise((res, rej) => {
    const r = indexedDB.open('lernpodcast', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('docs', { keyPath: 'id' });
      d.createObjectStore('audio');
      d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    put: (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
    keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  };
})();

const DEFAULTS = {
  textProvider: 'gemini', geminiKey: '', geminiModel: 'gemini-3.8-flash', geminiTtsModel: 'gemini-3.8-flash-tts', geminiVoice: 'Sulafat',
  openaiKey: '', model: 'gpt-6.1-terra', voiceProvider: 'gemini', voice: 'coral', elKey: '', elVoice: '', rate: 1,
};
const usesGemini = () => settings.textProvider === 'gemini';
const hasTextKey = () => !!(usesGemini() ? settings.geminiKey : settings.openaiKey);
const missingKeyMsg = () => `Bitte zuerst den ${usesGemini() ? 'Gemini' : 'OpenAI'}-Schlüssel in den Einstellungen eintragen.`;
let settings = { ...DEFAULTS };
async function loadSettings() {
  try { settings = { ...DEFAULTS, ...((await db.get('kv', 'settings')) || {}) }; } catch (e) { console.warn(e); }
}
const saveSettings = () => db.put('kv', { ...settings }, 'settings');

const docs = new Map();
async function loadDocs() {
  for (const d of await db.all('docs')) docs.set(d.id, d);
}
const saveDoc = (doc) => db.put('docs', doc).catch((e) => console.warn('saveDoc', e));

// Blobs werden als ArrayBuffer gespeichert – das ist in Safari am zuverlässigsten.
async function putAudio(key, blob) { await db.put('audio', { buf: await blob.arrayBuffer(), type: blob.type }, key); }
async function getAudio(key) {
  const v = await db.get('audio', key);
  return v ? new Blob([v.buf], { type: v.type }) : null;
}
async function deleteAudioPrefix(prefix) {
  for (const k of await db.keys('audio')) if (String(k).startsWith(prefix)) await db.del('audio', k);
}

/* ---------- Schnittstellen (OpenAI / ElevenLabs) ---------- */

function friendlyError(status, body, label) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j.error?.message || j.detail?.message || (typeof j.detail === 'string' ? j.detail : '') || '';
  } catch { msg = String(body || '').slice(0, 200); }
  if (status === 401 || /API_KEY_INVALID|API key not valid/i.test(body)) return `${label}: Der Schlüssel wird nicht akzeptiert. Bitte in den Einstellungen prüfen.`;
  if (status === 429 && isDailyLimit(body)) return `${label}: Das Tageslimit der kostenlosen Gemini-Stufe ist erreicht. Morgen einfach auf „Erstellung fortsetzen“ tippen – es geht dort weiter, wo es aufgehört hat.`;
  if (status === 429 && /limit: 0\b/i.test(body)) return `${label}: Dieses Modell gibt es in der kostenlosen Stufe nicht – bitte in den Einstellungen ein anderes wählen. (${msg})`;
  if (status === 429 && /insufficient_quota|billing|credit/i.test(body)) return `${label}: Kein Guthaben mehr auf dem Konto.`;
  if (/instant_voice_cloning|can_not_use|subscription/i.test(body)) return `${label}: Dein ElevenLabs-Abo erlaubt das nicht (Stimmen-Klonen gibt es ab dem Starter-Abo). ${msg}`;
  if (status === 404 && /model/i.test(msg)) return `${label}: Dieses Modell gibt es nicht – bitte in den Einstellungen ein anderes wählen. (${msg})`;
  return `${label}: Fehler ${status}. ${msg}`;
}

const isDailyLimit = (body) => /PerDay|per_day|requests per day/i.test(body || '');

async function apiFetch(url, opts, label) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`${label}: Keine Verbindung zum Internet.`);
    }
    if (res.ok) return res;
    let body = '';
    try { body = await res.text(); } catch { /* egal */ }
    // Minutenlimits (v. a. Gemini-Gratisstufe) abwarten; Tageslimit und fehlendes Guthaben nicht.
    const final = isDailyLimit(body) || /insufficient_quota|billing|limit: 0\b/i.test(body);
    if ((res.status === 429 || res.status >= 500) && attempt < 6 && !final) {
      const hint = /"retryDelay":\s*"(\d+)/.exec(body);
      await sleep(hint ? (+hint[1] + 1) * 1000 : 4000 * (attempt + 1));
      continue;
    }
    const err = new Error(friendlyError(res.status, body, label));
    err.status = res.status;
    err.body = body;
    throw err;
  }
}

const openaiHeaders = (json = true) => ({
  Authorization: `Bearer ${settings.openaiKey}`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

const geminiHeaders = () => ({ 'x-goog-api-key': settings.geminiKey, 'Content-Type': 'application/json' });

// Nachrichten kommen im OpenAI-Format ({role, content}); für Gemini werden sie umgebaut.
function chat(messages, opts = {}) {
  return usesGemini() ? geminiChat(messages, opts) : openaiChat(messages, opts);
}

function toGeminiPart(p) {
  if (p.type === 'text') return { text: p.text };
  if (p.type === 'audio') return { inlineData: { mimeType: p.mime, data: p.data } };
  const [head, data] = p.image_url.url.split(',');
  return { inlineData: { mimeType: head.slice(5, head.indexOf(';')), data } };
}

async function geminiChat(messages, { json = false, maxTokens = 32000 } = {}) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts = typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(toGeminiPart);
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  }
  const body = { contents, generationConfig: { maxOutputTokens: Math.min(maxTokens, 65536) } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const url = `${GEMINI}/models/${encodeURIComponent(settings.geminiModel)}:generateContent`;
  const res = await apiFetch(url, { method: 'POST', headers: geminiHeaders(), body: JSON.stringify(body) }, 'KI');
  const j = await res.json();
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text.trim()) {
    if (j.promptFeedback?.blockReason) throw new Error(`KI: Die Anfrage wurde von Google blockiert (${j.promptFeedback.blockReason}).`);
    throw new Error('KI: Leere Antwort erhalten' + (cand?.finishReason === 'MAX_TOKENS' ? ' (Text zu lang).' : '.'));
  }
  return text;
}

async function openaiChat(messages, { json = false, maxTokens = 32000, effort = 'low' } = {}) {
  const body = { model: settings.model, messages, max_completion_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  if (effort && /^(gpt-5|gpt-6|o\d)/.test(settings.model)) body.reasoning_effort = effort;
  for (let tries = 0; tries < 4; tries++) {
    try {
      const res = await apiFetch(`${OPENAI}/chat/completions`, { method: 'POST', headers: openaiHeaders(), body: JSON.stringify(body) }, 'KI');
      const j = await res.json();
      const choice = j.choices?.[0];
      const text = choice?.message?.content || '';
      if (!text.trim()) throw new Error('KI: Leere Antwort erhalten' + (choice?.finish_reason === 'length' ? ' (Text zu lang).' : '.'));
      return text;
    } catch (e) {
      // Ältere/andere Modelle kennen manche Parameter nicht – dann ohne sie nochmal.
      if (e.status === 400 && body.reasoning_effort && /reasoning/i.test(e.body)) { delete body.reasoning_effort; continue; }
      if (e.status === 400 && body.response_format && /response_format/i.test(e.body)) { delete body.response_format; continue; }
      if (e.status === 400 && body.max_completion_tokens && /max_completion_tokens|max_tokens/i.test(e.body)) {
        body.max_tokens = Math.min(body.max_completion_tokens, 16000);
        delete body.max_completion_tokens;
        continue;
      }
      throw e;
    }
  }
  throw new Error('KI: Anfrage wurde mehrmals abgelehnt.');
}

function splitForTts(text, max = TTS_CHUNK) {
  const pieces = text.match(/[^.!?…\n]+(?:[.!?…]+|\n+|$)\s*/g) || [text];
  const out = [];
  let cur = '';
  for (let p of pieces) {
    if ((cur + p).length > max && cur.trim()) { out.push(cur.trim()); cur = ''; }
    while (p.length > max) { out.push(p.slice(0, max)); p = p.slice(max); }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Entfernt ID3-Tags und den Xing/Info-Rahmen, damit aneinandergehängte MP3-Teile
// in Safari mit korrekter Gesamtlänge abgespielt werden.
function mp3FrameLen(b, o) {
  const h1 = b[o + 1], h2 = b[o + 2];
  const ver = (h1 >> 3) & 3, layer = (h1 >> 1) & 3;
  if (layer !== 1) return 0;
  const bri = (h2 >> 4) & 15, sri = (h2 >> 2) & 3, pad = (h2 >> 1) & 1;
  const br1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const br2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[ver];
  if (!rates || sri === 3 || bri === 0 || bri === 15) return 0;
  const br = (ver === 3 ? br1 : br2)[bri] * 1000;
  return ver === 3 ? Math.floor((144 * br) / rates[sri]) + pad : Math.floor((72 * br) / rates[sri]) + pad;
}
function stripMp3Headers(buf) {
  const b = new Uint8Array(buf);
  let off = 0, end = b.length;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    off = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  }
  let sync = off;
  while (sync < Math.min(b.length - 4, off + 4096) && !(b[sync] === 0xff && (b[sync + 1] & 0xe0) === 0xe0)) sync++;
  if (sync >= Math.min(b.length - 4, off + 4096)) return b; // kein MP3 erkannt – unverändert lassen
  off = sync;
  const len = mp3FrameLen(b, off);
  if (len) {
    const head = String.fromCharCode(...b.subarray(off, Math.min(off + 200, b.length)));
    if (/Xing|Info|VBRI/.test(head)) off += len;
  }
  if (end - off > 128 && b[end - 128] === 0x54 && b[end - 127] === 0x41 && b[end - 126] === 0x47) end -= 128;
  return b.subarray(off, end);
}

/* Gemini-Stimme: liefert rohes PCM (oder WAV), das hier zu MP3 wird – sonst wären die Dateien ca. 6× so groß. */

function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// Sucht in der Antwort nach den base64-Audiodaten – die Feldnamen unterscheiden sich je nach Schnittstelle.
function findAudio(o) {
  if (!o || typeof o !== 'object') return null;
  const mime = o.mime_type || o.mimeType || '';
  if (typeof o.data === 'string' && o.data.length > 100 && (/audio/i.test(mime) || o.type === 'audio')) return { data: o.data, mime };
  for (const v of Object.values(o)) {
    const found = findAudio(v);
    if (found) return found;
  }
  return null;
}

function pcmFromAudio({ data, mime }) {
  const b = b64ToBytes(data);
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) { // WAV
    const v = new DataView(b.buffer);
    let rate = 24000, off = 12;
    while (off + 8 <= b.length) {
      const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
      const size = v.getUint32(off + 4, true);
      if (id === 'fmt ') rate = v.getUint32(off + 12, true);
      if (id === 'data') {
        const len = Math.min(size, b.length - off - 8);
        return { pcm: new Int16Array(b.buffer.slice(off + 8, off + 8 + len - (len % 2))), rate };
      }
      off += 8 + size + (size % 2);
    }
  }
  const rate = +(/rate=(\d+)/i.exec(mime)?.[1] || 24000);
  return { pcm: new Int16Array(b.buffer.slice(0, b.length - (b.length % 2))), rate };
}

let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  return lameLoading || (lameLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = LAMEJS;
    s.onload = () => res();
    s.onerror = () => { lameLoading = null; rej(new Error('Stimme: Der MP3-Baustein konnte nicht geladen werden (Internet?).')); };
    document.head.appendChild(s);
  }));
}

async function pcmToMp3({ pcm, rate }) {
  await loadLame();
  const enc = new lamejs.Mp3Encoder(1, rate, 64);
  const out = [];
  for (let i = 0, n = 0; i < pcm.length; i += 1152, n++) {
    const chunk = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (chunk.length) out.push(new Uint8Array(chunk));
    if (n % 400 === 399) await sleep(0); // Bedienung bleibt flüssig
  }
  const tail = enc.flush();
  if (tail.length) out.push(new Uint8Array(tail));
  return new Blob(out);
}

async function geminiTtsPart(text) {
  if (!settings.geminiKey) throw new Error('Stimme: Für die Gemini-Stimme fehlt der Gemini-Schlüssel (Einstellungen).');
  let j;
  try {
    const res = await apiFetch(`${GEMINI}/interactions`, {
      method: 'POST',
      headers: geminiHeaders(),
      body: JSON.stringify({
        model: settings.geminiTtsModel,
        input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: GEMINI_TTS_STYLE }] }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: settings.geminiVoice }] },
      }),
    }, 'Stimme');
    j = await res.json();
  } catch (e) {
    if (e.status !== 400 && e.status !== 404) throw e;
    // Ältere Schnittstelle als Ersatz
    try {
      const res = await apiFetch(`${GEMINI}/models/${encodeURIComponent(settings.geminiTtsModel)}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(),
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Lies ${GEMINI_TTS_STYLE} vor: ${text}` }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.geminiVoice } } } },
        }),
      }, 'Stimme');
      j = await res.json();
    } catch { throw e; }
  }
  const audio = findAudio(j);
  if (!audio) throw new Error('Stimme: Gemini hat keine Audiodaten geliefert.');
  return pcmToMp3(pcmFromAudio(audio));
}

async function ttsPart(text) {
  if (settings.voiceProvider === 'gemini') return (await geminiTtsPart(text)).arrayBuffer();
  if (settings.voiceProvider === 'eleven') {
    if (!settings.elKey || !settings.elVoice) throw new Error('Stimme: Für die eigene Stimme fehlen ElevenLabs-Schlüssel oder Voice-ID (Einstellungen).');
    const res = await apiFetch(`${ELEVEN}/text-to-speech/${encodeURIComponent(settings.elVoice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': settings.elKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    }, 'Stimme');
    return res.arrayBuffer();
  }
  if (!settings.openaiKey) throw new Error('Stimme: Für die OpenAI-Stimme fehlt der OpenAI-Schlüssel (Einstellungen).');
  const res = await apiFetch(`${OPENAI}/audio/speech`, {
    method: 'POST',
    headers: openaiHeaders(),
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: settings.voice, input: text, response_format: 'mp3', instructions: VOICE_STYLE }),
  }, 'Stimme');
  return res.arrayBuffer();
}

async function tts(text) {
  const parts = [];
  const max = settings.voiceProvider === 'gemini' ? GEMINI_TTS_CHUNK : TTS_CHUNK;
  for (const piece of splitForTts(text, max)) parts.push(stripMp3Headers(await ttsPart(piece)));
  return new Blob(parts, { type: 'audio/mpeg' });
}

// iPhone-Aufnahmen (AAC/MP4) nimmt Gemini nicht sicher an – daher in ein kleines WAV (16 kHz, mono) umwandeln.
async function toWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close?.(); }
  const rate = 16000;
  const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const samples = (await off.startRendering()).getChannelData(0);
  const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(b);
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function transcribe(blob, ext) {
  if (usesGemini()) {
    const wav = await toWav16k(blob);
    const text = await geminiChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Schreibe genau auf, was in dieser Sprachaufnahme gesagt wird (meist Deutsch). Gib nur den gesprochenen Text aus, ohne Kommentar. Wenn nichts gesagt wird, antworte mit einem einzelnen Bindestrich.' },
        { type: 'audio', mime: 'audio/wav', data: bytesToB64(wav) },
      ],
    }], { maxTokens: 4000 });
    return text.trim() === '-' ? '' : text.trim();
  }
  const fd = new FormData();
  fd.append('file', blob, 'frage.' + ext);
  fd.append('model', 'gpt-4o-mini-transcribe');
  fd.append('language', 'de');
  const res = await apiFetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: openaiHeaders(false), body: fd }, 'Spracherkennung');
  return ((await res.json()).text || '').trim();
}

/* ---------- PDF lesen ---------- */

async function extractPdf(buf, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let s = '';
    for (const it of tc.items) s += it.str + (it.hasEOL ? '\n' : ' ');
    pages.push(s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim());
    onProgress(i, pdf.numPages);
  }
  const chars = pages.join('').replace(/\s/g, '').length;
  return { pdf, pages, scanned: chars < pdf.numPages * 80 };
}

async function renderPage(pdf, n) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1.6 });
  const c = document.createElement('canvas');
  c.width = vp.width;
  c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const url = c.toDataURL('image/jpeg', 0.75);
  c.width = c.height = 0;
  return url;
}

// Für eingescannte PDFs ohne Textebene: Seiten als Bild an die KI geben und abschreiben lassen.
async function ocrPdf(pdf, onProgress) {
  const max = Math.min(pdf.numPages, 80);
  const texts = [];
  for (let i = 1; i <= max; i += 3) {
    const nums = [];
    for (let j = i; j < Math.min(i + 3, max + 1); j++) nums.push(j);
    const content = [{ type: 'text', text: 'Schreibe den gesamten Text dieser Seiten exakt ab. Beschreibe Abbildungen, Diagramme und Tabellen kurz in Worten. Gib nur den Inhalt aus, keine Kommentare.' }];
    for (const n of nums) content.push({ type: 'image_url', image_url: { url: await renderPage(pdf, n) } });
    texts.push(`[Seiten ${nums[0]}–${nums[nums.length - 1]}]\n` + (await chat([{ role: 'user', content }], { maxTokens: 16000 })));
    onProgress(nums[nums.length - 1], max);
  }
  return texts.join('\n\n');
}

/* ---------- Podcast erstellen ---------- */

const running = new Set();

function docMessages(doc, text) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Hier ist das Dokument „${doc.fileName}“:\n\n<dokument>\n${text}\n</dokument>` },
  ];
}

function cleanSpoken(s) {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJson(s) {
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

async function makeOutline(doc, text) {
  const task = `Plane den Lern-Podcast zu diesem Dokument. Teile den Inhalt in Kapitel auf – so viele wie nötig, damit wirklich alles Wichtige ausführlich erklärt wird. Lieber ein Kapitel mehr, als etwas wegzulassen. Ein Kapitel entspricht etwa 6 bis 10 Minuten gesprochenem Text. Folge der Logik des Stoffs: Grundlagen zuerst, dann darauf aufbauen.

Antworte nur mit JSON in genau dieser Form:
{"title": "kurzer, griffiger Titel des Podcasts", "chapters": [{"title": "Kapitelname", "focus": "Was genau in diesem Kapitel erklärt wird: alle Begriffe, Zusammenhänge, Zahlen und Beispiele aus dem Dokument, stichpunktartig und vollständig"}]}`;
  const out = parseJson(await chat([...docMessages(doc, text), { role: 'user', content: task }], { json: true }));
  const chapters = (out.chapters || []).filter((c) => c && c.title).slice(0, MAX_CHAPTERS);
  if (!chapters.length) throw new Error('KI: Konnte keine Kapitel planen. Bitte nochmal versuchen.');
  return { title: String(out.title || doc.title), chapters };
}

async function writeChapter(doc, text, i) {
  const ch = doc.chapters[i];
  const n = doc.chapters.length;
  const overview = doc.chapters.map((c, k) => `${k + 1}. ${c.title}`).join('\n');
  const position = n === 1
    ? 'Es ist das einzige Kapitel: Beginne mit einer kurzen, motivierenden Einleitung ins Thema und ende mit einer Zusammenfassung des ganzen Stoffs.'
    : i === 0
      ? 'Es ist das erste Kapitel: Beginne mit einer kurzen, motivierenden Einleitung ins ganze Thema und sag kurz, was den Hörer erwartet.'
      : i === n - 1
        ? 'Es ist das letzte Kapitel: Beginne mit einer kurzen Brücke zum vorherigen Kapitel und ende mit einer Zusammenfassung des ganzen Stoffs.'
        : 'Beginne mit einer kurzen Brücke zum vorherigen Kapitel (ohne es zu wiederholen).';
  const task = `Schreibe jetzt den gesprochenen Text für Kapitel ${i + 1} von ${n}: „${ch.title}“ (Podcast: „${doc.title}“).

Inhalt dieses Kapitels: ${ch.focus || ch.title}

Alle Kapitel im Überblick, damit du weißt, was schon kam und was noch kommt:
${overview}

${position}
Ende das Kapitel mit einem einprägsamen Merksatz und einer kleinen Denkfrage, über die man beim Laufen nachdenken kann.
Länge: etwa 1000 bis 1500 Wörter. Wenn der Stoff mehr braucht, schreib mehr.

${SPOKEN_RULES}`;
  return cleanSpoken(await chat([...docMessages(doc, text), { role: 'user', content: task }]));
}

function blobDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      res(isFinite(d) ? d : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 6000);
    a.src = url;
  });
}
const estimateDuration = (script) => (script.split(/\s+/).length / 150) * 60;

async function pool(items, n, fn) {
  let next = 0, failed = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try { await fn(item); } catch (e) { failed = failed || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failed) throw failed;
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* nicht unterstützt */ }
}
function allowSleep() {
  if (!running.size && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function changed(doc) {
  saveDoc(doc);
  scheduleRender();
}

async function generate(doc) {
  if (running.has(doc.id)) return;
  if (!hasTextKey()) { toast(missingKeyMsg()); return; }
  running.add(doc.id);
  keepAwake();
  doc.error = null;
  try {
    let text = await db.get('kv', 'text:' + doc.id);
    if (!text) {
      doc.status = 'extracting';
      changed(doc);
      const buf = await db.get('kv', 'pdf:' + doc.id);
      if (!buf) throw new Error('Die PDF-Datei ist nicht mehr gespeichert. Bitte neu hochladen.');
      if (!window.pdfjsLib) throw new Error('Der PDF-Leser konnte nicht geladen werden (Internet?).');
      const ex = await extractPdf(buf, (i, n) => { doc.statusText = `PDF wird gelesen … Seite ${i} von ${n}`; doc.extractProgress = i / n; scheduleRender(); });
      doc.pageCount = ex.pages.length;
      if (ex.scanned) {
        text = await ocrPdf(ex.pdf, (i, n) => { doc.statusText = `Eingescanntes PDF – Text wird erkannt … Seite ${i} von ${n}`; doc.extractProgress = i / n; scheduleRender(); });
      } else {
        text = ex.pages.map((p, k) => `[Seite ${k + 1}]\n${p}`).join('\n\n');
      }
      if (!text.replace(/\s/g, '')) throw new Error('In diesem PDF wurde kein Text gefunden.');
      text = text.slice(0, MAX_DOC_CHARS);
      await db.put('kv', text, 'text:' + doc.id);
    }

    if (!doc.chapters) {
      doc.status = 'planning';
      changed(doc);
      const outline = await makeOutline(doc, text);
      doc.title = outline.title;
      doc.chapters = outline.chapters.map((c) => ({ title: String(c.title), focus: String(c.focus || ''), script: null, hasAudio: false, duration: 0 }));
    }

    doc.status = 'writing';
    changed(doc);
    const todo = doc.chapters.map((c, i) => i).filter((i) => !doc.chapters[i].hasAudio);
    await pool(todo, 2, async (i) => {
      const ch = doc.chapters[i];
      if (!ch.script) { ch.script = await writeChapter(doc, text, i); changed(doc); }
      const blob = await tts(ch.script);
      await putAudio(`${doc.id}:${i}`, blob);
      ch.duration = (await blobDuration(blob)) || estimateDuration(ch.script);
      ch.hasAudio = true;
      changed(doc);
      if (cur.docId === doc.id && cur.waitingFor === i) loadChapter(doc, i, 0, true);
    });

    doc.status = 'ready';
    await db.del('kv', 'pdf:' + doc.id); // Text ist gesichert, das PDF selbst brauchen wir nicht mehr
    changed(doc);
    if (view.name !== 'doc' || view.docId !== doc.id) toast(`„${doc.title}“ ist fertig.`);
  } catch (e) {
    console.error(e);
    doc.status = 'error';
    doc.error = e.message || String(e);
    changed(doc);
  } finally {
    running.delete(doc.id);
    allowSleep();
    scheduleRender();
  }
}

function docProgress(d) {
  if (d.status === 'ready') return 1;
  if (!d.chapters) return d.status === 'planning' ? 0.12 : (d.extractProgress || 0) * 0.1;
  const steps = d.chapters.reduce((s, c) => s + (c.script ? 1 : 0) + (c.hasAudio ? 1 : 0), 0);
  return 0.15 + (0.85 * steps) / (2 * d.chapters.length);
}
const totalDuration = (d) => (d.chapters || []).reduce((s, c) => s + (c.duration || 0), 0);

function docStatusText(d) {
  const isRunning = running.has(d.id);
  switch (d.status) {
    case 'extracting': return isRunning ? d.statusText || 'PDF wird gelesen …' : 'Pausiert – antippen zum Fortsetzen';
    case 'planning': return isRunning ? 'Inhalt wird verstanden und in Kapitel aufgeteilt …' : 'Pausiert – antippen zum Fortsetzen';
    case 'writing': {
      const done = d.chapters.filter((c) => c.hasAudio).length;
      return isRunning ? `Kapitel werden erstellt: ${done} von ${d.chapters.length} fertig` : `Pausiert: ${done} von ${d.chapters.length} Kapiteln fertig`;
    }
    case 'ready': {
      const t = totalDuration(d);
      return `${d.chapters.length} Kapitel` + (t ? ` · ca. ${fmtMin(t)}` : '') + (d.finished ? ' · gehört ✓' : '');
    }
    case 'error': return 'Unterbrochen – antippen zum Fortsetzen';
    default: return '';
  }
}

/* ---------- Abspielen ---------- */

const player = $('#player');
const cur = { docId: null, chapter: 0, mode: 'idle', waitingFor: null, resume: null };
let currentUrl = null;
let unlocked = false;

const SILENT_WAV = (() => {
  const n = 800, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(b, 44).fill(128);
  let s = '';
  new Uint8Array(b).forEach((x) => { s += String.fromCharCode(x); });
  return 'data:audio/wav;base64,' + btoa(s);
})();

// iOS erlaubt Ton nur nach einer Berührung. Einmal „freigeschaltet“, darf das
// Audio-Element später auch von selbst weiterspielen (nächstes Kapitel, Antworten).
function unlockAudio(el = player) {
  if (el === player && unlocked) return;
  if (!el.src || el.src.startsWith('data:')) el.src = SILENT_WAV;
  const wasSilent = el.src.startsWith('data:');
  const p = el.play();
  if (el === player) unlocked = true;
  if (p) p.then(() => { if (wasSilent && el.src.startsWith('data:')) el.pause(); }).catch(() => { if (el === player) unlocked = false; });
}

async function safePlay() {
  try { await player.play(); } catch (e) { console.warn('play', e); toast('Zum Abspielen bitte auf ▶ tippen.'); }
}

function setSource(blob) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  player.src = currentUrl;
  player.load();
}

function waitMeta() {
  return new Promise((res) => {
    if (player.readyState >= 1) return res();
    const on = () => { player.removeEventListener('loadedmetadata', on); res(); };
    player.addEventListener('loadedmetadata', on);
    setTimeout(res, 5000);
  });
}

function setMediaMeta(title, artist) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist, album: 'Lernpodcast',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch { /* egal */ }
}

async function loadChapter(doc, i, time = 0, autoplay = false) {
  cur.docId = doc.id;
  cur.chapter = i;
  cur.waitingFor = null;
  const blob = doc.chapters?.[i]?.hasAudio ? await getAudio(`${doc.id}:${i}`) : null;
  if (!blob) {
    cur.mode = 'idle';
    if (autoplay) cur.waitingFor = i;
    player.pause();
    updatePlayerUI();
    return false;
  }
  cur.mode = 'podcast';
  setSource(blob);
  await waitMeta();
  if (time > 0 && time < (player.duration || Infinity) - 1) player.currentTime = time;
  player.playbackRate = settings.rate;
  setMediaMeta(`Kapitel ${i + 1}: ${doc.chapters[i].title}`, doc.title);
  if (autoplay) await safePlay();
  updatePlayerUI();
  return true;
}

function rememberPosition() {
  if (cur.mode === 'podcast') cur.resume = { chapter: cur.chapter, time: player.currentTime };
}

async function resumePodcast(autoplay) {
  const doc = docs.get(cur.docId);
  if (!doc) return;
  const r = cur.resume || doc.position || { chapter: 0, time: 0 };
  cur.resume = null;
  await loadChapter(doc, r.chapter, Math.max(0, r.time - 3), autoplay);
}

async function playAnswer(doc, blob) {
  cur.docId = doc.id;
  cur.mode = 'answer';
  cur.waitingFor = null;
  setSource(blob);
  await waitMeta();
  player.playbackRate = settings.rate;
  setMediaMeta('Antwort auf deine Frage', doc.title);
  await safePlay();
  updatePlayerUI();
}

player.addEventListener('ended', async () => {
  const doc = docs.get(cur.docId);
  if (!doc) return;
  if (cur.mode === 'answer') { await resumePodcast(true); return; }
  if (cur.mode !== 'podcast') return;
  const next = cur.chapter + 1;
  if (next < doc.chapters.length) {
    doc.position = { chapter: next, time: 0 };
    saveDoc(doc);
    const ok = await loadChapter(doc, next, 0, true);
    if (!ok) toast(`Kapitel ${next + 1} wird noch erstellt – es startet automatisch, sobald es fertig ist.`, 6000);
  } else {
    doc.position = { chapter: 0, time: 0 };
    doc.finished = true;
    saveDoc(doc);
    cur.mode = 'idle';
    toast('Geschafft! Du hast den ganzen Podcast gehört.', 5000);
    updatePlayerUI();
  }
});

let lastSave = 0;
player.addEventListener('timeupdate', () => {
  if (cur.mode === 'podcast') {
    const doc = docs.get(cur.docId);
    if (doc) {
      doc.position = { chapter: cur.chapter, time: player.currentTime };
      if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveDoc(doc); }
    }
  }
  updatePlayerUI();
});
player.addEventListener('pause', () => {
  const doc = docs.get(cur.docId);
  if (doc && cur.mode === 'podcast') saveDoc(doc);
  updatePlayerUI();
});
player.addEventListener('play', updatePlayerUI);
player.addEventListener('loadedmetadata', () => {
  const doc = docs.get(cur.docId);
  const ch = doc?.chapters?.[cur.chapter];
  if (cur.mode === 'podcast' && ch && isFinite(player.duration)) ch.duration = player.duration;
});

function seekBy(sec) {
  if (!player.src) return;
  player.currentTime = Math.max(0, Math.min((player.duration || 0) - 0.5, player.currentTime + sec));
}

async function jumpChapter(delta) {
  const doc = docs.get(view.docId);
  if (!doc?.chapters) return;
  const base = cur.docId === doc.id ? cur.chapter : doc.position?.chapter || 0;
  const i = Math.max(0, Math.min(doc.chapters.length - 1, base + delta));
  unlockAudio();
  const ok = await loadChapter(doc, i, 0, true);
  if (!ok) toast(`Kapitel ${i + 1} wird noch erstellt.`);
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* nicht unterstützt */ } };
  set('play', () => safePlay());
  set('pause', () => player.pause());
  set('seekbackward', () => seekBy(-15));
  set('seekforward', () => seekBy(15));
  set('previoustrack', () => {
    const doc = docs.get(cur.docId);
    if (doc && cur.mode === 'podcast') loadChapter(doc, Math.max(0, cur.chapter - 1), 0, true);
  });
  set('nexttrack', () => {
    const doc = docs.get(cur.docId);
    if (doc && cur.mode === 'podcast' && cur.chapter + 1 < doc.chapters.length) loadChapter(doc, cur.chapter + 1, 0, true);
  });
}

/* ---------- Aufnahme (Fragen und eigene Stimme) ---------- */

class Recorder {
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Aufnahme wird hier nicht unterstützt.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.t0 = Date.now();
  }
  stop() {
    return new Promise((res) => {
      this.rec.onstop = () => {
        this.stream.getTracks().forEach((t) => t.stop());
        const type = this.rec.mimeType || 'audio/mp4';
        const ext = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'm4a';
        res({ blob: new Blob(this.chunks, { type }), ext, seconds: (Date.now() - this.t0) / 1000 });
      };
      this.rec.stop();
    });
  }
}

/* ---------- Fragen stellen ---------- */

let questionRec = null;
let asking = false;

function setAskStatus(msg) { $('#askStatus').textContent = msg || ''; }

function resetAskBtn() {
  const b = $('#askBtn');
  b.classList.remove('recording');
  b.textContent = 'Frage stellen';
  b.disabled = asking;
}

async function onAskButton() {
  const doc = docs.get(view.docId);
  if (!doc || asking) return;
  if (!hasTextKey()) { toast(missingKeyMsg()); return; }
  if (!questionRec) {
    unlockAudio();
    rememberPosition();
    player.pause();
    try {
      questionRec = new Recorder();
      await questionRec.start();
    } catch (e) {
      questionRec = null;
      setAskStatus('Kein Mikrofon-Zugriff. Du kannst die Frage auch unten eintippen (oder mit dem Mikrofon der Tastatur diktieren).');
      return;
    }
    const b = $('#askBtn');
    b.classList.add('recording');
    b.textContent = '■ Fertig – Frage senden';
    setAskStatus('Ich höre zu … stell deine Frage und tippe dann auf „Fertig“.');
    return;
  }
  const r = await questionRec.stop();
  questionRec = null;
  asking = true;
  resetAskBtn();
  try {
    if (r.seconds < 0.8) throw new Error('Das war zu kurz – bitte nochmal.');
    setAskStatus('Ich verstehe deine Frage …');
    const q = await transcribe(r.blob, r.ext);
    if (!q) throw new Error('Ich habe nichts verstanden – bitte nochmal.');
    await answerQuestion(doc, q);
  } catch (e) {
    setAskStatus(e.message);
  } finally {
    asking = false;
    resetAskBtn();
  }
}

async function onAskTyped(ev) {
  ev.preventDefault();
  const q = $('#askInput').value.trim();
  const doc = docs.get(view.docId);
  if (!q || !doc || asking) return;
  if (!hasTextKey()) { toast(missingKeyMsg()); return; }
  unlockAudio();
  rememberPosition();
  player.pause();
  $('#askInput').value = '';
  $('#askInput').blur();
  asking = true;
  resetAskBtn();
  try { await answerQuestion(doc, q); } catch (e) { setAskStatus(e.message); } finally { asking = false; resetAskBtn(); }
}

async function answerQuestion(doc, q) {
  setAskStatus(`Du fragst: „${q}“ – ich denke nach …`);
  const text = (await db.get('kv', 'text:' + doc.id)) || '';
  const r = (cur.docId === doc.id && cur.resume) || doc.position || { chapter: 0, time: 0 };
  const ch = doc.chapters?.[r.chapter];
  let where = '';
  if (ch?.script) {
    const frac = ch.duration ? Math.min(1, r.time / ch.duration) : 0;
    const pos = Math.floor(frac * ch.script.length);
    where = ch.script.slice(Math.max(0, pos - 900), pos + 200);
  }
  const history = (doc.qa || []).slice(-4).map((x) => `Frage: ${x.q}\nAntwort: ${x.a}`).join('\n\n');
  const task = `Der Hörer hört gerade den Podcast zu diesem Dokument${ch ? ` – Kapitel ${r.chapter + 1}: „${ch.title}“` : ''}.
${where ? `Ungefähr an dieser Stelle war er gerade:\n„… ${where} …“\n` : ''}${history ? `\nBisherige Fragen und Antworten:\n${history}\n` : ''}
Jetzt fragt er (eventuell per Spracherkennung, kann kleine Fehler enthalten): „${q}“

Beantworte die Frage gesprochen, in der Du-Form, wie im Podcast: direkt auf den Punkt, korrekt nach dem Dokument (wenn das Dokument die Antwort nicht hergibt, sag das ehrlich und erkläre mit allgemeinem Wissen) und bildlich mit einem anschaulichen Vergleich aus dem Alltag. So ausführlich wie nötig, meist 120 bis 300 Wörter. Keine Listen, kein Markdown, Zahlen und Formeln ausgesprochen. Schließe mit einem kurzen Satz, der zurück zum Podcast führt.`;
  const answer = cleanSpoken(await chat([...docMessages(doc, text), { role: 'user', content: task }], { maxTokens: 12000 }));
  setAskStatus('Die Antwort wird eingesprochen …');
  const blob = await tts(answer);
  doc.qa = doc.qa || [];
  const idx = doc.qa.length;
  await putAudio(`${doc.id}:qa:${idx}`, blob);
  doc.qa.push({ q, a: answer, at: Date.now(), chapter: r.chapter });
  await saveDoc(doc);
  setAskStatus('');
  if (cur.docId !== doc.id) cur.resume = null;
  await playAnswer(doc, blob);
  renderDoc(doc);
}

async function replayAnswer(doc, idx) {
  const blob = await getAudio(`${doc.id}:qa:${idx}`);
  if (!blob) return;
  if (cur.mode !== 'answer') rememberPosition();
  await playAnswer(doc, blob);
}

/* ---------- Ansichten ---------- */

let view = { name: 'library', docId: null };
const openScripts = new Set();

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('doc/')) view = { name: 'doc', docId: h.slice(4) };
  else if (h === 'settings') view = { name: 'settings', docId: null };
  else if (h === 'privacy') view = { name: 'privacy', docId: null };
  else view = { name: 'library', docId: null };
  render();
  window.scrollTo(0, 0);
  if (view.name === 'privacy') dismissNotice(); // wer die Details liest, braucht den Hinweis nicht mehr
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  $('#libraryView').hidden = view.name !== 'library';
  $('#docView').hidden = view.name !== 'doc';
  $('#settingsView').hidden = view.name !== 'settings';
  $('#privacyView').hidden = view.name !== 'privacy';
  $('#backBtn').hidden = view.name === 'library';
  $('#settingsBtn').hidden = view.name === 'settings';
  if (view.name === 'library') { $('#viewTitle').textContent = 'Lernpodcast'; renderLibrary(); }
  if (view.name === 'settings') { $('#viewTitle').textContent = 'Einstellungen'; renderSettings(); }
  if (view.name === 'privacy') $('#viewTitle').textContent = 'Datenschutz';
  if (view.name === 'doc') {
    const doc = docs.get(view.docId);
    if (!doc) { location.hash = ''; return; }
    $('#viewTitle').textContent = doc.title;
    renderDoc(doc);
  }
}

function renderLibrary() {
  const list = [...docs.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('#keyHint').hidden = hasTextKey();
  $('#emptyHint').hidden = list.length > 0;
  $('#docList').innerHTML = list.map((d) => `
    <li><a class="doc-item" href="#doc/${encodeURIComponent(d.id)}">
      <div class="doc-title">${esc(d.title)}</div>
      <div class="doc-sub">${esc(docStatusText(d))}</div>
      ${d.status !== 'ready' && d.status !== 'error' ? `<div class="bar"><div style="width:${Math.round(docProgress(d) * 100)}%"></div></div>` : ''}
    </a></li>`).join('');
  renderNowPlaying();
}

function renderNowPlaying() {
  const np = $('#nowPlaying');
  const doc = docs.get(cur.docId);
  const show = doc && view.name === 'library' && (cur.mode === 'podcast' || cur.mode === 'answer') && player.src;
  np.hidden = !show;
  if (!show) return;
  np.href = '#doc/' + encodeURIComponent(doc.id);
  const what = cur.mode === 'answer' ? 'Antwort auf deine Frage' : `Kapitel ${cur.chapter + 1}: ${doc.chapters[cur.chapter].title}`;
  np.innerHTML = `${player.paused ? 'Pausiert' : 'Läuft gerade'}: ${esc(doc.title)}<span>${esc(what)}</span>`;
}

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

function renderDoc(doc) {
  const isRunning = running.has(doc.id);
  const done = doc.status === 'ready';
  $('#genBox').hidden = done;
  if (!done) {
    $('#genText').textContent = docStatusText(doc);
    $('#genBar').style.width = Math.round(docProgress(doc) * 100) + '%';
    $('#genHint').hidden = !isRunning;
    $('#genError').hidden = !doc.error;
    $('#genError').textContent = doc.error || '';
    $('#resumeGenBtn').hidden = isRunning;
  }

  // Beim Öffnen den gespeicherten Stand laden – aber nichts unterbrechen, was gerade läuft.
  if (cur.docId !== doc.id && player.paused && !questionRec && doc.chapters?.[doc.position?.chapter || 0]?.hasAudio) {
    const p = doc.position || { chapter: 0, time: 0 };
    loadChapter(doc, p.chapter, p.time, false);
  }

  const activeChapter = cur.docId === doc.id ? cur.chapter : doc.position?.chapter || 0;
  $('#chapterList').innerHTML = (doc.chapters || []).map((c, i) => {
    const state = c.hasAudio ? (c.duration ? fmtMin(c.duration) : 'bereit') : c.script ? 'wird eingesprochen …' : isRunning ? 'wird geschrieben …' : 'noch nicht erstellt';
    return `<li data-i="${i}" class="${i === activeChapter ? 'current' : ''}">
      <span class="num">${i + 1}</span>
      <div class="body">
        <div>${esc(c.title)}</div>
        <div class="meta">${esc(state)}</div>
        ${c.script ? `<details data-i="${i}" ${openScripts.has(doc.id + ':' + i) ? 'open' : ''}><summary>Text lesen</summary><p>${esc(c.script)}</p></details>` : ''}
      </div>
    </li>`;
  }).join('');

  const qa = doc.qa || [];
  $('#qaHeading').hidden = !qa.length;
  $('#qaList').innerHTML = qa.map((x, i) => `<li>
      <div class="q">${esc(x.q)}</div>
      <div class="a">${esc(x.a)}</div>
      <button class="btn small-btn" data-qa="${i}">▶ Antwort anhören</button>
    </li>`).reverse().join('');

  $('#revoiceBtn').hidden = !doc.chapters || isRunning;
  updatePlayerUI();
}

let seeking = false;
function updatePlayerUI() {
  if (view.name === 'library') { renderNowPlaying(); return; }
  if (view.name !== 'doc') return;
  const doc = docs.get(view.docId);
  if (!doc) return;
  const mine = cur.docId === doc.id;
  const playing = mine && !player.paused && cur.mode !== 'idle';
  const playBtn = $('#playBtn');
  const icon = playing ? ICON_PAUSE : ICON_PLAY;
  if (playBtn.dataset.icon !== icon) { playBtn.innerHTML = icon; playBtn.dataset.icon = icon; }
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');

  let label;
  if (mine && cur.mode === 'answer') label = 'Antwort auf deine Frage';
  else {
    const i = mine ? cur.chapter : doc.position?.chapter || 0;
    const ch = doc.chapters?.[i];
    label = ch ? `Kapitel ${i + 1}: ${ch.title}` : 'Der Podcast wird gerade vorbereitet …';
    if (mine && cur.waitingFor != null) label += ' – wird noch erstellt …';
  }
  $('#nowChapter').textContent = label;

  const active = mine && cur.mode !== 'idle';
  const dur = active && isFinite(player.duration) ? player.duration : 0;
  const t = active ? player.currentTime : doc.position?.time || 0;
  const seek = $('#seek');
  seek.max = Math.max(1, Math.floor(dur));
  if (!seeking) seek.value = Math.floor(t);
  $('#tCur').textContent = fmtTime(t);
  $('#tDur').textContent = dur ? fmtTime(dur) : '–:––';
  $('#resumeBtn').hidden = !(mine && cur.mode === 'answer');
  $('#rateBtn').textContent = `Tempo ${String(settings.rate).replace('.', ',')}×`;

  const activeChapter = mine ? cur.chapter : doc.position?.chapter || 0;
  document.querySelectorAll('#chapterList > li').forEach((li, i) => li.classList.toggle('current', i === activeChapter && cur.mode !== 'answer'));
}

async function togglePlay() {
  const doc = docs.get(view.docId);
  if (!doc) return;
  if (cur.docId === doc.id && (cur.mode === 'podcast' || cur.mode === 'answer') && player.src) {
    if (player.paused) safePlay(); else player.pause();
    return;
  }
  unlockAudio();
  const p = doc.position || { chapter: 0, time: 0 };
  const ok = await loadChapter(doc, p.chapter, p.time, true);
  if (!ok) toast('Dieses Kapitel wird noch erstellt – es startet automatisch, sobald es fertig ist.', 5000);
}

/* ---------- Einstellungen ---------- */

function renderSettings() {
  document.querySelectorAll('input[name=textProv]').forEach((r) => { r.checked = r.value === settings.textProvider; });
  $('#geminiTextBox').hidden = !usesGemini();
  $('#openaiTextBox').hidden = usesGemini();
  $('#sGKey').value = settings.geminiKey;
  $('#sGModel').value = settings.geminiModel;
  $('#sGTtsModel').value = settings.geminiTtsModel;
  $('#sKey').value = settings.openaiKey;
  $('#sModel').value = settings.model;
  const sel = $('#sVoice');
  if (!sel.options.length) sel.innerHTML = OPENAI_VOICES.map((v) => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
  sel.value = settings.voice;
  const gSel = $('#sGVoice');
  if (!gSel.options.length) gSel.innerHTML = GEMINI_VOICES.map(([v, d]) => `<option value="${v}">${v} (${d})</option>`).join('');
  gSel.value = settings.geminiVoice;
  $('#sElKey').value = settings.elKey;
  $('#sElVoice').value = settings.elVoice;
  document.querySelectorAll('input[name=voiceProv]').forEach((r) => { r.checked = r.value === settings.voiceProvider; });
  $('#geminiVoiceBox').hidden = settings.voiceProvider !== 'gemini';
  $('#openaiVoiceBox').hidden = settings.voiceProvider !== 'openai';
  $('#elevenBox').hidden = settings.voiceProvider !== 'eleven';
  $('#voiceKeyHint').hidden = !(settings.voiceProvider === 'openai' && usesGemini() && !settings.openaiKey)
    && !(settings.voiceProvider === 'gemini' && !usesGemini() && !settings.geminiKey);
  $('#voiceKeyHint').textContent = settings.voiceProvider === 'openai'
    ? 'Für die OpenAI-Stimme brauchst du zusätzlich einen OpenAI-Schlüssel (oben unter „OpenAI“ eintragen).'
    : 'Für die Gemini-Stimme brauchst du zusätzlich einen Gemini-Schlüssel (oben unter „Google Gemini“ eintragen).';
  $('#sampleText').textContent = SAMPLE_TEXT;
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then((e) => {
      $('#storageInfo').textContent = `Belegt: ca. ${Math.round((e.usage || 0) / 1e6)} MB von ${docs.size} Podcast(s).`;
    }).catch(() => {});
  }
}

async function testGeminiKey() {
  const out = $('#testGKeyOut');
  if (!settings.geminiKey) { out.textContent = 'Bitte zuerst einen Schlüssel eintragen.'; return; }
  out.textContent = 'Prüfe …';
  try {
    const res = await apiFetch(`${GEMINI}/models?pageSize=1000`, { headers: geminiHeaders() }, 'Gemini');
    const ids = ((await res.json()).models || []).map((m) => m.name.replace(/^models\//, ''));
    const textModels = ids.filter((id) => /^gemini-/.test(id) && !/tts|image|embedding|live|robotics|transcribe|audio/.test(id)).sort().reverse();
    const ttsModels = ids.filter((id) => /tts/.test(id)).sort().reverse();
    $('#gModelList').innerHTML = textModels.map((id) => `<option value="${esc(id)}">`).join('');
    $('#gTtsModelList').innerHTML = ttsModels.map((id) => `<option value="${esc(id)}">`).join('');
    const problems = [];
    if (!ids.includes(settings.geminiModel)) problems.push(`Text-Modell „${settings.geminiModel}“ nicht gefunden (verfügbar z. B.: ${textModels.slice(0, 5).join(', ')})`);
    if (settings.voiceProvider === 'gemini' && !ids.includes(settings.geminiTtsModel)) problems.push(`Stimmen-Modell „${settings.geminiTtsModel}“ nicht gefunden (verfügbar z. B.: ${ttsModels.slice(0, 4).join(', ')})`);
    out.textContent = problems.length ? `Schlüssel funktioniert, aber: ${problems.join('; ')}.` : '✓ Schlüssel funktioniert, die Modelle sind verfügbar.';
  } catch (e) {
    out.textContent = e.message;
  }
}

async function testKey() {
  const out = $('#testKeyOut');
  if (!settings.openaiKey) { out.textContent = 'Bitte zuerst einen Schlüssel eintragen.'; return; }
  out.textContent = 'Prüfe …';
  try {
    const res = await apiFetch(`${OPENAI}/models`, { headers: openaiHeaders(false) }, 'OpenAI');
    const ids = ((await res.json()).data || []).map((m) => m.id);
    const textModels = ids.filter((id) => /^(gpt-|o\d)/.test(id) && !/audio|realtime|tts|transcribe|image|search|embedding/.test(id)).sort().reverse();
    $('#modelList').innerHTML = textModels.map((id) => `<option value="${esc(id)}">`).join('');
    if (ids.includes(settings.model)) {
      out.textContent = `✓ Schlüssel funktioniert, Modell „${settings.model}“ ist verfügbar.`;
    } else {
      out.textContent = `Schlüssel funktioniert, aber das Modell „${settings.model}“ gibt es für dich nicht. Verfügbar sind z. B.: ${textModels.slice(0, 8).join(', ')}`;
    }
  } catch (e) {
    out.textContent = e.message;
  }
}

const previewAudio = new Audio();
async function previewVoice() {
  const out = $('#previewOut');
  unlockAudio(previewAudio);
  player.pause();
  out.textContent = 'Stimme wird erzeugt …';
  try {
    const blob = await tts('Hallo! Ich bin deine Stimme für den Lernpodcast. Stell dir vor, wir laufen zusammen los, und ich erkläre dir unterwegs alles, was du wissen willst.');
    previewAudio.src = URL.createObjectURL(blob);
    previewAudio.playbackRate = settings.rate;
    await previewAudio.play();
    out.textContent = '';
  } catch (e) {
    out.textContent = e.message;
  }
}

let voiceRec = null;
let voiceTimer = null;
async function onRecordVoice() {
  const btn = $('#recVoiceBtn');
  const out = $('#recVoiceStatus');
  if (!voiceRec) {
    if (!settings.elKey) { out.textContent = 'Bitte zuerst den ElevenLabs-Schlüssel eintragen.'; return; }
    player.pause();
    try {
      voiceRec = new Recorder();
      await voiceRec.start();
    } catch (e) {
      voiceRec = null;
      out.textContent = 'Kein Mikrofon-Zugriff: ' + e.message;
      return;
    }
    btn.textContent = '■ Aufnahme beenden';
    btn.classList.add('recording');
    const t0 = Date.now();
    voiceTimer = setInterval(() => { out.textContent = `Aufnahme läuft … ${fmtTime((Date.now() - t0) / 1000)}`; }, 500);
    return;
  }
  clearInterval(voiceTimer);
  const r = await voiceRec.stop();
  voiceRec = null;
  btn.textContent = '● Aufnahme starten';
  btn.classList.remove('recording');
  if (r.seconds < 30) { out.textContent = 'Das war etwas kurz – bitte mindestens 30 Sekunden, besser den ganzen Text lesen.'; return; }
  btn.disabled = true;
  out.textContent = 'Deine Stimme wird angelernt …';
  try {
    const fd = new FormData();
    fd.append('name', 'Meine Stimme (Lernpodcast)');
    fd.append('files', r.blob, 'stimme.' + r.ext);
    fd.append('remove_background_noise', 'false');
    fd.append('description', 'Eigene Stimme, aufgenommen in der Lernpodcast-App');
    const res = await apiFetch(`${ELEVEN}/voices/add`, { method: 'POST', headers: { 'xi-api-key': settings.elKey }, body: fd }, 'ElevenLabs');
    const j = await res.json();
    if (!j.voice_id) throw new Error('ElevenLabs hat keine Voice-ID zurückgegeben.');
    settings.elVoice = j.voice_id;
    settings.voiceProvider = 'eleven';
    await saveSettings();
    renderSettings();
    out.textContent = '✓ Fertig! Ab jetzt spricht der Podcast mit deiner Stimme. Tipp auf „Probe hören“.' + (j.requires_verification ? ' (ElevenLabs möchte die Stimme evtl. noch bestätigen – schau ggf. auf elevenlabs.io.)' : '');
  } catch (e) {
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Datenschutz-Hinweis ----------
 * Einmalig, nicht blockierend, unten. Erscheint nicht beim Ankommen und nicht mitten in
 * einer Aufgabe, sondern direkt nachdem ein Schlüssel gespeichert wurde (passt zum Thema)
 * oder nach 15 s auf der Startseite. Nach „Verstanden“ (oder den Details) nie wieder. */

const NOTICE_DELAY_MS = 15000;
let noticeState = 'pending'; // pending | shown | done

async function initNotice() {
  try { if (await db.get('kv', 'noticeSeen')) noticeState = 'done'; } catch { /* dann eben zeigen */ }
  if (noticeState === 'pending') setTimeout(() => maybeShowNotice(false), NOTICE_DELAY_MS);
}

function maybeShowNotice(afterKeySaved) {
  if (noticeState !== 'pending') return;
  const busy = questionRec || asking || voiceRec || view.name === 'privacy' || (!afterKeySaved && view.name !== 'library');
  if (busy) { setTimeout(() => maybeShowNotice(false), 5000); return; }
  noticeState = 'shown';
  const n = $('#privacyNotice');
  n.hidden = false;
  document.body.classList.add('notice-open');
  document.body.style.setProperty('--notice-h', n.offsetHeight + 'px');
}

function dismissNotice() {
  if (noticeState === 'done') return;
  noticeState = 'done';
  $('#privacyNotice').hidden = true;
  document.body.classList.remove('notice-open');
  db.put('kv', Date.now(), 'noticeSeen').catch(() => {});
}

async function wipeAllData() {
  if (!confirm('Wirklich alle Podcasts, Fragen, Einstellungen und Schlüssel von diesem Gerät löschen? Das lässt sich nicht rückgängig machen.')) return;
  player.pause();
  for (const store of ['docs', 'audio', 'kv']) await db.clear(store);
  location.hash = '';
  location.reload();
}

/* ---------- Bedienung verbinden ---------- */

function bindUI() {
  $('#backBtn').addEventListener('click', () => { location.hash = ''; });
  $('#settingsBtn').addEventListener('click', () => { location.hash = 'settings'; });

  $('#pdfInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!hasTextKey()) { toast(missingKeyMsg()); location.hash = 'settings'; return; }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const doc = {
      id, title: file.name.replace(/\.pdf$/i, ''), fileName: file.name, createdAt: Date.now(),
      status: 'extracting', chapters: null, position: { chapter: 0, time: 0 }, qa: [],
    };
    try {
      await db.put('kv', await file.arrayBuffer(), 'pdf:' + id);
    } catch (err) {
      toast('Speichern fehlgeschlagen: ' + err.message);
      return;
    }
    docs.set(id, doc);
    await saveDoc(doc);
    try { navigator.storage?.persist?.(); } catch { /* egal */ }
    location.hash = 'doc/' + id;
    generate(doc);
  });

  $('#resumeGenBtn').addEventListener('click', () => { const d = docs.get(view.docId); if (d) generate(d); });
  $('#playBtn').addEventListener('click', togglePlay);
  $('#back15Btn').addEventListener('click', () => seekBy(-15));
  $('#fwd15Btn').addEventListener('click', () => seekBy(15));
  $('#prevBtn').addEventListener('click', () => jumpChapter(-1));
  $('#nextBtn').addEventListener('click', () => jumpChapter(1));
  $('#rateBtn').addEventListener('click', () => {
    settings.rate = RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length];
    player.playbackRate = settings.rate;
    saveSettings();
    updatePlayerUI();
  });
  const seek = $('#seek');
  seek.addEventListener('input', () => { seeking = true; $('#tCur').textContent = fmtTime(+seek.value); });
  seek.addEventListener('change', () => {
    seeking = false;
    if (cur.docId === view.docId && cur.mode !== 'idle') player.currentTime = +seek.value;
  });
  $('#resumeBtn').addEventListener('click', () => { unlockAudio(); resumePodcast(true); });
  $('#askBtn').addEventListener('click', onAskButton);
  $('#askForm').addEventListener('submit', onAskTyped);

  $('#chapterList').addEventListener('click', async (e) => {
    if (e.target.closest('details')) return;
    const li = e.target.closest('li[data-i]');
    const doc = docs.get(view.docId);
    if (!li || !doc) return;
    const i = +li.dataset.i;
    unlockAudio();
    const ok = await loadChapter(doc, i, 0, true);
    if (!ok) toast(`Kapitel ${i + 1} wird noch erstellt.`);
  });
  $('#chapterList').addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName !== 'DETAILS') return;
    const key = view.docId + ':' + d.dataset.i;
    if (d.open) openScripts.add(key); else openScripts.delete(key);
  }, true);
  $('#qaList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qa]');
    const doc = docs.get(view.docId);
    if (b && doc) { unlockAudio(); replayAnswer(doc, +b.dataset.qa); }
  });

  $('#revoiceBtn').addEventListener('click', async () => {
    const doc = docs.get(view.docId);
    if (!doc?.chapters) return;
    if (!confirm('Alle Kapitel mit der aktuell eingestellten Stimme neu einsprechen? Die Texte bleiben gleich.')) return;
    if (cur.docId === doc.id) { player.pause(); cur.mode = 'idle'; }
    doc.chapters.forEach((c) => { c.hasAudio = false; });
    doc.status = 'writing';
    await saveDoc(doc);
    generate(doc);
  });
  $('#deleteDocBtn').addEventListener('click', async () => {
    const doc = docs.get(view.docId);
    if (!doc || !confirm(`„${doc.title}“ wirklich löschen?`)) return;
    if (cur.docId === doc.id) { player.pause(); player.removeAttribute('src'); cur.docId = null; cur.mode = 'idle'; }
    docs.delete(doc.id);
    await db.del('docs', doc.id);
    await db.del('kv', 'text:' + doc.id);
    await db.del('kv', 'pdf:' + doc.id);
    await deleteAudioPrefix(doc.id + ':');
    location.hash = '';
  });

  const bindSetting = (sel, key, transform = (v) => v.trim()) => {
    $(sel).addEventListener('change', (e) => { settings[key] = transform(e.target.value); saveSettings(); });
  };
  for (const sel of ['#sGKey', '#sKey', '#sElKey']) {
    $(sel).addEventListener('change', (e) => { if (e.target.value.trim()) setTimeout(() => maybeShowNotice(true), 800); });
  }
  bindSetting('#sGKey', 'geminiKey');
  bindSetting('#sGModel', 'geminiModel');
  bindSetting('#sGTtsModel', 'geminiTtsModel');
  bindSetting('#sGVoice', 'geminiVoice');
  bindSetting('#sKey', 'openaiKey');
  bindSetting('#sModel', 'model');
  bindSetting('#sVoice', 'voice');
  bindSetting('#sElKey', 'elKey');
  bindSetting('#sElVoice', 'elVoice');
  document.querySelectorAll('input[name=textProv]').forEach((r) => r.addEventListener('change', () => {
    settings.textProvider = r.value;
    saveSettings();
    renderSettings();
  }));
  document.querySelectorAll('input[name=voiceProv]').forEach((r) => r.addEventListener('change', () => {
    settings.voiceProvider = r.value;
    saveSettings();
    renderSettings();
  }));
  $('#testGKeyBtn').addEventListener('click', testGeminiKey);
  $('#testKeyBtn').addEventListener('click', testKey);
  $('#previewGeminiBtn').addEventListener('click', previewVoice);
  $('#previewOpenaiBtn').addEventListener('click', previewVoice);
  $('#previewElBtn').addEventListener('click', previewVoice);
  $('#recVoiceBtn').addEventListener('click', onRecordVoice);
  $('#noticeOkBtn').addEventListener('click', dismissNotice);
  $('#wipeBtn').addEventListener('click', wipeAllData);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && noticeState === 'shown') dismissNotice(); });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running.size) keepAwake();
  });
}

(async function init() {
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  await loadSettings();
  await loadDocs();
  bindUI();
  await initNotice();
  route();
  // Was beim letzten Mal mitten in der Erstellung war, automatisch weitermachen.
  for (const d of docs.values()) {
    if (['extracting', 'planning', 'writing'].includes(d.status) && hasTextKey()) generate(d);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

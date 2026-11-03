# Lernpodcast

Static PWA for iPhone Safari: upload a PDF → AI turns it into a vivid, German, chapter-based learning podcast to listen to while running; follow-up questions by voice. No build step, no backend. Third-party code is self-hosted in `vendor/` (pdf.js 3.11.174, lamejs 1.2.1, both verified against cdnjs SRI hashes) so opening the app contacts no server except GitHub Pages — keep it that way (no CDN fonts/scripts, no analytics), otherwise a consent banner becomes necessary.

Privacy UX (based on Utz et al. 2019, NN/g popup/overlay research, Hsieh et al. 2020): no cookie banner, because nothing needs consent. Instead `#privacyNotice` — a small non-modal notice, bottom on phones / bottom-left on wide screens, shown once, never on arrival or mid-task (after a key is saved or after 15 s on the library), dismissed for good via `kv.noticeSeen`. Full details and "Alle Daten löschen" live in the `#privacy` view.

- Live: https://lockenlenny.github.io/lernpodcast/ (GitHub Pages, branch `main`, root)
- User speaks German. UI text, prompts and comments are German; answer the user in German.
- Design must stay very simple: big buttons, one column, light/dark via CSS variables in `style.css`.

## Files
- `index.html` – four views (`#libraryView`, `#docView`, `#settingsView`, `#privacyView`) switched by URL hash (`#doc/<id>`, `#settings`, `#privacy`).
- `app.js` – everything else, in sections:
  - IndexedDB `lernpodcast`: stores `docs` (metadata, chapters with `script`/`hasAudio`/`duration`, `position`, `qa`), `audio` (`<docId>:<i>` and `<docId>:qa:<i>` as `{buf, type}`), `kv` (`settings`, `text:<id>`, `pdf:<id>`).
  - API calls go straight from the browser (all three allow CORS). Text provider (`settings.textProvider`) and voice provider (`settings.voiceProvider`) are chosen separately; `chat()` and `transcribe()` follow the text provider. Messages are built in OpenAI format and converted for Gemini in `geminiChat()`.
    - Google Gemini (default, free tier): `generateContent` with `gemini-3.8-flash`; transcription = recording → 16 kHz WAV (`toWav16k`) → same text model; voice = `POST /v1beta/interactions` with `gemini-3.8-flash-tts` (falls back to `generateContent` with AUDIO). TTS returns PCM/WAV, which `pcmToMp3()` encodes with lamejs from cdnjs, loaded on demand. Free-tier rate limits: `apiFetch` waits on per-minute 429s (`retryDelay`) and stops with a German "Tageslimit" message on per-day 429s.
    - OpenAI: chat completions (default `gpt-6.1-terra`), `gpt-4o-mini-tts`, `gpt-4o-mini-transcribe`.
    - ElevenLabs: IVC (`/v1/voices/add`) and TTS (`eleven_multilingual_v2`).
  - Pipeline `generate(doc)`: pdf.js text extraction (vision OCR fallback for scans) → outline JSON → per chapter script + TTS (pool of 2), resumable from any step.
  - TTS input is split into ≤3500-char chunks; MP3 parts are joined after `stripMp3Headers` removes ID3/Xing so Safari reports the right duration.
  - Playback uses one `<audio>` element (iOS unlock via `unlockAudio()` inside a tap). Answers play in the same element, then `resumePodcast()` continues 3 s before the saved spot.
- Siri: an iOS Shortcut opens `?frage=<url-encoded text>`; `handleLinkQuestion()` answers it for the last played podcast (`kv.lastDocId`) and strips the parameter. Shortcuts open Safari, whose storage is separate from the home-screen app (explained in the settings card).
- `sw.js` – offline cache (stale-while-revalidate). **Bump `VERSION` in sw.js and `APP_VERSION` in app.js on every release**; a page that sees a new service worker take control reloads itself once (only when nothing is playing, generating or recording).

## Test
No test suite. Serve the folder over http on localhost (any static server) and use the browser in mobile size. Mock `window.fetch` for `api.openai.com` / `generativelanguage.googleapis.com` to test without a key (a WAV body works for OpenAI `/audio/speech`; for Gemini `/interactions` return `{steps:[{content:[{type:'audio', mime_type:'audio/l16;codec=pcm;rate=24000', data:<base64 PCM>}]}]}`). Real checks for microphone, lock-screen playback and the home-screen app only work on the iPhone.

## Release
Commit, then `git push`. Pages rebuilds in about a minute. Never commit API keys; keys live only in the phone's IndexedDB.

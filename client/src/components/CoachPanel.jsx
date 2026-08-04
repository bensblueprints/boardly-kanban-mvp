import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X, Mic, Square, Send, Sparkles, Settings2, Loader2, AlertTriangle,
  CheckCircle2, Volume2, VolumeX, ListPlus, RefreshCw
} from 'lucide-react';
import { api } from '../api.js';

// Speak a reply using the OS voices. Works offline in Electron; unlike mic
// input it needs no external service.
function speak(text, enabled) {
  if (!enabled || !text || typeof window.speechSynthesis === 'undefined') return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

function SettingsForm({ settings, onSave, onProbe, probe, busy }) {
  const [form, setForm] = useState(settings);
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // Pull the model list from whatever URL is currently typed in.
  async function loadModels(url) {
    const target = url || form.chatUrl;
    if (!target) return;
    setLoadingModels(true);
    setModelError('');
    try {
      const { models: list } = await api.post('/api/coach/models', { url: target, apiKey: form.apiKey });
      setModels(list);
      // If the saved model isn't on the server, pick the first available one so
      // the dropdown never sits on something that can't run.
      if (list.length && !list.includes(form.chatModel)) setForm((f) => ({ ...f, chatModel: list[0] }));
    } catch (e) {
      setModels([]);
      setModelError(e.message);
    } finally {
      setLoadingModels(false);
    }
  }

  useEffect(() => { loadModels(); /* on open */ }, []);

  // Keep the dropdown in sync when a probe discovers models.
  useEffect(() => {
    if (probe?.chat?.ok && probe.chat.models?.length) setModels(probe.chat.models);
  }, [probe]);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-zinc-500">
        Point these at the machine running your model. Both speak the OpenAI-compatible API,
        so Ollama, vLLM and LM Studio all work.
      </p>

      <label className="block">
        <span className="text-xs text-zinc-400">Model server URL</span>
        <input value={form.chatUrl || ''} onChange={set('chatUrl')}
          onBlur={(e) => loadModels(e.target.value)}
          placeholder="http://192.168.1.10:11434/v1"
          className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-mono outline-none focus:border-indigo-500" />
      </label>

      <div className="block">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400">Model</span>
          <button onClick={() => loadModels()} disabled={loadingModels}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-50">
            {loadingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
        </div>
        {models.length > 0 ? (
          <select value={form.chatModel || ''} onChange={set('chatModel')}
            className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-mono outline-none focus:border-indigo-500">
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <>
            <input value={form.chatModel || ''} onChange={set('chatModel')}
              placeholder="qwen2.5:14b-instruct-q4_K_M"
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-mono outline-none focus:border-indigo-500" />
            <p className="mt-1 text-[11px] text-zinc-600">
              {loadingModels ? 'Looking for models…'
                : modelError ? 'Can\'t list models yet — type the name, or fix the connection below.'
                : 'Connect to the server to pick from a list.'}
            </p>
          </>
        )}
      </div>
      <label className="block">
        <span className="text-xs text-zinc-400">Speech-to-text URL <span className="text-zinc-600">(optional)</span></span>
        <input value={form.sttUrl || ''} onChange={set('sttUrl')}
          placeholder="http://192.168.1.10:8178/v1"
          className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-mono outline-none focus:border-indigo-500" />
      </label>

      <div className="flex gap-2">
        <button onClick={() => onSave(form)} disabled={busy}
          className="flex-1 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-xs font-semibold rounded-lg py-2">
          Save
        </button>
        <button onClick={() => onProbe(form)} disabled={busy}
          className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-semibold rounded-lg px-3 py-2 disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Test
        </button>
      </div>

      {probe && (
        <div className="space-y-2">
          <div className={`flex items-start gap-2 rounded-lg p-2.5 text-xs border ${probe.chat?.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'}`}>
            {probe.chat?.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <div>
              <div className="font-semibold">Model server {probe.chat?.ok ? 'reachable' : 'unreachable'}</div>
              {!probe.chat?.ok && <div className="mt-0.5 opacity-90">{probe.chat?.error}</div>}
              {probe.chat?.ok && !probe.chat?.hasModel && (
                <div className="mt-0.5 opacity-90">
                  Connected, but "{form.chatModel}" isn't loaded.
                  {probe.chat.models?.length ? ` Available: ${probe.chat.models.slice(0, 6).join(', ')}` : ' No models reported.'}
                </div>
              )}
              {probe.chat?.ok && probe.chat?.hasModel && <div className="mt-0.5 opacity-90">Model is loaded and ready.</div>}
            </div>
          </div>
          {probe.stt && (
            <div className={`flex items-start gap-2 rounded-lg p-2.5 text-xs border ${probe.stt.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'}`}>
              {probe.stt.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <div>Speech-to-text {probe.stt.ok ? 'reachable' : `unreachable — ${probe.stt.error}`}</div>
            </div>
          )}
        </div>
      )}

      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer hover:text-zinc-300">Server won't connect?</summary>
        <div className="mt-2 space-y-1.5 leading-relaxed">
          <p>Ollama listens on localhost only by default. On the GPU box:</p>
          <code className="block bg-zinc-950 border border-zinc-800 rounded p-2 font-mono">
            OLLAMA_HOST=0.0.0.0 ollama serve
          </code>
          <p>vLLM: add <code className="text-zinc-400">--host 0.0.0.0</code>. LM Studio: enable "Serve on Local Network".</p>
        </div>
      </details>
    </div>
  );
}

export default function CoachPanel({ boardId, onClose, onApplied }) {
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [voice, setVoice] = useState(true);
  const [turns, setTurns] = useState([]);      // {role, content} | {role:'plan', plan}
  const [recording, setRecording] = useState(false);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.get('/api/coach')
      .then((s) => { setSettings(s); if (!s.chatUrl || s.chatUrl.includes('127.0.0.1')) setShowSettings(true); })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, thinking]);

  async function saveSettings(form) {
    setBusy(true);
    try {
      setSettings(await api.post('/api/coach/settings', form));
      setError('');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function runProbe(form) {
    setBusy(true);
    try { setProbe(await api.post('/api/coach/probe', form || {})); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function ask(question) {
    if (!question.trim()) return;
    setError('');
    setInput('');
    const history = turns.filter((t) => t.role === 'user' || t.role === 'assistant')
      .map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: 'user', content: question }]);
    setThinking(true);
    try {
      const res = await api.post('/api/coach/next', { question, board_id: boardId, history });
      if (res.plan) {
        setTurns((t) => [...t, { role: 'plan', plan: res.plan }]);
        speak(res.plan.say, voice);
      } else {
        setTurns((t) => [...t, { role: 'assistant', content: res.say || 'No answer came back.' }]);
        speak(res.say, voice);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setThinking(false);
    }
  }

  async function toggleRecord() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (!settings?.sttUrl) { setError('No speech-to-text server configured — set one in settings, or type instead.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1200) { setError('That was too short to transcribe.'); return; }
        setThinking(true);
        try {
          const fd = new FormData();
          fd.append('audio', blob, 'speech.webm');
          const { text } = await api.post('/api/coach/transcribe', fd);
          setThinking(false);
          if (text?.trim()) await ask(text.trim());
          else setError('Nothing was transcribed — try again a bit louder.');
        } catch (e) {
          setThinking(false);
          setError(e.message);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError('Could not access the microphone: ' + e.message);
    }
  }

  async function applyPlan(plan) {
    setBusy(true);
    try {
      await api.post('/api/coach/apply', {
        card_id: plan.card_id, steps: plan.steps, title: 'Next up'
      });
      setTurns((t) => [...t, { role: 'assistant', content: `Added ${plan.steps.length} steps to "${plan.card_title}".` }]);
      onApplied?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      className="w-[380px] shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col h-full"
    >
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/15 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">What's next</div>
          <div className="text-[11px] text-zinc-500 truncate">
            {settings?.chatModel || 'no model set'}
          </div>
        </div>
        <button onClick={() => setVoice((v) => !v)} title={voice ? 'Mute replies' : 'Speak replies'}
          className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100">
          {voice ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        </button>
        <button onClick={() => setShowSettings((v) => !v)} title="Settings"
          className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100">
          <Settings2 className="w-4 h-4" />
        </button>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {showSettings && settings && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
            <SettingsForm settings={settings} onSave={saveSettings} onProbe={runProbe} probe={probe} busy={busy} />
          </div>
        )}

        {!turns.length && !thinking && (
          <div className="text-center py-8">
            <p className="text-sm text-zinc-400 mb-1">Ask what to tackle next.</p>
            <p className="text-xs text-zinc-600 mb-4">
              It reads the board and picks one thing — not a list of twenty.
            </p>
            <button onClick={() => ask('What should I work on next?')}
              className="text-xs font-semibold bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg px-3 py-2">
              What do I need to do next?
            </button>
          </div>
        )}

        {turns.map((t, i) => {
          if (t.role === 'user') {
            return (
              <div key={i} className="ml-8 bg-indigo-500/10 border border-indigo-500/20 rounded-xl rounded-br-sm px-3 py-2">
                <p className="text-sm text-indigo-100">{t.content}</p>
              </div>
            );
          }
          if (t.role === 'assistant') {
            return (
              <div key={i} className="mr-8 bg-zinc-900 border border-zinc-800 rounded-xl rounded-bl-sm px-3 py-2">
                <p className="text-sm text-zinc-300 whitespace-pre-wrap">{t.content}</p>
              </div>
            );
          }
          const p = t.plan;
          return (
            <div key={i} className="mr-2 bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-2.5">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-indigo-400 font-semibold">Work on this</div>
                <div className="font-semibold text-sm mt-0.5">{p.card_title || 'Untitled card'}</div>
                {p.why && <p className="text-xs text-zinc-500 mt-1">{p.why}</p>}
              </div>
              <ol className="space-y-1.5">
                {p.steps.map((s, n) => (
                  <li key={n} className="flex gap-2 text-sm text-zinc-300">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-zinc-800 text-[11px] flex items-center justify-center text-zinc-400">{n + 1}</span>
                    <span className="leading-snug">{s}</span>
                  </li>
                ))}
              </ol>
              {p.card_id && (
                <button onClick={() => applyPlan(p)} disabled={busy}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-lg py-2 disabled:opacity-50">
                  <ListPlus className="w-3.5 h-3.5" /> Add these to the card
                </button>
              )}
            </div>
          );
        })}

        {thinking && (
          <div className="mr-8 flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
            <p className="text-xs text-rose-300">{error}</p>
          </div>
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-zinc-800 p-3">
        <div className="flex items-end gap-2">
          <button
            onClick={toggleRecord}
            title={recording ? 'Stop and send' : 'Hold a thought — click to talk'}
            className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              recording ? 'bg-rose-500 hover:bg-rose-400 text-white animate-pulse' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
            }`}
          >
            {recording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
            rows={1}
            placeholder={recording ? 'Listening…' : 'Ask what to do next…'}
            className="flex-1 resize-none bg-zinc-900 border border-zinc-800 focus:border-indigo-500 rounded-lg px-3 py-2.5 text-sm outline-none max-h-28"
          />
          <button onClick={() => ask(input)} disabled={!input.trim() || thinking}
            className="shrink-0 w-10 h-10 rounded-full bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white flex items-center justify-center">
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </motion.aside>
  );
}

'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import mammoth from 'mammoth';

const STATES = { IDLE: 'idle', ANALYZING: 'analyzing', DONE: 'done' };
const CUE_TYPES = {
  SFX: { label: 'SFX', color: '#f97316', bg: '#7c2d1220', icon: '💥' },
  MUSIC: { label: 'Music', color: '#a78bfa', bg: '#5b21b620', icon: '🎵' },
  AMBIENT: { label: 'Ambient', color: '#2dd4bf', bg: '#0f766e20', icon: '🌊' },
  VOA: { label: 'Voice Cue', color: '#f472b6', bg: '#9d174d20', icon: '🎭' },
  DIALOGUE: { label: 'Dialogue', color: '#e2e8f0', bg: '#1e293b40', icon: '💬' },
};

function parseScript(raw) {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const clean = line.replace(/\*+/g, '').trim();
    if (/^AMBIENT\s*SFX[:.\s]/i.test(clean)) parsed.push({ type: 'AMBIENT', text: clean });
    else if (/^SFX[:.\s]/i.test(clean)) parsed.push({ type: 'SFX', text: clean });
    else if (/^MUSIC\s*(CUE)?[:.\s]/i.test(clean)) parsed.push({ type: 'MUSIC', text: clean });
    else if (/^VOA\s*(CUE)?[:.\s]/i.test(clean)) parsed.push({ type: 'VOA', text: clean });
    else if (/^(SFX|MUSIC|AMBIENT|VOA)/i.test(clean)) {
      const upper = clean.toUpperCase();
      const t = upper.includes('AMBIENT') ? 'AMBIENT' : upper.includes('SFX') ? 'SFX' : upper.includes('MUSIC') ? 'MUSIC' : 'VOA';
      parsed.push({ type: t, text: clean });
    } else parsed.push({ type: 'DIALOGUE', text: clean });
  }
  return parsed;
}

function analyzeAudioBuffer(buf) {
  const data = buf.getChannelData(0), sr = buf.sampleRate, chunkSize = Math.floor(sr * 0.05), chunks = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    const sl = data.slice(i, i + chunkSize); let rms = 0;
    for (let j = 0; j < sl.length; j++) rms += sl[j] * sl[j];
    chunks.push({ time: i / sr, rms: Math.sqrt(rms / sl.length) });
  }
  const pauses = [], silenceThresh = 0.008; let sStart = null;
  for (const c of chunks) { if (c.rms < silenceThresh) { if (!sStart) sStart = c.time; } else { if (sStart) { const l = c.time - sStart; if (l > 0.8) pauses.push({ start: sStart, end: c.time, duration: l }); sStart = null; } } }
  const avgRms = chunks.reduce((a, c) => a + c.rms, 0) / chunks.length, noiseThresh = avgRms * 4, noiseEvents = []; let nStart = null;
  for (const c of chunks) { if (c.rms > noiseThresh) { if (!nStart) nStart = c.time; } else { if (nStart) { noiseEvents.push({ start: nStart, end: c.time, duration: c.time - nStart }); nStart = null; } } }
  const step = Math.max(1, Math.floor(chunks.length / 280));
  return { duration: buf.duration, pauses, noiseEvents, waveform: chunks.filter((_, i) => i % step === 0).map((c) => ({ time: c.time, amplitude: c.rms })), avgRms };
}

function fmt(s) { const m = Math.floor(s / 60), sec = Math.floor(s % 60), ms = Math.floor((s % 1) * 10); return `${m}:${sec.toString().padStart(2, '0')}.${ms}`; }

function Waveform({ data, pauses, noiseEvents, duration }) {
  if (!data?.length) return null;
  const w = 760, h = 90, mx = Math.max(...data.map((d) => d.amplitude), 0.001);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 90, borderRadius: 6, background: 'rgba(0,0,0,0.35)' }}>
      {data.map((d, i) => {
        const x = (d.time / duration) * w, bH = (d.amplitude / mx) * h * 0.88;
        const isPause = pauses.some((p) => d.time >= p.start && d.time <= p.end);
        const isNoise = noiseEvents.some((n) => d.time >= n.start && d.time <= n.end);
        return <rect key={i} x={x} y={(h - bH) / 2} width={Math.max(1.8, w / data.length - 0.5)} height={Math.max(0.5, bH)} fill={isNoise ? '#ef4444' : isPause ? '#eab308' : '#06b6d4'} rx="0.8" opacity="0.8" />;
      })}
    </svg>
  );
}

function Badge({ level }) {
  const c = { critical: ['#7f1d1d', '#fca5a5', '#dc2626'], warning: ['#713f12', '#fde68a', '#f59e0b'], info: ['#0c4a6e', '#7dd3fc', '#0284c7'], pass: ['#052e16', '#86efac', '#16a34a'] }[level] || ['#0c4a6e', '#7dd3fc', '#0284c7'];
  return <span style={{ display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', background: c[0], color: c[1], border: `1px solid ${c[2]}`, borderRadius: 3, whiteSpace: 'nowrap' }}>{level}</span>;
}
function Stat({ label, count, color }) {
  return (<div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid #1e293b', borderRadius: 10, padding: '14px 10px', textAlign: 'center', flex: 1, minWidth: 0 }}>
    <div style={{ fontSize: 26, fontWeight: 900, color: count > 0 ? color : '#16a34a' }}>{count}</div>
    <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.07em', marginTop: 3 }}>{label}</div>
  </div>);
}
function IssueSection({ title, icon, items, renderItem }) {
  if (!items?.length) return null;
  return (<div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid #1e293b', borderRadius: 14, padding: '20px 22px' }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>{icon} {title}</div>
    {items.map((item, i) => (<div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderTop: i > 0 ? '1px solid #1e293b' : 'none', flexWrap: 'wrap' }}>{renderItem(item)}</div>))}
  </div>);
}

export default function AudioQCStation() {
  const [state, setState] = useState(STATES.IDLE);
  const [scriptText, setScriptText] = useState('');
  const [scriptFileName, setScriptFileName] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [audioName, setAudioName] = useState('');
  const [progress, setProgress] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [dragAudio, setDragAudio] = useState(false);
  const [dragScript, setDragScript] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [transcriptPreview, setTranscriptPreview] = useState('');
  const audioRef = useRef();
  const scriptRef = useRef();

  const parsedScript = useMemo(() => (scriptText ? parseScript(scriptText) : []), [scriptText]);
  const cueStats = useMemo(() => { const s = { SFX: 0, MUSIC: 0, AMBIENT: 0, VOA: 0, DIALOGUE: 0 }; parsedScript.forEach((p) => s[p.type]++); return s; }, [parsedScript]);

  const handleAudio = (file) => {
    if (file && (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(file.name))) { setAudioFile(file); setAudioName(file.name); setError(''); }
    else setError('Upload a valid audio file.');
  };
  const handleScript = async (file) => {
    setError(''); const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.docx') || name.endsWith('.doc')) { const buf = await file.arrayBuffer(); const r = await mammoth.extractRawText({ arrayBuffer: buf }); setScriptText(r.value); setScriptFileName(file.name); }
      else if (name.endsWith('.txt') || name.endsWith('.md')) { setScriptText(await file.text()); setScriptFileName(file.name); }
      else setError('Upload .docx, .txt, or .md file.');
    } catch (e) { setError('Failed to read script: ' + e.message); }
  };

  const runQC = useCallback(async () => {
    if (!audioFile || !scriptText.trim()) { setError('Upload both an audio file and a script.'); return; }
    setState(STATES.ANALYZING); setError(''); setResults(null); setTranscriptPreview('');

    try {
      // 1. Analyze audio waveform client-side
      setProgress('Decoding audio waveform…'); setProgressPct(5);
      const ab = await audioFile.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuf = await ctx.decodeAudioData(ab);
      const audioAnalysis = analyzeAudioBuffer(audioBuf);
      ctx.close();

      // 2. Transcribe via server API (Groq Whisper — no CORS!)
      setProgress('Transcribing audio with Whisper AI…'); setProgressPct(15);
      const formData = new FormData();
      formData.append('file', audioFile);

      const transcribeResp = await fetch('/api/transcribe', { method: 'POST', body: formData });
      const transcribeData = await transcribeResp.json();

      if (!transcribeResp.ok) throw new Error(transcribeData.error || 'Transcription failed');
      const transcript = transcribeData.text;
      setTranscriptPreview(transcript);

      if (!transcript || transcript.trim().length < 5) throw new Error('Transcription returned empty. Audio may be silent or too short.');

      // 3. QC analysis via server API (Claude)
      setProgress('Running AI QC analysis…'); setProgressPct(55);
      const sfxCues = parsedScript.filter((p) => p.type === 'SFX').map((p) => p.text);
      const musicCues = parsedScript.filter((p) => p.type === 'MUSIC').map((p) => p.text);
      const ambientCues = parsedScript.filter((p) => p.type === 'AMBIENT').map((p) => p.text);
      const voaCues = parsedScript.filter((p) => p.type === 'VOA').map((p) => p.text);
      const dialogueLines = parsedScript.filter((p) => p.type === 'DIALOGUE').map((p) => p.text);

      const analyzeResp = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scriptText,
          transcript,
          dialogueLines,
          sfxCues,
          musicCues,
          ambientCues,
          voaCues,
          audioData: {
            duration: audioAnalysis.duration.toFixed(1),
            pauseCount: audioAnalysis.pauses.length,
            noiseCount: audioAnalysis.noiseEvents.length,
            pauses: audioAnalysis.pauses.slice(0, 10).map((p) => fmt(p.start) + '(' + p.duration.toFixed(1) + 's)').join(', ') || 'none',
            noise: audioAnalysis.noiseEvents.slice(0, 8).map((n) => fmt(n.start)).join(', ') || 'none',
          },
        }),
      });

      setProgressPct(90);
      const analyzeData = await analyzeResp.json();
      if (!analyzeResp.ok) throw new Error(analyzeData.error || 'Analysis failed');

      setResults({ ...analyzeData, audioAnalysis, transcript });
      setState(STATES.DONE); setProgress(''); setProgressPct(100);
    } catch (err) {
      console.error(err);
      setError('Analysis failed: ' + err.message);
      setState(STATES.IDLE); setProgress(''); setProgressPct(0);
    }
  }, [audioFile, scriptText, parsedScript]);

  const reset = () => {
    setState(STATES.IDLE); setResults(null); setAudioFile(null); setAudioName('');
    setScriptText(''); setScriptFileName(''); setTranscriptPreview('');
    setError(''); setProgress(''); setProgressPct(0); setActiveTab('overview');
  };

  const vColors = { PASS: '#16a34a', NEEDS_REVIEW: '#eab308', FAIL: '#ef4444' };
  const totalIssues = results ? (results.missingDialogue?.length || 0) + (results.sfxIssues?.filter(i => i.status !== 'ok').length || 0) + (results.musicIssues?.filter(i => i.status !== 'ok').length || 0) + (results.ambientIssues?.filter(i => i.status !== 'ok').length || 0) + (results.voiceActingIssues?.filter(i => i.status !== 'ok').length || 0) + (results.pauseIssues?.length || 0) + (results.noiseIssues?.length || 0) + (results.mispronunciations?.length || 0) : 0;

  const ss = { page: { minHeight: '100vh', background: 'linear-gradient(170deg, #080b14 0%, #0f1524 35%, #0c1220 100%)', color: '#cbd5e1', fontFamily: "'IBM Plex Mono', 'Fira Code', monospace" } };

  return (
    <div style={ss.page}>
      {/* Header */}
      <header style={{ borderBottom: '1px solid #1e293b', padding: '16px 28px', display: 'flex', alignItems: 'center', gap: 14, background: 'rgba(0,0,0,0.4)' }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg, #ef4444 0%, #f97316 50%, #eab308 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 900, color: '#fff', fontFamily: "'Instrument Serif', serif" }}>Q</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>Audio QC Station</div>
          <div style={{ fontSize: 10, color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Auto-Transcribe · Script Compliance · SFX · Dialogue</div>
        </div>
        {state === STATES.DONE && <button onClick={reset} style={{ marginLeft: 'auto', padding: '7px 18px', background: 'transparent', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>← New Analysis</button>}
      </header>

      <div style={{ maxWidth: 880, margin: '0 auto', padding: '28px 20px' }}>

        {/* ═══ INPUT ═══ */}
        {state !== STATES.DONE && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7 }}>
              <strong style={{ color: '#f8fafc' }}>Upload audio + script → fully automatic QC.</strong> No API keys needed, no transcript to generate. Just drop your files.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>🎙 Audio Recording</label>
                <div onClick={() => audioRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragAudio(true); }} onDragLeave={() => setDragAudio(false)}
                  onDrop={(e) => { e.preventDefault(); setDragAudio(false); handleAudio(e.dataTransfer.files[0]); }}
                  style={{ border: `2px dashed ${dragAudio ? '#f97316' : audioName ? '#16a34a' : '#1e293b'}`, borderRadius: 10, padding: '40px 16px', textAlign: 'center', cursor: 'pointer', background: dragAudio ? 'rgba(249,115,22,0.05)' : 'rgba(0,0,0,0.2)' }}>
                  <input ref={audioRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={(e) => handleAudio(e.target.files[0])} />
                  {audioName ? (<><div style={{ fontSize: 24 }}>✅</div><div style={{ color: '#86efac', fontWeight: 600, fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>{audioName}</div><div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>Auto-transcribed by Whisper</div></>) : (<><div style={{ fontSize: 24 }}>📁</div><div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>Drop audio or click</div><div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>MP3 · WAV · M4A · OGG · FLAC</div></>)}
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>📜 Script File</label>
                <div onClick={() => scriptRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragScript(true); }} onDragLeave={() => setDragScript(false)}
                  onDrop={(e) => { e.preventDefault(); setDragScript(false); handleScript(e.dataTransfer.files[0]); }}
                  style={{ border: `2px dashed ${dragScript ? '#f97316' : scriptFileName ? '#16a34a' : '#1e293b'}`, borderRadius: 10, padding: '40px 16px', textAlign: 'center', cursor: 'pointer', background: dragScript ? 'rgba(249,115,22,0.05)' : 'rgba(0,0,0,0.2)' }}>
                  <input ref={scriptRef} type="file" accept=".docx,.doc,.txt,.md" style={{ display: 'none' }} onChange={(e) => handleScript(e.target.files[0])} />
                  {scriptFileName ? (<><div style={{ fontSize: 24 }}>✅</div><div style={{ color: '#86efac', fontWeight: 600, fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>{scriptFileName}</div></>) : (<><div style={{ fontSize: 24 }}>📄</div><div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>Drop script or click</div><div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>DOCX · DOC · TXT</div></>)}
                </div>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>…or paste script</label>
              <textarea value={scriptText} onChange={(e) => { setScriptText(e.target.value); setScriptFileName(''); }} placeholder="Paste script with SFX cues, music directions, dialogue…" rows={5}
                style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid #1e293b', borderRadius: 10, padding: 14, color: '#cbd5e1', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.7, boxSizing: 'border-box' }}
                onFocus={(e) => (e.target.style.borderColor = '#f97316')} onBlur={(e) => (e.target.style.borderColor = '#1e293b')} />
            </div>

            {parsedScript.length > 0 && (
              <div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid #1e293b', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Script Parsed</span>
                  <div style={{ display: 'flex', gap: 10, fontSize: 10, flexWrap: 'wrap' }}>
                    {Object.entries(cueStats).filter(([, v]) => v > 0).map(([k, v]) => (<span key={k} style={{ color: CUE_TYPES[k].color }}>{CUE_TYPES[k].icon} {v}</span>))}
                  </div>
                </div>
                <div style={{ maxHeight: 140, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {parsedScript.slice(0, 30).map((p, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 6px', borderRadius: 4, background: CUE_TYPES[p.type].bg }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: CUE_TYPES[p.type].color, minWidth: 48, textTransform: 'uppercase' }}>{CUE_TYPES[p.type].icon} {p.type}</span>
                      <span style={{ fontSize: 10, color: CUE_TYPES[p.type].color, opacity: 0.8, lineHeight: 1.5 }}>{p.text.substring(0, 100)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid #7f1d1d', borderRadius: 8, color: '#fca5a5', fontSize: 12 }}>{error}</div>}

            <button onClick={runQC} disabled={state === STATES.ANALYZING}
              style={{ padding: '16px 28px', background: state === STATES.ANALYZING ? '#1e293b' : 'linear-gradient(135deg, #ef4444, #f97316, #eab308)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', cursor: state === STATES.ANALYZING ? 'wait' : 'pointer', opacity: state === STATES.ANALYZING ? 0.7 : 1 }}>
              {state === STATES.ANALYZING ? `⏳ ${progress}` : '▶ Run QC Analysis'}
            </button>

            {state === STATES.ANALYZING && (
              <div style={{ height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${progressPct}%`, height: '100%', background: 'linear-gradient(90deg, #ef4444, #f97316, #eab308)', borderRadius: 2, transition: 'width 0.5s ease' }} />
              </div>
            )}

            {transcriptPreview && state === STATES.ANALYZING && (
              <div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(22,163,74,0.3)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>✅ Whisper Transcription Complete</div>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6, maxHeight: 80, overflow: 'hidden' }}>{transcriptPreview.substring(0, 400)}…</div>
              </div>
            )}
          </div>
        )}

        {/* ═══ RESULTS ═══ */}
        {state === STATES.DONE && results && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid #1e293b', borderRadius: 14, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 28 }}>
              <div style={{ textAlign: 'center', minWidth: 100 }}>
                <div style={{ fontSize: 56, fontWeight: 900, color: vColors[results.overallVerdict] || '#94a3b8', lineHeight: 1, fontFamily: "'Instrument Serif', serif" }}>{results.overallScore}</div>
                <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.15em', marginTop: 2 }}>Score</div>
                <div style={{ display: 'inline-block', marginTop: 8, padding: '4px 14px', borderRadius: 14, fontSize: 11, fontWeight: 800, color: vColors[results.overallVerdict], background: `${vColors[results.overallVerdict]}18`, border: `1px solid ${vColors[results.overallVerdict]}40` }}>{results.overallVerdict}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.7 }}>{results.summary}</div>
                <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>{totalIssues} issue{totalIssues !== 1 ? 's' : ''} · {fmt(results.audioAnalysis.duration)}</div>
              </div>
            </div>

            <div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid #1e293b', borderRadius: 12, padding: '16px 20px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Waveform</div>
              <Waveform data={results.audioAnalysis.waveform} pauses={results.audioAnalysis.pauses} noiseEvents={results.audioAnalysis.noiseEvents} duration={results.audioAnalysis.duration} />
              <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 10, color: '#475569' }}>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#06b6d4', borderRadius: 2, marginRight: 3, verticalAlign: 'middle' }} />Normal</span>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#eab308', borderRadius: 2, marginRight: 3, verticalAlign: 'middle' }} />Pause</span>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#ef4444', borderRadius: 2, marginRight: 3, verticalAlign: 'middle' }} />Noise</span>
              </div>
            </div>

            {results.transcript && (
              <details style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid #1e293b', borderRadius: 12, padding: '16px 20px' }}>
                <summary style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', cursor: 'pointer' }}>📝 Auto-Generated Transcript (click to expand)</summary>
                <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.8, marginTop: 12, whiteSpace: 'pre-wrap' }}>{results.transcript}</div>
              </details>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Stat label="Missing Lines" count={results.missingDialogue?.length || 0} color="#ef4444" />
              <Stat label="Wrong Words" count={results.mispronunciations?.length || 0} color="#fb923c" />
              <Stat label="SFX" count={results.sfxIssues?.filter(i => i.status !== 'ok').length || 0} color="#f97316" />
              <Stat label="Music" count={results.musicIssues?.filter(i => i.status !== 'ok').length || 0} color="#a78bfa" />
              <Stat label="Ambient" count={results.ambientIssues?.filter(i => i.status !== 'ok').length || 0} color="#2dd4bf" />
              <Stat label="VOA" count={results.voiceActingIssues?.filter(i => i.status !== 'ok').length || 0} color="#f472b6" />
              <Stat label="Pauses" count={results.pauseIssues?.length || 0} color="#eab308" />
              <Stat label="Noise" count={results.noiseIssues?.length || 0} color="#ef4444" />
            </div>

            <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #1e293b', overflowX: 'auto' }}>
              {[{ id: 'overview', label: 'All' }, { id: 'dialogue', label: '💬 Dialogue' }, { id: 'sfx', label: '💥 SFX' }, { id: 'music', label: '🎵 Music' }, { id: 'ambient', label: '🌊 Ambient' }].map((t) => (
                <button key={t.id} onClick={() => setActiveTab(t.id)}
                  style={{ padding: '8px 14px', fontSize: 11, fontFamily: 'inherit', fontWeight: activeTab === t.id ? 700 : 400, background: activeTab === t.id ? 'rgba(249,115,22,0.1)' : 'transparent', color: activeTab === t.id ? '#f97316' : '#64748b', border: 'none', borderBottom: activeTab === t.id ? '2px solid #f97316' : '2px solid transparent', cursor: 'pointer', whiteSpace: 'nowrap' }}>{t.label}</button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {(activeTab === 'overview' || activeTab === 'dialogue') && (<>
                <IssueSection title="Missing Dialogue Lines" icon="💬" items={results.missingDialogue} renderItem={(m) => (<><Badge level={m.severity} /><div><div style={{ color: '#fca5a5', fontSize: 12, fontStyle: 'italic', lineHeight: 1.5 }}>"{m.line}"</div>{m.context && <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{m.context}</div>}</div></>)} />
                <IssueSection title="Word Differences" icon="🗣" items={results.mispronunciations} renderItem={(m) => (<><Badge level={m.severity} /><span style={{ color: '#86efac', fontSize: 12 }}>Script: <strong>{m.expected}</strong></span><span style={{ color: '#334155' }}>→</span><span style={{ color: '#fca5a5', fontSize: 12 }}>Heard: <strong>{m.heard}</strong></span></>)} />
              </>)}
              {(activeTab === 'overview' || activeTab === 'sfx') && <IssueSection title="SFX Issues" icon="💥" items={results.sfxIssues?.filter(i => i.status !== 'ok')} renderItem={(s) => (<><Badge level={s.severity} /><span style={{ fontSize: 10, fontWeight: 700, color: '#f97316', textTransform: 'uppercase', padding: '2px 6px', background: 'rgba(249,115,22,0.1)', borderRadius: 3 }}>{s.status}</span><div><div style={{ color: '#e2e8f0', fontSize: 12 }}>{s.cue}</div><div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{s.note}</div></div></>)} />}
              {(activeTab === 'overview' || activeTab === 'music') && <IssueSection title="Music Issues" icon="🎵" items={results.musicIssues?.filter(i => i.status !== 'ok')} renderItem={(m) => (<><Badge level={m.severity} /><span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', padding: '2px 6px', background: 'rgba(167,139,250,0.1)', borderRadius: 3 }}>{m.status}</span><div><div style={{ color: '#e2e8f0', fontSize: 12 }}>{m.cue}</div><div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{m.note}</div></div></>)} />}
              {(activeTab === 'overview' || activeTab === 'ambient') && <IssueSection title="Ambient Issues" icon="🌊" items={results.ambientIssues?.filter(i => i.status !== 'ok')} renderItem={(a) => (<><Badge level={a.severity} /><span style={{ fontSize: 10, fontWeight: 700, color: '#2dd4bf', textTransform: 'uppercase', padding: '2px 6px', background: 'rgba(45,212,191,0.1)', borderRadius: 3 }}>{a.status}</span><div><div style={{ color: '#e2e8f0', fontSize: 12 }}>{a.cue}</div><div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{a.note}</div></div></>)} />}
              {activeTab === 'overview' && (<>
                <IssueSection title="Voice Acting" icon="🎭" items={results.voiceActingIssues?.filter(i => i.status !== 'ok')} renderItem={(v) => (<><Badge level={v.severity} /><div><div style={{ color: '#f472b6', fontSize: 12 }}>{v.cue}</div><div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{v.note}</div></div></>)} />
                <IssueSection title="Pauses" icon="⏸" items={results.pauseIssues} renderItem={(p) => (<><Badge level={p.severity} /><span style={{ color: '#fde68a', fontSize: 12 }}>{p.note}</span><span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>@ {p.timestamp} · {p.duration}s</span></>)} />
                <IssueSection title="Noise" icon="📢" items={results.noiseIssues} renderItem={(n) => (<><Badge level={n.severity} /><span style={{ color: '#fca5a5', fontSize: 12 }}>{n.note}</span><span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>@ {n.timestamp}</span></>)} />
                {results.additionalNotes?.length > 0 && (
                  <div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid #1e293b', borderRadius: 14, padding: '16px 20px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>📝 Notes</div>
                    {results.additionalNotes.map((n, i) => <div key={i} style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.6, padding: '3px 0' }}>• {n}</div>)}
                  </div>
                )}
              </>)}
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        textarea::placeholder, input::placeholder { color: #334155; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
        details summary { list-style: none; } details summary::-webkit-details-marker { display: none; }
      `}</style>
    </div>
  );
}

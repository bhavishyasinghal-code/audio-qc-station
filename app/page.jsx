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
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/^Ep\s*\d+/i.test(l.replace(/\*+/g, '').trim()));
  const parsed = [];
  for (const line of lines) {
    const clean = line.replace(/\*+/g, '').trim();
    if (/^AMBIENT\s*SFX[:.\s]/i.test(clean)) parsed.push({ type: 'AMBIENT', text: clean });
    else if (/^SFX[:.\s]/i.test(clean)) parsed.push({ type: 'SFX', text: clean });
    else if (/^MUSIC\s*(CUE)?[:.\s]/i.test(clean)) parsed.push({ type: 'MUSIC', text: clean });
    else if (/^VOA\s*(CUE)?[:.\s]/i.test(clean)) parsed.push({ type: 'VOA', text: clean });
    else if (/^(SFX|MUSIC|AMBIENT|VOA)/i.test(clean)) {
      const upper = clean.toUpperCase();
      parsed.push({ type: upper.includes('AMBIENT') ? 'AMBIENT' : upper.includes('SFX') ? 'SFX' : upper.includes('MUSIC') ? 'MUSIC' : 'VOA', text: clean });
    } else parsed.push({ type: 'DIALOGUE', text: clean });
  }
  return parsed;
}

async function loadLameJs() {
  if (typeof window !== 'undefined' && window.lamejs) return window.lamejs;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    s.onload = () => resolve(window.lamejs);
    s.onerror = () => reject(new Error('Failed to load MP3 encoder'));
    document.head.appendChild(s);
  });
}

async function getWavInfo(file) {
  const head = await file.slice(0, 12).arrayBuffer();
  const hv = new DataView(head);
  const riff = String.fromCharCode(hv.getUint8(0), hv.getUint8(1), hv.getUint8(2), hv.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file');
  let channels = 2, sampleRate = 44100, bitsPerSample = 16, dataOffset = -1, dataSize = 0;
  let offset = 12;
  const scanLimit = Math.min(file.size, 5 * 1024 * 1024);
  while (offset < scanLimit - 8) {
    const chBuf = await file.slice(offset, offset + 8).arrayBuffer();
    const cv = new DataView(chBuf);
    const id = String.fromCharCode(cv.getUint8(0), cv.getUint8(1), cv.getUint8(2), cv.getUint8(3));
    const size = cv.getUint32(4, true);
    if (id === 'fmt ') {
      const fmtBuf = await file.slice(offset + 8, offset + 8 + Math.min(size, 40)).arrayBuffer();
      const fv = new DataView(fmtBuf);
      channels = fv.getUint16(2, true);
      sampleRate = fv.getUint32(4, true);
      bitsPerSample = fv.getUint16(14, true);
    }
    if (id === 'data') { dataOffset = offset + 8; dataSize = size; break; }
    offset += 8 + size;
    if (size % 2 !== 0) offset++;
  }
  if (dataOffset === -1) throw new Error('No audio data found in WAV');
  if (dataSize === 0 || dataSize > file.size) dataSize = file.size - dataOffset;
  return { channels, sampleRate, bitsPerSample, dataOffset, dataSize };
}

async function streamWavToMp3Segments(file, onProgress) {
  const lame = await loadLameJs();
  const info = await getWavInfo(file);
  const { channels, sampleRate, bitsPerSample, dataOffset, dataSize } = info;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const targetRate = 16000;
  const ratio = sampleRate / targetRate;
  const targetBitRate = 64;
  const segmentDuration = 300;
  const samplesPerSegment = segmentDuration * targetRate;
  const readSize = Math.floor((2 * 1024 * 1024) / blockAlign) * blockAlign;
  const segments = [];
  let encoder = new lame.Mp3Encoder(1, targetRate, targetBitRate);
  let mp3Chunks = [];
  let segmentSamples = 0;
  let filePos = dataOffset;
  const fileEnd = dataOffset + dataSize;
  let totalRead = 0;
  while (filePos < fileEnd) {
    const end = Math.min(filePos + readSize, fileEnd);
    const raw = await file.slice(filePos, end).arrayBuffer();
    const view = new DataView(raw);
    const numFrames = Math.floor(raw.byteLength / blockAlign);
    const outLen = Math.floor(numFrames / ratio);
    if (outLen > 0) {
      const samples = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcFrame = Math.floor(i * ratio);
        const byteOff = srcFrame * blockAlign;
        if (byteOff + bytesPerSample <= raw.byteLength) {
          if (bitsPerSample === 16) {
            if (channels >= 2 && byteOff + 4 <= raw.byteLength) { samples[i] = (view.getInt16(byteOff, true) + view.getInt16(byteOff + 2, true)) >> 1; }
            else { samples[i] = view.getInt16(byteOff, true); }
          } else if (bitsPerSample === 24) {
            let val = view.getUint8(byteOff) | (view.getUint8(byteOff+1) << 8) | (view.getInt8(byteOff+2) << 16);
            if (channels >= 2 && byteOff + 6 <= raw.byteLength) { let v2 = view.getUint8(byteOff+3)|(view.getUint8(byteOff+4)<<8)|(view.getInt8(byteOff+5)<<16); val = (val+v2)>>1; }
            samples[i] = val >> 8;
          } else if (bitsPerSample === 32) {
            if (channels >= 2 && byteOff + 8 <= raw.byteLength) { samples[i] = ((view.getInt32(byteOff, true) + view.getInt32(byteOff + 4, true)) / 2) >> 16; }
            else { samples[i] = view.getInt32(byteOff, true) >> 16; }
          }
        }
      }
      const buf = encoder.encodeBuffer(samples);
      if (buf.length > 0) mp3Chunks.push(new Uint8Array(buf));
      segmentSamples += outLen;
    }
    if (segmentSamples >= samplesPerSegment) {
      const flush = encoder.flush();
      if (flush.length > 0) mp3Chunks.push(new Uint8Array(flush));
      if (mp3Chunks.length > 0) segments.push(new Blob(mp3Chunks, { type: 'audio/mpeg' }));
      mp3Chunks = []; encoder = new lame.Mp3Encoder(1, targetRate, targetBitRate); segmentSamples = 0;
    }
    filePos = end; totalRead += raw.byteLength;
    onProgress(Math.min(0.99, totalRead / dataSize));
  }
  const flush = encoder.flush();
  if (flush.length > 0) mp3Chunks.push(new Uint8Array(flush));
  if (mp3Chunks.length > 0) segments.push(new Blob(mp3Chunks, { type: 'audio/mpeg' }));
  onProgress(1);
  return segments;
}

async function compressNonWav(file, onProgress) {
  const lame = await loadLameJs();
  onProgress(0.1);
  const buf = await file.arrayBuffer();
  onProgress(0.2);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  onProgress(0.3);
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  const ratio = decoded.sampleRate / 16000;
  const total = Math.floor(decoded.length / ratio);
  const encoder = new lame.Mp3Encoder(1, 16000, 64);
  const mp3Chunks = [];
  const block = 50000;
  for (let i = 0; i < total; i += block) {
    const end = Math.min(i + block, total);
    const samples = new Int16Array(end - i);
    for (let j = 0; j < end - i; j++) {
      const idx = Math.floor((i + j) * ratio);
      if (idx < decoded.length) { samples[j] = Math.max(-32768, Math.min(32767, Math.floor(((left[idx] + right[idx]) / 2) * 32767))); }
    }
    const b = encoder.encodeBuffer(samples);
    if (b.length > 0) mp3Chunks.push(new Uint8Array(b));
    onProgress(0.3 + 0.65 * (end / total));
  }
  const flush = encoder.flush();
  if (flush.length > 0) mp3Chunks.push(new Uint8Array(flush));
  onProgress(1);
  return [new Blob(mp3Chunks, { type: 'audio/mpeg' })];
}

function fmt(s) { return Math.floor(s/60)+':'+Math.floor(s%60).toString().padStart(2,'0')+'.'+Math.floor((s%1)*10); }
function formatSize(bytes) { return bytes < 1024*1024 ? (bytes/1024).toFixed(0)+' KB' : (bytes/(1024*1024)).toFixed(1)+' MB'; }

function Waveform({ data, pauses, noiseEvents, duration }) {
  if (!data?.length) return null;
  const w = 760, h = 90, mx = Math.max(...data.map(d => d.amplitude), 0.001);
  return (<svg viewBox={`0 0 ${w} ${h}`} style={{width:'100%',height:90,borderRadius:6,background:'rgba(0,0,0,0.35)'}}>
    {data.map((d,i) => {
      const x=(d.time/duration)*w, bH=(d.amplitude/mx)*h*0.88;
      const col = noiseEvents.some(n=>d.time>=n.start&&d.time<=n.end)?'#ef4444':pauses.some(p=>d.time>=p.start&&d.time<=p.end)?'#eab308':'#06b6d4';
      return <rect key={i} x={x} y={(h-bH)/2} width={Math.max(1.8,w/data.length-0.5)} height={Math.max(0.5,bH)} fill={col} rx="0.8" opacity="0.8"/>;
    })}
  </svg>);
}

function Badge({level}) {
  const c={critical:['#7f1d1d','#fca5a5','#dc2626'],warning:['#713f12','#fde68a','#f59e0b'],info:['#0c4a6e','#7dd3fc','#0284c7'],pass:['#052e16','#86efac','#16a34a']}[level]||['#0c4a6e','#7dd3fc','#0284c7'];
  return <span style={{display:'inline-block',padding:'2px 8px',fontSize:10,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',background:c[0],color:c[1],border:'1px solid '+c[2],borderRadius:3,whiteSpace:'nowrap'}}>{level}</span>;
}
function Stat({label,count,color}) {
  return (<div style={{background:'rgba(0,0,0,0.25)',border:'1px solid #1e293b',borderRadius:10,padding:'14px 10px',textAlign:'center',flex:1,minWidth:0}}>
    <div style={{fontSize:26,fontWeight:900,color:count>0?color:'#16a34a'}}>{count}</div>
    <div style={{fontSize:9,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.07em',marginTop:3}}>{label}</div>
  </div>);
}
function IssueSection({title,icon,items,renderItem}) {
  if (!items?.length) return null;
  return (<div style={{background:'rgba(0,0,0,0.25)',border:'1px solid #1e293b',borderRadius:14,padding:'20px 22px'}}>
    <div style={{fontSize:11,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:14}}>{icon} {title}</div>
    {items.map((item,i)=>(<div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 0',borderTop:i>0?'1px solid #1e293b':'none',flexWrap:'wrap'}}>{renderItem(item)}</div>))}
  </div>);
}

export default function AudioQCStation() {
  const [state, setState] = useState(STATES.IDLE);
  const [scriptText, setScriptText] = useState('');
  const [scriptFileName, setScriptFileName] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [audioName, setAudioName] = useState('');
  const [audioSize, setAudioSize] = useState(0);
  const [progress, setProgress] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [compressInfo, setCompressInfo] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [dragAudio, setDragAudio] = useState(false);
  const [dragScript, setDragScript] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [transcriptPreview, setTranscriptPreview] = useState('');
  const audioRef = useRef();
  const scriptRef = useRef();

  const parsedScript = useMemo(() => scriptText ? parseScript(scriptText) : [], [scriptText]);
  const cueStats = useMemo(() => { const s={SFX:0,MUSIC:0,AMBIENT:0,VOA:0,DIALOGUE:0}; parsedScript.forEach(p=>s[p.type]++); return s; }, [parsedScript]);

  const handleAudio = f => {
    if (f && (f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(f.name))) {
      setAudioFile(f); setAudioName(f.name); setAudioSize(f.size); setError('');
    } else setError('Upload a valid audio file.');
  };
  const handleScript = async f => {
    setError(''); const n = f.name.toLowerCase();
    try {
      if (n.endsWith('.docx')||n.endsWith('.doc')) { const b = await f.arrayBuffer(); const r = await mammoth.extractRawText({arrayBuffer:b}); setScriptText(r.value); setScriptFileName(f.name); }
      else if (n.endsWith('.txt')||n.endsWith('.md')) { setScriptText(await f.text()); setScriptFileName(f.name); }
      else setError('Upload .docx, .txt, or .md file.');
    } catch(e) { setError('Failed to read: '+e.message); }
  };

  const runQC = useCallback(async () => {
    if (!audioFile || !scriptText.trim()) { setError('Upload both an audio file and a script.'); return; }
    setState(STATES.ANALYZING); setError(''); setResults(null); setTranscriptPreview(''); setCompressInfo('');

    try {
      const isWav = audioFile.name.toLowerCase().endsWith('.wav');
      const needsCompression = audioFile.size > 10 * 1024 * 1024;
      let audioSegments = [];

      if (needsCompression) {
        setProgress('Loading MP3 encoder...'); setProgressPct(2);
        await loadLameJs();
        setProgress('Compressing ' + formatSize(audioFile.size) + '...'); setProgressPct(5);
        if (isWav) {
          audioSegments = await streamWavToMp3Segments(audioFile, pct => {
            setProgressPct(5 + Math.floor(pct * 40));
            setProgress('Compressing WAV... ' + Math.floor(pct * 100) + '%');
          });
        } else {
          audioSegments = await compressNonWav(audioFile, pct => {
            setProgressPct(5 + Math.floor(pct * 40));
            setProgress('Compressing... ' + Math.floor(pct * 100) + '%');
          });
        }
        const totalCompressed = audioSegments.reduce((a, s) => a + s.size, 0);
        setCompressInfo(formatSize(audioFile.size) + ' → ' + formatSize(totalCompressed) + ' (' + audioSegments.length + ' segment' + (audioSegments.length > 1 ? 's' : '') + ')');
      } else {
        audioSegments = [audioFile];
      }

      let audioAnalysis = { duration: 0, pauses: [], noiseEvents: [], waveform: [], avgRms: 0 };
      setProgress('Analyzing waveform...'); setProgressPct(48);
      try {
        const wfBuf = await audioSegments[0].arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await ctx.decodeAudioData(wfBuf);
        const data = decoded.getChannelData(0), sr = decoded.sampleRate, cs = Math.floor(sr*0.05), chunks = [];
        for (let i=0;i<data.length;i+=cs){const sl=data.slice(i,i+cs);let rms=0;for(let j=0;j<sl.length;j++)rms+=sl[j]*sl[j];chunks.push({time:i/sr,rms:Math.sqrt(rms/sl.length)})}
        const pauses=[];let ss2=null;
        for(const c of chunks){if(c.rms<0.008){if(!ss2)ss2=c.time}else{if(ss2){const l=c.time-ss2;if(l>0.8)pauses.push({start:ss2,end:c.time,duration:l});ss2=null}}}
        const avg=chunks.reduce((a,c)=>a+c.rms,0)/chunks.length;
        const ne=[];let ns2=null;
        for(const c of chunks){if(c.rms>avg*4){if(!ns2)ns2=c.time}else{if(ns2){ne.push({start:ns2,end:c.time,duration:c.time-ns2});ns2=null}}}
        const step=Math.max(1,Math.floor(chunks.length/280));
        audioAnalysis={duration:decoded.duration,pauses,noiseEvents:ne,waveform:chunks.filter((_,i)=>i%step===0).map(c=>({time:c.time,amplitude:c.rms})),avgRms:avg};
        ctx.close();
      } catch(e) {}

      setProgress('Transcribing ('+audioSegments.length+' segment'+(audioSegments.length>1?'s':'')+')...');
      setProgressPct(50);
      const transcripts = [];
      for (let i = 0; i < audioSegments.length; i++) {
        setProgress('Transcribing segment '+(i+1)+'/'+audioSegments.length+'...');
        setProgressPct(50+Math.floor(((i+0.5)/audioSegments.length)*25));
        const fd = new FormData();
        fd.append('file', audioSegments[i], 'segment_'+i+'.mp3');
        const resp = await fetch('/api/transcribe', {method:'POST',body:fd});
        const text = await resp.text();
        let data; try{data=JSON.parse(text)}catch(e){throw new Error('Server error: '+text.substring(0,100))}
        if (!resp.ok) throw new Error(data.error || 'Transcription failed');
        transcripts.push(data.text || '');
      }
      const fullTranscript = transcripts.join(' ').trim();
      setTranscriptPreview(fullTranscript);
      if (fullTranscript.length < 5) throw new Error('Transcription returned empty.');

      setProgress('Running AI QC analysis...'); setProgressPct(80);
      const sfxCues=parsedScript.filter(p=>p.type==='SFX').map(p=>p.text);
      const musicCues=parsedScript.filter(p=>p.type==='MUSIC').map(p=>p.text);
      const ambientCues=parsedScript.filter(p=>p.type==='AMBIENT').map(p=>p.text);
      const voaCues=parsedScript.filter(p=>p.type==='VOA').map(p=>p.text);
      const dialogueLines=parsedScript.filter(p=>p.type==='DIALOGUE').map(p=>p.text);

      const ar = await fetch('/api/analyze', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          scriptText, transcript:fullTranscript, dialogueLines, sfxCues, musicCues, ambientCues, voaCues,
          audioData: {
            duration: audioAnalysis.duration.toFixed(1),
            pauseCount: audioAnalysis.pauses.length,
            noiseCount: audioAnalysis.noiseEvents.length,
            longPauses: audioAnalysis.pauses.filter(p=>p.duration>3).map(p=>'at '+fmt(p.start)+' for '+p.duration.toFixed(1)+'s').join(', ')||'none',
            allPauses: audioAnalysis.pauses.slice(0,15).map(p=>fmt(p.start)+'('+p.duration.toFixed(1)+'s)').join(', ')||'none',
            noise: audioAnalysis.noiseEvents.slice(0,10).map(n=>'at '+fmt(n.start)+' for '+(n.duration||0).toFixed(1)+'s').join(', ')||'none',
          },
        }),
      });
      setProgressPct(95);
      const at = await ar.text();
      let ad; try{ad=JSON.parse(at)}catch(e){throw new Error('Server error: '+at.substring(0,100))}
      if (!ar.ok) throw new Error(ad.error || 'Analysis failed');

      setResults({...ad, audioAnalysis, transcript:fullTranscript});
      setState(STATES.DONE); setProgress(''); setProgressPct(100);
    } catch(err) {
      console.error(err);
      setError('Error: '+err.message);
      setState(STATES.IDLE); setProgress(''); setProgressPct(0);
    }
  }, [audioFile, scriptText, parsedScript]);

  const reset = () => {
    setState(STATES.IDLE);setResults(null);setAudioFile(null);setAudioName('');setAudioSize(0);
    setScriptText('');setScriptFileName('');setTranscriptPreview('');setCompressInfo('');
    setError('');setProgress('');setProgressPct(0);setActiveTab('overview');
  };

  const vColors={PASS:'#16a34a',NEEDS_REVIEW:'#eab308',FAIL:'#ef4444'};
  const totalIssues=results?(results.missingDialogue?.length||0)+(results.sfxIssues?.filter(i=>i.status!=='ok').length||0)+(results.musicIssues?.filter(i=>i.status!=='ok').length||0)+(results.ambientIssues?.filter(i=>i.status!=='ok').length||0)+(results.voiceActingIssues?.filter(i=>i.status!=='ok').length||0)+(results.pauseIssues?.length||0)+(results.noiseIssues?.length||0)+(results.mispronunciations?.length||0):0;

  return (
    <div style={{minHeight:'100vh',background:'linear-gradient(170deg,#080b14 0%,#0f1524 35%,#0c1220 100%)',color:'#cbd5e1',fontFamily:"'IBM Plex Mono','Fira Code',monospace"}}>
      <header style={{borderBottom:'1px solid #1e293b',padding:'16px 28px',display:'flex',alignItems:'center',gap:14,background:'rgba(0,0,0,0.4)'}}>
        <div style={{width:38,height:38,borderRadius:10,background:'linear-gradient(135deg,#ef4444,#f97316,#eab308)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,fontWeight:900,color:'#fff',fontFamily:"'Instrument Serif',serif"}}>Q</div>
        <div>
          <div style={{fontSize:16,fontWeight:700,color:'#f8fafc'}}>Audio QC Station</div>
          <div style={{fontSize:10,color:'#475569',letterSpacing:'0.12em',textTransform:'uppercase'}}>Auto-Compress · Auto-Transcribe · Script QC</div>
        </div>
        {state===STATES.DONE&&<button onClick={reset} style={{marginLeft:'auto',padding:'7px 18px',background:'transparent',border:'1px solid #334155',color:'#94a3b8',borderRadius:6,cursor:'pointer',fontSize:11,fontFamily:'inherit'}}>← New Analysis</button>}
      </header>

      <div style={{maxWidth:880,margin:'0 auto',padding:'28px 20px'}}>
        {state!==STATES.DONE&&(
          <div style={{display:'flex',flexDirection:'column',gap:20}}>
            <div style={{fontSize:13,color:'#94a3b8',lineHeight:1.7}}>
              <strong style={{color:'#f8fafc'}}>Drop audio + script → fully automatic.</strong> Large WAV files are streamed and compressed. Detects missing lines, wrong words, long pauses, and noise.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
              <div>
                <label style={{display:'block',fontSize:10,fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.12em',marginBottom:6}}>🎙 Audio Recording</label>
                <div onClick={()=>audioRef.current?.click()}
                  onDragOver={e=>{e.preventDefault();setDragAudio(true)}} onDragLeave={()=>setDragAudio(false)}
                  onDrop={e=>{e.preventDefault();setDragAudio(false);handleAudio(e.dataTransfer.files[0])}}
                  style={{border:'2px dashed '+(dragAudio?'#f97316':audioName?'#16a34a':'#1e293b'),borderRadius:10,padding:'40px 16px',textAlign:'center',cursor:'pointer',background:dragAudio?'rgba(249,115,22,0.05)':'rgba(0,0,0,0.2)'}}>
                  <input ref={audioRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" style={{display:'none'}} onChange={e=>handleAudio(e.target.files[0])}/>
                  {audioName?(<><div style={{fontSize:24}}>✅</div><div style={{color:'#86efac',fontWeight:600,fontSize:12,marginTop:4,wordBreak:'break-all'}}>{audioName}</div><div style={{fontSize:10,color:'#475569',marginTop:2}}>{formatSize(audioSize)}{audioSize>10*1024*1024?' — will be auto-compressed':''}</div></>):(<><div style={{fontSize:24}}>📁</div><div style={{color:'#64748b',fontSize:12,marginTop:6}}>Drop audio or click</div><div style={{fontSize:10,color:'#334155',marginTop:2}}>WAV · MP3 · M4A · any size</div></>)}
                </div>
              </div>
              <div>
                <label style={{display:'block',fontSize:10,fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.12em',marginBottom:6}}>📜 Script File</label>
                <div onClick={()=>scriptRef.current?.click()}
                  onDragOver={e=>{e.preventDefault();setDragScript(true)}} onDragLeave={()=>setDragScript(false)}
                  onDrop={e=>{e.preventDefault();setDragScript(false);handleScript(e.dataTransfer.files[0])}}
                  style={{border:'2px dashed '+(dragScript?'#f97316':scriptFileName?'#16a34a':'#1e293b'),borderRadius:10,padding:'40px 16px',textAlign:'center',cursor:'pointer',background:dragScript?'rgba(249,115,22,0.05)':'rgba(0,0,0,0.2)'}}>
                  <input ref={scriptRef} type="file" accept=".docx,.doc,.txt,.md" style={{display:'none'}} onChange={e=>handleScript(e.target.files[0])}/>
                  {scriptFileName?(<><div style={{fontSize:24}}>✅</div><div style={{color:'#86efac',fontWeight:600,fontSize:12,marginTop:4,wordBreak:'break-all'}}>{scriptFileName}</div></>):(<><div style={{fontSize:24}}>📄</div><div style={{color:'#64748b',fontSize:12,marginTop:6}}>Drop script or click</div><div style={{fontSize:10,color:'#334155',marginTop:2}}>DOCX · DOC · TXT</div></>)}
                </div>
              </div>
            </div>
            <div>
              <label style={{display:'block',fontSize:10,fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.12em',marginBottom:6}}>…or paste script</label>
              <textarea value={scriptText} onChange={e=>{setScriptText(e.target.value);setScriptFileName('')}} placeholder="Paste script here…" rows={5}
                style={{width:'100%',background:'rgba(0,0,0,0.3)',border:'1px solid #1e293b',borderRadius:10,padding:14,color:'#cbd5e1',fontSize:12,fontFamily:'inherit',resize:'vertical',outline:'none',lineHeight:1.7,boxSizing:'border-box'}}
                onFocus={e=>e.target.style.borderColor='#f97316'} onBlur={e=>e.target.style.borderColor='#1e293b'}/>
            </div>
            {parsedScript.length>0&&(
              <div style={{background:'rgba(0,0,0,0.25)',border:'1px solid #1e293b',borderRadius:12,padding:16}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
                  <span style={{fontSize:11,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.1em'}}>Script parsed</span>
                  <div style={{display:'flex',gap:10,fontSize:10,flexWrap:'wrap'}}>
                    {Object.entries(cueStats).filter(([,v])=>v>0).map(([k,v])=>(<span key={k} style={{color:CUE_TYPES[k].color}}>{CUE_TYPES[k].icon} {v}</span>))}
                  </div>
                </div>
                <div style={{maxHeight:120,overflowY:'auto',display:'flex',flexDirection:'column',gap:2}}>
                  {parsedScript.slice(0,20).map((p,i)=>(<div key={i} style={{display:'flex',gap:8,padding:'2px 6px',borderRadius:4,background:CUE_TYPES[p.type].bg}}>
                    <span style={{fontSize:9,fontWeight:700,color:CUE_TYPES[p.type].color,minWidth:48,textTransform:'uppercase'}}>{CUE_TYPES[p.type].icon} {p.type}</span>
                    <span style={{fontSize:10,color:CUE_TYPES[p.type].color,opacity:0.8,lineHeight:1.5}}>{p.text.substring(0,100)}</span>
                  </div>))}
                </div>
              </div>
            )}
            {error&&<div style={{padding:'10px 14px',background:'rgba(239,68,68,0.1)',border:'1px solid #7f1d1d',borderRadius:8,color:'#fca5a5',fontSize:12}}>{error}</div>}
            <button onClick={runQC} disabled={state===STATES.ANALYZING}
              style={{padding:'16px 28px',background:state===STATES.ANALYZING?'#1e293b':'linear-gradient(135deg,#ef4444,#f97316,#eab308)',border:'none',borderRadius:10,color:'#fff',fontSize:14,fontWeight:800,fontFamily:'inherit',cursor:state===STATES.ANALYZING?'wait':'pointer',opacity:state===STATES.ANALYZING?0.7:1}}>
              {state===STATES.ANALYZING?'⏳ '+progress:'▶ Run QC Analysis'}
            </button>
            {state===STATES.ANALYZING&&(<>
              <div style={{height:4,background:'#1e293b',borderRadius:2,overflow:'hidden'}}>
                <div style={{width:progressPct+'%',height:'100%',background:'linear-gradient(90deg,#ef4444,#f97316,#eab308)',borderRadius:2,transition:'width 0.3s ease'}}/>
              </div>
              {compressInfo&&<div style={{fontSize:11,color:'#86efac'}}>✅ Compressed: {compressInfo}</div>}
              {transcriptPreview&&<div style={{background:'rgba(0,0,0,0.25)',border:'1px solid rgba(22,163,74,0.3)',borderRadius:10,padding:14}}>
                <div style={{fontSize:10,fontWeight:700,color:'#16a34a',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:6}}>✅ Transcription complete</div>
                <div style={{fontSize:11,color:'#94a3b8',lineHeight:1.6,maxHeight:80,overflow:'hidden'}}>{transcriptPreview.substring(0,400)}…</div>
              </div>}
            </>)}
          </div>
        )}

        {state===STATES.DONE&&results&&(
          <div style={{display:'flex',flexDirection:'column',gap:20}}>
            <div style={{background:'rgba(0,0,0,0.3)',border:'1px solid #1e293b',borderRadius:14,padding:'28px 24px',display:'flex',alignItems:'center',gap:28}}>
              <div style={{textAlign:'center',minWidth:100}}>
                <div style={{fontSize:56,fontWeight:900,color:vColors[results.overallVerdict]||'#94a3b8',lineHeight:1,fontFamily:"'Instrument Serif',serif"}}>{results.overallScore}</div>
                <div style={{fontSize:9,color:'#475569',textTransform:'uppercase',letterSpacing:'0.15em',marginTop:2}}>Score</div>
                <div style={{display:'inline-block',marginTop:8,padding:'4px 14px',borderRadius:14,fontSize:11,fontWeight:800,color:vColors[results.overallVerdict],background:(vColors[results.overallVerdict]||'')+'18',border:'1px solid '+(vColors[results.overallVerdict]||'')+'40'}}>{results.overallVerdict}</div>
              </div>
              <div style={{flex:1}}>
                <div style={{color:'#94a3b8',fontSize:13,lineHeight:1.7}}>{results.summary}</div>
                <div style={{fontSize:11,color:'#475569',marginTop:8}}>{totalIssues} issue{totalIssues!==1?'s':''} · {results.audioAnalysis.duration>0?fmt(results.audioAnalysis.duration):'N/A'}</div>
              </div>
            </div>
            {results.audioAnalysis.waveform?.length>0&&(
              <div style={{background:'rgba(0,0,0,0.25)',border:'1px solid #1e293b',borderRadius:12,padding:'16px 20px'}}>
                <div style={{fontSize:10,fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:8}}>Waveform</div>
                <Waveform data={results.audioAnalysis.waveform} pauses={results.audioAnalysis.pauses} noiseEvents={results.audioAnalysis.noiseEvents} duration={results.audioAnalysis.duration}/>
                <div style={{display:'flex',gap:14,marginTop:8,fontSize:10,color:'#475569'}}>
                  <span><span style={{display:'inline-block',width:8,height:8,background:'#06b6d4',borderRadius:2,marginRight:3,verticalAlign:'middle'}}/>Normal</span>
                  <span><span style={{display:'inline-block',width:8,height:8,background:'#eab308',borderRadius:2,marginRight:3,verticalAlign:'middle'}}/>Pause</span>
                  <span><span style={{display:'inline-block',width:8,height:8,background:'#ef4444',borderRadius:2,marginRight:3,verticalAlign:'middle'}}/>Noise</span>
                </div>
              </div>
            )}
            {results.transcript&&(
              <details style={{background:'rgba(0,0,0,0.25)',border:'1px solid #1e293b',borderRadius:12,padding:'16px 20px'}}>
                <summary style={{fontSize:10,fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.1em',cursor:'pointer'}}>📝 Auto-generated transcript (click to expand)</summary>
                <div style={{fontSize:12,color:'#94a3b8',lineHeight:1.8,marginTop:12,whiteSpace:'pre-wrap'}}>{results.transcript}</div>
              </details>
            )}
            <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
              <Stat label="Missing Lines" count={results.missingDialogue?.length||0} color="#ef4444"/>
              <Stat label="Wrong Words" count={results.mispronunciations?.length||0} color="#fb923c"/>
              <Stat label="SFX" count={results.sfxIssues?.filter(i=>i.status!=='ok').length||0} color="#f97316"/>
              <Stat label="Music" count={results.musicIssues?.filter(i=>i.status!=='ok').length||0} color="#a78bfa"/>
              <Stat label="Ambient" count={results.ambientIssues?.filter(i=>i.status!=='ok').length||0} color="#2dd4bf"/>
              <Stat label="VOA" count={results.voiceActingIssues?.filter(i=>i.status!=='ok').length||0} color="#f472b6"/>
              <Stat label="Pauses" count={results.pauseIssues?.length||0} color="#eab308"/>
              <Stat label="Noise" count={results.noiseIssues?.length||0} color="#ef4444"/>
            </div>
            <div style={{display:'flex',gap:2,borderBottom:'1px solid #1e293b',overflowX:'auto'}}>
              {[{id:'overview',label:'All'},{id:'dialogue',label:'💬 Dialogue'},{id:'sfx',label:'💥 SFX'},{id:'music',label:'🎵 Music'},{id:'ambient',label:'🌊 Ambient'}].map(t=>(
                <button key={t.id} onClick={()=>setActiveTab(t.id)}
                  style={{padding:'8px 14px',fontSize:11,fontFamily:'inherit',fontWeight:activeTab===t.id?700:400,background:activeTab===t.id?'rgba(249,115,22,0.1)':'transparent',color:activeTab===t.id?'#f97316':'#64748b',border:'none',borderBottom:activeTab===t.id?'2px solid #f97316':'2px solid transparent',cursor:'pointer',whiteSpace:'nowrap'}}>{t.label}</button>
              ))}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:16}}>
              {(activeTab==='overview'||activeTab==='dialogue')&&(<>
                <IssueSection title="Missing dialogue lines" icon="💬" items={results.missingDialogue} renderItem={m=>(<><Badge level={m.severity}/><div><div style={{color:'#fca5a5',fontSize:12,fontStyle:'italic',lineHeight:1.5}}>"{m.line}"</div>{m.context&&<div style={{fontSize:10,color:'#475569',marginTop:2}}>{m.context}</div>}</div></>)}/>
                <IssueSection title="Word differences" icon="🗣" items={results.mispronunciations} renderItem={m=>(<><Badge level={m.severity}/><span style={{color:'#86efac',fontSize:12}}>Script: <strong>{m.expected}</strong></span><span style={{color:'#334155'}}>→</span><span style={{color:'#fca5a5',fontSize:12}}>Heard: <strong>{m.heard}</strong></span></>)}/>
              </>)}
              {(activeTab==='overview'||activeTab==='sfx')&&<IssueSection title="SFX issues" icon="💥" items={results.sfxIssues?.filter(i=>i.status!=='ok')} renderItem={s=>(<><Badge level={s.severity}/><span style={{fontSize:10,fontWeight:700,color:'#f97316',textTransform:'uppercase',padding:'2px 6px',background:'rgba(249,115,22,0.1)',borderRadius:3}}>{s.status}</span><div><div style={{color:'#e2e8f0',fontSize:12}}>{s.cue}</div><div style={{fontSize:10,color:'#64748b',marginTop:2}}>{s.note}</div></div></>)}/>}
              {(activeTab==='overview'||activeTab==='music')&&<IssueSection title="Music issues" icon="🎵" items={results.musicIssues?.filter(i=>i.status!=='ok')} renderItem={m=>(<><Badge level={m.severity}/><span style={{fontSize:10,fontWeight:700,color:'#a78bfa',textTransform:'uppercase',padding:'2px 6px',background:'rgba(167,139,250,0.1)',borderRadius:3}}>{m.status}</span><div><div style={{color:'#e2e8f0',fontSize:12}}>{m.cue}</div><div style={{fontSize:10,color:'#64748b',marginTop:2}}>{m.note}</div></div></>)}/>}
              {(activeTab==='overview'||activeTab==='ambient')&&<IssueSection title="Ambient issues" icon="🌊" items={results.ambientIssues?.filter(i=>i.status!=='ok')} renderItem={a=>(<><Badge level={a.severity}/><span style={{fontSize:10,fontWeight:700,color:'#2dd4bf',textTransform:'uppercase',padding:'2px 6px',background:'rgba(45,212,191,0.1)',borderRadius:3}}>{a.status}</span><div><div style={{color:'#e2e8f0',fontSize:12}}>{a.cue}</div><div style={{fontSize:10,color:'#64748b',marginTop:2}}>{a.note}</div></div></>)}/>}
              {activeTab==='overview'&&(<>
                <IssueSection title="Voice acting" icon="🎭" items={results.voiceActingIssues?.filter(i=>i.status!=='ok')} renderItem={v=>(<><Badge level={v.severity}/><div><div style={{color:'#f472b6',fontSize:12}}>{v.cue}</div><div style={{fontSize:10,color:'#64748b',marginTop:2}}>{v.note}</div></div></>)}/>
                <IssueSection title="Pauses" icon="⏸" items={results.pauseIssues} renderItem={p=>(<><Badge level={p.severity}/><span style={{color:'#fde68a',fontSize:12}}>{p.note}</span><span style={{fontSize:10,color:'#475569',marginLeft:'auto'}}>@ {p.timestamp} · {p.duration}s</span></>)}/>
                <IssueSection title="Noise" icon="📢" items={results.noiseIssues} renderItem={n=>(<><Badge level={n.severity}/><span style={{color:'#fca5a5',fontSize:12}}>{n.note}</span><span style={{fontSize:10,color:'#475569',marginLeft:'auto'}}>@ {n.timestamp}</span></>)}/>
                {results.additionalNotes?.length>0&&(
                  <div style={{background:'rgba(0,0,0,0.25)',border:'1px solid #1e293b',borderRadius:14,padding:'16px 20px'}}>
                    <div style={{fontSize:11,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:10}}>📝 Notes</div>
                    {results.additionalNotes.map((n,i)=><div key={i} style={{color:'#94a3b8',fontSize:12,lineHeight:1.6,padding:'3px 0'}}>• {n}</div>)}
                  </div>
                )}
              </>)}
            </div>
          </div>
        )}
      </div>
      <style jsx global>{`textarea::placeholder,input::placeholder{color:#334155}*{box-sizing:border-box}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:3px}details summary{list-style:none}details summary::-webkit-details-marker{display:none}`}</style>
    </div>
  );
}

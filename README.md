# 🎙 Audio QC Station

**Production audio QC tool** that auto-transcribes recordings and compares them against scripts line-by-line. Detects missing dialogue, mispronunciations, SFX/music gaps, noise issues, and more.

## How It Works

1. **Upload audio + script** → drag and drop, that's it
2. **Whisper AI auto-transcribes** the recording (via Groq, server-side)
3. **Claude AI compares** transcript vs script word-by-word
4. **Detailed QC report** with every issue categorized and scored

## Deploy to Vercel (5 minutes)

### Step 1: Get API Keys (free)

1. **Groq API Key** (free, for transcription):
   - Go to [console.groq.com/keys](https://console.groq.com/keys)
   - Sign up (Google/GitHub, 30 seconds)
   - Create a new API key → copy it

2. **Anthropic API Key** (for QC analysis):
   - Go to [console.anthropic.com](https://console.anthropic.com)
   - Create an API key → copy it

### Step 2: Deploy

#### Option A: Deploy with Vercel (Recommended)

1. Push this folder to a GitHub repo
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your repo
4. In **Environment Variables**, add:
   - `GROQ_API_KEY` = your Groq key
   - `ANTHROPIC_API_KEY` = your Anthropic key
5. Click **Deploy**
6. Share the URL with your team ✅

#### Option B: Run Locally

```bash
# Clone/download this folder, then:
cd audio-qc-app
npm install

# Create .env.local with your keys
cp .env.example .env.local
# Edit .env.local and paste your actual keys

# Start dev server
npm run dev
# Open http://localhost:3000
```

### Step 3: Share with Team

After deploying to Vercel, you get a URL like `https://audio-qc-station.vercel.app`. 
Share that link — anyone can use it, no login needed.

## Project Structure

```
audio-qc-app/
├── app/
│   ├── layout.jsx          # HTML layout
│   ├── page.jsx            # Main QC Station UI
│   └── api/
│       ├── transcribe/
│       │   └── route.js    # Groq Whisper API (server-side, no CORS)
│       └── analyze/
│           └── route.js    # Claude API for QC analysis
├── package.json
├── next.config.js
├── .env.example            # Template for API keys
└── README.md
```

## Features

- 📜 **Script parsing** — auto-detects SFX cues, music cues, ambient sounds, voice directions, and dialogue
- 🎧 **Auto-transcription** — Whisper large-v3 via Groq (fast, accurate, free tier)
- 🔍 **Line-by-line comparison** — finds every missing line, wrong word, and deviation
- 📊 **Waveform analysis** — detects pauses, noise spikes, and audio quality issues
- 📋 **Tabbed results** — filter by Dialogue, SFX, Music, Ambient, or see all issues
- 📁 **DOCX support** — upload Word docs directly
- 🔒 **API keys stay server-side** — never exposed to the browser

## Supported File Types

- **Audio**: MP3, WAV, M4A, OGG, FLAC, WebM, AAC
- **Scripts**: .docx, .doc, .txt, .md

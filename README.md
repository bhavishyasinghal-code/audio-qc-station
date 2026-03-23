# Audio QC Station v2

Auto-compress large WAV files → Auto-transcribe → Compare against script → Full QC report.

## Features
- **Auto-compression**: 400-500MB WAV files compressed to small MP3 in the browser
- **Chunked transcription**: Long audio split into 5-min segments, each transcribed separately
- **Script parsing**: Detects SFX, Music, Ambient, VOA cues, and dialogue
- **Line-by-line comparison**: Finds missing lines, wrong words, audio issues

## Setup
1. Push to GitHub
2. Deploy on Vercel
3. Add environment variables: `GROQ_API_KEY` and `ANTHROPIC_API_KEY`

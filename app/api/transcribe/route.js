import { NextResponse } from 'next/server';

export const maxDuration = 120;

export async function POST(request) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('file');
    const chunkIndex = formData.get('chunkIndex') || '0';
    const totalChunks = formData.get('totalChunks') || '1';

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    if (audioFile.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'Audio chunk too large. Max 25MB per chunk.' }, { status: 400 });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return NextResponse.json({ error: 'GROQ_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.' }, { status: 500 });
    }

    const groqFormData = new FormData();
    groqFormData.append('file', audioFile);
    groqFormData.append('model', 'whisper-large-v3');
    groqFormData.append('response_format', 'verbose_json');
    groqFormData.append('language', 'en');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: groqFormData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let errMsg;
      try { errMsg = JSON.parse(errText).error?.message; } catch (e) { errMsg = errText.substring(0, 200); }
      return NextResponse.json(
        { error: errMsg || `Transcription failed (${resp.status})` },
        { status: resp.status }
      );
    }

    const data = await resp.json();
    return NextResponse.json({
      text: data.text || '',
      duration: data.duration || 0,
      chunkIndex: parseInt(chunkIndex),
      totalChunks: parseInt(totalChunks),
    });
  } catch (err) {
    console.error('Transcribe error:', err);
    return NextResponse.json({ error: 'Server error: ' + err.message }, { status: 500 });
  }
}

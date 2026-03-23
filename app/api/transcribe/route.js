import { NextResponse } from 'next/server';

export const maxDuration = 60; // allow up to 60s for long audio files

export async function POST(request) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('file');

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return NextResponse.json({ error: 'GROQ_API_KEY not configured on server' }, { status: 500 });
    }

    // Forward to Groq Whisper API
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
      const err = await resp.json().catch(() => ({}));
      console.error('Groq API error:', err);
      return NextResponse.json(
        { error: err.error?.message || `Transcription failed (${resp.status})` },
        { status: resp.status }
      );
    }

    const data = await resp.json();
    return NextResponse.json({
      text: data.text || '',
      segments: data.segments || [],
      duration: data.duration || 0,
    });
  } catch (err) {
    console.error('Transcribe error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';

export const maxDuration = 60;

export async function POST(request) {
  try {
    const body = await request.json();
    const { scriptText, transcript, dialogueLines, sfxCues, musicCues, ambientCues, voaCues, audioData } = body;

    if (!scriptText || !transcript) {
      return NextResponse.json({ error: 'Missing script or transcript' }, { status: 400 });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured on server' }, { status: 500 });
    }

    const prompt = `You are a professional Audio Drama QC specialist. Compare the ORIGINAL SCRIPT against the ACTUAL TRANSCRIPT word by word.

ORIGINAL SCRIPT (what SHOULD have been recorded):
"""
${scriptText.substring(0, 5500)}
"""

ACTUAL TRANSCRIPT OF RECORDING (what WAS actually spoken):
"""
${transcript.substring(0, 4500)}
"""

ALL DIALOGUE LINES FROM SCRIPT (check each against transcript):
${(dialogueLines || []).slice(0, 60).map((d, i) => `${i + 1}. ${d}`).join('\n')}
${(dialogueLines || []).length > 60 ? `\n...+${dialogueLines.length - 60} more` : ''}

CUE COUNTS: ${(sfxCues || []).length} SFX, ${(musicCues || []).length} Music, ${(ambientCues || []).length} Ambient, ${(voaCues || []).length} VOA
SFX: ${(sfxCues || []).join(' | ')}
MUSIC: ${(musicCues || []).join(' | ')}
AMBIENT: ${(ambientCues || []).join(' | ')}
VOA: ${(voaCues || []).join(' | ')}

AUDIO DATA: Duration ${audioData?.duration || '?'}s | ${audioData?.pauseCount || 0} pauses >0.8s | ${audioData?.noiseCount || 0} noise spikes
Pauses: ${audioData?.pauses || 'none'}
Noise: ${audioData?.noise || 'none'}

INSTRUCTIONS:
1. Compare EVERY dialogue line from script against the transcript. If missing or substantially different, report it with the EXACT line from the script.
2. Report word-level differences (expected vs heard).
3. SFX/Music/Ambient won't appear as text — use waveform data to infer presence.
4. ONLY report problems. Keep notes under 15 words.

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "overallScore": 0-100,
  "overallVerdict": "PASS|NEEDS_REVIEW|FAIL",
  "summary": "2-3 sentences",
  "missingDialogue": [{"line":"exact missing line","severity":"critical|warning","context":"location in script"}],
  "mispronunciations": [{"expected":"script words","heard":"transcript words","severity":"critical|warning"}],
  "sfxIssues": [{"cue":"cue","status":"missing|weak|misplaced","severity":"critical|warning","note":"short"}],
  "musicIssues": [{"cue":"cue","status":"missing|wrong_mood","severity":"critical|warning","note":"short"}],
  "ambientIssues": [{"cue":"cue","status":"missing|weak","severity":"critical|warning","note":"short"}],
  "voiceActingIssues": [{"cue":"cue","status":"not_followed|partially_followed","severity":"warning","note":"short"}],
  "pauseIssues": [{"timestamp":"time","duration":"sec","severity":"warning|info","note":"short"}],
  "noiseIssues": [{"timestamp":"time","severity":"critical|warning","note":"short"}],
  "additionalNotes": ["short"]
}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('Anthropic API error:', err);
      return NextResponse.json(
        { error: err.error?.message || `Analysis failed (${resp.status})` },
        { status: resp.status }
      );
    }

    const data = await resp.json();
    const text = data.content.map((i) => (i.type === 'text' ? i.text : '')).join('');
    let clean = text.replace(/```json|```/g, '').trim();

    // Attempt JSON repair for truncated responses
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      let s = clean;
      if ((s.match(/"/g) || []).length % 2 !== 0) s += '"';
      const opens = { '[': 0, '{': 0 };
      for (const ch of s) {
        if (ch === '[' || ch === '{') opens[ch]++;
        if (ch === ']') opens['[']--;
        if (ch === '}') opens['{']--;
      }
      for (let i = 0; i < opens['[']; i++) s += ']';
      for (let i = 0; i < opens['{']; i++) s += '}';
      s = s.replace(/,\s*([}\]])/g, '$1');
      try {
        parsed = JSON.parse(s);
      } catch (e2) {
        return NextResponse.json({ error: 'Could not parse AI response. Try again.' }, { status: 500 });
      }
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

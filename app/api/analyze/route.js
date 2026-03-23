import { NextResponse } from 'next/server';

export const maxDuration = 120;

export async function POST(request) {
  try {
    const body = await request.json();
    const { scriptText, transcript, dialogueLines, sfxCues, musicCues, ambientCues, voaCues, audioData } = body;

    if (!scriptText || !transcript) {
      return NextResponse.json({ error: 'Missing script or transcript' }, { status: 400 });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return NextResponse.json({ error: 'GROQ_API_KEY not configured.' }, { status: 500 });
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
${(dialogueLines || []).slice(0, 60).map((d, i) => (i + 1) + '. ' + d).join('\n')}
${(dialogueLines || []).length > 60 ? '\n...+' + (dialogueLines.length - 60) + ' more' : ''}

CUE COUNTS: ${(sfxCues || []).length} SFX, ${(musicCues || []).length} Music, ${(ambientCues || []).length} Ambient, ${(voaCues || []).length} VOA
SFX: ${(sfxCues || []).join(' | ')}
MUSIC: ${(musicCues || []).join(' | ')}
AMBIENT: ${(ambientCues || []).join(' | ')}
VOA: ${(voaCues || []).join(' | ')}

AUDIO DATA: Duration ${audioData?.duration || '?'}s | ${audioData?.pauseCount || 0} pauses >0.8s | ${audioData?.noiseCount || 0} noise spikes
Pauses: ${audioData?.pauses || 'none'}
Noise: ${audioData?.noise || 'none'}

INSTRUCTIONS:
1. IGNORE title lines like "Ep 1 - Year 3100" or episode headers — these are NOT spoken dialogue.
2. Compare each dialogue line against the transcript using FUZZY matching. Whisper transcription is imperfect — "Location. Earth." might appear as "Location, Earth" or "location earth" in the transcript. If the MEANING is the same, it is NOT missing.
3. A line is ONLY "missing" if its content is completely absent from the transcript — not just worded slightly differently.
4. For mispronunciations, only report if the word is clearly WRONG (different meaning), not just minor transcription artifacts like missing periods or slightly different punctuation.
5. SFX/Music/Ambient won't appear as text — use waveform data to infer presence.
6. ONLY report real problems. Keep notes under 15 words.
7. Be lenient — Whisper often drops punctuation, changes capitalization, or slightly rewords short phrases. This is normal and should NOT be flagged.
8. Numbers are often transcribed differently — "thirty-one hundred" may appear as "3100" or "three thousand one hundred". These are the SAME and should NOT be flagged.
9. Short narrative phrases like "Year. Thirty-one hundred." or "Designation. Lost Cause." may appear without periods or in slightly different form in the transcript. If the words are present ANYWHERE in the transcript, even without exact punctuation, they are NOT missing.
10. Before marking ANY line as missing, search the ENTIRE transcript carefully for those words. Only mark as missing if the words truly do not appear in any form.

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

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + groqKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.1,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let errMsg;
      try { errMsg = JSON.parse(errText).error?.message; } catch (e) { errMsg = errText.substring(0, 200); }
      return NextResponse.json({ error: errMsg || 'Analysis failed (' + resp.status + ')' }, { status: resp.status });
    }

    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    let clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      let s = clean;
      if ((s.match(/"/g) || []).length % 2 !== 0) s += '"';
      const opens = { '[': 0, '{': 0 };
      for (const ch of s) { if (ch === '[' || ch === '{') opens[ch]++; if (ch === ']') opens['[']--; if (ch === '}') opens['{']--; }
      for (let i = 0; i < opens['[']; i++) s += ']';
      for (let i = 0; i < opens['{']; i++) s += '}';
      s = s.replace(/,\s*([}\]])/g, '$1');
      try { parsed = JSON.parse(s); } catch (e2) {
        return NextResponse.json({ error: 'Could not parse AI response. Try again.' }, { status: 500 });
      }
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: 'Server error: ' + err.message }, { status: 500 });
  }
}

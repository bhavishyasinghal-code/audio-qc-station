import { NextResponse } from 'next/server';

export const maxDuration = 120;

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Check if two words are similar (allows minor spelling differences)
function wordsSimilar(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return a === b;
  // One contains the other (e.g. "werewolves" vs "werewolf")
  if (a.includes(b) || b.includes(a)) return true;
  // Levenshtein-like: allow 1-2 char difference for longer words
  if (Math.abs(a.length - b.length) > 2) return false;
  let diff = 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  for (let i = 0; i < longer.length; i++) {
    if (shorter[i] !== longer[i]) diff++;
    if (diff > 2) return false;
  }
  return true;
}

// Check if a script line's words exist in the transcript (90%+ match with spelling tolerance)
function lineExistsInTranscript(line, transcriptWords) {
  const words = normalize(line).split(' ').filter(w => w.length > 1);
  if (words.length === 0) return true;
  
  let found = 0;
  for (const word of words) {
    // Exact match first
    if (transcriptWords.has(word)) { found++; continue; }
    // Spelling tolerance: check if any transcript word is similar
    let matched = false;
    for (const tw of transcriptWords) {
      if (wordsSimilar(word, tw)) { matched = true; break; }
    }
    if (matched) found++;
  }
  
  const matchRatio = found / words.length;
  return matchRatio >= 0.9; // 90% of words must be found
}

// Find transcript sentences not in script (90%+ of words must NOT match script)
function findExtraDialogue(transcript, scriptLines) {
  const scriptWords = new Set(normalize(scriptLines.join(' ')).split(' ').filter(w => w.length > 1));
  const sentences = transcript.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 15);
  const extras = [];
  
  const hallucinations = ['thank you for watching', 'subscribe', 'like and share', 'see you in the next', 'leave a comment', 'hit the bell', 'thanks for listening', 'thank you', 'bye bye'];
  
  for (const sentence of sentences) {
    const norm = normalize(sentence);
    if (hallucinations.some(h => norm.includes(h))) continue;
    
    const words = norm.split(' ').filter(w => w.length > 1);
    if (words.length < 4) continue;
    
    let found = 0;
    for (const word of words) {
      if (scriptWords.has(word)) { found++; continue; }
      let matched = false;
      for (const sw of scriptWords) {
        if (wordsSimilar(word, sw)) { matched = true; break; }
      }
      if (matched) found++;
    }
    
    const matchRatio = found / words.length;
    if (matchRatio < 0.3) { // Less than 30% match to script = likely extra
      extras.push(sentence);
    }
  }
  return extras;
}

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

    // ── STEP 1: Strict programmatic comparison ──
    const transcriptWords = new Set(normalize(transcript).split(' ').filter(w => w.length > 1));
    
    const missingLines = [];
    const presentLines = [];
    for (const line of (dialogueLines || [])) {
      if (lineExistsInTranscript(line, transcriptWords)) {
        presentLines.push(line);
      } else {
        missingLines.push(line);
      }
    }

    const extraLines = findExtraDialogue(transcript, dialogueLines || []);

    // ── STEP 2: AI only verifies suspicious items ──
    const prompt = `You are an audio QC specialist verifying pre-detected issues.

SCRIPT:
"""
${scriptText.substring(0, 3000)}
"""

TRANSCRIPT:
"""
${transcript.substring(0, 3000)}
"""

LINES FLAGGED AS MISSING (90%+ word match failed — verify each one. Only keep lines that are TRULY absent. Remove if the meaning exists anywhere in transcript):
${missingLines.length > 0 ? missingLines.map((l, i) => (i+1) + '. ' + l).join('\n') : 'None'}

LINES FLAGGED AS EXTRA (not found in script — verify each. Remove if it matches any script content):
${extraLines.length > 0 ? extraLines.map((l, i) => (i+1) + '. ' + l).join('\n') : 'None'}

AUDIO DATA:
- Duration: ${audioData?.duration || '?'}s
- Long pauses >3s (MUST flag as critical): ${audioData?.longPauses || 'none'}
- All pauses >0.8s: ${audioData?.allPauses || 'none'}
- Noise spikes (MUST flag each one): ${audioData?.noise || 'none'}

RULES:
1. For missing lines: ONLY keep ones truly absent from transcript. Numbers like "3100" = "thirty one hundred". Remove false positives.
2. For extra lines: ONLY keep ones genuinely not in script. Remove Whisper artifacts.
3. Flag ALL pauses >3s as critical. Flag ALL noise spikes.
4. Note any mispronunciations (clearly wrong words, not just spelling).

Respond ONLY with valid JSON:
{
  "overallScore": 0-100,
  "overallVerdict": "PASS|NEEDS_REVIEW|FAIL",
  "summary": "2-3 sentences",
  "missingDialogue": [{"line":"exact line","severity":"critical|warning","context":"where"}],
  "extraDialogue": [{"line":"exact extra text","severity":"critical|warning","context":"location"}],
  "mispronunciations": [{"expected":"word","heard":"word","severity":"warning"}],
  "sfxIssues": [{"cue":"cue","status":"missing|weak","severity":"warning","note":"short"}],
  "musicIssues": [{"cue":"cue","status":"missing","severity":"warning","note":"short"}],
  "ambientIssues": [{"cue":"cue","status":"missing","severity":"warning","note":"short"}],
  "voiceActingIssues": [{"cue":"cue","status":"not_followed","severity":"warning","note":"short"}],
  "pauseIssues": [{"timestamp":"time","duration":"sec","severity":"critical|info","note":"short"}],
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
        messages: [
          { role: 'system', content: 'You verify pre-detected QC issues. Remove false positives. If a missing line exists in transcript in ANY form, remove it. If an extra line matches script in ANY form, remove it. Be conservative. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 4096,
        temperature: 0,
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

    if (!parsed.additionalNotes) parsed.additionalNotes = [];
    parsed.additionalNotes.push(presentLines.length + '/' + (dialogueLines||[]).length + ' lines matched (90%+ words). ' + missingLines.length + ' flagged for review.');

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: 'Server error: ' + err.message }, { status: 500 });
  }
}

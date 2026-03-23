import { NextResponse } from 'next/server';

export const maxDuration = 120;

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordsSimilar(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return a === b;
  if (a.includes(b) || b.includes(a)) return true;
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

// Check if 90%+ words from a script line exist in transcript
function lineExistsInTranscript(line, transcriptWords) {
  const words = normalize(line).split(' ').filter(w => w.length > 1);
  if (words.length === 0) return true;
  let found = 0;
  for (const word of words) {
    if (transcriptWords.has(word)) { found++; continue; }
    let matched = false;
    for (const tw of transcriptWords) {
      if (wordsSimilar(word, tw)) { matched = true; break; }
    }
    if (matched) found++;
  }
  return (found / words.length) >= 0.9;
}

// Build a set of all 3-word sequences (trigrams) from script for fast lookup
function buildScriptNgrams(scriptText) {
  const words = normalize(scriptText).split(' ').filter(w => w.length > 1);
  const ngrams = new Set();
  for (let i = 0; i <= words.length - 3; i++) {
    ngrams.add(words[i] + ' ' + words[i+1] + ' ' + words[i+2]);
  }
  // Also add all individual words
  const wordSet = new Set(words);
  return { ngrams, wordSet };
}

// Find extra dialogue: sliding window over transcript, find runs of words not matching script
function findExtraDialogue(transcript, scriptText) {
  const { ngrams, wordSet } = buildScriptNgrams(scriptText);
  const tWords = normalize(transcript).split(' ').filter(w => w.length > 1);
  
  // For each word, check if it and its neighbors form trigrams found in script
  const matched = new Array(tWords.length).fill(false);
  
  for (let i = 0; i <= tWords.length - 3; i++) {
    const tri = tWords[i] + ' ' + tWords[i+1] + ' ' + tWords[i+2];
    if (ngrams.has(tri)) {
      matched[i] = true;
      matched[i+1] = true;
      matched[i+2] = true;
    }
  }
  
  // Also match individual words with spelling tolerance
  for (let i = 0; i < tWords.length; i++) {
    if (matched[i]) continue;
    if (wordSet.has(tWords[i])) { matched[i] = true; continue; }
    for (const sw of wordSet) {
      if (wordsSimilar(tWords[i], sw)) { matched[i] = true; break; }
    }
  }
  
  // Find runs of 5+ consecutive unmatched words = extra dialogue
  const extras = [];
  let runStart = -1;
  
  // Common Whisper hallucination words
  const hallWords = new Set(['thank', 'watching', 'subscribe', 'subscribed', 'subscribers', 'comment', 'comments', 'bell', 'notification', 'video', 'channel', 'like', 'share', 'bye']);
  
  for (let i = 0; i <= tWords.length; i++) {
    if (i < tWords.length && !matched[i]) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1) {
        const runLen = i - runStart;
        if (runLen >= 5) {
          const phrase = tWords.slice(runStart, i).join(' ');
          // Check if it's a Whisper hallucination
          const phraseWords = tWords.slice(runStart, i);
          const hallCount = phraseWords.filter(w => hallWords.has(w)).length;
          if (hallCount / phraseWords.length < 0.4) {
            extras.push(phrase);
          }
        }
        runStart = -1;
      }
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

    // ── Programmatic comparison ──
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

    const extraLines = findExtraDialogue(transcript, scriptText);

    // ── AI verification ──
    const prompt = `You are an audio QC specialist verifying pre-detected issues.

SCRIPT:
"""
${scriptText.substring(0, 3000)}
"""

TRANSCRIPT:
"""
${transcript.substring(0, 3000)}
"""

LINES FLAGGED AS MISSING FROM RECORDING (90%+ word match failed):
${missingLines.length > 0 ? missingLines.map((l, i) => (i+1) + '. ' + l).join('\n') : 'None'}

EXTRA PHRASES IN RECORDING NOT IN SCRIPT (5+ consecutive words not matching any script text):
${extraLines.length > 0 ? extraLines.map((l, i) => (i+1) + '. "' + l + '"').join('\n') : 'None'}

AUDIO DATA:
- Duration: ${audioData?.duration || '?'}s
- Long pauses >3s (flag as critical): ${audioData?.longPauses || 'none'}
- All pauses >0.8s: ${audioData?.allPauses || 'none'}
- Noise spikes (flag each): ${audioData?.noise || 'none'}

RULES:
1. Missing lines: keep only ones TRULY absent. Numbers like "3100"="thirty one hundred". Remove false positives.
2. Extra phrases: keep ones genuinely not in script. These are ad-libs, retakes, wrong lines, or random speech by the voice actor. Remove if it loosely matches script content.
3. Flag ALL pauses >3s. Flag ALL noise spikes.
4. Note clear mispronunciations.

Respond ONLY with valid JSON:
{
  "overallScore": 0-100,
  "overallVerdict": "PASS|NEEDS_REVIEW|FAIL",
  "summary": "2-3 sentences",
  "missingDialogue": [{"line":"exact line","severity":"critical|warning","context":"where"}],
  "extraDialogue": [{"line":"exact extra phrase from recording","severity":"critical|warning","context":"description of what it might be"}],
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
          { role: 'system', content: 'Verify pre-detected QC issues. Remove false positives only. If a missing line exists in transcript in any form, remove it. Keep extra dialogue that is genuinely not in the script. Return valid JSON only.' },
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
    parsed.additionalNotes.push(presentLines.length + '/' + (dialogueLines||[]).length + ' lines matched (90%+). ' + missingLines.length + ' flagged as possibly missing. ' + extraLines.length + ' extra phrases detected.');

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: 'Server error: ' + err.message }, { status: 500 });
  }
}

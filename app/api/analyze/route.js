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

// Check if a sequence of words exists as a consecutive run in the script
function sequenceExistsInScript(words, scriptWordsArray) {
  if (words.length === 0) return true;
  const seqLen = words.length;
  
  // Slide over script looking for a matching window
  for (let i = 0; i <= scriptWordsArray.length - seqLen; i++) {
    let matchCount = 0;
    for (let j = 0; j < seqLen; j++) {
      if (wordsSimilar(words[j], scriptWordsArray[i + j])) {
        matchCount++;
      }
    }
    // If 80%+ of the sequence matches a consecutive run in script, it's present
    if (matchCount / seqLen >= 0.8) return true;
  }
  return false;
}

// Find extra dialogue by checking transcript chunks against script sequences
function findExtraDialogue(transcript, scriptText) {
  const scriptWords = normalize(scriptText).split(' ').filter(w => w.length > 1);
  const tWords = normalize(transcript).split(' ').filter(w => w.length > 1);
  
  const hallWords = new Set(['thank', 'watching', 'subscribe', 'subscribed', 'comment', 'video', 'channel', 'like', 'share', 'bye', 'hello', 'welcome']);
  
  // Mark each transcript word as "covered" or not
  // A word is covered if it's part of a 6-word window that matches a consecutive run in the script
  const windowSize = 6;
  const covered = new Array(tWords.length).fill(false);
  
  for (let i = 0; i <= tWords.length - windowSize; i++) {
    const window = tWords.slice(i, i + windowSize);
    if (sequenceExistsInScript(window, scriptWords)) {
      for (let j = i; j < i + windowSize; j++) {
        covered[j] = true;
      }
    }
  }
  
  // Also cover first and last 3 words (edge padding)
  for (let i = 0; i < Math.min(3, tWords.length); i++) covered[i] = true;
  for (let i = Math.max(0, tWords.length - 3); i < tWords.length; i++) covered[i] = true;
  
  // Find runs of 6+ uncovered words = extra dialogue
  const extras = [];
  let runStart = -1;
  
  for (let i = 0; i <= tWords.length; i++) {
    if (i < tWords.length && !covered[i]) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1) {
        const runLen = i - runStart;
        if (runLen >= 6) {
          const phrase = tWords.slice(runStart, i).join(' ');
          const phraseWords = tWords.slice(runStart, i);
          const hallCount = phraseWords.filter(w => hallWords.has(w)).length;
          if (hallCount / phraseWords.length < 0.4) {
            extras.push({
              text: phrase,
              wordIndex: runStart,
              wordCount: runLen
            });
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

    const extraResults = findExtraDialogue(transcript, scriptText);
    const extraLines = extraResults.map(e => e.text);

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

EXTRA PHRASES IN RECORDING NOT IN SCRIPT (consecutive words in transcript that don't match any consecutive sequence in script):
${extraLines.length > 0 ? extraLines.map((l, i) => (i+1) + '. "' + l + '"').join('\n') : 'None'}

AUDIO DATA:
- Duration: ${audioData?.duration || '?'}s
- Long pauses >3s (flag as critical): ${audioData?.longPauses || 'none'}
- All pauses >0.8s: ${audioData?.allPauses || 'none'}
- Noise spikes (flag each): ${audioData?.noise || 'none'}

RULES:
1. Missing lines: keep only TRULY absent ones. "3100"="thirty one hundred". Remove false positives.
2. Extra phrases: these are spoken content in the recording that does NOT exist in the script. Keep them — they are ad-libs, retakes, wrong lines, or unscripted speech. Only remove if the phrase actually IS in the script.
3. Flag ALL pauses >3s. Flag ALL noise spikes.
4. Note clear mispronunciations.

Respond ONLY with valid JSON:
{
  "overallScore": 0-100,
  "overallVerdict": "PASS|NEEDS_REVIEW|FAIL",
  "summary": "2-3 sentences",
  "missingDialogue": [{"line":"exact line","severity":"critical|warning","context":"where"}],
  "extraDialogue": [{"line":"exact extra phrase from recording","severity":"critical|warning","context":"description"}],
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
          { role: 'system', content: 'Verify pre-detected QC issues. Remove false positives for missing lines. For extra dialogue, keep them unless the phrase genuinely appears in the script. Return valid JSON only.' },
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
    parsed.additionalNotes.push(
      presentLines.length + '/' + (dialogueLines||[]).length + ' script lines matched. ' +
      missingLines.length + ' possibly missing. ' +
      extraLines.length + ' extra phrases detected in recording.'
    );

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    return NextResponse.json({ error: 'Server error: ' + err.message }, { status: 500 });
  }
}

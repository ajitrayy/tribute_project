// Fact-preservation check: compares the text that will be printed on the new
// poster with the transcription of the source poster. It cannot prove a poster
// is correct, but it flags the two failure modes that matter most to a news
// desk: a number/name that appears on the new poster but not the source
// (possibly invented or mistyped), and one that was on the source but dropped.

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

export function normalizeDigits(s) {
  return String(s || '').replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

/** Numeric tokens such as 25, 3.5, 1,200, 12/08/2026, 10:30 - normalized to ASCII digits. */
export function numbersIn(text) {
  const t = normalizeDigits(text);
  const out = t.match(/\d+(?:[.,:/-]\d+)*/g) || [];
  return out.map((n) => n.replace(/,(?=\d{2,3}\b)/g, ''));
}

function multiset(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

export function posterText(fields) {
  return [fields.category_label, fields.headline, fields.subheadline, ...(fields.body_lines || []), fields.location, fields.date_text]
    .filter(Boolean)
    .join('\n');
}

const squash = (s) => String(s || '').replace(/\s+/g, '').normalize('NFC');

export function factCheck(extraction, fields) {
  const warnings = [];
  if (!extraction) {
    return { checked: false, warnings: [{ level: 'info', message: 'No machine transcription to compare against - verify facts against the source poster manually.' }] };
  }
  const branding = new Set((extraction.source_branding || []).map(squash));
  const sourceText = String(extraction.full_text || '');
  const out = posterText(fields);

  const srcNums = multiset(numbersIn(sourceText));
  const outNums = multiset(numbersIn(out));
  for (const [n, c] of outNums) {
    if ((srcNums.get(n) || 0) < c) {
      warnings.push({ level: 'error', message: `Number "${n}" is on the new poster but not on the source poster.` });
    }
  }
  const brandingNums = new Set(numbersIn([...(extraction.source_branding || [])].join(' ')));
  for (const [n] of srcNums) {
    if (!outNums.has(n) && !brandingNums.has(n)) {
      warnings.push({ level: 'warn', message: `Number "${n}" from the source poster is not on the new poster.` });
    }
  }

  const srcSquashed = squash(sourceText);
  const outSquashed = squash(out);
  for (const [kind, list] of [['Name', extraction.people], ['Place', extraction.places]]) {
    for (const item of list || []) {
      const s = squash(item);
      if (!s || branding.has(s)) continue;
      if (!srcSquashed.includes(s)) {
        warnings.push({ level: 'warn', message: `${kind} "${item}" was listed by the extractor but not found in the transcription.` });
      } else if (!outSquashed.includes(s)) {
        warnings.push({ level: 'warn', message: `${kind} "${item}" from the source poster is not on the new poster.` });
      }
    }
  }
  for (const b of extraction.source_branding || []) {
    const s = squash(b);
    if (s.length >= 3 && outSquashed.includes(s)) {
      warnings.push({ level: 'error', message: `Source outlet branding "${b}" appears on the new poster.` });
    }
  }
  for (const u of extraction.uncertain || []) {
    warnings.push({ level: 'warn', message: `Extractor was unsure about "${u}" - check against the source.` });
  }
  if (!fields.headline?.trim()) warnings.push({ level: 'error', message: 'Headline is empty.' });

  return { checked: true, warnings };
}

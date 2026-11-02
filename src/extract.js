// SILA — "Demo extraction": a transparent, rule-based reader for a caller's transcript. Pure function.
// extractIntake(transcript, lang) → { fields, matches, method, lang }
//   fields: every intake field, "unknown" unless a rule matched; values are the caller's own words where possible.
//   matches: the exact phrase that produced each value, so the UI can show why.
// It never outputs triage, diagnosis, vital signs or acuity. Unmatched information stays "unknown" — that is honest.

export const UNKNOWN = 'unknown';
export const INTAKE_FIELDS = ['age', 'concern', 'onset', 'awake', 'breathing', 'conditions', 'allergies', 'patientCount', 'location', 'transportMode', 'contact', 'assistance'];

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD = Object.keys(NUMBER_WORDS).join('|');
const DECADES = { twenties: '20s', thirties: '30s', forties: '40s', fifties: '50s', sixties: '60s', seventies: '70s', eighties: '80s', nineties: '90s' };
const wordsToNumber = (w) => w.toLowerCase().split(/[-\s]+/).reduce((n, part) => n + (NUMBER_WORDS[part] ?? 0), 0);

// Arabic-Indic and Eastern Arabic-Indic digits → ASCII, so "٧٢" is read as 72.
const normalize = (s) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

const sentences = (text) => text.split(/(?<=[.!?؟\n])\s+/).map((x) => x.trim()).filter(Boolean);

// Each rule: [field, regex, value(match) → string]. Rules for a field run in order; the first match wins.
// Negative forms are listed before positive ones so "not breathing" can never read as "breathing".
const RULES = [
  // Age / approximate age
  ['age', /\b(\d{1,3})\s*(?:-\s*)?(?:years?|yrs?|y\/o)(?:[-\s]*old)?\b/i, (m) => m[1]],
  ['age', /\b(?:aged?|age\s+is)\s+(\d{1,3})\b/i, (m) => m[1]],
  ['age', /\b(?:about|around|roughly|approximately|maybe)\s+(\d{1,3})\b(?!\s*(?:minutes?|mins?|hours?|days?|km|people|patients))/i, (m) => `~${m[1]}`],
  ['age', new RegExp(`\\b(?:is|he's|she's|aged)\\s+(?:about\\s+|around\\s+)?((?:${WORD})(?:[-\\s](?:${WORD}))?)\\b(?!\\s+(?:minutes?|hours?|days?|people|patients|of))`, 'i'), (m) => String(wordsToNumber(m[1]))],
  ['age', /\bin\s+(?:his|her|their)\s+(\d0)s\b/i, (m) => `${m[1]}s`],
  ['age', /\bin\s+(?:his|her|their)\s+(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/i, (m) => DECADES[m[1].toLowerCase()]],
  ['age', /(?:عمره|عمرها|العمر)\s*(\d{1,3})/, (m) => m[1]],
  ['age', /(\d{1,3})\s*(?:سنة|سنوات|عام|عاما|عامًا)/, (m) => m[1]],

  // Onset
  ['onset', /\b(since\s+(?:this\s+(?:morning|afternoon|evening)|last\s+night|yesterday|\w+day|\d{1,2}(?::\d{2})?\s*(?:am|pm)?))\b/i, (m) => m[1]],
  ['onset', /\b(\d+\s*(?:minutes?|mins?|hours?|hrs?|days?)\s+ago)\b/i, (m) => m[1]],
  ['onset', /\b(for\s+(?:the\s+)?(?:last|past)\s+(?:\w+\s+)?(?:minutes?|hours?|days?|week))\b/i, (m) => m[1]],
  ['onset', /\b(this\s+morning|last\s+night|yesterday)\b/i, (m) => m[1]],
  ['onset', /(منذ\s+[^\s.،,؟!]+(?:\s+(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام|الصباح|أمس))?)/, (m) => m[1].trim()],

  // Awake (negatives first)
  ['awake', /\b(not\s+(?:awake|conscious|responding|responsive|waking\s+up)|isn't\s+(?:awake|conscious|responding)|unconscious|unresponsive|passed\s+out|won't\s+wake)\b/i, () => 'no'],
  ['awake', /(غير\s*واعي[ةه]?|فاقد[ةه]?\s*الوعي|مغمى\s*علي[هها])/, () => 'no'],
  ['awake', /\b(awake|conscious|alert|talking|responding)\b/i, () => 'yes'],
  ['awake', /(واعي[ةه]?|صاحي[ةه]?|يتكلم|تتكلم)/, () => 'yes'],

  // Breathing (negatives first)
  // "not breathing well/properly" describes difficulty, not absent breathing — it must not read as "no".
  ['breathing', /\b(not\s+breathing|isn't\s+breathing|is\s+not\s+breathing|stopped\s+breathing|no\s+longer\s+breathing|no\s+breathing)\b(?!\s+(?:well|properly|normally|right|easily|good))/i, () => 'no'],
  ['breathing', /(لا\s*يتنفس|لا\s*تتنفس|توقف\s*عن\s*التنفس|توقفت\s*عن\s*التنفس)/, () => 'no'],
  ['breathing', /\b((?:is|are|he's|she's|they're|still|and)\s+breathing|breathing\s+(?:normally|fine|ok(?:ay)?|on\s+(?:his|her|their)\s+own))\b/i, () => 'yes'],
  ['breathing', /(يتنفس|تتنفس)/, () => 'yes'],

  // Allergies
  ['allergies', /\b(no\s+(?:known\s+)?allergies)\b/i, (m) => m[1]],
  ['allergies', /\ballergic\s+to\s+([a-z][a-z\s,-]{1,40}?)(?=[.;!?]|$|\s+and\s+(?:he|she|we|they))/i, (m) => m[1].trim()],
  ['allergies', /\ballerg(?:y|ies)\s*(?:to|:)\s*([^.;!?]{2,40})/i, (m) => m[1].trim()],
  ['allergies', /(حساسية(?:\s+(?:من|ضد))?\s*[^.،,؟!]{0,30})/, (m) => m[1].trim()],

  // Number of patients
  ['patientCount', new RegExp(`\\b(\\d+|${WORD})\\s+(?:people|patients|persons|casualties|injured|victims)\\b`, 'i'), (m) => String(/^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]))],
  ['patientCount', /(\d+)\s*(?:مصابين|أشخاص|اشخاص|مرضى)/, (m) => m[1]],

  // Location
  ['location', /\b(?:from|at|in|near)\s+((?:the\s+)?[\w'-]+(?:\s+[\w'-]+){0,3}\s+(?:district|street|road|mall|park|area|neighbou?rhood|square|station|market|compound|highway))\b/i, (m) => m[1].trim()],
  ['location', /\b(?:we(?:'re| are)|i(?:'m| am)|they(?:'re| are))\s+(?:at|in|near|on)\s+([^.,;!?]{3,50}?)(?=\s+and\s|[.,;!?]|$)/i, (m) => m[1].trim()],
  ['location', /(?:في|من|قرب)\s+(حي\s+[^.،,؟!]{2,30})/, (m) => m[1].trim()],

  // Transport mode
  ['transportMode', /\b(we(?:'ll|'re| will| are| can)?\s+walk(?:ing)?|on\s+foot)\b/i, () => 'walking'],
  ['transportMode', /\b(taxi|cab|uber|careem)\b/i, () => 'taxi'],
  ['transportMode', /\b(driving|by\s+car|in\s+(?:the|our|my)\s+car|private\s+car|my\s+car|our\s+car|drive\s+(?:him|her|them))\b/i, () => 'private_car'],
  ['transportMode', /\b(by\s+ambulance|in\s+an?\s+ambulance|ambulance\s+is\s+(?:bringing|taking))\b/i, () => 'ambulance'],
  ['transportMode', /(تاكسي|سيارة\s+أجرة)/, () => 'taxi'],
  ['transportMode', /(بالإسعاف|سيارة\s+إسعاف|الإسعاف|اسعاف)/, () => 'ambulance'],
  ['transportMode', /(سيارة|بالسيارة)/, () => 'private_car'],

  // Contact (a phone number of 8+ digits)
  ['contact', /(\+?\d[\d\s-]{7,}\d)/, (m) => (m[1].replace(/\D/g, '').length >= 8 ? m[1].trim() : null)],

  // Assistance / accessibility needs
  ['assistance', /\b(wheelchair|deaf|hard\s+of\s+hearing|blind|interpreter|speaks?\s+only\s+\w+|only\s+speaks?\s+\w+|stretcher|mobility\s+problems?|can't\s+walk|cannot\s+walk)\b/i, (m) => m[1]],
  ['assistance', /(كرسي\s*متحرك|أصم|مترجم)/, (m) => m[1]],
];

const CONDITIONS = /\b(diabetes|diabetic|asthma|heart\s+(?:disease|condition|problems?|failure)|high\s+blood\s+pressure|hypertension|epilepsy|copd|kidney\s+(?:disease|failure)|dementia|cancer|pregnant|on\s+blood\s+thinners)\b/gi;
const CONDITIONS_AR = /(السكري|سكري|السكر|الربو|ربو|الضغط|ضغط\s*الدم|القلب|الصرع|حامل)/g;
const CONCERN = /\b(pain|ache|hurt|fever|temperature|fell|fall(?:en)?|bleed\w*|blood|breath\w*|chest|confus\w*|unconscious|faint\w*|collaps\w*|vomit\w*|seizure|rash|injur\w*|accident|crash|dizz\w*|weak\w*|headache|burn\w*|cut|swollen|swelling|choking|stroke|numb|sick)\b/i;
const CONCERN_AR = /(ألم|الم|حرارة|حمى|سقط|سقطت|نزيف|ضيق|تنفس|يتنفس|دوخة|إغماء|تشنج|طفح|حادث|إصابة|قيء|صداع|واعي)/;

export function extractIntake(transcript, lang = 'en') {
  const text = normalize(String(transcript ?? ''));
  const fields = Object.fromEntries(INTAKE_FIELDS.map((f) => [f, UNKNOWN]));
  const matches = {};
  const set = (field, value, phrase) => {
    if (fields[field] !== UNKNOWN || value === null || value === undefined || value === '') return;
    fields[field] = value;
    matches[field] = phrase.trim();
  };

  // Main concern: the caller's own sentence that mentions a complaint, verbatim.
  const concernSentence = sentences(text).find((x) => CONCERN.test(x) || CONCERN_AR.test(x));
  if (concernSentence) set('concern', concernSentence, concernSentence);

  for (const [field, re, value] of RULES) {
    if (fields[field] !== UNKNOWN) continue;
    const m = text.match(re);
    if (m) set(field, value(m), m[0]);
  }

  const conditions = [...new Set([...text.matchAll(CONDITIONS), ...text.matchAll(CONDITIONS_AR)].map((m) => m[1].toLowerCase()))];
  if (conditions.length) set('conditions', conditions.join(', '), conditions.join(', '));

  return { fields, matches, method: 'demo-rule-based', lang };
}

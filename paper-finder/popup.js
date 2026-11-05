const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  topic: '', yearFrom: '', yearTo: '', max: 10, minImpact: 0,
  maxQuartile: 0, sort: 'citations', oaOnly: false, email: '',
};
let hasSjr = false;

const SOURCE_INFO = {
  scholar: ['Google Scholar', 'opens a tab, may ask for a CAPTCHA'],
  openalex: ['OpenAlex', 'large index with journal data'],
  semanticscholar: ['Semantic Scholar', 'many fields, links to open PDFs'],
  europepmc: ['Europe PMC', 'open-access life-science papers'],
  arxiv: ['arXiv', 'preprints, no journal metrics'],
};
const DEFAULT_SOURCES = [
  { id: 'scholar', on: true }, { id: 'openalex', on: true }, { id: 'semanticscholar', on: true },
  { id: 'europepmc', on: true }, { id: 'arxiv', on: false },
];
let sourceState = DEFAULT_SOURCES.map((s) => ({ ...s }));

function normalizeSources(saved) {
  if (!saved) return DEFAULT_SOURCES.map((s) => ({ ...s }));
  const out = saved.filter((s) => SOURCE_INFO[s.id]).map((s) => ({ id: s.id, on: !!s.on }));
  DEFAULT_SOURCES.forEach((d) => { if (!out.some((s) => s.id === d.id)) out.push({ ...d, on: false }); });
  return out;
}

async function persistSources() {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings || {}), sourceState } });
}

function renderSources() {
  const ul = $('sources');
  ul.replaceChildren();
  sourceState.forEach((s, i) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = s.on;
    cb.addEventListener('change', () => { s.on = cb.checked; persistSources(); });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${i + 1}. ${SOURCE_INFO[s.id][0]}`;
    const small = document.createElement('small');
    small.textContent = SOURCE_INFO[s.id][1];
    name.appendChild(small);
    label.append(cb, name);
    li.appendChild(label);
    [['Up', -1], ['Down', 1]].forEach(([text, d]) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = text;
      btn.setAttribute('aria-label', `Move ${SOURCE_INFO[s.id][0]} ${text.toLowerCase()}`);
      btn.disabled = i + d < 0 || i + d >= sourceState.length;
      btn.addEventListener('click', () => {
        [sourceState[i], sourceState[i + d]] = [sourceState[i + d], sourceState[i]];
        renderSources(); persistSources();
      });
      li.appendChild(btn);
    });
    ul.appendChild(li);
  });
}

const STATUS_LABEL = {
  queued: 'Queued', working: 'Working...', downloaded: 'Downloaded',
  'no-open-copy': 'No open copy', failed: 'Failed',
};

function readForm() {
  return {
    topic: $('topic').value.trim(),
    yearFrom: $('yearFrom').value.trim(),
    yearTo: $('yearTo').value.trim(),
    max: Math.min(50, Math.max(1, Number($('max').value) || 10)),
    minImpact: Number($('minImpact').value) || 0,
    maxQuartile: hasSjr ? Number($('quartile').value) || 0 : 0,
    sort: $('sort').value,
    oaOnly: $('oaOnly').checked,
    email: $('email').value.trim(),
    sources: sourceState.filter((s) => s.on).map((s) => s.id),
  };
}

function fillForm(s) {
  $('topic').value = s.topic;
  $('yearFrom').value = s.yearFrom;
  $('yearTo').value = s.yearTo;
  $('max').value = s.max;
  $('minImpact').value = s.minImpact;
  $('quartile').value = String(s.maxQuartile);
  $('sort').value = s.sort;
  $('oaOnly').checked = s.oaOnly;
  $('email').value = s.email;
}

function showMessage(text, isError) {
  const el = $('message');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', !!isError);
}

async function onStart() {
  const p = readForm();
  if (!p.topic) { showMessage('Enter a topic to search for.', true); $('topic').focus(); return; }
  if (!/^\S+@\S+\.\S+$/.test(p.email)) {
    showMessage('Add your email in Settings. Unpaywall requires it to answer requests.', true);
    $('settings').open = true; $('email').focus(); return;
  }
  if (!p.sources.length) { showMessage('Turn on at least one search source.', true); return; }
  showMessage('');
  await chrome.storage.local.set({ settings: { ...p, sourceState } });
  const res = await chrome.runtime.sendMessage({ type: 'start', params: p });
  if (!res || !res.ok) showMessage((res && res.error) || 'Could not start the search.', true);
}

function td(content, cls) {
  const el = document.createElement('td');
  if (cls) el.className = cls;
  if (typeof content === 'string') el.textContent = content; else el.appendChild(content);
  return el;
}

function render(job) {
  if (!job) return;
  const running = job.status === 'running';
  $('start').disabled = running;
  $('stop').hidden = !running;
  $('phase').textContent = job.phase || '';
  showMessage(job.message, job.status === 'error');

  const papers = job.papers || [];
  $('results').hidden = papers.length === 0;
  const done = papers.filter((x) => x.status === 'downloaded').length;
  $('summary').textContent = `${done} of ${papers.length} downloaded`;

  const rows = $('rows');
  rows.replaceChildren();
  papers.forEach((x) => {
    const tr = document.createElement('tr');

    const cell = document.createElement('div');
    const a = document.createElement('a');
    a.href = x.link || (x.doi ? `https://doi.org/${x.doi}` : '#');
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = x.title;
    cell.appendChild(a);
    if (x.note) {
      const n = document.createElement('span');
      n.className = 'note'; n.textContent = x.note;
      cell.appendChild(n);
    } else if (x.status === 'downloaded' && x.source) {
      const n = document.createElement('span');
      n.className = 'note'; n.textContent = `found via ${x.found || 'search'}, PDF via ${x.source}`;
      cell.appendChild(n);
    }
    tr.appendChild(td(cell));
    tr.appendChild(td(x.journal || '-', 'j'));
    tr.appendChild(td(String(x.year || '-'), 'num'));
    tr.appendChild(td(x.quartile || '-', 'num'));
    tr.appendChild(td(x.impact === null || x.impact === undefined ? '-' : x.impact.toFixed(2), 'num'));
    tr.appendChild(td(STATUS_LABEL[x.status] || x.status, `st ${x.status}`));
    rows.appendChild(tr);
  });
}

// ---- SJR import ----
function splitSemicolonLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ';' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function importSjr(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = splitSemicolonLine(lines[0].replace(/^\uFEFF/, '')).map((h) => h.trim().toLowerCase());
  const iIssn = header.indexOf('issn');
  const iQ = header.indexOf('sjr best quartile');
  if (iIssn < 0 || iQ < 0) {
    showMessage('That file does not look like a SCImago export. It needs "Issn" and "SJR Best Quartile" columns, separated by semicolons.', true);
    return;
  }
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitSemicolonLine(lines[i]);
    const q = (cols[iQ] || '').trim();
    if (!/^Q[1-4]$/.test(q)) continue;
    (cols[iIssn] || '').split(',').forEach((raw) => {
      const issn = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
      if (issn.length === 8) map[issn] = q;
    });
  }
  await chrome.storage.local.set({ sjr: map, sjrMeta: { count: Object.keys(map).length, at: Date.now() } });
  showMessage('');
}

async function refreshSjrInfo() {
  const { sjrMeta } = await chrome.storage.local.get('sjrMeta');
  hasSjr = !!(sjrMeta && sjrMeta.count);
  $('quartile').disabled = !hasSjr;
  $('sjrInfo').textContent = hasSjr
    ? `Imported: ${sjrMeta.count.toLocaleString()} ISSNs.`
    : 'Not imported yet, so the quartile filter is off.';
  if (!hasSjr) $('quartile').value = '0';
}

// ---- CSV export ----
function exportCsv(job) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Title', 'DOI', 'Journal', 'Year', 'Citations', 'SJR quartile', 'Approx IF', 'Status', 'Found via', 'PDF source', 'Link', 'File'];
  const rows = (job.papers || []).map((x) =>
    [x.title, x.doi, x.journal, x.year, x.cites, x.quartile, x.impact, STATUS_LABEL[x.status] || x.status, x.found, x.source, x.link, x.file]
      .map(esc).join(','));
  const blob = new Blob(['\uFEFF' + [head.map(esc).join(','), ...rows].join('\r\n')], { type: 'text/csv' });
  const topic = (job.params.topic || 'results').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50);
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `PaperFinder/${topic}/results.csv`,
    conflictAction: 'uniquify',
  });
}

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  fillForm({ ...DEFAULTS, ...settings });
  sourceState = normalizeSources(settings && settings.sourceState);
  renderSources();
  await refreshSjrInfo();
  if (settings && settings.maxQuartile && hasSjr) $('quartile').value = String(settings.maxQuartile);
  if (!(settings && settings.email)) $('settings').open = true;

  const { job } = await chrome.storage.local.get('job');
  render(job);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.job) render(changes.job.newValue);
    if (changes.sjrMeta) refreshSjrInfo();
  });

  $('start').addEventListener('click', onStart);
  $('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancel' }));
  $('topic').addEventListener('keydown', (e) => { if (e.key === 'Enter') onStart(); });
  $('sjrFile').addEventListener('change', (e) => { if (e.target.files[0]) importSjr(e.target.files[0]); });
  $('export').addEventListener('click', async () => {
    const { job: j } = await chrome.storage.local.get('job');
    if (j) exportCsv(j);
  });
}
init();

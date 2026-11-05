// Paper Finder - background service worker (Manifest V3)
// Flow: Google Scholar (tab + content script) -> OpenAlex match for DOI/metrics -> filters
//       -> PDF fallback chain -> chrome.downloads. OpenAlex search tops up if Scholar falls short.

const OPENALEX = 'https://api.openalex.org';
const WORK_SELECT = 'id,doi,title,publication_year,cited_by_count,primary_location,best_oa_location,locations';
let running = false;
let cancelled = false;
let currentJob = null;

// Scholar tab bookkeeping
let scholarTabId = null;
const scholarInbox = new Map();
const scholarWaiters = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encDoi = (doi) => doi.split('/').map(encodeURIComponent).join('/');
const safe = (s, n) =>
  String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, n) || 'untitled';
const normIssn = (s) => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const needMetrics = (p) => Number(p.minImpact) > 0 || Number(p.maxQuartile) > 0;

function similarTitle(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (nb.length > 20 && na.startsWith(nb)) return true; // Scholar truncates long titles
  const A = new Set(na.split(' ')), B = new Set(nb.split(' '));
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter) >= 0.8;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start') {
    if (running) sendResponse({ ok: false, error: 'A search is already running.' });
    else { runJob(msg.params); sendResponse({ ok: true }); }
  } else if (msg.type === 'cancel') {
    cancelled = true;
    sendResponse({ ok: true });
  } else if (msg.type === 'scholar-page') {
    if (sender.tab && sender.tab.id === scholarTabId) deliverScholar(sender.tab.id, msg);
  }
  return false;
});

chrome.tabs.onRemoved.addListener((id) => { if (id === scholarTabId) scholarTabId = null; });

const save = (job) => chrome.storage.local.set({ job });

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return r.json();
  }
  throw new Error(`Too many retries for ${new URL(url).hostname}`);
}

async function runJob(p) {
  running = true;
  cancelled = false;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const job = { status: 'running', phase: 'Starting...', params: p, papers: [], message: '' };
  currentJob = job;
  await save(job);

  try {
    const { sjr } = await chrome.storage.local.get('sjr');
    job.papers = await collectPapers(p, sjr || null, job);

    if (!job.papers.length && !cancelled) {
      job.message = 'No papers matched. Try a broader topic or looser filters.';
    }

    for (let i = 0; i < job.papers.length; i++) {
      if (cancelled) break;
      const paper = job.papers[i];
      job.phase = `Downloading ${i + 1} of ${job.papers.length}`;
      paper.status = 'working';
      await save(job);
      try {
        await resolveAndDownload(paper, p);
      } catch (e) {
        paper.status = 'failed';
        paper.note = String(e.message || e);
      }
      await save(job);
      await sleep(300);
    }
    job.status = cancelled ? 'cancelled' : 'done';
    job.phase = cancelled ? 'Stopped' : 'Finished';
  } catch (e) {
    job.status = 'error';
    job.phase = 'Error';
    job.message = String(e.message || e);
  } finally {
    clearInterval(keepAlive);
    await closeScholarTab();
    running = false;
    currentJob = null;
    await save(job);
  }
}

// ---------- Collecting papers ----------

const SOURCE_NAMES = {
  scholar: 'Google Scholar', openalex: 'OpenAlex', semanticscholar: 'Semantic Scholar',
  europepmc: 'Europe PMC', arxiv: 'arXiv',
};

// Tries each enabled source in the user's order until enough papers are found.
async function collectPapers(p, sjr, job) {
  const out = [];
  const seen = new Set();
  const collectors = {
    scholar: collectFromScholar,
    openalex: collectFromOpenAlex,
    semanticscholar: collectFromSemanticScholar,
    europepmc: collectFromEuropePmc,
    arxiv: collectFromArxiv,
  };
  const order = p.sources && p.sources.length ? p.sources : ['scholar', 'openalex'];
  for (const id of order) {
    if (out.length >= p.max || cancelled) break;
    const fn = collectors[id];
    if (!fn) continue;
    try {
      await fn(p, sjr, job, out, seen);
    } catch (e) {
      job.message = `${job.message ? job.message + ' ' : ''}${SOURCE_NAMES[id] || id} failed (${e.message}); moving on.`;
      await save(job);
    }
  }
  return out;
}

// Turns an OpenAlex work (plus journal metrics) into a paper, or null if filters reject it.
function evaluate(w, metrics, sjr, p) {
  const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
  const src = w.primary_location?.source;
  const m = src ? metrics[src.id] : null;
  let quartile = null;
  if (m && sjr) {
    for (const issn of m.issns) {
      if (sjr[issn]) { quartile = sjr[issn]; break; }
    }
  }
  const impact = m && typeof m.impact === 'number' ? Math.round(m.impact * 100) / 100 : null;

  if (Number(p.minImpact) > 0 && (impact === null || impact < Number(p.minImpact))) return null;
  if (Number(p.maxQuartile) > 0) {
    if (!quartile || Number(quartile.slice(1)) > Number(p.maxQuartile)) return null;
  }

  const oaPdfs = [w.best_oa_location?.pdf_url, ...(w.locations || []).map((l) => l.pdf_url)].filter(Boolean);
  return {
    doi,
    title: w.title || '(untitled)',
    journal: src?.display_name || '',
    year: w.publication_year || '',
    cites: w.cited_by_count || 0,
    quartile,
    impact,
    oaPdfs: [...new Set(oaPdfs)],
    hintPdf: '',
    link: doi ? `https://doi.org/${doi}` : '',
    found: 'OpenAlex',
    status: 'queued',
    note: '',
    source: '',
    file: '',
  };
}

async function collectFromOpenAlex(p, sjr, job, out, seen) {
  const filters = ['has_doi:true', 'type:article'];
  if (p.yearFrom) filters.push(`from_publication_date:${p.yearFrom}-01-01`);
  if (p.yearTo) filters.push(`to_publication_date:${p.yearTo}-12-31`);
  if (p.oaOnly) filters.push('is_oa:true');
  const sort =
    p.sort === 'relevance' ? '' : p.sort === 'newest' ? '&sort=publication_date:desc' : '&sort=cited_by_count:desc';

  for (let page = 1; page <= 6 && out.length < p.max; page++) {
    if (cancelled) break;
    job.phase = `Searching OpenAlex (page ${page})...`;
    await save(job);

    const url =
      `${OPENALEX}/works?search=${encodeURIComponent(p.topic)}&filter=${filters.join(',')}${sort}` +
      `&per-page=50&page=${page}&select=${WORK_SELECT}&mailto=${encodeURIComponent(p.email)}`;
    const data = await getJSON(url);
    const works = (data && data.results) || [];
    if (!works.length) break;

    const srcIds = [...new Set(works.map((w) => w.primary_location?.source?.id).filter(Boolean))];
    const metrics = await fetchSourceMetrics(srcIds, p.email);

    for (const w of works) {
      if (out.length >= p.max) break;
      const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
      const tkey = 't:' + norm(w.title);
      if (!doi || seen.has(doi) || seen.has(tkey)) continue;
      seen.add(doi);
      const paper = evaluate(w, metrics, sjr, p);
      if (paper) { seen.add(tkey); out.push(paper); }
    }
  }
}

async function fetchSourceMetrics(ids, email) {
  const result = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map((id) => id.split('/').pop());
    const url =
      `${OPENALEX}/sources?filter=openalex:${chunk.join('|')}&per-page=50` +
      `&select=id,display_name,issn,issn_l,summary_stats&mailto=${encodeURIComponent(email)}`;
    const data = await getJSON(url);
    for (const s of (data && data.results) || []) {
      const issns = [...(s.issn || []), s.issn_l].filter(Boolean).map(normIssn);
      result[s.id] = { impact: s.summary_stats?.['2yr_mean_citedness'], issns };
    }
  }
  return result;
}

// ---------- Google Scholar ----------

function scholarUrl(p, page) {
  const q = new URLSearchParams({ hl: 'en', q: p.topic, start: String(page * 10) });
  if (p.yearFrom) q.set('as_ylo', p.yearFrom);
  if (p.yearTo) q.set('as_yhi', p.yearTo);
  if (p.sort === 'newest') q.set('scisbd', '1');
  return `https://scholar.google.com/scholar?${q.toString()}`;
}

function deliverScholar(tabId, msg) {
  const w = scholarWaiters.get(tabId);
  if (w) { scholarWaiters.delete(tabId); w(msg); }
  else scholarInbox.set(tabId, msg);
}

function waitScholar(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const early = scholarInbox.get(tabId);
    if (early) { scholarInbox.delete(tabId); return resolve(early); }
    const timer = setTimeout(() => { scholarWaiters.delete(tabId); resolve(null); }, timeoutMs);
    scholarWaiters.set(tabId, (m) => { clearTimeout(timer); resolve(m); });
  });
}

async function loadScholarPage(url) {
  if (scholarTabId === null) {
    const tab = await chrome.tabs.create({ url, active: false });
    scholarTabId = tab.id;
  } else {
    scholarInbox.delete(scholarTabId);
    await chrome.tabs.update(scholarTabId, { url });
  }
  let msg = await waitScholar(scholarTabId, 30000);

  if (msg && msg.captcha && scholarTabId !== null) {
    if (currentJob) {
      currentJob.message = 'Google Scholar is asking for a CAPTCHA. Solve it in the Scholar tab that just opened; the search continues on its own.';
      await save(currentJob);
    }
    try {
      const tab = await chrome.tabs.update(scholarTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* tab may be gone */ }
    msg = await waitScholar(scholarTabId, 180000);
    if (currentJob) { currentJob.message = ''; await save(currentJob); }
  }
  return msg;
}

async function closeScholarTab() {
  if (scholarTabId !== null) {
    try { await chrome.tabs.remove(scholarTabId); } catch { /* already closed */ }
    scholarTabId = null;
  }
  scholarInbox.clear();
}

async function matchOpenAlex(title, email) {
  const t = title.replace(/[….]+$/, '').trim();
  const url = `${OPENALEX}/works?search=${encodeURIComponent(t)}&per-page=3&select=${WORK_SELECT}&mailto=${encodeURIComponent(email)}`;
  const data = await getJSON(url);
  return ((data && data.results) || []).find((w) => similarTitle(w.title, t)) || null;
}

function fromScholarOnly(r) {
  const parts = r.meta.split(' - ');
  const journal = (parts[1] || '').replace(/,?\s*(?:19|20)\d{2}\s*$/, '').trim();
  return {
    doi: '', title: r.title, journal, year: r.year || '', cites: 0, quartile: null, impact: null,
    oaPdfs: [], hintPdf: '', link: r.link, found: 'Google Scholar',
    status: 'queued', note: '', source: '', file: '',
  };
}

async function addScholarResults(results, p, sjr, out, seen) {
  const matched = [];
  for (const r of results) {
    if (cancelled) break;
    let w = null;
    try { w = await matchOpenAlex(r.title, p.email); } catch { /* treat as unmatched */ }
    matched.push({ r, w });
    await sleep(100);
  }
  const srcIds = [...new Set(matched.map((m) => m.w?.primary_location?.source?.id).filter(Boolean))];
  const metrics = srcIds.length ? await fetchSourceMetrics(srcIds, p.email) : {};

  for (const { r, w } of matched) {
    if (out.length >= p.max) break;
    let paper = null;
    if (w) {
      const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
      if (doi && seen.has(doi)) continue;
      paper = evaluate(w, metrics, sjr, p);
    } else if (!needMetrics(p)) {
      if (seen.has('t:' + norm(r.title))) continue;
      paper = fromScholarOnly(r);
    }
    if (!paper) continue;
    paper.found = 'Google Scholar';
    paper.hintPdf = r.pdf || '';
    if (!paper.link) paper.link = r.link || '';
    if (paper.doi) seen.add(paper.doi);
    seen.add('t:' + norm(paper.title));
    out.push(paper);
  }
}

async function collectFromScholar(p, sjr, job, out, seen) {
  const maxPages = Math.min(4, Math.ceil(p.max / 5));
  for (let page = 0; page < maxPages && out.length < p.max && !cancelled; page++) {
    job.phase = `Reading Google Scholar (page ${page + 1} of up to ${maxPages})...`;
    await save(job);
    const msg = await loadScholarPage(scholarUrl(p, page));
    if (!msg || msg.captcha) {
      job.message = 'Google Scholar returned no results (CAPTCHA or timeout). Continuing with OpenAlex.';
      await save(job);
      break;
    }
    if (!msg.results.length) break;
    job.phase = `Matching Scholar results (page ${page + 1})...`;
    await save(job);
    await addScholarResults(msg.results, p, sjr, out, seen);
    if (!msg.hasNext) break;
    await sleep(3000 + Math.random() * 3000); // polite pacing between Scholar pages
  }
  await closeScholarTab();
}

// ---------- Other search sources ----------

async function workByDoi(dois, email) {
  const map = {};
  const list = [...new Set(dois.filter((d) => d && !/[,|]/.test(d)))];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const url =
      `${OPENALEX}/works?filter=doi:${encodeURI(chunk.join('|'))}&per-page=50` +
      `&select=${WORK_SELECT}&mailto=${encodeURIComponent(email)}`;
    const d = await getJSON(url);
    for (const w of (d && d.results) || []) {
      const k = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
      if (k) map[k] = w;
    }
  }
  return map;
}

// Candidates from any source: [{doi, title, year, journal, cites, hintPdf, link}].
// Journal metrics come from OpenAlex via the DOI.
async function addDoiCandidates(cands, found, p, sjr, out, seen) {
  const wmap = await workByDoi(cands.map((c) => c.doi), p.email);
  const srcIds = [...new Set(Object.values(wmap).map((w) => w.primary_location?.source?.id).filter(Boolean))];
  const metrics = srcIds.length ? await fetchSourceMetrics(srcIds, p.email) : {};

  for (const c of cands) {
    if (out.length >= p.max) break;
    const key = (c.doi || '').toLowerCase();
    const tkey = 't:' + norm(c.title);
    if ((key && seen.has(key)) || seen.has(tkey)) continue;
    const w = key ? wmap[key] : null;
    let paper = null;
    if (w) paper = evaluate(w, metrics, sjr, p);
    else if (!needMetrics(p)) {
      paper = {
        doi: c.doi || '', title: c.title, journal: c.journal || '', year: c.year || '', cites: c.cites || 0,
        quartile: null, impact: null, oaPdfs: [], hintPdf: '', link: '', found,
        status: 'queued', note: '', source: '', file: '',
      };
    }
    if (!paper) continue;
    paper.found = found;
    paper.hintPdf = c.hintPdf || '';
    paper.link = paper.link || c.link || (paper.doi ? `https://doi.org/${paper.doi}` : '');
    if (paper.doi) seen.add(paper.doi.toLowerCase());
    seen.add(tkey);
    out.push(paper);
  }
}

async function collectFromSemanticScholar(p, sjr, job, out, seen) {
  for (let page = 0; page < 3 && out.length < p.max && !cancelled; page++) {
    job.phase = `Searching Semantic Scholar (page ${page + 1})...`;
    await save(job);
    const q = new URLSearchParams({
      query: p.topic, limit: '50', offset: String(page * 50),
      fields: 'title,year,externalIds,openAccessPdf,citationCount,venue',
    });
    if (p.yearFrom || p.yearTo) q.set('year', `${p.yearFrom || ''}-${p.yearTo || ''}`);
    const d = await getJSON(`https://api.semanticscholar.org/graph/v1/paper/search?${q.toString()}`);
    const rows = (d && d.data) || [];
    if (!rows.length) break;
    const cands = rows
      .map((r) => ({
        doi: ((r.externalIds && r.externalIds.DOI) || '').toLowerCase(),
        title: r.title || '', year: r.year, journal: r.venue, cites: r.citationCount,
        hintPdf: (r.openAccessPdf && r.openAccessPdf.url) || '',
        link: r.externalIds && r.externalIds.DOI ? `https://doi.org/${r.externalIds.DOI}` : '',
      }))
      .filter((c) => c.title);
    await addDoiCandidates(cands, 'Semantic Scholar', p, sjr, out, seen);
    if (!d.next) break;
    await sleep(1200);
  }
}

async function collectFromEuropePmc(p, sjr, job, out, seen) {
  for (let page = 1; page <= 3 && out.length < p.max && !cancelled; page++) {
    job.phase = `Searching Europe PMC (page ${page})...`;
    await save(job);
    let query = `(${p.topic}) AND OPEN_ACCESS:y`;
    if (p.yearFrom || p.yearTo) query += ` AND (PUB_YEAR:[${p.yearFrom || 1900} TO ${p.yearTo || 2100}])`;
    const q = new URLSearchParams({ query, format: 'json', resultType: 'lite', pageSize: '50', page: String(page) });
    if (p.sort === 'citations') q.set('sort', 'CITED desc');
    else if (p.sort === 'newest') q.set('sort', 'P_PDATE_D desc');
    const d = await getJSON(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${q.toString()}`);
    const rows = (d && d.resultList && d.resultList.result) || [];
    if (!rows.length) break;
    const cands = rows
      .map((r) => ({
        doi: (r.doi || '').toLowerCase(),
        title: (r.title || '').replace(/\.$/, ''), year: r.pubYear, journal: r.journalTitle, cites: r.citedByCount,
        hintPdf: r.pmcid ? `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${r.pmcid}&blobtype=pdf` : '',
        link: r.doi ? `https://doi.org/${r.doi}` : '',
      }))
      .filter((c) => c.title && c.doi);
    await addDoiCandidates(cands, 'Europe PMC', p, sjr, out, seen);
  }
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function collectFromArxiv(p, sjr, job, out, seen) {
  job.phase = 'Searching arXiv...';
  await save(job);
  const terms = p.topic.split(/\s+/).filter(Boolean).map((t) => 'all:' + encodeURIComponent(t)).join('+AND+');
  let sq = terms;
  if (p.yearFrom || p.yearTo) {
    sq += `+AND+submittedDate:[${p.yearFrom || 1990}01010000+TO+${p.yearTo || 2100}12312359]`;
  }
  const sortBy = p.sort === 'newest' ? 'submittedDate' : 'relevance';
  const url =
    `https://export.arxiv.org/api/query?search_query=${sq}&start=0&max_results=${Math.min(50, p.max * 3)}` +
    `&sortBy=${sortBy}&sortOrder=descending`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from arxiv.org`);
  const xml = await r.text();
  const cands = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((m) => {
      const e = m[1];
      const get = (tag) => {
        const x = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return x ? x[1].replace(/\s+/g, ' ').trim() : '';
      };
      const id = get('id');
      return {
        doi: get('arxiv:doi').toLowerCase(),
        title: decodeXml(get('title')),
        year: Number(get('published').slice(0, 4)) || '',
        journal: 'arXiv', cites: 0,
        hintPdf: `https://arxiv.org/pdf/${id.replace(/^https?:\/\/arxiv\.org\/abs\//, '')}`,
        link: id,
      };
    })
    .filter((c) => c.title);
  await addDoiCandidates(cands, 'arXiv', p, sjr, out, seen);
}

// ---------- PDF fallback chain ----------

async function unpaywallUrls(doi, email) {
  const j = await getJSON(`https://api.unpaywall.org/v2/${encDoi(doi)}?email=${encodeURIComponent(email)}`, 2);
  if (!j) return [];
  return [j.best_oa_location, ...(j.oa_locations || [])].map((l) => l && l.url_for_pdf).filter(Boolean);
}

async function semanticScholarUrls(doi) {
  const j = await getJSON(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${encDoi(doi)}?fields=openAccessPdf`, 2);
  return j && j.openAccessPdf && j.openAccessPdf.url ? [j.openAccessPdf.url] : [];
}

async function europePmcUrls(doi) {
  const j = await getJSON(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22` +
    `&format=json&resultType=core`, 2);
  const rec = j && j.resultList && j.resultList.result && j.resultList.result[0];
  if (!rec) return [];
  const urls = ((rec.fullTextUrlList && rec.fullTextUrlList.fullTextUrl) || [])
    .filter((u) => u.documentStyle === 'pdf' && /open/i.test(u.availability || ''))
    .map((u) => u.url);
  if (rec.pmcid) urls.push(`https://europepmc.org/backend/ptpmcrender.fcgi?accid=${rec.pmcid}&blobtype=pdf`);
  return urls;
}

async function looksLikePdf(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: 'application/pdf,*/*' } });
    if (!r.ok || !r.body) return false;
    const { value } = await r.body.getReader().read();
    ctrl.abort();
    if (!value) return false;
    return new TextDecoder('latin1').decode(value.slice(0, 1024)).includes('%PDF-');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Starts a download and resolves true only if it completes.
// The listener is attached first so a fast download cannot finish unnoticed.
function downloadAndWait(url, filename, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let myId = null;
    const early = {};
    let timer;
    function finish(ok) {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(ok);
    }
    function onChanged(delta) {
      if (!delta.state) return;
      const st = delta.state.current;
      if (st !== 'complete' && st !== 'interrupted') return;
      if (myId === null) early[delta.id] = st;
      else if (delta.id === myId) finish(st === 'complete');
    }
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => finish(false), timeoutMs);
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) return finish(false);
      myId = id;
      if (early[id]) finish(early[id] === 'complete');
    });
  });
}

async function resolveAndDownload(paper, p) {
  const filename =
    `PaperFinder/${safe(p.topic, 50)}/` +
    `${paper.year}_${safe(paper.journal, 40)}_${safe(paper.title, 80)}.pdf`;

  const chain = [];
  if (paper.hintPdf) chain.push([paper.found || 'Search result', async () => [paper.hintPdf]]);
  chain.push(['OpenAlex', async () => paper.oaPdfs]);
  if (paper.doi) {
    chain.push(['Unpaywall', () => unpaywallUrls(paper.doi, p.email)]);
    chain.push(['Semantic Scholar', () => semanticScholarUrls(paper.doi)]);
    chain.push(['Europe PMC', () => europePmcUrls(paper.doi)]);
  }

  let foundLinks = false;
  const tried = new Set();
  for (const [name, getUrls] of chain) {
    if (cancelled) return;
    let urls = [];
    try { urls = await getUrls(); } catch { /* source unavailable, try next */ }
    for (const url of urls) {
      if (tried.has(url)) continue;
      tried.add(url);
      foundLinks = true;
      if (!(await looksLikePdf(url))) continue;
      if (await downloadAndWait(url, filename)) {
        paper.status = 'downloaded';
        paper.source = name;
        paper.file = filename;
        paper.note = '';
        return;
      }
    }
  }
  paper.status = 'no-open-copy';
  paper.note = foundLinks
    ? 'Open-access links exist but none served a direct PDF. Open the paper link.'
    : 'No open-access copy found. Open the paper link (use university access if available).';
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ui = {
  form: $('#searchForm'), input: $('#searchInput'), clear: $('#clearSearch'), error: $('#queryError'),
  results: $('#results'), count: $('#resultCount'), loading: $('#loading'), sort: $('#sortBy'),
  pagination: $('#pagination'), reset: $('#resetFilters'), active: $('#activeFilters'),
  filterPanel: $('#filterPanel'), mobileFilter: $('#mobileFilterButton'), dateFrom: $('#dateFrom'),
  dateTo: $('#dateTo'), versionFrom: $('#versionFrom'), versionTo: $('#versionTo'),
  dialog: $('#syntaxDialog'), syntaxButton: $('#syntaxButton')
};

const PAGE_SIZE = 15;
let index = [];
let filteredResults = [];
let currentPage = 1;
let lastQuery = null;
let debounceTimer;

const categoryRules = {
  blocks: /\b(blocks?|items?|crafting|recipe|loot|texture|sound)\b/i,
  mobs: /\b(mobs?|entities|entity|pathfind|spawn|health|damage)\b/i,
  world: /\b(biomes?|world generation|terrain|structure|noise|dimension)\b/i,
  commands: /\bcommands?|selector|subcommands?|syntax|execute\b/i,
  fixes: /\b(fixed|fixes|bug fixes?|resolved|issue)\b/i,
  features: /\b(new features?|added|introducing|now available|experimental features?)\b/i
};
const technicalRules = {
  scripting: /@minecraft\/|scripting api|script api|molang|add-ons?|behavior pack|component schema/i,
  packs: /pack_format|data packs?|resource packs?|pack format/i,
  breaking: /breaking change|deprecated|deprecation|removed component|no longer supported/i,
  protocol: /protocol|network packet|packet update|server protocol/i
};

function stripHtml(html = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function classify(article) {
  const title = article.title.toLowerCase();
  const text = `${article.title} ${article._text}`;
  let edition = 'other';
  if (title.includes('education')) edition = 'education';
  else if (title.includes('java')) edition = 'java';
  else if (title.includes('bedrock') || title.includes('preview') || title.includes('beta') || /minecraft\s*-\s*\d[^\n]*\(bedrock\)/i.test(article.title)) edition = 'bedrock';

  let stream = 'release';
  if (/hotfix/i.test(title)) stream = 'hotfix';
  else if (/release candidate|pre[- ]?release|\bpre\d/i.test(title)) stream = 'prerelease';
  else if (/snapshot|preview|beta/i.test(title)) stream = 'preview';

  const versionMatch = article.title.match(/\b(\d{1,2}(?:\.\d+){1,3})\b/);
  const categories = Object.entries(categoryRules).filter(([, rule]) => rule.test(text)).map(([key]) => key);
  const technical = Object.entries(technicalRules).filter(([, rule]) => rule.test(text)).map(([key]) => key);
  return { edition, stream, version: versionMatch?.[1] || '', categories, technical };
}

function tokenize(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) { i++; continue; }
    let negated = false;
    if (query[i] === '-' && query[i + 1] && !/\s/.test(query[i + 1])) { negated = true; i++; }
    if (query[i] === '"') {
      const start = ++i;
      while (i < query.length && query[i] !== '"') i++;
      if (i >= query.length) throw new Error('Unclosed quote. Add a closing “ character.');
      const value = query.slice(start, i++);
      if (value) tokens.push({ type: 'term', value, exact: true, negated });
      continue;
    }
    if (query[i] === '/') {
      const start = ++i;
      let escaped = false;
      while (i < query.length) {
        if (!escaped && query[i] === '/') break;
        escaped = !escaped && query[i] === '\\';
        if (query[i] !== '\\') escaped = false;
        i++;
      }
      if (i >= query.length) throw new Error('Unclosed regular expression. Add a trailing /.');
      const pattern = query.slice(start, i++);
      let flags = '';
      while (i < query.length && /[gimsuy]/.test(query[i])) flags += query[i++];
      try { new RegExp(pattern, flags.replace('g', '')); } catch { throw new Error('That regular expression is not valid.'); }
      tokens.push({ type: 'regex', value: pattern, flags, negated });
      continue;
    }
    const start = i;
    while (i < query.length && !/\s/.test(query[i])) i++;
    const value = query.slice(start, i);
    if (/^(AND|OR|NOT)$/.test(value)) tokens.push({ type: 'operator', value });
    else if (value) tokens.push({ type: 'term', value, exact: false, negated });
  }
  return tokens;
}

function wildcardToRegex(value) {
  // Wildcards match within one identifier/token instead of consuming entire paragraphs.
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\s]*').replace(/\?/g, '[^\\s]');
  return new RegExp(escaped, 'i');
}

function parseQuery(query) {
  const tokens = tokenize(query);
  const groups = [[]];
  let pendingNot = false;
  for (const token of tokens) {
    if (token.type === 'operator') {
      if (token.value === 'OR') groups.push([]);
      if (token.value === 'NOT') pendingNot = true;
      continue;
    }
    token.negated = token.negated || pendingNot;
    pendingNot = false;
    token.regex = token.type === 'regex'
      ? new RegExp(token.value, token.flags.replace('g', ''))
      : wildcardToRegex(token.value);
    groups.at(-1).push(token);
  }
  const usefulGroups = groups.filter(group => group.length);
  return {
    groups: usefulGroups,
    highlightMatchers: tokens
      .filter(token => token.type !== 'operator' && !token.negated)
      .map(token => token.regex),
    isIssueLookup: /^\s*(MC|MCPE|MCL|REALMS)-\d+\s*$/i.test(query)
  };
}

function countMatches(text, regex, cap = 20) {
  let flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const global = new RegExp(regex.source, flags);
  let count = 0;
  while (global.exec(text) && count < cap) {
    count++;
    if (global.lastIndex === 0) global.lastIndex++;
  }
  return count;
}

function evaluateArticle(article, parsed) {
  if (!parsed.groups.length) return { match: true, score: 0 };
  let bestScore = -1;
  for (const group of parsed.groups) {
    let valid = true;
    let score = 0;
    for (const token of group) {
      const inTitle = token.regex.test(article.title);
      const inText = token.regex.test(article._text);
      const found = inTitle || inText;
      if (token.negated ? found : !found) { valid = false; break; }
      if (!token.negated) {
        score += countMatches(article._text, token.regex) * 2;
        if (inTitle) score += 30;
        if (token.exact) score += 18;
      }
    }
    if (valid) bestScore = Math.max(bestScore, score);
  }
  if (parsed.isIssueLookup && bestScore >= 0) bestScore += 500;
  return { match: bestScore >= 0, score: bestScore };
}

function versionParts(value) {
  return String(value).split('.').map(v => Number.parseInt(v, 10) || 0);
}
function compareVersions(a, b) {
  const aa = versionParts(a), bb = versionParts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
function selected(name) { return $$(`input[name="${name}"]:checked`).map(el => el.value); }

function getFilters() {
  return {
    editions: selected('edition'), streams: selected('stream'), categories: selected('category'), technical: selected('technical'),
    dateFrom: ui.dateFrom.value, dateTo: ui.dateTo.value,
    versionFrom: ui.versionFrom.value.trim(), versionTo: ui.versionTo.value.trim()
  };
}

function passesFilters(article, f) {
  const m = article._meta;
  if (f.editions.length && !f.editions.includes(m.edition)) return false;
  if (f.streams.length && !f.streams.includes(m.stream)) return false;
  const day = article.created_at.slice(0, 10);
  if (f.dateFrom && day < f.dateFrom) return false;
  if (f.dateTo && day > f.dateTo) return false;
  if ((f.versionFrom || f.versionTo) && !m.version) return false;
  if (f.versionFrom && compareVersions(m.version, f.versionFrom) < 0) return false;
  if (f.versionTo && compareVersions(m.version, f.versionTo) > 0) return false;
  if (f.categories.length && !f.categories.some(x => m.categories.includes(x))) return false;
  if (f.technical.length && !f.technical.some(x => m.technical.includes(x))) return false;
  return true;
}

function updateSearch() {
  const raw = ui.input.value.trim();
  let parsed;
  try {
    parsed = parseQuery(raw);
    ui.error.hidden = true;
  } catch (error) {
    ui.error.textContent = error.message;
    ui.error.hidden = false;
    return;
  }
  lastQuery = parsed;
  const filters = getFilters();
  filteredResults = index.filter(article => passesFilters(article, filters)).map(article => {
    const evaluated = evaluateArticle(article, parsed);
    return evaluated.match ? { ...article, _score: evaluated.score } : null;
  }).filter(Boolean);

  const sort = ui.sort.value;
  filteredResults.sort((a, b) => {
    if (sort === 'newest') return new Date(b.created_at) - new Date(a.created_at);
    if (sort === 'oldest') return new Date(a.created_at) - new Date(b.created_at);
    return (b._score - a._score) || (new Date(b.created_at) - new Date(a.created_at));
  });

  currentPage = 1;
  ui.clear.hidden = !raw;
  renderActiveFilters(filters);
  render();
  const url = new URL(location.href);
  raw ? url.searchParams.set('q', raw) : url.searchParams.delete('q');
  history.replaceState(null, '', url);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function findMatches(text, matchers) {
  const ranges = [];
  for (const matcher of matchers) {
    const flags = [...new Set(`${matcher.flags}gi`)].join('');
    const regex = new RegExp(matcher.source, flags);
    let match;
    while ((match = regex.exec(text))) {
      if (!match[0].length) {
        regex.lastIndex++;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
      if (ranges.length >= 100) break;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const accepted = [];
  for (const range of ranges) {
    if (!accepted.length || range[0] >= accepted.at(-1)[1]) accepted.push(range);
  }
  return accepted;
}

function highlight(text, matchers) {
  const ranges = findMatches(text, matchers);
  if (!ranges.length) return escapeHtml(text);
  let out = '', last = 0;
  for (const [start, end] of ranges) {
    out += escapeHtml(text.slice(last, start));
    out += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    last = end;
  }
  return out + escapeHtml(text.slice(last));
}

function snippet(article, matchers) {
  const text = article._text;
  const firstMatch = findMatches(text, matchers)[0];
  const position = firstMatch?.[0] || 0;
  const start = Math.max(0, position - 85);
  const end = Math.min(text.length, start + 290);
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function badgeLabel(article) {
  const m = article._meta;
  const list = [{ label: m.edition === 'other' ? 'General' : m.edition[0].toUpperCase() + m.edition.slice(1), cls: m.edition }];
  const streams = { release:'Release', preview:'Snapshot / Preview', prerelease:'Pre-release', hotfix:'Hotfix' };
  list.push({ label: streams[m.stream], cls: m.stream });
  if (m.version) list.push({ label: `v${m.version}`, cls: 'version' });
  return list.map(b => `<span class="badge ${escapeHtml(b.cls)}">${escapeHtml(b.label)}</span>`).join('');
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en', { year:'numeric', month:'short', day:'numeric' }).format(new Date(value));
}

function render() {
  ui.loading.hidden = true;
  const total = filteredResults.length;
  const query = ui.input.value.trim();
  ui.count.textContent = query ? `${total.toLocaleString()} result${total === 1 ? '' : 's'} for “${query}”` : `${total.toLocaleString()} changelog${total === 1 ? '' : 's'}`;
  if (!total) {
    ui.results.innerHTML = `<div class="no-results"><h2>No matching changes</h2><p>Try removing a filter, checking the version range, or using OR between alternatives.</p></div>`;
    ui.pagination.innerHTML = '';
    return;
  }
  const start = (currentPage - 1) * PAGE_SIZE;
  const matchers = lastQuery?.highlightMatchers || [];
  ui.results.innerHTML = filteredResults.slice(start, start + PAGE_SIZE).map(article => `
    <article class="result-card">
      <div class="result-top">
        <h2 class="result-title"><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${highlight(article.title, matchers)}</a></h2>
        <time class="result-date" datetime="${escapeHtml(article.created_at)}">${formatDate(article.created_at)}</time>
      </div>
      <div class="badges">${badgeLabel(article)}</div>
      <p class="result-snippet">${highlight(snippet(article, matchers), matchers)}</p>
      <div class="result-footer"><span>${article._meta.categories.slice(0,3).map(x => x.replace(/^./, c => c.toUpperCase())).join(' · ') || 'Changelog'}</span><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">Open changelog →</a></div>
    </article>`).join('');
  renderPagination(total);
}

function renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) { ui.pagination.innerHTML = ''; return; }
  const visible = new Set([1, pages, currentPage - 1, currentPage, currentPage + 1].filter(n => n >= 1 && n <= pages));
  let html = `<button class="page-btn" data-page="${currentPage-1}" ${currentPage===1?'disabled':''} aria-label="Previous page">←</button>`;
  let previous = 0;
  [...visible].sort((a,b)=>a-b).forEach(page => {
    if (previous && page - previous > 1) html += '<span class="ellipsis">…</span>';
    html += `<button class="page-btn ${page===currentPage?'active':''}" data-page="${page}" ${page===currentPage?'aria-current="page"':''}>${page}</button>`;
    previous = page;
  });
  html += `<button class="page-btn" data-page="${currentPage+1}" ${currentPage===pages?'disabled':''} aria-label="Next page">→</button>`;
  ui.pagination.innerHTML = html;
  $$('.page-btn[data-page]').forEach(button => button.addEventListener('click', () => {
    currentPage = Number(button.dataset.page); render();
    ui.results.scrollIntoView({ behavior:'smooth', block:'start' });
  }));
}

function renderActiveFilters(filters) {
  const labels = [];
  ['editions','streams','categories','technical'].forEach(group => filters[group].forEach(value => labels.push(value.replace(/^./, c => c.toUpperCase()))));
  if (filters.dateFrom) labels.push(`From ${filters.dateFrom}`);
  if (filters.dateTo) labels.push(`To ${filters.dateTo}`);
  if (filters.versionFrom) labels.push(`≥ ${filters.versionFrom}`);
  if (filters.versionTo) labels.push(`≤ ${filters.versionTo}`);
  ui.active.innerHTML = labels.map(label => `<button class="active-filter" type="button" title="Reset filters">${escapeHtml(label)}</button>`).join('');
  $$('.active-filter').forEach(button => button.addEventListener('click', resetFilters));
}

function resetFilters() {
  $$('.filters input').forEach(input => { if (input.type === 'checkbox') input.checked = false; else input.value = ''; });
  updateSearch();
}

function updateEditionCounts() {
  for (const edition of ['java','bedrock','education','other']) {
    const target = $(`#count${edition[0].toUpperCase()+edition.slice(1)}`);
    if (target) target.textContent = index.filter(a => a._meta.edition === edition).length.toLocaleString();
  }
}

function scheduleSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(updateSearch, 220);
}

async function init() {
  try {
    const response = await fetch('data/search-index.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.json();
    index = source.map(article => {
      const enriched = { ...article, _text: article.text || stripHtml(article.body) };
      enriched._meta = article.edition
        ? { edition: article.edition, stream: article.stream, version: article.version, categories: article.categories || [], technical: article.technical || [] }
        : classify(enriched);
      return enriched;
    });
    updateEditionCounts();
    ui.input.value = new URL(location.href).searchParams.get('q') || '';
    updateSearch();
  } catch (error) {
    ui.loading.textContent = 'Could not load the changelog index. Refresh the page to try again.';
    ui.count.textContent = 'Archive unavailable';
    console.error(error);
  }
}

ui.form.addEventListener('submit', event => { event.preventDefault(); updateSearch(); });
ui.input.addEventListener('input', scheduleSearch);
ui.clear.addEventListener('click', () => { ui.input.value = ''; ui.input.focus(); updateSearch(); });
ui.sort.addEventListener('change', updateSearch);
$$('.filters input').forEach(input => input.addEventListener(input.type === 'text' ? 'input' : 'change', input.type === 'text' ? scheduleSearch : updateSearch));
ui.reset.addEventListener('click', resetFilters);
ui.mobileFilter.addEventListener('click', () => {
  const open = ui.filterPanel.classList.toggle('open');
  ui.mobileFilter.setAttribute('aria-expanded', String(open));
});
$$('[data-query]').forEach(button => button.addEventListener('click', () => { ui.input.value = button.dataset.query; updateSearch(); ui.input.focus(); }));
ui.syntaxButton.addEventListener('click', () => ui.dialog.showModal());
document.addEventListener('keydown', event => {
  if (event.key === '?' && document.activeElement !== ui.input) ui.dialog.showModal();
  if (event.key === '/' && document.activeElement !== ui.input) { event.preventDefault(); ui.input.focus(); }
});

init();

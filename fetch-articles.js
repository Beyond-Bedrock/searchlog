const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');

const BASE_URL = 'https://feedback.minecraft.net/api/v2/help_center/en-us/articles.json';
const OUTPUT_DIR = path.join(__dirname, 'data');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function plainText(html = '') {
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}
function classify(title, text) {
  const lower = title.toLowerCase();
  let edition = 'other';
  if (lower.includes('education')) edition = 'education';
  else if (lower.includes('java')) edition = 'java';
  else if (lower.includes('bedrock') || lower.includes('preview') || lower.includes('beta') || /minecraft\s*-\s*\d[^\n]*\(bedrock\)/i.test(title)) edition = 'bedrock';
  let stream = 'release';
  if (/hotfix/i.test(title)) stream = 'hotfix';
  else if (/release candidate|pre[- ]?release|\bpre\d/i.test(title)) stream = 'prerelease';
  else if (/snapshot|preview|beta/i.test(title)) stream = 'preview';
  const version = title.match(/\b(\d{1,2}(?:\.\d+){1,3})\b/)?.[1] || '';
  const corpus = `${title} ${text}`;
  const categories = Object.entries(categoryRules).filter(([, regex]) => regex.test(corpus)).map(([key]) => key);
  const technical = Object.entries(technicalRules).filter(([, regex]) => regex.test(corpus)).map(([key]) => key);
  return { edition, stream, version, categories, technical };
}

async function getWithRetry(page, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(BASE_URL, { params: { per_page: 100, page }, timeout: 20000 });
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

async function atomicJson(filePath, value, options = {}) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeJson(tempPath, value, options);
  await fs.move(tempPath, filePath, { overwrite: true });
}

async function fetchAllArticles() {
  const allArticles = [];
  await fs.ensureDir(OUTPUT_DIR);
  console.log('Fetching articles…');
  for (let page = 1; ; page++) {
    const response = await getWithRetry(page);
    if (!Array.isArray(response.data?.articles)) throw new Error(`Unexpected API response on page ${page}`);
    allArticles.push(...response.data.articles);
    console.log(`Fetched page ${page} with ${response.data.articles.length} articles`);
    if (!response.data.next_page) break;
    await sleep(200);
  }
  const outputPath = path.join(OUTPUT_DIR, 'articles.json');
  await atomicJson(outputPath, allArticles, { spaces: 2 });
  console.log(`Saved ${allArticles.length} source articles`);
  return allArticles;
}

async function generateSearchIndex(articles) {
  const searchIndex = articles.map(article => {
    const text = plainText(article.body);
    return {
      id: article.id,
      title: article.title,
      text,
      url: article.html_url,
      created_at: article.created_at,
      updated_at: article.updated_at,
      edited_at: article.edited_at || article.updated_at,
      ...classify(article.title, text)
    };
  });
  const indexPath = path.join(OUTPUT_DIR, 'search-index.json');
  await atomicJson(indexPath, searchIndex);
  console.log(`Generated compact search index with ${searchIndex.length} entries`);
}

async function main() {
  try {
    const articles = await fetchAllArticles();
    await generateSearchIndex(articles);
    console.log('Done');
  } catch (error) {
    console.error('Build failed:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { fetchAllArticles, generateSearchIndex };
if (require.main === module) main();

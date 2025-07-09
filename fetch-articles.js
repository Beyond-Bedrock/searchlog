const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const BASE_URL = 'https://feedback.minecraft.net/api/v2/help_center/en-us/articles.json';
const OUTPUT_DIR = path.join(__dirname, 'data');

async function fetchAllArticles() {
  let allArticles = [];
  let page = 1;
  let hasMore = true;

  try {

    await fs.ensureDir(OUTPUT_DIR);

    console.log('Fetching articles...');
    
    while (hasMore) {
      const response = await axios.get(BASE_URL, {
        params: {
          per_page: 100,
          page: page
        }
      });

      const { articles, next_page } = response.data;
      allArticles = [...allArticles, ...articles];
      console.log(`Fetched page ${page} with ${articles.length} articles`);

      if (!next_page) {
        hasMore = false;
      } else {
        page++;

        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const outputPath = path.join(OUTPUT_DIR, 'articles.json');
    await fs.writeJson(outputPath, allArticles, { spaces: 2 });
    
    console.log(`✅ Successfully fetched and saved ${allArticles.length} articles to ${outputPath}`);
    return allArticles;
  } catch (error) {
    console.error('Error fetching articles:', error.message);
    throw error;
  }
}

async function generateSearchIndex(articles) {
  const searchIndex = articles.map(article => ({
    id: article.id,
    title: article.title,
    description: article.description,
    body: article.body,
    url: article.html_url,
    section_id: article.section_id,
    created_at: article.created_at,
    updated_at: article.updated_at
  }));

  const indexPath = path.join(OUTPUT_DIR, 'search-index.json');
  await fs.writeJson(indexPath, searchIndex, { spaces: 2 });
  console.log(`✅ Generated search index with ${searchIndex.length} entries`);
}

async function main() {
  try {
    const articles = await fetchAllArticles();
    await generateSearchIndex(articles);
    console.log('✅ Done!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();

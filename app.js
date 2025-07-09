let searchIndex = [];

const searchInput = document.getElementById('searchInput');
const resultsContainer = document.getElementById('results');
const resultCountElement = document.getElementById('resultCount');
const loadingElement = document.getElementById('loading');
const sortBySelect = document.getElementById('sortBy');
const excludePreviewCheckbox = document.getElementById('excludePreview');
const excludeJavaCheckbox = document.getElementById('excludeJava');
const excludeBedrockCheckbox = document.getElementById('excludeBedrock');
const paginationContainer = document.createElement('div');
paginationContainer.className = 'pagination';
document.querySelector('main').appendChild(paginationContainer);

const ITEMS_PER_PAGE = 20;
let currentPage = 1;
let currentArticles = [];

async function init() {
    try {

        const response = await fetch('data/search-index.json');
        searchIndex = await response.json();
        

        loadingElement.style.display = 'none';
        

        searchButton.addEventListener('click', performSearch);
        searchInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                performSearch();
            }
        });

        sortBySelect.addEventListener('change', performSearch);
        excludePreviewCheckbox.addEventListener('change', performSearch);
        excludeJavaCheckbox.addEventListener('change', performSearch);
        excludeBedrockCheckbox.addEventListener('change', performSearch);

        displayResults(searchIndex);
    } catch (error) {
        console.error('Error loading search index:', error);
        loadingElement.textContent = 'Error loading articles. Please try again later.';
    }
}

function sortArticles(articles, sortBy) {
    const articlesCopy = [...articles];
    
    switch(sortBy) {
        case 'newest':
            return articlesCopy.sort((a, b) => 
                new Date(b.created_at) - new Date(a.created_at)
            );
        case 'oldest':
            return articlesCopy.sort((a, b) => 
                new Date(a.created_at) - new Date(b.created_at)
            );
        case 'recentlyUpdated':
            return articlesCopy.sort((a, b) => 
                new Date(b.updated_at) - new Date(a.updated_at)
            );
        case 'recentlyEdited':
            return articlesCopy.sort((a, b) => {

                const dateA = a.edited_at ? new Date(a.edited_at) : new Date(a.created_at);
                const dateB = b.edited_at ? new Date(b.edited_at) : new Date(b.created_at);
                return dateB - dateA;
            });
        default:
            return articlesCopy;
    }
}

function performSearch() {
    const query = searchInput.value.trim().toLowerCase();
    const sortBy = sortBySelect.value;
    const results = searchArticles(query);
    const sortedResults = sortArticles(results, sortBy);
    displayResults(sortedResults, query);
}

function searchArticles(query) {
    const excludePreview = excludePreviewCheckbox.checked;
    const excludeJava = excludeJavaCheckbox.checked;
    const excludeBedrock = excludeBedrockCheckbox.checked;
    
    let results = searchIndex;
    

    if (query.length > 0) {
        results = results.filter(article => {
            const searchableText = `${article.title} ${article.description} ${article.body}`.toLowerCase();
            return searchableText.includes(query);
        });
    }
    

    if (excludePreview) {
        results = results.filter(article => 
            !article.title.toLowerCase().includes('preview') && !article.title.toLowerCase().includes('beta')
        );
    }
    
    if (excludeJava) {
        results = results.filter(article => 
            !article.title.toLowerCase().includes('java')
        );
    }
    
    if (excludeBedrock) {
        results = results.filter(article => {
            const title = article.title.toLowerCase();
            return !title.includes('preview') && !title.includes('bedrock') && !title.includes('beta');
        });
    }
    
    return results;
}

function extractContext(text, terms, contextLength = 50) {
    if (!terms || terms.length === 0) return text.substring(0, 200) + (text.length > 200 ? '...' : '');
    
    const regex = new RegExp(`(${terms.map(term => escapeRegExp(term)).join('|')})`, 'gi');
    const matches = [];
    let match;
    

    while ((match = regex.exec(text)) !== null) {
        const start = Math.max(0, match.index - contextLength);
        const end = Math.min(text.length, regex.lastIndex + contextLength);
        matches.push({ start, end });
    }
    

    if (matches.length === 0) {
        return text.substring(0, 200) + (text.length > 200 ? '...' : '');
    }
    

    const merged = [];
    let current = matches[0];
    
    for (let i = 1; i < matches.length; i++) {
        if (matches[i].start <= current.end) {
            current.end = Math.max(current.end, matches[i].end);
        } else {
            merged.push(current);
            current = matches[i];
        }
    }
    merged.push(current);
    

    let result = '';
    merged.forEach((range, index) => {
        if (index > 0 && range.start > merged[index - 1].end + 1) {
            result += ' ... ';
        } else if (index > 0) {
            result += ' ';
        }
        
        let textChunk = text.substring(range.start, range.end);

        if (range.start > 0) textChunk = '...' + textChunk;
        if (range.end < text.length) textChunk = textChunk + '...';
        
        result += textChunk;
    });
    
    return result;
}

function displayResults(articles, highlightQuery = '') {
    resultCountElement.textContent = `${articles.length} article${articles.length !== 1 ? 's' : ''} found`;
    currentArticles = articles;
    
    if (articles.length === 0) {
        resultsContainer.innerHTML = '<div class="no-results">No articles found matching your search.</div>';
        paginationContainer.innerHTML = '';
        return;
    }
    

    currentPage = 1;
    renderPagination(articles.length);
    

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const paginatedArticles = articles.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    

    const searchTerms = highlightQuery ? highlightQuery.split(/\s+/).filter(term => term.length > 0) : [];
    
    resultsContainer.innerHTML = paginatedArticles.map(article => {

        const bodyDoc = new DOMParser().parseFromString(article.body, 'text/html');
        const fullText = bodyDoc.body.textContent.trim();
        

        let preview = extractContext(fullText, searchTerms);
        let title = article.title;
        

        if (searchTerms.length > 0) {

            searchTerms.forEach(term => {
                const regex = new RegExp(`(${escapeRegExp(term)})`, 'gi');
                title = title.replace(regex, '<mark>$1</mark>');
                

                let lastIndex = 0;
                let result = '';
                let match;
                
                regex.lastIndex = 0;
                
                while ((match = regex.exec(preview)) !== null) {
                    result += preview.substring(lastIndex, match.index) + 
                              `<mark>${match[0]}</mark>`;
                    lastIndex = regex.lastIndex;
                }
                
                result += preview.substring(lastIndex);
                preview = result;
            });
        }
        
        return `
            <article class="article">
                <h2>${title}</h2>
                <p>${preview}</p>
                <a href="${article.url}" target="_blank" rel="noopener noreferrer">Read more →</a>
            </article>
        `;
    }).join('');
    

}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function renderPagination(totalItems) {
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    
    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }
    
    let paginationHTML = '';
    

    paginationHTML += `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">Previous</button>`;
    

    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
            paginationHTML += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        } else if (i === currentPage - 3 || i === currentPage + 3) {
            paginationHTML += '<span class="ellipsis">...</span>';
        }
    }
    

    paginationHTML += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next</button>`;
    
    paginationContainer.innerHTML = paginationHTML;
    

    document.querySelectorAll('.page-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            const page = parseInt(e.target.dataset.page);
            if (page >= 1 && page <= totalPages) {
                currentPage = page;
                displayResults(currentArticles); // Re-render with the same articles but different page
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', init);

let searchIndex = [];

const searchInput = document.getElementById('searchInput');
const resultsContainer = document.getElementById('results');
const resultCountElement = document.getElementById('resultCount');
const loadingElement = document.getElementById('loading');
const sortBySelect = document.getElementById('sortBy');
const excludePreviewCheckbox = document.getElementById('excludePreview');
const excludeJavaCheckbox = document.getElementById('excludeJava');
const excludeBedrockCheckbox = document.getElementById('excludeBedrock');
const matchCaseCheckbox = document.getElementById('matchCase');
const matchExactCheckbox = document.getElementById('matchExact');
const matchWholeWordCheckbox = document.getElementById('matchWholeWord');

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
        searchInput.addEventListener('input', (e) => {
            debouncedSearch();
        });
        
        searchInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                performSearch(); // Immediate search on Enter
            }
        });

        sortBySelect.addEventListener('change', performSearch);
        excludePreviewCheckbox.addEventListener('change', performSearch);
        excludeJavaCheckbox.addEventListener('change', performSearch);
        excludeBedrockCheckbox.addEventListener('change', performSearch);
        matchCaseCheckbox.addEventListener('change', performSearch);
        matchExactCheckbox.addEventListener('change', performSearch);
        matchWholeWordCheckbox.addEventListener('change', performSearch);

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
    const query = searchInput.value.trim();
    const sortBy = sortBySelect.value;
    const results = searchArticles(query);
    const sortedResults = sortArticles(results, sortBy);
    displayResults(sortedResults, query);
}

function searchArticles(query) {
    const excludePreview = excludePreviewCheckbox.checked;
    const excludeJava = excludeJavaCheckbox.checked;
    const excludeBedrock = excludeBedrockCheckbox.checked;
    const matchCase = matchCaseCheckbox.checked;
    const matchExact = matchExactCheckbox.checked;
    const matchWholeWord = matchWholeWordCheckbox.checked;
    
    let results = searchIndex;
    
    // Apply filters first
    if (excludePreview) {
        results = results.filter(article => 
            !article.title.toLowerCase().includes('preview') && 
            !article.title.toLowerCase().includes('beta')
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
            return !title.includes('preview') && 
                   !title.includes('bedrock') && 
                   !title.includes('beta');
        });
    }
    
    // Enhanced search with ranking
    if (query.length > 0) {
        let searchTerms;
        
        if (matchExact) {
            searchTerms = [query];
        } else {
            searchTerms = query.split(/\s+/).filter(term => term.length > 0);
        }
        
        // Clean terms based on options
        searchTerms = searchTerms.map(term => {
            if (!matchCase) {
                term = term.toLowerCase();
            }
            if (!matchWholeWord) {
                term = term.replace(/[^\w\s]/g, ''); // Remove special chars for partial matching
            }
            return term;
        }).filter(term => term.length > 0);
        
        if (searchTerms.length > 0) {
            results = results
                .map(article => {
                    const title = matchCase ? article.title : article.title.toLowerCase();
                    const description = matchCase ? (article.description || '') : (article.description || '').toLowerCase();
                    const body = matchCase ? stripHtml(article.body) : stripHtml(article.body).toLowerCase();
                    
                    // Calculate relevance score
                    let score = 0;
                    const matches = {
                        title: [],
                        description: [],
                        body: []
                    };
                    
                    searchTerms.forEach(term => {
                        // Build regex based on options
                        let regexPattern;
                        if (matchWholeWord) {
                            regexPattern = `\\b${escapeRegExp(term)}\\b`;
                        } else {
                            regexPattern = escapeRegExp(term);
                        }
                        
                        const flags = matchCase ? 'g' : 'gi';
                        const regex = new RegExp(regexPattern, flags);
                        
                        // Title matches (highest weight)
                        const titleMatches = [...title.matchAll(regex)];
                        if (titleMatches.length > 0) {
                            score += titleMatches.length * 10;
                            matches.title.push(...titleMatches);
                        }
                        
                        // Description matches (medium weight)
                        const descMatches = [...description.matchAll(regex)];
                        if (descMatches.length > 0) {
                            score += descMatches.length * 5;
                            matches.description.push(...descMatches);
                        }
                        
                        // Body matches (lower weight)
                        const bodyMatches = [...body.matchAll(regex)];
                        if (bodyMatches.length > 0) {
                            score += bodyMatches.length * 1;
                            matches.body.push(...bodyMatches);
                        }
                        
                        // Only add bonus scores if not using whole word mode (since regex already handles boundaries)
                        if (!matchWholeWord && !matchExact) {
                            // Exact phrase bonus
                            if (title.includes(term)) score += 15;
                            if (description.includes(term)) score += 8;
                            if (body.includes(term)) score += 2;
                            
                            // Word boundary bonus
                            const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(term)}\\b`, matchCase ? 'g' : 'gi');
                            if (wordBoundaryRegex.test(title)) score += 5;
                            if (wordBoundaryRegex.test(description)) score += 3;
                            if (wordBoundaryRegex.test(body)) score += 1;
                        }
                    });
                    
                    // Bonus for exact match mode
                    if (matchExact && searchTerms.length === 1) {
                        const term = searchTerms[0];
                        if (title === term) score += 50;
                        if (description === term) score += 25;
                        if (body === term) score += 10;
                    }
                    
                    return {
                        ...article,
                        _searchScore: score,
                        _matches: matches
                    };
                })
                .filter(article => article._searchScore > 0)
                .sort((a, b) => b._searchScore - a._searchScore);
        }
        
            }
    
    return results;
}

// Helper function to strip HTML tags
function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
}

// Enhanced context extraction with better highlighting
function extractContext(text, terms, contextLength = 50) {
    if (!terms || terms.length === 0) {
        return text.substring(0, 200) + (text.length > 200 ? '...' : '');
    }
    
    const cleanTerms = terms
        .filter(term => term.length > 1)
        .sort((a, b) => b.length - a.length); // Prioritize longer terms
    
    if (cleanTerms.length === 0) {
        return text.substring(0, 200) + (text.length > 200 ? '...' : '');
    }
    
    // Find all matches with positions
    const allMatches = [];
    cleanTerms.forEach(term => {
        const regex = new RegExp(escapeRegExp(term), 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
            allMatches.push({
                term: term,
                index: match.index,
                length: match[0].length
            });
        }
    });
    
    if (allMatches.length === 0) {
        return text.substring(0, 200) + (text.length > 200 ? '...' : '');
    }
    
    // Sort matches by position
    allMatches.sort((a, b) => a.index - b.index);
    
    // Merge overlapping contexts
    const contexts = [];
    let current = {...allMatches[0]};
    
    for (let i = 1; i < allMatches.length; i++) {
        const next = allMatches[i];
        const currentEnd = current.index + contextLength * 2;
        
        if (next.index <= currentEnd) {
            // Overlapping, extend current context
            current = {
                ...current,
                index: Math.min(current.index, next.index - contextLength)
            };
        } else {
            // Non-overlapping, add current and start new
            contexts.push({
                start: Math.max(0, current.index - contextLength),
                end: Math.min(text.length, current.index + contextLength * 2),
                term: current.term
            });
            current = next;
        }
    }
    
    // Add the last context
    contexts.push({
        start: Math.max(0, current.index - contextLength),
        end: Math.min(text.length, current.index + contextLength * 2),
        term: current.term
    });
    
    // Build result with ellipsis between contexts
    let result = '';
    let lastEnd = 0;
    
    contexts.forEach((context, index) => {
        if (context.start > lastEnd) {
            result += ' ... ';
        } else if (index > 0) {
            result += ' ';
        }
        
        let contextText = text.substring(context.start, context.end);
        
        // Add ellipsis at boundaries
        if (context.start > 0) contextText = '...' + contextText;
        if (context.end < text.length) contextText = contextText + '...';
        
        result += contextText;
        lastEnd = context.end;
    });
    
    return result;
}

// Debounced search for better performance
const debouncedSearch = debounce(performSearch, 300);

function displayResults(articles, highlightQuery = '', preservePage = false) {
    resultCountElement.textContent = `${articles.length} article${articles.length !== 1 ? 's' : ''} found`;
    currentArticles = articles;
    
    if (articles.length === 0) {
        resultsContainer.innerHTML = '<div class="no-results">No articles found matching your search.</div>';
        paginationContainer.innerHTML = '';
        return;
    }
    
    // Reset to first page when displaying new results, unless preserving page
    if (!preservePage) {
        currentPage = 1;
    }
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
            // Get current search options for highlighting
            const matchCase = matchCaseCheckbox.checked;
            const matchExact = matchExactCheckbox.checked;
            const matchWholeWord = matchWholeWordCheckbox.checked;
            
            // Build search terms for highlighting based on options
            let highlightTerms;
            if (matchExact) {
                highlightTerms = [highlightQuery];
            } else {
                highlightTerms = highlightQuery.split(/\s+/).filter(term => term.length > 0);
            }
            
            highlightTerms.forEach(term => {
                // Build regex based on options
                let regexPattern;
                if (matchWholeWord) {
                    regexPattern = `\\b${escapeRegExp(term)}\\b`;
                } else {
                    regexPattern = escapeRegExp(term);
                }
                
                const flags = matchCase ? 'g' : 'gi';
                const regex = new RegExp(`(${regexPattern})`, flags);
                
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
        
        // Format date for display
        const formatDate = (dateString) => {
            const date = new Date(dateString);
            return date.toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            });
        };

        // Determine article type and badges
        const getArticleBadges = (article) => {
            const badges = [];
            const title = article.title.toLowerCase();
            
            if (title.includes('snapshot')) {
                badges.push('<span class="badge snapshot">Snapshot</span>');
            } else if (title.includes('preview') || title.includes('beta')) {
                badges.push('<span class="badge preview">Preview</span>');
            } else if (title.includes('hotfix')) {
                badges.push('<span class="badge hotfix">Hotfix</span>');
            }
            
            if (title.includes('java')) {
                badges.push('<span class="badge java">Java</span>');
            } else if (title.includes('bedrock')) {
                badges.push('<span class="badge bedrock">Bedrock</span>');
            }
            
                        
            return badges.join(' ');
        };

        return `
            <article class="article ${article._searchScore ? 'search-result' : ''}">
                <div class="article-header">
                    <h2>${title}</h2>
                </div>
                <p>${preview}</p>
                <div class="article-footer">
                    <a href="${article.url}" target="_blank" rel="noopener noreferrer">Read more</a>
                    <div class="article-meta-bottom">
                        <div class="article-dates">
                            <span class="date">Created: ${formatDate(article.created_at)}</span>
                            ${article.edited_at && article.edited_at !== article.created_at ? 
                                (() => {
                                    const updatedDate = new Date(article.edited_at);
                                    const createdDate = new Date(article.created_at);
                                    const daysSinceUpdate = Math.floor((updatedDate - createdDate) / (1000 * 60 * 60 * 24));
                                    const isRecentlyUpdated = daysSinceUpdate > 0 && daysSinceUpdate <= 7;
                                    return `<span class="edited ${isRecentlyUpdated ? 'recent' : ''}">${isRecentlyUpdated ? 'Recently updated' : 'Edited'}: ${formatDate(article.edited_at)}</span>`;
                                })() : ''}
                        </div>
                        <div class="article-badges">${getArticleBadges(article)}</div>
                    </div>
                </div>
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
                displayResults(currentArticles, '', true); // Re-render with the same articles but different page, preserving page
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', init);

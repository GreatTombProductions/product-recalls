// Product Recall Check — CPSC recall search
// Modes: product search (letter-sharded) + category browse

(function() {
    'use strict';

    let stats = null;
    let currentResults = [];
    let displayedCount = 0;
    const PAGE_SIZE = 25;
    let currentMode = 'search';
    let activeCategory = null;
    let loadedShards = {};  // cache loaded index shards
    let loadedCategories = {};  // cache loaded category data

    // --- Init ---

    async function init() {
        try {
            const resp = await fetch('data/stats.json');
            stats = await resp.json();
            renderStatsBar();
            renderYearlyChart();
            renderCountryChart();
            loadCategoryIndex();
        } catch (e) {
            document.getElementById('stats-bar').innerHTML =
                '<div class="loading">Failed to load data. Please try again.</div>';
        }

        // Search on enter
        document.getElementById('search-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') doSearch();
        });

        // Auto-focus search
        document.getElementById('search-input').focus();
    }

    // --- Stats bar ---

    function renderStatsBar() {
        const bar = document.getElementById('stats-bar');
        bar.innerHTML = `
            <div class="stat">
                <div class="stat-value">${stats.total_recalls.toLocaleString()}</div>
                <div class="stat-label">Total Recalls</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.recalls_with_injuries.toLocaleString()}</div>
                <div class="stat-label">With Injuries</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.recalls_with_deaths.toLocaleString()}</div>
                <div class="stat-label">With Deaths</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.date_range}</div>
                <div class="stat-label">Date Range</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.top_countries.length}</div>
                <div class="stat-label">Countries</div>
            </div>
        `;
    }

    // --- Yearly chart ---

    function renderYearlyChart() {
        const container = document.getElementById('yearly-chart');
        container.style.display = 'block';
        const barsEl = document.getElementById('chart-bars');
        const labelsEl = document.getElementById('chart-labels');

        // Filter to years with data, skip very sparse early years
        const years = stats.yearly_trends.filter(y => parseInt(y.year) >= 1980);
        const maxVal = Math.max(...years.map(y => y.total));

        barsEl.innerHTML = years.map(y => {
            const h = Math.max(2, (y.total / maxVal) * 100);
            return `<div class="chart-bar" style="height:${h}px" title="${y.year}: ${y.total} recalls">
                <div class="tooltip">${y.year}: ${y.total} recalls${y.deaths ? ', ' + y.deaths + ' deaths' : ''}</div>
            </div>`;
        }).join('');

        // Show labels every 10 years
        const labelYears = years.filter(y => parseInt(y.year) % 10 === 0);
        labelsEl.innerHTML = '';
        if (years.length > 0) {
            labelsEl.innerHTML = `<span>${years[0].year}</span>`;
            labelYears.forEach(y => {
                labelsEl.innerHTML += `<span>${y.year}</span>`;
            });
            labelsEl.innerHTML += `<span>${years[years.length - 1].year}</span>`;
        }
    }

    // --- Country chart ---

    function renderCountryChart() {
        const container = document.getElementById('country-chart');
        container.style.display = 'block';
        const barsEl = document.getElementById('country-bars');

        const countries = stats.top_countries.slice(0, 10);
        const maxVal = Math.max(...countries.map(c => c.count));

        barsEl.innerHTML = countries.map(c => {
            const pct = (c.count / maxVal) * 100;
            return `<div class="country-row">
                <div class="country-name">${c.country}</div>
                <div class="country-bar-wrap">
                    <div class="country-bar-fill" style="width:${pct}%"></div>
                </div>
                <div class="country-count">${c.count.toLocaleString()}</div>
            </div>`;
        }).join('');
    }

    // --- Category index ---

    async function loadCategoryIndex() {
        try {
            const resp = await fetch('data/categories/index.json');
            const cats = await resp.json();
            renderCategories(cats);
        } catch (e) {
            console.error('Failed to load categories:', e);
        }
    }

    function renderCategories(cats) {
        const grid = document.getElementById('categories-grid');
        grid.innerHTML = cats.map(c => `
            <div class="category-card" data-slug="${c.slug}" onclick="selectCategory('${c.slug}', '${c.name}')">
                <div class="cat-name">${c.name}</div>
                <div class="cat-stats">
                    ${c.count.toLocaleString()} recalls
                    ${c.injuries ? ' &middot; <span class="danger">' + c.injuries + ' with injuries</span>' : ''}
                    ${c.deaths ? ' &middot; <span class="danger">' + c.deaths + ' deaths</span>' : ''}
                </div>
            </div>
        `).join('');
    }

    // --- Mode switching ---

    window.switchMode = function(mode) {
        currentMode = mode;
        document.querySelectorAll('.mode-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.mode === mode);
        });
        document.getElementById('search-panel').classList.toggle('hidden', mode !== 'search');
        document.getElementById('browse-panel').classList.toggle('hidden', mode !== 'browse');

        if (mode === 'search') {
            document.getElementById('search-input').focus();
            // Clear category selection
            activeCategory = null;
            document.querySelectorAll('.category-card').forEach(c => c.classList.remove('active'));
        }

        // Hide results when switching
        document.getElementById('results-area').classList.add('hidden');
    };

    // --- Search ---

    window.doSearch = async function() {
        const query = document.getElementById('search-input').value.trim().toLowerCase();
        if (!query) return;

        const resultsArea = document.getElementById('results-area');
        const resultsList = document.getElementById('results-list');
        resultsArea.classList.remove('hidden');
        resultsList.innerHTML = '<div class="loading">Searching...</div>';

        try {
            // Determine which letter shards to load
            // We need to search across potentially all shards
            // Strategy: load ALL shards on first search (they're ~3MB total)
            const allRecalls = await loadAllShards();

            // Filter by query — match against name and hazard
            const queryTerms = query.split(/\s+/).filter(t => t.length > 1);
            const matches = allRecalls.filter(r => {
                const text = (r.name + ' ' + (r.hazard || '')).toLowerCase();
                return queryTerms.every(term => text.includes(term));
            });

            currentResults = matches;
            displayedCount = 0;
            renderResults();
        } catch (e) {
            resultsList.innerHTML = '<div class="no-results">Search failed. Please try again.</div>';
        }
    };

    async function loadAllShards() {
        // Check if we already have all shards cached
        if (loadedShards._all) return loadedShards._all;

        const letters = 'abcdefghijklmnopqrstuvwxyz_0123456789'.split('');
        const all = [];

        // Load in parallel batches
        const batchSize = 10;
        for (let i = 0; i < letters.length; i += batchSize) {
            const batch = letters.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(letter =>
                    fetch(`data/index/${letter}.json`)
                        .then(r => r.ok ? r.json() : [])
                        .catch(() => [])
                )
            );
            for (const r of results) {
                if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                    all.push(...r.value);
                }
            }
        }

        loadedShards._all = all;
        return all;
    }

    // --- Category browsing ---

    window.selectCategory = async function(slug, name) {
        activeCategory = slug;

        // Update UI
        document.querySelectorAll('.category-card').forEach(c => {
            c.classList.toggle('active', c.dataset.slug === slug);
        });

        const resultsArea = document.getElementById('results-area');
        const resultsList = document.getElementById('results-list');
        resultsArea.classList.remove('hidden');
        resultsList.innerHTML = '<div class="loading">Loading category...</div>';

        try {
            let data;
            if (loadedCategories[slug]) {
                data = loadedCategories[slug];
            } else {
                const resp = await fetch(`data/categories/${slug}.json`);
                data = await resp.json();
                loadedCategories[slug] = data;
            }

            currentResults = data;
            displayedCount = 0;
            renderResults();
        } catch (e) {
            resultsList.innerHTML = '<div class="no-results">Failed to load category.</div>';
        }
    };

    // --- Render results ---

    function renderResults() {
        const resultsList = document.getElementById('results-list');
        const countEl = document.getElementById('results-count');
        const loadMoreEl = document.getElementById('load-more');

        if (currentResults.length === 0) {
            resultsList.innerHTML = '<div class="no-results">No recalls found matching your search.</div>';
            countEl.textContent = '0 results';
            loadMoreEl.classList.add('hidden');
            return;
        }

        // Apply sort
        applySortToResults();

        countEl.textContent = `${currentResults.length.toLocaleString()} recalls found`;

        // Render page
        const end = Math.min(displayedCount + PAGE_SIZE, currentResults.length);
        const html = currentResults.slice(displayedCount, end).map(renderRecallCard).join('');

        if (displayedCount === 0) {
            resultsList.innerHTML = html;
        } else {
            resultsList.insertAdjacentHTML('beforeend', html);
        }

        displayedCount = end;
        loadMoreEl.classList.toggle('hidden', displayedCount >= currentResults.length);
    }

    function renderRecallCard(r) {
        const tags = [];

        if (r.deaths) tags.push('<span class="tag tag-death">Deaths reported</span>');
        else if (r.injuries) tags.push('<span class="tag tag-injury">Injuries reported</span>');

        if (r.countries) {
            r.countries.forEach(c => {
                if (c) tags.push(`<span class="tag tag-country">${escapeHtml(c)}</span>`);
            });
        }

        if (r.remedy_options) {
            r.remedy_options.forEach(ro => {
                if (ro) tags.push(`<span class="tag tag-remedy">${escapeHtml(ro)}</span>`);
            });
        }

        if (r.categories) {
            r.categories.slice(0, 2).forEach(cat => {
                tags.push(`<span class="tag tag-category">${escapeHtml(cat)}</span>`);
            });
        }

        return `
            <div class="recall-card" data-id="${escapeHtml(r.id)}" data-shard="${escapeHtml(r.s || '')}" onclick="toggleDetail(this)">
                <div class="recall-top">
                    <div class="recall-name">${escapeHtml(r.name)}</div>
                    <div class="recall-date">${formatDate(r.date)}</div>
                </div>
                ${r.hazard ? `<div class="recall-hazard">${escapeHtml(r.hazard)}</div>` : ''}
                <div class="recall-tags">${tags.join('')}</div>
                <div class="recall-detail" id="detail-${escapeHtml(r.id)}">
                    <div class="loading">Loading details...</div>
                </div>
            </div>
        `;
    }

    // --- Detail loading ---

    window.toggleDetail = async function(card) {
        const id = card.dataset.id;
        const shard = card.dataset.shard;  // pre-computed by pipeline
        const isExpanded = card.classList.contains('expanded');

        // Collapse all others
        document.querySelectorAll('.recall-card.expanded').forEach(c => {
            if (c !== card) c.classList.remove('expanded');
        });

        if (isExpanded) {
            card.classList.remove('expanded');
            return;
        }

        card.classList.add('expanded');

        // Load detail
        const detailEl = document.getElementById('detail-' + id);
        if (detailEl.dataset.loaded) return;

        try {
            const resp = await fetch(`data/detail/${shard}.json`);
            const shardData = await resp.json();
            const detail = shardData[id];

            if (detail) {
                detailEl.innerHTML = renderDetail(detail);
                detailEl.dataset.loaded = '1';
            } else {
                detailEl.innerHTML = '<div class="detail-text">Detail not found for this recall.</div>';
            }
        } catch (e) {
            detailEl.innerHTML = '<div class="detail-text">Failed to load details.</div>';
        }
    };

    function renderDetail(d) {
        let html = '';

        if (d.description) {
            html += `<div class="detail-section">
                <div class="detail-label">Description</div>
                <div class="detail-text">${escapeHtml(d.description)}</div>
            </div>`;
        }

        if (d.hazard) {
            html += `<div class="detail-section">
                <div class="detail-label">Hazard</div>
                <div class="detail-text">${escapeHtml(d.hazard)}</div>
            </div>`;
        }

        if (d.injury_text && !d.injury_text.toLowerCase().includes('none reported')) {
            html += `<div class="detail-section">
                <div class="detail-label">Injuries/Incidents</div>
                <div class="detail-text">${escapeHtml(d.injury_text)}</div>
            </div>`;
        }

        if (d.remedy) {
            html += `<div class="detail-section">
                <div class="detail-label">Remedy</div>
                <div class="detail-text">${escapeHtml(d.remedy)}</div>
            </div>`;
        }

        if (d.units) {
            html += `<div class="detail-section">
                <div class="detail-label">Units Affected</div>
                <div class="detail-text">${escapeHtml(d.units)}</div>
            </div>`;
        }

        if (d.retailers && d.retailers.length > 0) {
            html += `<div class="detail-section">
                <div class="detail-label">Sold At</div>
                <div class="detail-text">${d.retailers.map(escapeHtml).join('<br>')}</div>
            </div>`;
        }

        if (d.url) {
            html += `<a class="detail-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">
                View on CPSC.gov &rarr;
            </a>`;
        }

        if (d.images && d.images.length > 0) {
            html += `<div class="detail-images">
                ${d.images.map(url => `<img src="${escapeHtml(url)}" alt="Recalled product" loading="lazy">`).join('')}
            </div>`;
        }

        return html;
    }

    // --- Sort ---

    window.sortResults = function() {
        displayedCount = 0;
        document.getElementById('results-list').innerHTML = '';
        renderResults();
    };

    function applySortToResults() {
        const sort = document.getElementById('sort-select').value;
        switch (sort) {
            case 'date-desc':
                currentResults.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
                break;
            case 'date-asc':
                currentResults.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                break;
            case 'severity':
                currentResults.sort((a, b) => {
                    const sa = (a.deaths ? 2 : 0) + (a.injuries ? 1 : 0);
                    const sb = (b.deaths ? 2 : 0) + (b.injuries ? 1 : 0);
                    return sb - sa || (b.date || '').localeCompare(a.date || '');
                });
                break;
        }
    }

    window.loadMore = function() {
        renderResults();
    };

    // --- Utilities ---

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatDate(d) {
        if (!d) return '';
        const parts = d.split('-');
        if (parts.length !== 3) return d;
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[parseInt(parts[1]) - 1]} ${parseInt(parts[2])}, ${parts[0]}`;
    }

    // --- Start ---
    init();
})();

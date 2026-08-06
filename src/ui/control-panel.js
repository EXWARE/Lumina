const ipcRenderer = window.electron;

// Fix: Force full DOM repaint when window is restored after Show Desktop / Alt+Tab.
// The transparent Electron window can visually freeze due to Windows DWM compositor
// losing the backing store. Forcing display none → reflow → display resets it.
ipcRenderer.on('window-focused', () => {
    document.body.style.display = 'none';
    // eslint-disable-next-line no-unused-expressions
    document.body.offsetHeight; // force reflow
    document.body.style.display = '';
});

// Also handle browser-native visibility change (Win+D / Alt+Tab)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // The DWM texture is frozen, but JS still runs. Tell the Main process to forcefully redraw the window.
        ipcRenderer.send('fix-dwm-freeze');
    }
});

// DOM Elements
const winMinBtn = document.getElementById('btn-minimize');
const winCloseBtn = document.getElementById('btn-close');
const navButtons = document.querySelectorAll('.nav-btn');
const tabContents = document.querySelectorAll('.tab-content');
const libraryGrid = document.getElementById('library-grid');
const discoverGrid = document.getElementById('discover-grid');
const addWallpaperBtn = document.getElementById('btn-add-wallpaper');
const searchInput = document.getElementById('discover-search');
const categoriesBar = document.getElementById('categories-bar');


// Settings Elements
const autoPauseToggle = document.getElementById('set-autopause');
const pauseBatteryToggle = document.getElementById('set-pause-battery');
const pauseLockToggle = document.getElementById('set-pause-lock');
const taskbarStyleSelect = document.getElementById('set-taskbar-style');
const volumeSlider = document.getElementById('set-volume');
const volumeIndicator = document.getElementById('volume-indicator');
const startWindowsToggle = document.getElementById('set-start-windows');
const slideshowToggle = document.getElementById('set-slideshow-enabled');
const slideshowIntervalSelect = document.getElementById('set-slideshow-interval');

const btnImportRmskin = document.getElementById('btn-import-rmskin');
const importedSkinsContainer = document.getElementById('imported-skins-container');

// App Config (module-scoped)
let config = {};
try {
    const fetchedConfig = ipcRenderer.sendSync('get-config');
    if (fetchedConfig) {
        config = fetchedConfig;
        if (autoPauseToggle) autoPauseToggle.checked = config.autoPause;
        if (pauseBatteryToggle) pauseBatteryToggle.checked = config.pauseOnBattery;
        if (pauseLockToggle) pauseLockToggle.checked = config.pauseOnLock;
        if (taskbarStyleSelect) taskbarStyleSelect.value = config.taskbarStyle;
        if (startWindowsToggle) startWindowsToggle.checked = config.startWithWindows || false;
        if (slideshowToggle) slideshowToggle.checked = config.slideshowEnabled || false;
        if (slideshowIntervalSelect) slideshowIntervalSelect.value = config.slideshowInterval || 300;
        const setSlideshowModeSelect = document.getElementById('set-slideshow-mode');
        if (setSlideshowModeSelect) {
            setSlideshowModeSelect.value = config.slideshowSelectedOnly ? 'selected' : 'all';
            setSlideshowModeSelect.addEventListener('change', (e) => {
                const isSelectedOnly = e.target.value === 'selected';
                config.slideshowSelectedOnly = isSelectedOnly;
                ipcRenderer.send('set-slideshow-selected-only', isSelectedOnly);
            });
        }
        
        if (volumeSlider && volumeIndicator) {
            volumeSlider.value = config.volume;
            volumeIndicator.textContent = config.volume == 0 ? 'Muted' : `${config.volume}%`;
        }
    }
} catch (e) {
    console.error('Failed to load settings config', e);
}

try {
    const version = ipcRenderer.sendSync('get-version');
    if (version) {
        document.getElementById('app-version-display').textContent = `v${version}`;
    }
} catch (e) {
    console.error('Failed to load version', e);
}

// App State
let library = [];
let activeCategory = '4k';
let currentSearchQuery = '';
let currentDiscoverPage = 1;
let basePaginationUrl = '';
let paginationType = 'path'; // 'path' (/X/) or 'param' (page=X)
let paginationQuerySuffix = '';
let _discoverAbortController = null;
let _discoverLoaded = false; // Track if discover has been loaded at least once
let isLoadingDiscover = false;

// Multi-Source Config
const SOURCES = {
    motionbgs: {
        name: 'Server 1',
        searchPlaceholder: 'Search Server 1...',
        categories: [
            { label: 'All 4K', value: '4k' },
            { label: 'Anime', value: 'anime' },
            { label: 'Games', value: 'games' },
            { label: 'Superhero', value: 'superhero' },
            { label: 'Nature', value: 'nature' },
            { label: 'Cars', value: 'car' },
            { label: 'Movies & TV', value: 'tv' },
            { label: 'Fantasy', value: 'fantasy' },
            { label: 'Space', value: 'space' },
            { label: 'Horror', value: 'horror' },
            { label: 'Animals', value: 'animal' },
            { label: 'Technology', value: 'technology' }
        ]
    },
    wallpaperwaves: {
        name: 'Server 2',
        searchPlaceholder: 'Search Server 2...',
        categories: [
            { label: 'All 4K', value: '3840x2160' },
            { label: 'Anime', value: 'anime' },
            { label: 'Games', value: 'games' },
            { label: 'Fantasy', value: 'fantasy' },
            { label: 'Abstract', value: 'abstract' },
            { label: 'Landscape', value: 'landscape' },
            { label: 'Pixel Art', value: 'pixel-art' },
            { label: 'Sci-Fi', value: 'sci-fi' },
            { label: 'Animals', value: 'animal' },
            { label: 'Cartoons', value: 'cartoon' },
            { label: 'TV & Movies', value: 'tv-movies' },
            { label: 'Vehicles', value: 'vehicle' },
            { label: 'Memes', value: 'memes' },
            { label: 'Retro', value: 'retro' }
        ]
    },
    desktophut: {
        name: 'Server 3',
        searchPlaceholder: 'Search Server 3...',
        categories: [
            { label: 'All 4K', value: 'all' },
            { label: 'Anime', value: 'anime-live-wallpapers' },
            { label: 'Games', value: 'games-live-wallpapers' },
            { label: 'Sci-Fi & Fantasy', value: 'fantasy-sci-fi-live-wallpapers' },
            { label: 'Abstract', value: 'abstract-live-wallpapers' },
            { label: 'Animals', value: 'animals-live-wallpapers' },
            { label: 'Landscape', value: 'landscape-live-wallpapers' },
            { label: 'Movies & TV', value: 'movies-tv-live-wallpapers' },
            { label: 'Pixel Art', value: 'pixel-art-live-wallpapers' },
            { label: 'Cars & Bikes', value: 'cars-motorcycles-live-wallpapers' },
            { label: 'Lofi', value: 'Lofi' },
            { label: 'Nature', value: 'nature-live-wallpapers' },
            { label: 'Technology', value: 'tech-live-wallpapers' },
            { label: '3D Animation', value: '3d-animation-live-wallpapers' },
            { label: 'Comics', value: 'comics-live-wallpapers' }
        ]
    }
};
let activeSource = 'motionbgs';

// --- Window Controls ---
if (winMinBtn) winMinBtn.addEventListener('click', () => ipcRenderer.send('window-control', 'minimize'));
if (winCloseBtn) winCloseBtn.addEventListener('click', () => ipcRenderer.send('window-control', 'close'));
const winMaxBtn = document.getElementById('btn-maximize');
if (winMaxBtn) {
    winMaxBtn.addEventListener('click', () => ipcRenderer.send('window-control', 'maximize'));
}

// --- Tab Navigation ---
navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const tabName = btn.getAttribute('data-tab');
        
        navButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        tabContents.forEach(tab => {
            tab.classList.remove('active');
            if (tab.id === tabName) {
                tab.classList.add('active');
            }
        });

        // Trigger load when switching tabs
        if (tabName === 'discover') {
            if (!_discoverLoaded) {
                _discoverLoaded = true;
                loadDiscoverFeed();
            }
        } else if (tabName === 'library') {
            loadLibrary();
        }
    });
});

// --- Settings Event Listeners ---
if (slideshowToggle) {
    slideshowToggle.addEventListener('change', () => {
        ipcRenderer.send('set-slideshow-enabled', slideshowToggle.checked);
    });
}

if (slideshowIntervalSelect) {
    slideshowIntervalSelect.addEventListener('change', () => {
        ipcRenderer.send('set-slideshow-interval', parseInt(slideshowIntervalSelect.value, 10));
    });
}

ipcRenderer.on('active-wallpaper-changed', (event, newWp) => {
    console.log(`[Renderer]: Slideshow active wallpaper changed: ${newWp.name}`);
    loadLibrary(); // Refresh grid border status
});

if (startWindowsToggle) {
    startWindowsToggle.addEventListener('change', () => {
        ipcRenderer.send('set-start-with-windows', startWindowsToggle.checked);
    });
}

if (autoPauseToggle) {
    autoPauseToggle.addEventListener('change', () => {
        ipcRenderer.send('set-autopause', autoPauseToggle.checked);
    });
}

if (pauseBatteryToggle) {
    pauseBatteryToggle.addEventListener('change', () => {
        ipcRenderer.send('set-pause-on-battery', pauseBatteryToggle.checked);
    });
}

if (pauseLockToggle) {
    pauseLockToggle.addEventListener('change', () => {
        ipcRenderer.send('set-pause-on-lock', pauseLockToggle.checked);
    });
}

if (taskbarStyleSelect) {
    taskbarStyleSelect.addEventListener('change', () => {
        ipcRenderer.send('set-taskbar-style', taskbarStyleSelect.value);
    });
}

if (btnImportRmskin) {
    btnImportRmskin.addEventListener('click', async () => {
        const btnOldHtml = btnImportRmskin.innerHTML;
        btnImportRmskin.innerText = 'Importing...';
        btnImportRmskin.disabled = true;
        
        try {
            const success = await ipcRenderer.invoke('import-rmskin');
            if (success) {
                if (window.loadInstalledSkins) window.loadInstalledSkins();
            }
        } catch(e) {
            console.error(e);
            alert('Failed to import skin.');
        } finally {
            btnImportRmskin.innerHTML = btnOldHtml;
            btnImportRmskin.disabled = false;
        }
    });
}


if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
        const val = volumeSlider.value;
        if (volumeIndicator) volumeIndicator.textContent = val == 0 ? 'Muted' : `${val}%`;
        ipcRenderer.send('set-volume', parseInt(val, 10));
    });
}

// --- Local Library ---
let currentLibrarySearchQuery = '';

async function loadLibrary() {
    library = await ipcRenderer.invoke('get-library');
    libraryGrid.innerHTML = '';
    
    const filtered = library.filter(w => {
        if (!currentLibrarySearchQuery) return true;
        return w.name.toLowerCase().includes(currentLibrarySearchQuery.toLowerCase());
    });
    
    if (filtered.length === 0) {
        libraryGrid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                <p style="margin-bottom: 15px;">${currentLibrarySearchQuery ? 'No matching wallpapers found.' : 'Your library is empty.'}</p>
                <p style="font-size: 13px;">${currentLibrarySearchQuery ? 'Try a different search query!' : 'Add your own videos/images, or download from the "Discover" tab!'}</p>
            </div>
        `;
        return;
    }
    
    filtered.forEach(wallpaper => {
        const card = createWallpaperCard(wallpaper, false);
        libraryGrid.appendChild(card);
    });
}

const librarySearchInput = document.getElementById('library-search');
if (librarySearchInput) {
    librarySearchInput.addEventListener('input', () => {
        currentLibrarySearchQuery = librarySearchInput.value.trim();
        loadLibrary();
    });
}

const addUrlBtn = document.getElementById('btn-add-url');
const promptModal = document.getElementById('prompt-modal');
const promptNameInput = document.getElementById('prompt-name-input');
const promptUrlInput = document.getElementById('prompt-url-input');
const promptCancelBtn = document.getElementById('prompt-cancel');
const promptOkBtn = document.getElementById('prompt-ok');
let promptResolver = null;

function showPromptDialog() {
    return new Promise((resolve) => {
        if (!promptModal) {
            resolve(null);
            return;
        }
        if (promptNameInput) promptNameInput.value = '';
        if (promptUrlInput) promptUrlInput.value = '';
        promptResolver = resolve;
        promptModal.classList.add('active');
    });
}

if (promptCancelBtn) {
    promptCancelBtn.addEventListener('click', () => {
        if (promptModal) promptModal.classList.remove('active');
        if (promptResolver) {
            promptResolver(null);
            promptResolver = null;
        }
    });
}

if (promptOkBtn) {
    promptOkBtn.addEventListener('click', () => {
        const name = promptNameInput ? promptNameInput.value.trim() : '';
        const url = promptUrlInput ? promptUrlInput.value.trim() : '';
        if (!url) {
            alert('URL is required!');
            return;
        }
        if (promptModal) promptModal.classList.remove('active');
        if (promptResolver) {
            promptResolver({ name, url });
            promptResolver = null;
        }
    });
}

if (promptModal) {
    promptModal.addEventListener('click', (e) => {
        if (e.target === promptModal) {
            promptModal.classList.remove('active');
            if (promptResolver) {
                promptResolver(null);
                promptResolver = null;
            }
        }
    });
}

if (addUrlBtn) {
    addUrlBtn.addEventListener('click', async () => {
        const result = await showPromptDialog();
        if (result) {
            const res = await ipcRenderer.invoke('add-url-wallpaper', result);
            if (res && res.success) {
                loadLibrary();
                ipcRenderer.send('apply-wallpaper', res.wallpaper);
            } else {
                alert('Failed to add URL wallpaper: ' + (res.error || 'Unknown error'));
            }
        }
    });
}

if (addWallpaperBtn) addWallpaperBtn.addEventListener('click', async () => {
    const wallpaper = await ipcRenderer.invoke('select-file');
    if (wallpaper) {
        // Automatically apply the new wallpaper
        ipcRenderer.send('apply-wallpaper', wallpaper);
        loadLibrary();
    }
});

// --- Discover Feed Scraper ---
function getUrlForPage(pageNum) {
    if (activeSource === 'motionbgs') {
        if (pageNum === 1) {
            if (currentSearchQuery) {
                return `https://motionbgs.com/search?q=${encodeURIComponent(currentSearchQuery)}`;
            } else if (activeCategory && activeCategory !== '4k') {
                return `https://motionbgs.com/tag:${activeCategory}/`;
            }
            return 'https://motionbgs.com/4k/';
        }
        
        if (paginationType === 'param') {
            return `${basePaginationUrl}page=${pageNum}${paginationQuerySuffix}`;
        } else if (paginationType === 'param_p') {
            return `${basePaginationUrl}p=${pageNum}${paginationQuerySuffix}`;
        } else if (paginationType === 'path_query') {
            return `${basePaginationUrl}/${pageNum}/${paginationQuerySuffix}`;
        } else {
            return `${basePaginationUrl}/${pageNum}/`;
        }
    } else if (activeSource === 'wallpaperwaves') {
        if (pageNum === 1) {
            if (currentSearchQuery) {
                return `https://wallpaperwaves.com/?s=${encodeURIComponent(currentSearchQuery)}`;
            } else if (activeCategory) {
                return `https://wallpaperwaves.com/category/${activeCategory}/`;
            }
            return 'https://wallpaperwaves.com/category/3840x2160/';
        } else {
            if (currentSearchQuery) {
                return `https://wallpaperwaves.com/page/${pageNum}/?s=${encodeURIComponent(currentSearchQuery)}`;
            } else if (activeCategory) {
                return `https://wallpaperwaves.com/category/${activeCategory}/page/${pageNum}/`;
            }
            return `https://wallpaperwaves.com/category/3840x2160/page/${pageNum}/`;
        }
    } else { // activeSource === 'desktophut'
        if (currentSearchQuery) {
            return pageNum === 1
                ? `https://www.desktophut.com/search?q=${encodeURIComponent(currentSearchQuery)}`
                : `https://www.desktophut.com/search?q=${encodeURIComponent(currentSearchQuery)}&page=${pageNum}`;
        } else if (activeCategory && activeCategory !== 'all') {
            return pageNum === 1
                ? `https://www.desktophut.com/category/${activeCategory}`
                : `https://www.desktophut.com/category/${activeCategory}?page=${pageNum}`;
        } else {
            return pageNum === 1
                ? 'https://www.desktophut.com/'
                : `https://www.desktophut.com/?page=${pageNum}`;
        }
    }
}

async function loadDiscoverFeed() {
    if (isLoadingDiscover) return;
    isLoadingDiscover = true;
    
    if (_discoverAbortController) {
        _discoverAbortController.abort();
    }
    _discoverAbortController = new AbortController();
    const signal = _discoverAbortController.signal;
    
    discoverGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
            <div class="logo-glow" style="margin: 0 auto 15px auto;"></div>
            <p>Fetching latest wallpapers from ${SOURCES[activeSource].name}...</p>
        </div>
    `;
    
    const paginationContainer = document.getElementById('discover-pagination');
    if (paginationContainer) paginationContainer.style.display = 'none';

    let url = getUrlForPage(currentDiscoverPage);

    try {
        const response = await fetch(url, {
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const html = await response.text();
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        let wallpapers = [];
        let nextLinkEl = null;

        if (activeSource === 'motionbgs') {
            const cards = doc.querySelectorAll('.tmb a');
            cards.forEach(a => {
                const img = a.querySelector('img');
                const ttl = a.querySelector('.ttl');
                if (!img) return;
                
                const slug = a.getAttribute('href');
                let thumb = img.getAttribute('src');
                if (thumb && thumb.startsWith('/')) {
                    thumb = 'https://motionbgs.com' + thumb;
                }
                const title = ttl ? ttl.textContent.trim().replace(' 4K', '').replace(' HD', '') : 'Live Wallpaper';
                
                wallpapers.push({
                    name: title,
                    slug: slug,
                    thumbnail: thumb,
                    type: 'video',
                    local: false
                });
            });
            nextLinkEl = Array.from(doc.querySelectorAll('a')).find(el => el.textContent.toLowerCase().includes('next'));
        } else if (activeSource === 'wallpaperwaves') {
            const cards = doc.querySelectorAll('.jeg_post');
            cards.forEach(item => {
                const titleEl = item.querySelector('.jeg_post_title a');
                const imgEl = item.querySelector('.jeg_thumb img');
                const linkEl = item.querySelector('.jeg_thumb a');
                
                if (titleEl && imgEl && linkEl) {
                    const detailUrl = linkEl.getAttribute('href');
                    const name = titleEl.textContent.trim().replace(' Live Wallpaper', '');
                    const thumb = imgEl.getAttribute('src');
                    
                    wallpapers.push({
                        name: name,
                        slug: detailUrl, // full page URL
                        thumbnail: thumb,
                        type: 'video',
                        local: false
                    });
                }
            });
            nextLinkEl = doc.querySelector('.page_nav.next') || doc.querySelector('.next');
        } else { // desktophut
            const cards = doc.querySelectorAll('.wallpaper-card');
            cards.forEach(a => {
                const img = a.querySelector('img');
                const titleEl = a.querySelector('.card-title');
                if (!img) return;

                let href = a.getAttribute('href');
                if (href && href.startsWith('/')) {
                    href = 'https://www.desktophut.com' + href;
                }
                let thumb = img.getAttribute('src');
                if (thumb && thumb.startsWith('/')) {
                    thumb = 'https://www.desktophut.com' + thumb;
                }
                const title = titleEl 
                    ? titleEl.textContent.trim() 
                    : (a.getAttribute('title') || img.getAttribute('alt') || 'Live Wallpaper').replace(/ - Free Live Wallpaper.*/i, '').trim();

                wallpapers.push({
                    name: title,
                    slug: href,
                    thumbnail: thumb,
                    type: 'video',
                    local: false
                });
            });
            nextLinkEl = doc.querySelector('a.dh-pager-btn[rel="next"]') || doc.querySelector('a[rel="next"]');
        }
        
        discoverGrid.innerHTML = '';
        
        if (wallpapers.length === 0) {
            discoverGrid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                    <p>No wallpapers found for this category or search.</p>
                </div>
            `;
            return;
        }

        wallpapers.forEach(wp => {
            const card = createWallpaperCard(wp, true);
            discoverGrid.appendChild(card);
        });

        // 1. Check if there is a next page
        const hasMore = !!nextLinkEl;
        
        let maxPageNumber = currentDiscoverPage;
        if (hasMore) {
            maxPageNumber = currentDiscoverPage + 1;
            Array.from(doc.querySelectorAll('a')).forEach(link => {
                const num = parseInt(link.textContent.trim(), 10);
                if (!isNaN(num) && num > maxPageNumber && num < currentDiscoverPage + 100) {
                    maxPageNumber = num;
                }
            });
            
            // Check for JNews page info text: "Page X of Y"
            const pageInfo = doc.querySelector('.page_info');
            if (pageInfo) {
                const pageMatch = pageInfo.textContent.match(/of\s+(\d+)/i);
                if (pageMatch && pageMatch[1]) {
                    const totalPages = parseInt(pageMatch[1], 10);
                    if (!isNaN(totalPages) && totalPages > maxPageNumber) {
                        maxPageNumber = totalPages;
                    }
                }
            }
        }

        // 2. Parse pagination pattern on the first page (only needed for MotionBGs)
        if (activeSource === 'motionbgs' && currentDiscoverPage === 1 && hasMore) {
            let nextHref = nextLinkEl.getAttribute('href');
            if (nextHref) {
                if (nextHref.startsWith('/')) {
                    nextHref = 'https://motionbgs.com' + nextHref;
                }
                
                if (nextHref.includes('page=2')) {
                    paginationType = 'param';
                    basePaginationUrl = nextHref.replace('page=2', '');
                    paginationQuerySuffix = '';
                } else if (nextHref.includes('p=2')) {
                    paginationType = 'param_p';
                    basePaginationUrl = nextHref.replace('p=2', '');
                    paginationQuerySuffix = '';
                } else if (nextHref.includes('/2/?')) {
                    paginationType = 'path_query';
                    const parts = nextHref.split('/2/?');
                    basePaginationUrl = parts[0];
                    paginationQuerySuffix = parts[1] ? '?' + parts[1] : '';
                } else {
                    paginationType = 'path';
                    basePaginationUrl = nextHref.replace('/2/', '');
                }
                console.log(`[Discover Scraper]: Detected pagination type '${paginationType}' with base: ${basePaginationUrl}`);
            }
        }

        // 3. Render numbered pagination bar
        renderPagination(hasMore, maxPageNumber);
        
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('Scraping error:', e);
        discoverGrid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #ef4444;">
                <p>Failed to load wallpapers. Please check your internet connection.</p>
                <button class="add-btn" style="margin: 15px auto 0 auto;" onclick="loadDiscoverFeed()">Retry</button>
            </div>
        `;
    } finally {
        isLoadingDiscover = false;
    }
}

function renderPagination(hasMore, maxPageNumber = null) {
    const container = document.getElementById('discover-pagination');
    if (!container) return;
    
    container.innerHTML = '';
    
    // If we are on page 1 and there is no next page, hide the pagination bar
    if (currentDiscoverPage === 1 && !hasMore) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'flex';
    
    // 1. Previous page button
    const prevBtn = document.createElement('div');
    prevBtn.className = `page-btn ${currentDiscoverPage === 1 ? 'disabled' : ''}`;
    prevBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
    `;
    prevBtn.addEventListener('click', () => {
        if (currentDiscoverPage > 1) {
            changeDiscoverPage(currentDiscoverPage - 1);
        }
    });
    container.appendChild(prevBtn);
    
    // 2. Numbered buttons (always show 5 buttons max, centered around the current page)
    const startPage = Math.max(1, currentDiscoverPage - 2);
    let endPage = startPage + 4;
    
    if (maxPageNumber && endPage > maxPageNumber) {
        endPage = maxPageNumber;
    }
    
    for (let i = startPage; i <= endPage; i++) {
        // If there's no more next pages, don't render page numbers higher than current page
        if (!hasMore && i > currentDiscoverPage) {
            continue;
        }
        
        const numBtn = document.createElement('div');
        numBtn.className = `page-btn ${i === currentDiscoverPage ? 'active' : ''}`;
        numBtn.textContent = i;
        numBtn.addEventListener('click', () => {
            if (i !== currentDiscoverPage) {
                changeDiscoverPage(i);
            }
        });
        container.appendChild(numBtn);
    }
    
    // 3. Next page button
    const nextBtn = document.createElement('div');
    nextBtn.className = `page-btn ${!hasMore ? 'disabled' : ''}`;
    nextBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
    `;
    nextBtn.addEventListener('click', () => {
        if (hasMore) {
            changeDiscoverPage(currentDiscoverPage + 1);
        }
    });
    container.appendChild(nextBtn);
}

function changeDiscoverPage(pageNum) {
    currentDiscoverPage = pageNum;
    loadDiscoverFeed();
}

// Search Handler
let searchTimeout;
if (searchInput) searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        currentSearchQuery = searchInput.value.trim();
        currentDiscoverPage = 1; // Reset page to 1 on new search
        document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
        basePaginationUrl = '';
        paginationType = 'path';
        _discoverLoaded = true;
        loadDiscoverFeed();
    }, 500); // Debounce search input
});

// Dynamic Category Rendering Function
function renderCategoryTags() {
    if (!categoriesBar) return;
    categoriesBar.innerHTML = '';
    
    const sourceConfig = SOURCES[activeSource];
    sourceConfig.categories.forEach((cat, idx) => {
        const tag = document.createElement('div');
        tag.className = 'category-tag' + (cat.value === activeCategory ? ' active' : '');
        tag.dataset.tag = cat.value;
        tag.textContent = cat.label;
        
        tag.addEventListener('click', () => {
            if (isLoadingDiscover) return;
            
            document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
            tag.classList.add('active');
            
            activeCategory = cat.value;
            currentSearchQuery = '';
            if (searchInput) searchInput.value = '';
            currentDiscoverPage = 1; // Reset page to 1 on tag switch
            basePaginationUrl = '';
            paginationType = 'path';
            
            _discoverLoaded = false;
            loadDiscoverFeed();
        });
        categoriesBar.appendChild(tag);
    });
}

// Source Switcher Click Handlers
const sourceButtons = document.querySelectorAll('.source-btn');
sourceButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (isLoadingDiscover) return;
        
        const src = btn.getAttribute('data-source');
        if (src === activeSource) return;
        
        sourceButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        activeSource = src;
        
        // Reset state for new source
        activeCategory = SOURCES[activeSource].categories[0].value;
        currentSearchQuery = '';
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = SOURCES[activeSource].searchPlaceholder;
        }
        currentDiscoverPage = 1;
        basePaginationUrl = '';
        paginationType = 'path';
        
        renderCategoryTags();
        _discoverLoaded = false;
        loadDiscoverFeed();
    });
});


// --- Thumbnail Cache ---
// Stores base64 JPEG thumbnails in localStorage keyed by video path.
// Cache key format: "thumb_cache:<videoPath>"
const THUMB_CACHE_PREFIX = 'thumb_cache:';

function getCachedThumbnail(videoPath) {
    try {
        return localStorage.getItem(THUMB_CACHE_PREFIX + videoPath) || null;
    } catch (e) {
        return null;
    }
}

function setCachedThumbnail(videoPath, dataUrl) {
    try {
        localStorage.setItem(THUMB_CACHE_PREFIX + videoPath, dataUrl);
    } catch (e) {
        // localStorage quota exceeded — silently ignore, will re-generate next time
        console.warn('[Thumb Cache]: Could not save thumbnail to localStorage:', e.message);
    }
}

// Concurrency limiter — max 3 video decode jobs at a time to avoid GPU thrashing
const MAX_THUMB_CONCURRENCY = 3;
let _thumbActiveCount = 0;
const _thumbQueue = [];

function _runThumbQueue() {
    while (_thumbActiveCount < MAX_THUMB_CONCURRENCY && _thumbQueue.length > 0) {
        const { videoPath, resolve } = _thumbQueue.shift();
        _thumbActiveCount++;
        _generateVideoThumbnailRaw(videoPath).then(result => {
            _thumbActiveCount--;
            _runThumbQueue();
            resolve(result);
        });
    }
}

// Public API — returns cached thumbnail instantly or queues a decode job
function generateVideoThumbnail(videoPath) {
    const cached = getCachedThumbnail(videoPath);
    if (cached) {
        return Promise.resolve(cached);
    }

    return new Promise((resolve) => {
        _thumbQueue.push({ videoPath, resolve });
        _runThumbQueue();
    });
}

// Internal: actually decodes a video frame (called from queue runner)
function _generateVideoThumbnailRaw(videoPath) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.style.position = 'fixed';
        video.style.left = '-9999px';
        video.style.top = '-9999px';
        video.style.width = '100px';
        video.style.height = '100px';
        video.style.opacity = '0';
        document.body.appendChild(video);
        
        let formattedPath = videoPath.replace(/\\/g, '/');
        if (!formattedPath.startsWith('file:///')) {
            formattedPath = 'file:///' + formattedPath;
        }
        video.src = formattedPath;
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.playsInline = true;
        
        let resolved = false;
        let timeoutId;
        
        const done = (result) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);
            video.pause();
            video.src = '';
            try { video.load(); } catch(e) {}
            video.remove();
            // Cache successful frames only (not the placeholder fallback)
            if (result && result.startsWith('data:')) {
                setCachedThumbnail(videoPath, result);
            }
            resolve(result);
        };
        
        video.addEventListener('loadedmetadata', () => {
            video.currentTime = Math.min(3, video.duration / 2 || 1);
        });
        
        video.addEventListener('seeked', () => {
            setTimeout(() => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = 364;
                    canvas.height = 205;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                    done(dataUrl);
                } catch (e) {
                    console.error("Failed to render video thumbnail frame:", e);
                    done('assets/video-thumbnail.jpg');
                }
            }, 150);
        });
        
        video.addEventListener('error', (e) => {
            if (video.src) {
                console.error("Video element error loading local thumbnail. Code:", video.error ? video.error.code : 'no-code', "Msg:", video.error ? video.error.message : 'no-msg');
            }
            done('assets/video-thumbnail.jpg');
        });
        
        // Timeout safeguard — give up after 5s
        timeoutId = setTimeout(() => {
            done('assets/video-thumbnail.jpg');
        }, 5000);
    });
}

// --- Preview Modal Logic ---
const previewModal = document.getElementById('preview-modal');
const previewCloseBtn = document.getElementById('preview-close');
const previewVideo = document.getElementById('preview-video');
const previewTitle = document.getElementById('preview-title');
const previewLoader = document.getElementById('preview-loader');

async function showPreviewModal(wallpaper) {
    if (!previewModal) return;
    
    previewModal.classList.add('active');
    previewLoader.style.display = 'flex';
    previewLoader.innerHTML = `
        <div class="logo-glow"></div>
        <span>Resolving preview stream...</span>
    `;
    previewTitle.textContent = wallpaper.name;
    previewVideo.src = '';
    
    try {
        // Fetch details page to get download URL (which is also the direct video stream URL)
        const detailUrl = wallpaper.slug.startsWith('http') 
            ? wallpaper.slug 
            : 'https://motionbgs.com' + wallpaper.slug;
            
        const response = await fetch(detailUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const html = await response.text();
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        let previewUrl = '';
        if (activeSource === 'motionbgs') {
            const dlLink = doc.querySelector('a[href*="/dl/4k/"]') || doc.querySelector('a[href*="/dl/hd/"]');
            if (!dlLink) {
                throw new Error("Could not find video preview link.");
            }
            previewUrl = dlLink.getAttribute('href');
            if (previewUrl.startsWith('/')) {
                previewUrl = 'https://motionbgs.com' + previewUrl;
            }
        } else if (activeSource === 'wallpaperwaves') {
            const sourceEl = doc.querySelector('video source');
            if (!sourceEl) {
                throw new Error("Could not find video preview link on Wallpaper Waves page.");
            }
            previewUrl = sourceEl.getAttribute('src');
        } else { // desktophut
            const videoPreview = doc.querySelector('video.card-preview-video') || doc.querySelector('video source') || doc.querySelector('#primaryDownloadBtn') || doc.querySelector('a[href*=".mp4"]');
            if (videoPreview) {
                previewUrl = videoPreview.getAttribute('data-src') || videoPreview.getAttribute('src') || videoPreview.getAttribute('href');
                if (previewUrl && previewUrl.startsWith('/')) {
                    previewUrl = 'https://www.desktophut.com' + previewUrl;
                }
            }
            if (!previewUrl) {
                throw new Error("Could not find video preview link on DesktopHut page.");
            }
        }
        
        previewVideo.src = previewUrl;
        previewVideo.load();
        previewVideo.play().catch(e => console.error("Preview play failed:", e));
        
        previewVideo.addEventListener('playing', () => {
            previewLoader.style.display = 'none';
        }, { once: true });
        
    } catch (err) {
        console.error("Preview failed:", err);
        previewLoader.innerHTML = `
            <div style="color: #ef4444; text-align: center; padding: 20px;">
                <p>Failed to load preview.</p>
                <p style="font-size:12px; margin-top:5px;">${err.message}</p>
            </div>
        `;
    }
}

function closePreviewModal() {
    if (!previewModal) return;
    previewModal.classList.remove('active');
    previewVideo.pause();
    previewVideo.src = '';
}

if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', closePreviewModal);
}
if (previewModal) {
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            closePreviewModal();
        }
    });
}

// --- Custom Confirmation Dialog Logic ---
let confirmResolver = null;

function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const msgEl = document.getElementById('confirm-message');
        
        if (!modal) {
            resolve(false);
            return;
        }
        
        modal.querySelector('.confirm-title').textContent = title;
        msgEl.textContent = message;
        
        // Save resolver callback globally
        confirmResolver = resolve;
        
        modal.classList.add('active');
    });
}

// --- Helper Card Generator ---
function createWallpaperCard(wallpaper, isDiscover = false) {
    const card = document.createElement('div');
    card.className = 'card';
    
    // Thumbnail source logic
    let thumbSrc = 'assets/fallback.jpg';
    let isLocalVideo = false;
    if (wallpaper.local) {
        if (wallpaper.type === 'video') {
            thumbSrc = 'assets/video-thumbnail.jpg'; // default placeholder while extracting
            isLocalVideo = true;
        } else if (wallpaper.type === 'url') {
            thumbSrc = 'assets/web-thumbnail.png';
        } else {
            thumbSrc = 'file:///' + wallpaper.path.replace(/\\/g, '/');
        }
    } else {
        thumbSrc = wallpaper.thumbnail;
    }

    // Build card structure safely (no innerHTML with external data)
    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'card-thumb-container';
    
    const imgEl = document.createElement('img');
    imgEl.className = 'card-thumb';
    imgEl.src = thumbSrc;
    imgEl.alt = wallpaper.name || 'Wallpaper thumbnail';
    imgEl.addEventListener('error', () => {
        imgEl.src = 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=364&auto=format&fit=crop&q=60';
    });
    thumbContainer.appendChild(imgEl);
    
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    const overlayBtns = document.createElement('div');
    overlayBtns.className = 'card-overlay-buttons';
    if (isDiscover) {
        const previewBtn = document.createElement('button');
        previewBtn.className = 'action-btn btn-secondary card-preview-btn';
        previewBtn.textContent = 'Preview';
        overlayBtns.appendChild(previewBtn);
        const actionBtn2 = document.createElement('button');
        actionBtn2.className = 'action-btn card-action-btn';
        actionBtn2.textContent = 'Download';
        overlayBtns.appendChild(actionBtn2);
    } else {
        const actionBtn2 = document.createElement('button');
        actionBtn2.className = 'action-btn card-action-btn';
        actionBtn2.textContent = 'Apply';
        overlayBtns.appendChild(actionBtn2);
    }
    overlay.appendChild(overlayBtns);
    thumbContainer.appendChild(overlay);
    
    const progressOv = document.createElement('div');
    progressOv.className = 'progress-overlay';
    const progressBarContainer = document.createElement('div');
    progressBarContainer.className = 'progress-bar-container';
    const progressBarEl = document.createElement('div');
    progressBarEl.className = 'progress-bar';
    progressBarContainer.appendChild(progressBarEl);
    progressOv.appendChild(progressBarContainer);
    const progressTextEl = document.createElement('div');
    progressTextEl.className = 'progress-text';
    progressTextEl.textContent = '0%';
    progressOv.appendChild(progressTextEl);
    thumbContainer.appendChild(progressOv);
    card.appendChild(thumbContainer);
    
    const cardInfo = document.createElement('div');
    cardInfo.className = 'card-info';
    const cardTitle = document.createElement('div');
    cardTitle.className = 'card-title';
    cardTitle.textContent = wallpaper.name || 'Untitled';
    const cardType = document.createElement('div');
    cardType.className = 'card-type';
    cardType.textContent = wallpaper.local
        ? (wallpaper.type === 'video' ? 'Local Video' : (wallpaper.type === 'url' ? 'Web URL' : 'Local Image'))
        : (activeSource === 'motionbgs' ? 'Server 1 4K' : (activeSource === 'wallpaperwaves' ? 'Server 2' : 'Server 3 4K'));
    cardInfo.appendChild(cardTitle);
    cardInfo.appendChild(cardType);
    card.appendChild(cardInfo);

    // Add Playlist Toggle & Delete Button to local Library Cards
    if (wallpaper.local) {
        // Slideshow Playlist Toggle Badge
        const playlistBtn = document.createElement('div');
        playlistBtn.className = 'playlist-toggle-btn';
        
        const isSelected = Array.isArray(config.slideshowPlaylist) && config.slideshowPlaylist.includes(wallpaper.path);
        if (isSelected) {
            playlistBtn.classList.add('in-playlist');
            playlistBtn.title = "Included in Slideshow (Click to remove)";
            playlistBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
        } else {
            playlistBtn.title = "Add to Slideshow Playlist";
            playlistBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
            `;
        }

        playlistBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            ipcRenderer.send('toggle-slideshow-playlist-item', wallpaper.path);
            const nowSelected = playlistBtn.classList.toggle('in-playlist');
            if (nowSelected) {
                playlistBtn.title = "Included in Slideshow (Click to remove)";
                playlistBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                `;
                if (!Array.isArray(config.slideshowPlaylist)) config.slideshowPlaylist = [];
                if (!config.slideshowPlaylist.includes(wallpaper.path)) config.slideshowPlaylist.push(wallpaper.path);
            } else {
                playlistBtn.title = "Add to Slideshow Playlist";
                playlistBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                `;
                if (Array.isArray(config.slideshowPlaylist)) {
                    config.slideshowPlaylist = config.slideshowPlaylist.filter(p => p !== wallpaper.path);
                }
            }
        });
        
        card.appendChild(playlistBtn);

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
            </svg>
        `;
        card.appendChild(deleteBtn);
        
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmDelete = await showConfirmDialog("Delete Wallpaper", `Are you sure you want to delete "${wallpaper.name}" from your library?`);
            if (confirmDelete) {
                const res = await ipcRenderer.invoke('delete-wallpaper', wallpaper.path);
                if (res && res.success) {
                    loadLibrary();
                } else {
                    alert("Failed to delete: " + (res.error || "Unknown error"));
                }
            }
        });
    }

    // Bind preview action if discover card
    if (isDiscover) {
        const previewBtn = card.querySelector('.card-preview-btn');
        if (previewBtn) {
            previewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showPreviewModal(wallpaper);
            });
        }
    }

    // Asynchronously extract the thumbnail for local videos
    if (isLocalVideo) {
        const imgElement = card.querySelector('.card-thumb');
        generateVideoThumbnail(wallpaper.path).then(dataUrl => {
            if (imgElement && dataUrl) {
                imgElement.src = dataUrl;
            }
        });
    }

    const actionBtn = card.querySelector('.card-action-btn');
    const progressOverlay = card.querySelector('.progress-overlay');
    const progressBar = card.querySelector('.progress-bar');
    const progressText = card.querySelector('.progress-text');

    actionBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        
        if (isDiscover) {
            // Trigger MotionBGs download sequence
            actionBtn.style.display = 'none';
            progressOverlay.style.display = 'flex';
            
            try {
                // 1. Fetch details page to get download URL
                progressText.textContent = "Resolving URL...";
                const detailUrl = wallpaper.slug.startsWith('http') 
                    ? wallpaper.slug 
                    : 'https://motionbgs.com' + wallpaper.slug;
                    
                const response = await fetch(detailUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const html = await response.text();
                
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                
                let dlUrl = '';
                if (activeSource === 'motionbgs') {
                    const dlLink = doc.querySelector('a[href*="/dl/4k/"]') || doc.querySelector('a[href*="/dl/hd/"]');
                    if (!dlLink) {
                        throw new Error("Could not find download link on MotionBGs page.");
                    }
                    dlUrl = dlLink.getAttribute('href');
                    if (dlUrl.startsWith('/')) {
                        dlUrl = 'https://motionbgs.com' + dlUrl;
                    }
                } else if (activeSource === 'wallpaperwaves') {
                    const dlLink = doc.querySelector('a[href*="download.php"]');
                    if (!dlLink) {
                        throw new Error("Could not find download link on Wallpaper Waves page.");
                    }
                    dlUrl = dlLink.getAttribute('href');
                } else { // desktophut
                    const dlLink = doc.querySelector('#primaryDownloadBtn') || doc.querySelector('a[download][href*=".mp4"]') || doc.querySelector('a[href*=".mp4"]');
                    if (!dlLink) {
                        throw new Error("Could not find download link on DesktopHut page.");
                    }
                    dlUrl = dlLink.getAttribute('href');
                    if (dlUrl.startsWith('/')) {
                        dlUrl = 'https://www.desktophut.com' + dlUrl;
                    }
                }
                
                // 2. Call download via main IPC
                progressText.textContent = "Connecting...";
                
                // Track progress listener locally for this specific download
                const progressCallback = (event, data) => {
                    if (data.name === wallpaper.name) {
                        progressBar.style.width = `${data.progress}%`;
                        progressText.textContent = `Downloading... ${data.progress}%`;
                    }
                };
                
                ipcRenderer.on('download-progress', progressCallback);
                
                try {
                    const fileName = activeSource === 'wallpaperwaves' ? wallpaper.name + '_ww_' : wallpaper.name;
                    const downloadedWallpaper = await ipcRenderer.invoke('download-wallpaper', { 
                        url: dlUrl, 
                        name: fileName 
                    });
                    
                    progressOverlay.style.display = 'none';
                    actionBtn.style.display = 'block';
                    actionBtn.textContent = 'Apply';
                    
                    // Convert card into applied local card
                    isDiscover = false;
                    wallpaper.local = true;
                    wallpaper.path = downloadedWallpaper.path;
                    
                    // Refresh library so downloaded wallpaper appears there
                    loadLibrary();
                } catch (err) {
                    throw err; // Bubble up to outer catch
                } finally {
                    ipcRenderer.off('download-progress', progressCallback);
                }
                
            } catch (err) {
                console.error("Download failed:", err);
                progressOverlay.style.display = 'none';
                actionBtn.style.display = 'block';
                alert("Download failed: " + err.message);
            }
        } else {
            // Apply local wallpaper
            ipcRenderer.send('apply-wallpaper', wallpaper);
        }
    });

    // Make clicking the card apply it directly if it's already local
    card.addEventListener('click', () => {
        if (!isDiscover) {
            ipcRenderer.send('apply-wallpaper', wallpaper);
        }
    });

    return card;
}

// --- Initialize App ---
document.addEventListener('DOMContentLoaded', () => {
    renderCategoryTags();
    loadLibrary();

    // Premium Logo Intro Animation
    const introOverlay = document.getElementById('intro-overlay');
    if (introOverlay) {
        setTimeout(() => {
            introOverlay.classList.add('fade-out');
            setTimeout(() => {
                introOverlay.remove();
            }, 800); // wait for fade transition to finish, then clean up from DOM
        }, 1800); // Show intro for 1.8 seconds
    }

    // Bind custom confirm modal actions exactly once at startup
    const confirmModal = document.getElementById('confirm-modal');
    if (confirmModal) {
        document.getElementById('confirm-cancel').addEventListener('click', () => {
            confirmModal.classList.remove('active');
            if (confirmResolver) {
                confirmResolver(false);
                confirmResolver = null;
            }
        });
        
        document.getElementById('confirm-ok').addEventListener('click', () => {
            confirmModal.classList.remove('active');
            if (confirmResolver) {
                confirmResolver(true);
                confirmResolver = null;
            }
        });
        
        confirmModal.addEventListener('click', (e) => {
            if (e.target === confirmModal) {
                confirmModal.classList.remove('active');
                if (confirmResolver) {
                    confirmResolver(false);
                    confirmResolver = null;
                }
            }
        });
    }

    // Auto-Updater Toast Logic
    const updateToast = document.getElementById('update-toast');
    const updateTitle = document.getElementById('update-toast-title');
    const updateMsg = document.getElementById('update-toast-msg');
    const updateBtn = document.getElementById('update-action-btn');

    if (ipcRenderer && updateToast) {
        let updateVersion = '';
        ipcRenderer.on('update-available', (event, info) => {
            updateToast.classList.add('show');
            if (info && info.version) {
                updateVersion = info.version;
                updateMsg.textContent = `Downloading v${info.version} in the background...`;
            }
        });

        ipcRenderer.on('download-progress-update', (event, progressObj) => {
            updateToast.classList.add('show');
            if (progressObj && typeof progressObj.percent === 'number') {
                const pct = Math.round(progressObj.percent);
                updateMsg.textContent = `Downloading v${updateVersion || '2.9.1'}... (${pct}%)`;
                updateBtn.textContent = `${pct}%`;
            }
        });

        ipcRenderer.on('update-downloaded', (event, info) => {
            updateToast.classList.add('show');
            updateTitle.textContent = 'Update Ready';
            updateMsg.textContent = 'The latest version has been downloaded and is ready to install.';
            updateBtn.textContent = 'Restart & Install';
            updateBtn.disabled = false;
            
            updateBtn.onclick = () => {
                updateBtn.textContent = 'Installing...';
                updateBtn.disabled = true;
                ipcRenderer.send('install-update');
            };
        });
    }
});




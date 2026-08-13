const { app, BrowserWindow, ipcMain, dialog, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Set App User Model ID for Windows taskbar grouping
if (process.platform === 'win32') {
    app.setAppUserModelId('com.exware.lumina');
}

// Bypass Chromium autoplay user-gesture gesture requirement for wallpapers
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Prevent Chromium from throttling/freezing the renderer when the window is
// hidden by "Show Desktop" (Win+D) or minimized — fixes the Alt+Tab freeze bug.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let controlPanelWindow = null;
let wallpaperWindow = null;
let tray = null;
let helperProcess = null;

// Paths
const wallpapersDir = path.join(app.getPath('userData'), 'LocalWallpapers');
if (!fs.existsSync(wallpapersDir)) {
    fs.mkdirSync(wallpapersDir, { recursive: true });
}

// Config file path
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = {
    activeWallpaper: null,
    volume: 0, // Default muted
    autoPause: true,
    taskbarStyle: 'none', // 'none', 'clear', 'blur', 'fluent'
    pauseOnBattery: false,
    pauseOnLock: false,
    startWithWindows: false,
    urlWallpapers: [],
    slideshowEnabled: false,
    slideshowInterval: 300, // default 5 minutes (300 seconds)
    slideshowSelectedOnly: false,
    slideshowPlaylist: [],
    serverUrl: 'https://lumina-q649.onrender.com'
};

if (fs.existsSync(configPath)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) {
        console.error('Error loading config', e);
    }
}

let _saveConfigTimer = null;
function saveConfig() {
    clearTimeout(_saveConfigTimer);
    _saveConfigTimer = setTimeout(() => {
        fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8', (err) => {
            if (err) console.error('[Main]: Error saving config:', err);
        });
    }, 300);
}

// Create the Control Panel (UI) Window
function createControlPanel() {
    if (controlPanelWindow) {
        controlPanelWindow.show();
        return;
    }

    controlPanelWindow = new BrowserWindow({
        show: !process.argv.includes('--hidden'),
        width: 1000,
        height: 680,
        title: "Lumina by EXWARE",
        frame: false,
        transparent: true,
        resizable: true,
        icon: path.join(__dirname, 'ui', 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false,
            backgroundThrottling: false  // Prevent freeze when hidden by Show Desktop
        }
    });

    controlPanelWindow.loadFile(path.join(__dirname, 'ui', 'control-panel.html'));
    if (!process.argv.includes('--hidden')) {
        controlPanelWindow.maximize();
    }
    
    // Toggle Developer Tools with F12
    controlPanelWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            controlPanelWindow.webContents.toggleDevTools();
        }
    });
    
    controlPanelWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            controlPanelWindow.hide();
        }
    });

    controlPanelWindow.on('minimize', (event) => {
        event.preventDefault();
        controlPanelWindow.hide();
    });

    controlPanelWindow.on('closed', () => {
        controlPanelWindow = null;
    });

    // Fix: Transparent windows on Windows can freeze after "Show Desktop" + Alt+Tab
    // because the DWM compositor loses the window's backing store or GPU process halts.
    // If the user can move the window but it's frozen, the native window is alive but the renderer is suspended.
    // Calling .show() forces the native window to redraw its renderer texture.
    const fixDwmFreeze = () => {
        if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
            // Re-asserting show() forces a DWM surface refresh without breaking transparency or causing loops
            controlPanelWindow.show();
            controlPanelWindow.webContents.invalidate();
        }
    };

    controlPanelWindow.on('restore', fixDwmFreeze);
    controlPanelWindow.on('focus', fixDwmFreeze);
}

// Helper: Calculate Virtual Desktop bounds across single or multiple monitors
function getVirtualDesktopBounds() {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    if (!displays || displays.length === 0) return { x: 0, y: 0, width: 1920, height: 1080 };
    
    let minX = displays[0].bounds.x;
    let minY = displays[0].bounds.y;
    let maxX = displays[0].bounds.x + displays[0].bounds.width;
    let maxY = displays[0].bounds.y + displays[0].bounds.height;
    
    displays.forEach(display => {
        const b = display.bounds;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
    });
    
    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

// Create the Wallpaper Viewport Window
function createWallpaperWindow() {
    if (wallpaperWindow) return;

    const bounds = getVirtualDesktopBounds();

    wallpaperWindow = new BrowserWindow({
        title: "Lumina Wallpaper Viewport",
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        show: true, // Show window so Win32 FindWindow can locate and parent it
        skipTaskbar: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        icon: path.join(__dirname, 'ui', 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false
        }
    });

    wallpaperWindow.setBounds(bounds);

    wallpaperWindow.loadFile(path.join(__dirname, 'ui', 'wallpaper-viewer.html'));

    wallpaperWindow.webContents.on('did-finish-load', () => {
        // Apply saved wallpaper if any
        if (config.activeWallpaper) {
            wallpaperWindow.webContents.send('set-wallpaper', config.activeWallpaper, config.volume);
        }
        
        // Launch helper to parent the window to WorkerW
        launchHelper();
    });

    wallpaperWindow.on('closed', () => {
        wallpaperWindow = null;
    });
}

// Start the Win32 window-parenting helper
function launchHelper() {
    if (!wallpaperWindow) {
        console.warn('[Main]: Cannot launch helper: wallpaper window not available');
        return;
    }
    
    if (helperProcess) {
        helperProcess.removeAllListeners();
        helperProcess.stdout && helperProcess.stdout.removeAllListeners();
        helperProcess.stderr && helperProcess.stderr.removeAllListeners();
        try { helperProcess.kill(); } catch(e) {}
        helperProcess = null;
    }

    const isPackaged = app.isPackaged;
    const helperPath = isPackaged 
        ? path.join(process.resourcesPath, 'LuminaHelper.exe')
        : path.join(__dirname, '..', 'LuminaHelper.exe');
        
    if (!fs.existsSync(helperPath)) {
        console.error('LuminaHelper.exe not found at ' + helperPath);
        return;
    }

    // Get raw HWND of the wallpaper window (read full 64-bit on x64)
    const hwndBuf = wallpaperWindow.getNativeWindowHandle();
    const hwnd = process.arch === 'x64'
        ? hwndBuf.readBigInt64LE(0).toString()
        : hwndBuf.readInt32LE(0).toString();
    console.log(`[Main]: Launching helper with HWND: ${hwnd}`);

    helperProcess = spawn(helperPath, [
        hwnd, 
        (config.autoPause || config.pauseOnBattery || config.pauseOnLock) ? "autopause" : "normal"
    ]);

    helperProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
        lines.forEach(msg => {
            console.log('[Helper Stdout]:', msg);
            if (msg === 'PAUSE' && config.autoPause) {
                if (wallpaperWindow) wallpaperWindow.webContents.send('pause');
            } else if (msg === 'RESUME') {
                if (wallpaperWindow) wallpaperWindow.webContents.send('resume');
            }
        });
    });

    helperProcess.stderr.on('data', (data) => {
        console.error('[Helper Stderr]:', data.toString().trim());
    });

    helperProcess.on('error', (err) => {
        console.error('Helper process error:', err);
    });
}

// System Tray Integration
function createTray() {
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, 'ui', 'assets', 'icon.png');
    
    // Create temporary pixel icon if real icon doesn't exist
    if (!fs.existsSync(iconPath)) {
        const assetsDir = path.join(__dirname, 'ui', 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
        // Save dummy 1x1 transparent png or use standard fallback
    }

    tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Lumina Control Panel', click: () => createControlPanel() },
        { type: 'separator' },
        { 
            label: 'Mute Wallpaper', 
            type: 'checkbox', 
            checked: config.volume === 0, 
            click: (menuItem) => {
                config.volume = menuItem.checked ? 0 : 50;
                saveConfig();
                if (wallpaperWindow) wallpaperWindow.webContents.send('set-volume', config.volume);
            }
        },
        { 
            label: 'Auto-Pause on Fullscreen', 
            type: 'checkbox', 
            checked: config.autoPause,
            click: (menuItem) => {
                config.autoPause = menuItem.checked;
                saveConfig();
                launchHelper(); // Restart helper with new config
            }
        },
        { type: 'separator' },
        { label: 'Exit', click: () => {
            app.isQuiting = true;
            app.quit();
        }}
    ]);

    tray.setToolTip('Lumina Wallpaper by EXWARE');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        createControlPanel();
    });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (controlPanelWindow) {
            if (controlPanelWindow.isMinimized()) controlPanelWindow.restore();
            controlPanelWindow.show();
            controlPanelWindow.focus();
        } else {
            createControlPanel();
        }
        
        // Also check for updates when restored
        if (app.isPackaged) {
            autoUpdater.checkForUpdatesAndNotify().catch(e => console.error("Update check failed:", e));
        }
    });

    app.whenReady().then(() => {
    createWallpaperWindow();
    
    createControlPanel();
    
    // Automatically apply active wallpaper on startup if valid
    if (config.activeWallpaper && fs.existsSync(config.activeWallpaper.path)) {
        createWallpaperWindow();
    } else if (config.activeWallpaper && config.activeWallpaper.path.startsWith('http')) {
        createWallpaperWindow();
    }
    
    fetchRemoteSources();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createControlPanel();
        }
    });

    createTray();

    // Sync login item settings with current configuration
    app.setLoginItemSettings({
        openAtLogin: config.startWithWindows || false,
        path: process.execPath,
        args: ['--hidden']
    });

    // Start wallpaper rotation slideshow if enabled
    if (config.slideshowEnabled) {
        startSlideshow();
    }

    // --- PowerMonitor Efficiency Setup (0.00% CPU/GPU on sleep/lock) ---
    const { powerMonitor } = require('electron');
    powerMonitor.on('suspend', () => {
        console.log('[PowerMonitor]: System suspend detected — pausing live wallpaper for 0% CPU/GPU.');
        if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
            wallpaperWindow.webContents.send('pause');
        }
    });

    powerMonitor.on('resume', () => {
        console.log('[PowerMonitor]: System resume detected — restoring live wallpaper.');
        if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
            wallpaperWindow.webContents.send('resume');
        }
    });

    powerMonitor.on('lock-screen', () => {
        if (config.pauseOnLock && wallpaperWindow && !wallpaperWindow.isDestroyed()) {
            wallpaperWindow.webContents.send('pause');
        }
    });

    powerMonitor.on('unlock-screen', () => {
        if (config.pauseOnLock && wallpaperWindow && !wallpaperWindow.isDestroyed()) {
            wallpaperWindow.webContents.send('resume');
        }
    });

    // --- OTA Auto-Updater Setup ---
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    
    // Listen for updates
    autoUpdater.on('update-available', (info) => {
        if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
            controlPanelWindow.webContents.send('update-available', info);
        }
    });
    
    autoUpdater.on('download-progress', (progressObj) => {
        if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
            controlPanelWindow.webContents.send('download-progress-update', progressObj);
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
            controlPanelWindow.webContents.send('update-downloaded', info);
        }
    });
    
    autoUpdater.on('error', (err) => {
        console.error('AutoUpdater Error:', err);
    });

    // Initiate check (only works in packaged apps)
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify().catch(e => console.error("Update check failed:", e));
    }
});

// Prevent app from quitting when all windows close — keep running in system tray
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
    stopSlideshow();
    if (helperProcess) {
        helperProcess.removeAllListeners();
        try { helperProcess.kill(); } catch(e) {}
        helperProcess = null;
    }
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

// IPC Handler: Fix DWM Freeze (triggered by Renderer on visibilitychange)
ipcMain.on('fix-dwm-freeze', () => {
    if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
        controlPanelWindow.show();
        controlPanelWindow.webContents.invalidate();
    }
});

// IPC Handler: Install Update
ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall(true, true);
});

// IPC Handler: Apply Wallpaper
ipcMain.on('apply-wallpaper', (event, wallpaper) => {
    config.activeWallpaper = wallpaper;
    saveConfig();
    
    if (wallpaperWindow) {
        wallpaperWindow.webContents.send('set-wallpaper', wallpaper, config.volume);
    } else {
        createWallpaperWindow();
    }
});

// IPC Handler: Set Volume
ipcMain.on('set-volume', (event, volume) => {
    const vol = Math.max(0, Math.min(100, parseInt(volume, 10) || 0));
    config.volume = vol;
    saveConfig();
    if (wallpaperWindow) {
        wallpaperWindow.webContents.send('set-volume', vol);
    }
});

// IPC Handler: Browse files
ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog(controlPanelWindow || undefined, {
        properties: ['openFile'],
        filters: [
            { name: 'Media Files', extensions: ['mp4', 'webm', 'jpg', 'jpeg', 'png', 'gif'] }
        ]
    });
    
    if (result.canceled || result.filePaths.length === 0) return null;
    
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath, ext);
    const destPath = path.join(wallpapersDir, Date.now() + ext);
    
    try {
        await fs.promises.copyFile(filePath, destPath);
    } catch (err) {
        console.error('[Main]: Failed to copy file:', err);
        return null;
    }
    
    return {
        name: fileName,
        path: destPath,
        type: ext === '.mp4' || ext === '.webm' ? 'video' : 'image',
        local: true
    };
});

// Helper function to load library wallpapers (used by get-library IPC and slideshow)
async function getLibraryItems() {
    let library = [];
    if (fs.existsSync(wallpapersDir)) {
        const files = await fs.promises.readdir(wallpapersDir);
        library = files.map(file => {
            const filePath = path.join(wallpapersDir, file);
            const ext = path.extname(file).toLowerCase();
            const cleanName = file.replace(/^\d+_?/, '').replace(new RegExp('\\' + ext + '$', 'i'), '') || 'Custom Wallpaper';
            return {
                name: cleanName,
                path: filePath,
                type: ext === '.mp4' || ext === '.webm' ? 'video' : 'image',
                local: true
            };
        });
    }
    const urlWallpapers = config.urlWallpapers || [];
    return [...library, ...urlWallpapers];
}

// IPC Handler: Get Library Wallpapers
ipcMain.handle('get-library', async () => {
    return await getLibraryItems();
});

// Slideshow Playlist Mode Logic
let slideshowTimer = null;

function startSlideshow() {
    stopSlideshow();
    if (!config.slideshowEnabled) return;
    
    console.log(`[Main]: Starting wallpaper slideshow (Selected Only: ${config.slideshowSelectedOnly}) with interval: ${config.slideshowInterval}s`);
    
    const intervalMs = config.slideshowInterval * 1000;
    
    slideshowTimer = setInterval(async () => {
        const libraryItems = await getLibraryItems();
        if (libraryItems.length <= 1) {
            console.log('[Main]: Slideshow: Not enough wallpapers in library to switch.');
            return;
        }
        
        let pool = libraryItems;
        // Filter by user selected playlist if selective mode is enabled
        if (config.slideshowSelectedOnly && Array.isArray(config.slideshowPlaylist) && config.slideshowPlaylist.length > 0) {
            pool = libraryItems.filter(w => config.slideshowPlaylist.includes(w.path));
        }

        if (pool.length === 0) {
            console.log('[Main]: Slideshow: No wallpapers matched the selected playlist filter.');
            return;
        }
        
        let candidates = pool;
        if (config.activeWallpaper && pool.length > 1) {
            candidates = pool.filter(w => w.path !== config.activeWallpaper.path);
        }
        
        if (candidates.length === 0) return;
        
        const randomWp = candidates[Math.floor(Math.random() * candidates.length)];
        console.log(`[Main]: Slideshow: Switching active wallpaper to "${randomWp.name}"`);
        
        config.activeWallpaper = randomWp;
        saveConfig();
        
        if (wallpaperWindow) {
            wallpaperWindow.webContents.send('set-wallpaper', randomWp, config.volume);
        }
        if (controlPanelWindow) {
            controlPanelWindow.webContents.send('active-wallpaper-changed', randomWp);
        }
    }, intervalMs);
}

function stopSlideshow() {
    if (slideshowTimer) {
        clearInterval(slideshowTimer);
        slideshowTimer = null;
        console.log('[Main]: Stopped wallpaper slideshow');
    }
}

// IPC Handler: Download wallpaper from MotionBGs
ipcMain.handle('download-wallpaper', async (event, { url, name }) => {
    const ext = '.mp4';
    const destPath = path.join(wallpapersDir, Date.now() + '_' + name.replace(/[^a-zA-Z0-9]/g, '_') + ext);
    
    const https = require('https');
    
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destPath);
        let streamClosed = false;
        
        const cleanupOnError = (err) => {
            if (!streamClosed) {
                streamClosed = true;
                fileStream.close(() => {
                    fs.unlink(destPath, () => {});
                });
            }
            reject(err);
        };
        
        const request = (targetUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                cleanupOnError(new Error('Too many redirects'));
                return;
            }
            https.get(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://motionbgs.com/'
                }
            }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    res.resume(); // Drain response body
                    let nextUrl = res.headers.location;
                    if (nextUrl && nextUrl.startsWith('/')) {
                        nextUrl = 'https://motionbgs.com' + nextUrl;
                    }
                    if (!nextUrl) {
                        cleanupOnError(new Error('Redirect with no Location header'));
                        return;
                    }
                    request(nextUrl, redirectCount + 1);
                    return;
                }
                
                if (res.statusCode !== 200) {
                    res.resume();
                    cleanupOnError(new Error(`Failed to download: Status Code ${res.statusCode}`));
                    return;
                }
                
                const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                let downloadedBytes = 0;
                
                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
                    if (controlPanelWindow) {
                        controlPanelWindow.webContents.send('download-progress', { name, progress });
                    }
                });
                
                res.pipe(fileStream);
                
                fileStream.on('finish', () => {
                    streamClosed = true;
                    fileStream.close();
                    resolve({
                        name: name,
                        path: destPath,
                        type: 'video',
                        local: true
                    });
                });
                
                fileStream.on('error', (err) => {
                    cleanupOnError(err);
                });
            }).on('error', (err) => {
                cleanupOnError(err);
            });
        };
        
        request(url);
    });
});

// IPC Handler: Close, Minimize, and Maximize
ipcMain.on('window-control', (event, action) => {
    if (controlPanelWindow) {
        if (action === 'close') {
            controlPanelWindow.close();
        } else if (action === 'minimize') {
            controlPanelWindow.minimize();
        } else if (action === 'maximize') {
            if (controlPanelWindow.isMaximized()) {
                controlPanelWindow.unmaximize();
            } else {
                controlPanelWindow.maximize();
            }
        }
    }
});

ipcMain.handle('delete-wallpaper', async (event, wallpaperPath) => {
    try {
        // Handle URL wallpapers by removing from the config array
        const isUrl = config.urlWallpapers && config.urlWallpapers.some(w => w.path === wallpaperPath);
        if (isUrl) {
            config.urlWallpapers = config.urlWallpapers.filter(w => w.path !== wallpaperPath);
            saveConfig();
            if (config.activeWallpaper && config.activeWallpaper.path === wallpaperPath) {
                if (wallpaperWindow) {
                    wallpaperWindow.webContents.send('clear-wallpaper');
                }
                config.activeWallpaper = null;
                saveConfig();
            }
            return { success: true };
        }

        // Security: Prevent path traversal attacks
        const resolvedPath = path.resolve(wallpaperPath);
        const resolvedWallpapersDir = path.resolve(wallpapersDir);
        if (!resolvedPath.startsWith(resolvedWallpapersDir + path.sep) && resolvedPath !== resolvedWallpapersDir) {
            return { success: false, error: 'Invalid path: access denied' };
        }

        // If the wallpaper being deleted is currently active, unload it from the viewport first to release the file lock
        if (config.activeWallpaper && config.activeWallpaper.path === wallpaperPath) {
            if (wallpaperWindow) {
                wallpaperWindow.webContents.send('clear-wallpaper');
            }
            config.activeWallpaper = null;
            saveConfig();
            
            // Wait 300ms for Chromium to release the media file handle lock
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (fs.existsSync(wallpaperPath)) {
            fs.unlinkSync(wallpaperPath);
            return { success: true };
        }
        return { success: false, error: "File not found on disk" };
    } catch (err) {
        console.error("Failed to delete wallpaper file:", err);
        return { success: false, error: err.message };
    }
});

// IPC Handler: Add URL Wallpaper
ipcMain.handle('add-url-wallpaper', async (event, { name, url }) => {
    try {
        if (!config.urlWallpapers) {
            config.urlWallpapers = [];
        }
        const newWp = {
            name: name || 'Custom Web Wallpaper',
            path: url,
            type: 'url',
            local: true
        };
        config.urlWallpapers.push(newWp);
        saveConfig();
        return { success: true, wallpaper: newWp };
    } catch (err) {
        console.error("Failed to add URL wallpaper:", err);
        return { success: false, error: err.message };
    }
});

// --- New Features IPC Listeners & Services ---

ipcMain.on('get-config', (event) => {
    event.returnValue = config;
});

ipcMain.on('get-version', (event) => {
    event.returnValue = app.getVersion();
});

ipcMain.on('set-autopause', (event, val) => {
    config.autoPause = val;
    saveConfig();
    if (helperProcess) {
        launchHelper(); // Restart helper with new config
    }
});

ipcMain.on('set-taskbar-style', (event, style) => {
    config.taskbarStyle = style;
    saveConfig();
    updateTaskbarTheme();
});

ipcMain.on('set-pause-on-battery', (event, val) => {
    config.pauseOnBattery = val;
    saveConfig();
    checkPowerMutePause();
});

ipcMain.on('set-pause-on-lock', (event, val) => {
    config.pauseOnLock = val;
    saveConfig();
});

ipcMain.on('set-start-with-windows', (event, val) => {
    config.startWithWindows = !!val;
    saveConfig();
    app.setLoginItemSettings({
        openAtLogin: config.startWithWindows,
        path: process.execPath,
        args: ['--hidden']
    });
    console.log(`[Main]: Start with Windows set to: ${config.startWithWindows}`);
});

ipcMain.on('set-slideshow-enabled', (event, val) => {
    config.slideshowEnabled = !!val;
    saveConfig();
    if (config.slideshowEnabled) {
        startSlideshow();
    } else {
        stopSlideshow();
    }
});

ipcMain.on('set-slideshow-selected-only', (event, val) => {
    config.slideshowSelectedOnly = !!val;
    saveConfig();
    if (config.slideshowEnabled) {
        startSlideshow();
    }
});

ipcMain.on('toggle-slideshow-playlist-item', (event, wallpaperPath) => {
    if (!wallpaperPath) return;
    if (!Array.isArray(config.slideshowPlaylist)) {
        config.slideshowPlaylist = [];
    }
    const idx = config.slideshowPlaylist.indexOf(wallpaperPath);
    if (idx >= 0) {
        config.slideshowPlaylist.splice(idx, 1);
    } else {
        config.slideshowPlaylist.push(wallpaperPath);
    }
    saveConfig();
    if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
        controlPanelWindow.webContents.send('slideshow-playlist-updated', config.slideshowPlaylist);
    }
    if (config.slideshowEnabled && config.slideshowSelectedOnly) {
        startSlideshow();
    }
});

ipcMain.on('set-slideshow-interval', (event, val) => {
    config.slideshowInterval = parseInt(val, 10) || 300;
    saveConfig();
    if (config.slideshowEnabled) {
        startSlideshow();
    }
});


// Power Monitor and System Suspends
const { powerMonitor } = require('electron');
let isBatteryPaused = false;

function checkPowerMutePause() {
    if (config.pauseOnBattery && powerMonitor.isOnBattery()) {
        if (!isBatteryPaused) {
            isBatteryPaused = true;
            if (wallpaperWindow) wallpaperWindow.webContents.send('pause');
            console.log('[Main]: Wallpaper paused (On Battery Power)');
        }
    } else {
        if (isBatteryPaused) {
            isBatteryPaused = false;
            if (wallpaperWindow) wallpaperWindow.webContents.send('resume');
            console.log('[Main]: Wallpaper resumed (On AC Power)');
        }
    }
}

powerMonitor.on('on-battery', () => {
    checkPowerMutePause();
});

powerMonitor.on('on-ac', () => {
    checkPowerMutePause();
});

powerMonitor.on('lock-screen', () => {
    if (config.pauseOnLock) {
        if (wallpaperWindow) wallpaperWindow.webContents.send('pause');
        console.log('[Main]: Wallpaper paused (System Locked)');
    }
});

powerMonitor.on('unlock-screen', () => {
    if (config.pauseOnLock) {
        if (wallpaperWindow) wallpaperWindow.webContents.send('resume');
        console.log('[Main]: Wallpaper resumed (System Unlocked)');
    }
});

async function fetchRemoteSources() {
    if (!config.serverUrl) return;
    try {
        const https = require('https');
        const url = config.serverUrl.endsWith('/') ? config.serverUrl + 'api/sources' : config.serverUrl + '/api/sources';
        
        console.log(`[Main]: Fetching remote sources from ${url}...`);
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        if (json && Array.isArray(json.sources)) {
                            config.remoteSources = json.sources;
                            console.log(`[Main]: Loaded ${json.sources.length} remote sources for Discover tab.`);
                            // Optional: send to renderer if already open
                            if (controlPanelWindow) {
                                controlPanelWindow.webContents.send('remote-sources-updated', json.sources);
                            }
                            saveConfig();
                        }
                    } catch (e) {
                        console.error('[Main]: Error parsing remote sources:', e.message);
                    }
                }
            });
        }).on('error', (err) => {
            console.error('[Main]: Error fetching remote sources:', err.message);
        });
    } catch (e) {
        console.error('[Main]: Exception fetching remote sources:', e);
    }
}
}

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

class WidgetManager {
    constructor(configManager, updateConfigCallback) {
        this.configManager = configManager;
        this.updateConfigCallback = updateConfigCallback;
        this.activeWindows = {}; // map of widgetId -> BrowserWindow

        // Ensure config structure exists
        if (!this.configManager.widgets) this.configManager.widgets = { active: [], bounds: {} };

        // Handle IPC from widgets
        ipcMain.on('widget-dragged', (event, id, bounds) => {
            if (this.configManager.widgets.bounds) {
                this.configManager.widgets.bounds[id] = bounds;
                this.updateConfigCallback();
            }
        });
    }

    startAll() {
        const active = this.configManager.widgets.active || [];
        active.forEach(id => this.spawnWidget(id));
    }

    stopAll() {
        Object.values(this.activeWindows).forEach(win => {
            if (!win.isDestroyed()) win.close();
        });
        this.activeWindows = {};
    }

    toggleWidget(id, state) {
        let active = this.configManager.widgets.active || [];
        if (state) {
            if (!active.includes(id)) active.push(id);
            this.spawnWidget(id);
        } else {
            active = active.filter(wId => wId !== id);
            this.destroyWidget(id);
        }
        this.configManager.widgets.active = active;
        this.updateConfigCallback();
    }

    getWidgetPath(id) {
        if (id.startsWith('rmskin:')) {
            return path.join(__dirname, 'widgets', 'rainmeter-host', 'index.html');
        }
        return path.join(__dirname, 'widgets', id, 'index.html');
    }

    spawnWidget(id) {
        if (this.activeWindows[id]) return; // Already running

        const widgetPath = this.getWidgetPath(id);
        if (!fs.existsSync(widgetPath)) {
            console.error(`[WidgetManager] Cannot find widget ${id} at ${widgetPath}`);
            return;
        }

        // Get saved bounds or default
        const savedBounds = (this.configManager.widgets.bounds || {})[id];
        const display = screen.getPrimaryDisplay();
        
        const defaultWidth = 400;
        const defaultHeight = 250;
        
        let x = savedBounds ? savedBounds.x : (display.workArea.width - defaultWidth - 50);
        let y = savedBounds ? savedBounds.y : 50;

        const win = new BrowserWindow({
            width: savedBounds ? savedBounds.width : defaultWidth,
            height: savedBounds ? savedBounds.height : defaultHeight,
            x: x,
            y: y,
            transparent: true,
            frame: false,
            resizable: false,
            hasShadow: false,
            skipTaskbar: true,
            type: 'toolbar', // Helps it behave like a widget
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        // Load the widget
        win.loadFile(widgetPath);
        
        // If it's a rainmeter skin, parse the ini and send it via IPC when loaded
        if (id.startsWith('rmskin:')) {
            win.webContents.on('did-finish-load', () => {
                try {
                    const IniParser = require('./parser/ini-parser');
                    const skinsBaseDir = path.join(require('electron').app.getPath('userData'), 'skins');
                    
                    // id is rmskin:SuiteName/Widget/File.ini
                    const relPath = id.replace('rmskin:', '');
                    const suiteName = relPath.split('/')[0];
                    const suiteDir = path.join(skinsBaseDir, suiteName);
                    
                    const skinPath = path.join(skinsBaseDir, relPath);
                    const skinDir = path.dirname(skinPath);
                    
                    const parser = new IniParser(suiteDir);
                    const parsedData = parser.parseFile(skinPath);
                    win.webContents.send('load-skin', { parsedData, skinDir });
                } catch (e) {
                    console.error('[WidgetManager] Failed to load rainmeter skin:', e);
                }
            });
        }

        // Keep it at the bottom (below other apps, but above desktop)
        win.setAlwaysOnTop(false, 'bottom');

        // Prevent minimize
        win.on('minimize', (e) => {
            e.preventDefault();
            win.restore();
        });

        // Track dragging
        win.on('moved', () => {
            const bounds = win.getBounds();
            if (!this.configManager.widgets.bounds) this.configManager.widgets.bounds = {};
            this.configManager.widgets.bounds[id] = bounds;
            this.updateConfigCallback();
        });

        win.on('closed', () => {
            delete this.activeWindows[id];
        });

        this.activeWindows[id] = win;
        console.log(`[WidgetManager] Spawned widget: ${id}`);
    }

    destroyWidget(id) {
        if (this.activeWindows[id]) {
            this.activeWindows[id].close();
            delete this.activeWindows[id];
            console.log(`[WidgetManager] Destroyed widget: ${id}`);
        }
    }
}

module.exports = WidgetManager;

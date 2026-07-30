const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Invoke methods (async, returns a Promise)
    invoke: (channel, data) => {
        const validChannels = ['select-file', 'get-library', 'download-wallpaper', 'delete-wallpaper', 'get-config'];
        if (validChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
        return Promise.reject(new Error(`Unauthorized IPC channel: ${channel}`));
    },
    // Send methods (one-way to main process)
    send: (channel, data) => {
        const validChannels = ['window-control', 'apply-wallpaper', 'set-volume', 'save-config', 'set-autopause', 'set-taskbar-style', 'set-pause-on-battery', 'set-pause-on-lock', 'install-update', 'fix-dwm-freeze', 'set-start-with-windows', 'set-slideshow-enabled', 'set-slideshow-interval'];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    // Synchronous send methods
    sendSync: (channel, data) => {
        const validChannels = ['get-config', 'get-version'];
        if (validChannels.includes(channel)) {
            return ipcRenderer.sendSync(channel, data);
        }
    },
    // Listen methods (from main process)
    on: (channel, func) => {
        const validChannels = ['download-progress', 'set-wallpaper', 'clear-wallpaper', 'set-volume', 'pause', 'resume', 'update-available', 'update-downloaded'];
        if (validChannels.includes(channel)) {
            // Strip event as it includes sender
            ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
        }
    },
    // Remove listeners
    off: (channel, func) => {
        const validChannels = ['download-progress'];
        if (validChannels.includes(channel)) {
            ipcRenderer.off(channel, func);
        }
    }
});

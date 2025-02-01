import Store from 'electron-store';
import { app, BrowserWindow, globalShortcut, clipboard, ipcMain, dialog, nativeImage, Notification } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const DEFAULT_SETTINGS = {
    apiKey: '',
    preferences: {
        automaticClipboardSync: false,
        notifications: false, // Changed to false
        debugLogging: false,
        automaticUpdates: true
    },
    refreshIntervalSeconds: 60,
    apiBaseUrl: 'https://crossyclip.com',
    theme: {
        primaryColor: '#6200ee',
        hoverColor: '#3700b3',
        bgColor: '#121212',
        surfaceColor: '#1e1e1e',
        textColor: '#ffffff'
    },
    keybindings: {
        copy: 'CommandOrControl+Shift+C',
        paste: 'CommandOrControl+Shift+V'
    }
};

function logDebug(message, ...args) {
    const settings = getSettings();
    if (settings.preferences.debugLogging) {
        console.log(`[DEBUG] ${message}`, ...args);
    }
}

function logInfo(message, ...args) {
    console.log(`[INFO] ${message}`, ...args);
}

// Add to existing showNotification function
function showNotification(title, body) {
    const settings = getSettings();
    if (settings.preferences.notifications) {
        // Use system notification
        new Notification({ 
            title, 
            body,
            silent: false
        }).show();
    }
    // Always send in-app notification
    mainWindow?.webContents.send('showInAppNotification', { title, body });
}

const initStore = () => {
    return new Store({
        defaults: DEFAULT_SETTINGS
    });
};

const store = initStore();

let mainWindow;
let refreshInterval;
let lastLocalClipboardTimestamp = Date.now();
let clipboardMonitoringInterval;

const getSettings = () => {
    const defaults = {
        ...DEFAULT_SETTINGS,
        preferences: {
            ...DEFAULT_SETTINGS.preferences
        }
    };
    
    const settings = store?.store || defaults;
    
    settings.preferences = {
        ...defaults.preferences,
        ...settings.preferences
    };
    
    return settings;
};

const getAppKey = () => {
    return store?.get('apiKey');
};

const saveAppKey = (key) => {
    store?.set('apiKey', key);
};

const checkForUpdatesIfEnabled = async () => {
    const settings = getSettings();
    if (settings.preferences.automaticUpdates) {
        logDebug('Checking for updates (auto-updates enabled)');
        try {
            await autoUpdater.checkForUpdatesAndNotify();
        } catch (error) {
            logDebug('Auto-update check failed:', error);
            // Don't show notification for 404 errors since they're expected when no update exists
            if (!error.message.includes('404')) {
                showNotification(
                    'Update Check Failed', 
                    'Could not check for updates. Will try again later.'
                );
            }
            // Don't crash the app, just log the error
            return false;
        }
    } else {
        logDebug('Auto-updates disabled - skipping update check');
    }
    return true;
};

const setupIpcHandlers = () => {
    ipcMain.on('saveApiKey', (event, key) => {
        saveAppKey(key);
    });

    ipcMain.handle('getApiKey', () => {
        return getAppKey();
    });

    ipcMain.handle('getSettings', () => {
        return getSettings();
    });

    ipcMain.handle('selectFile', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile']
        });
        if (!result.canceled) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('copyFile', async (event, filePath) => {
        await cloudCopyFile(filePath);
    });

    ipcMain.handle('saveSettings', async (event, newSettings) => {
        logDebug('Saving new settings:', newSettings);
        store.set(newSettings);
        setupRefreshInterval();
        registerCustomKeybindings();
        
        showNotification('Settings Saved', 'Your settings have been updated successfully');
        
        if (newSettings.preferences.automaticUpdates) {
            await checkForUpdatesIfEnabled();
        }
        return store.get();
    });

    ipcMain.handle('saveFile', async (event, suggestedName) => {
        const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: suggestedName,
            properties: ['createDirectory', 'showOverwriteConfirmation']
        });
        return result.filePath;
    });

    ipcMain.handle('downloadFile', async (event, filename) => {
        try {
            const appKey = getAppKey();
            const settings = getSettings();
            
            const response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
                headers: { AppKey: appKey },
                responseType: 'arraybuffer'
            });

            const disposition = response.headers['content-disposition'];
            const suggestedName = filename || 
                disposition?.match(/filename="?([^"]+)"?/)?.[1] || 
                'downloaded_file';

            const saveOptions = {
                title: 'Save File',
                defaultPath: path.join(app.getPath('downloads'), suggestedName),
                filters: [
                    { name: 'All Files', extensions: ['*'] }
                ]
            };
            
            const result = await dialog.showSaveDialog(mainWindow, saveOptions);
            
            if (!result.canceled && result.filePath) {
                await fs.promises.writeFile(result.filePath, response.data);
                return true;
            }
            return false;
        } catch (error) {
            logDebug('Operation failed:', error);
            showNotification('Error', error.message);
            mainWindow?.webContents.send('clipboardError', error.message);
            throw error;
        }
    });

    ipcMain.handle('refreshMonitoring', () => {
        logDebug('Handling refresh monitoring request');
        setupClipboardMonitoring();
    });

    ipcMain.on('checkForUpdates', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });

    ipcMain.handle('getVersionInfo', () => {
        return app.getVersion();
    });

    ipcMain.handle('checkForUpdates', async () => {
        const settings = getSettings();
        if (!settings.preferences.automaticUpdates) {
            logDebug('Auto-updates disabled - manual check requested');
        }
        try {
            const result = await autoUpdater.checkForUpdates();
            return result?.updateInfo?.version !== app.getVersion();
        } catch (error) {
            logDebug('Update check failed:', error);
            // Don't show notification for 404 errors
            if (!error.message.includes('404')) {
                showNotification(
                    'Update Check Failed', 
                    'Could not check for updates. Please try again later.'
                );
            }
            return false;
        }
    });

    ipcMain.handle('getLatestVersion', async () => {
        try {
            const result = await autoUpdater.checkForUpdates();
            return result?.updateInfo?.version;
        } catch (error) {
            logDebug('Failed to get latest version:', error);
            return app.getVersion(); // Return current version if check fails
        }
    });

    ipcMain.on('startUpdate', () => {
        autoUpdater.downloadUpdate();
    });

    ipcMain.handle('saveCustomKeybindings', (event, keybindings) => {
        const settings = getSettings();
        settings.keybindings = keybindings;
        store.set(settings);
        registerCustomKeybindings();
        showNotification('Keybindings Saved', 'Custom keybindings have been updated');
        return settings.keybindings;
    });

    ipcMain.handle('getCustomKeybindings', () => {
        const settings = getSettings();
        return settings.keybindings;
    });

    ipcMain.on('manualRefresh', async () => {
        try {
            await cloudPaste();
        } catch (error) {
            logDebug('Manual refresh failed:', error);
            showNotification('Error', error.message);
            mainWindow?.webContents.send('clipboardError', error.message);
        }
    });
};

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: true
        },
    });

    mainWindow.loadFile('index.html');
};

const checkAndSyncClipboard = async () => {
    const settings = getSettings();
    if (!settings.preferences.automaticClipboardSync) return;

    const appKey = getAppKey();
    if (!appKey) return;

    try {
        const response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey }
        });
        
        const cloudTimestamp = parseInt(response.headers['x-clipboard-timestamp']);
        
        if (cloudTimestamp > lastLocalClipboardTimestamp) {
            await cloudPaste();
        } else if (lastLocalClipboardTimestamp > cloudTimestamp) {
            await cloudCopy();
        }
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
};

let lastClipboardContent = {
    text: '',
    image: null,
    filePath: null
};

const setupClipboardMonitoring = () => {
    logDebug('Setting up clipboard monitoring...');
    
    if (clipboardMonitoringInterval) {
        logDebug('Clearing existing monitoring interval');
        clearInterval(clipboardMonitoringInterval);
        clipboardMonitoringInterval = null;
    }

    const settings = getSettings();
    logDebug('Current settings:', {
        automaticClipboardSync: settings.preferences.automaticClipboardSync
    });

    if (settings.preferences.automaticClipboardSync !== true) {
        logDebug('Automatic clipboard sync disabled');
        return;
    }

    logDebug('Starting clipboard monitoring');
    clipboardMonitoringInterval = setInterval(() => {
        const currentText = clipboard.readText();
        const currentImage = clipboard.readImage();
        
        if (currentText && currentText !== lastClipboardContent.text) {
            lastClipboardContent.text = currentText;
            lastLocalClipboardTimestamp = Date.now();
            cloudCopy();
        }
        
        if (!currentImage.isEmpty() && 
            currentImage.toDataURL() !== lastClipboardContent.image) {
            lastClipboardContent.image = currentImage.toDataURL();
            lastLocalClipboardTimestamp = Date.now();
            cloudCopy();
        }
        
        try {
            const rawFilePaths = clipboard.readBuffer('FileNameW').toString('ucs2');
            const filePaths = rawFilePaths
                .split('\0')
                .filter(Boolean)
                .map(fp => fp.replace(/\\/g, '\\'));
                
            if (filePaths[0] && filePaths[0] !== lastClipboardContent.filePath) {
                lastClipboardContent.filePath = filePaths[0];
                lastLocalClipboardTimestamp = Date.now();
                cloudCopy();
            }
        } catch (error) {
        }
    }, 1000);
};

function setupRefreshInterval() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    const settings = store.get();
    const intervalMs = settings.refreshIntervalSeconds * 1000;
    refreshInterval = setInterval(() => {
        checkAndSyncClipboard();
        mainWindow?.webContents.send('triggerRefresh');
    }, intervalMs);
}

const cloudCopy = async () => {
    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;
    
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
        const tempPath = path.join(app.getPath('temp'), `clipboard-${Date.now()}.png`);
        fs.writeFileSync(tempPath, image.toPNG());
        await cloudCopyFile(tempPath);
        fs.unlinkSync(tempPath);
        mainWindow?.webContents.send('triggerRefresh');
        return;
    }

    const text = clipboard.readText();
    if (text) {
        try {
            await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                headers: { AppKey: appKey },
            });
            mainWindow.webContents.send('refreshClipboard');
            mainWindow?.webContents.send('triggerRefresh');
            showNotification('Clipboard Synced', 'Text copied to cloud clipboard');
        } catch (error) {
            logDebug('Operation failed:', error);
            showNotification('Error', error.message);
            mainWindow?.webContents.send('clipboardError', error.message);
        }
        return;
    }

    try {
        const rawFilePaths = clipboard.readBuffer('FileNameW').toString('ucs2');
        const filePaths = rawFilePaths
            .split('\0')
            .filter(Boolean)
            .map(fp => fp.replace(/\\/g, '\\'));
        
        if (filePaths.length > 0) {
            const filePath = filePaths[0];
            if (fs.existsSync(filePath)) {
                await cloudCopyFile(filePath);
                mainWindow?.webContents.send('triggerRefresh');
            } else {
                console.error('File not found:', filePath);
            }
        }
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
};

const cloudCopyFile = async (filePath) => {
    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;
    
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const form = new FormData();
        const fileStream = fs.createReadStream(filePath);
        const fileName = path.basename(filePath);
        
        form.append('file', fileStream, fileName);
        
        await axios.post(`${settings.apiBaseUrl}/app/copy`, form, {
            headers: { 
                AppKey: appKey,
                ...form.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        mainWindow?.webContents.send('refreshClipboard');
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
        throw error;
    }
};

const cloudPaste = async () => {
    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;

    try {
        const response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey },
            responseType: 'json'
        });

        if (response.data.type === 'text') {
            clipboard.writeText(response.data.content);
            mainWindow?.webContents.send('refreshClipboard');
            showNotification('Clipboard Updated', 'New text content pasted from cloud');
            return;
        }

        const fileResponse = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey },
            responseType: 'arraybuffer'
        });

        const contentType = fileResponse.headers['content-type'];

        if (contentType.startsWith('image/')) {
            const img = nativeImage.createFromBuffer(fileResponse.data);
            clipboard.writeImage(img);
        } else {
            let filename = 'downloaded_file';
            const disposition = fileResponse.headers['content-disposition'];
            if (disposition) {
                const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
                if (filenameMatch) {
                    filename = filenameMatch[1].trim();
                }
            }
            const tempPath = path.join(app.getPath('temp'), filename);
            fs.writeFileSync(tempPath, fileResponse.data);
            clipboard.writeBuffer('FileNameW', Buffer.from(tempPath + '\0', 'ucs2'));
        }

        mainWindow?.webContents.send('refreshClipboard');
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
};

async function handleLatestContent() {
    try {
        const response = await fetch(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: localStorage.getItem('appKey') }
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const filename = response.headers.get('content-disposition')
            ?.split('filename=')[1]?.replace(/"/g, '') || 'clipboard.txt';
        logDebug('Extracted filename:', filename);
        
        const content = await response.text();
        document.getElementById('clipboardText').textContent = content;
        
        const downloadBtn = document.getElementById('downloadBtn');
        downloadBtn.onclick = () => handleFileDownload(filename);
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
}

async function handleFileDownload(filename) {
    try {
        logDebug('Initiating download with filename:', filename);
        const success = await window.electronAPI.downloadFile(filename);
        if (success) {
            document.getElementById('clipboardText').textContent = 'File downloaded successfully!';
        }
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
}

const setupAutoUpdater = () => {
    autoUpdater.logger = {
        info: (msg) => logDebug('Update info:', msg),
        warn: (msg) => logDebug('Update warning:', msg),
        error: (msg) => logDebug('Update error:', msg)
    };

    // Add error handling for the feed URL
    try {
        autoUpdater.setFeedURL({
            provider: 'github',
            owner: 'Crossy-Clipboard',
            repo: 'crossy-electron'
        });
    } catch (error) {
        logDebug('Failed to set update feed URL:', error);
    }

    autoUpdater.on('error', (error) => {
        logDebug('Update error:', error);
        // Only show notification for non-404 errors
        if (!error.message.includes('404')) {
            showNotification(
                'Update Error', 
                'There was a problem checking for updates.'
            );
        }
        mainWindow?.webContents.send('updateError', error.message);
    });

    // Add download update handler
    ipcMain.on('startUpdate', () => {
        logDebug('Starting update download...');
        try {
            showNotification('Update', 'Starting download...');
            autoUpdater.downloadUpdate().catch(err => {
                logDebug('Download failed:', err);
                showNotification('Update Error', 'Failed to download update.');
                mainWindow?.webContents.send('updateError', err.message);
            });
        } catch (error) {
            logDebug('Download start failed:', error);
            showNotification('Update Error', 'Could not start download.');
            mainWindow?.webContents.send('updateError', error.message);
        }
    });

    // Add download progress handler
    autoUpdater.on('download-progress', (progressObj) => {
        const progress = Math.round(progressObj.percent);
        logDebug(`Download progress: ${progress}%`);
        mainWindow?.webContents.send('updateProgress', progress);
    });

    // Add download completion handler 
    autoUpdater.on('update-downloaded', (info) => {
        logDebug('Update downloaded:', info);
        showNotification(
            'Update Ready',
            'Update downloaded. Restart to install.'
        );
        mainWindow?.webContents.send('updateDownloaded', info);
    });
};

const registerCustomKeybindings = () => {
    const settings = getSettings();
    const keybindings = settings.keybindings;

    globalShortcut.unregisterAll();

    globalShortcut.register(keybindings.copy, cloudCopy);
    globalShortcut.register(keybindings.paste, cloudPaste);
};

app.whenReady().then(async () => {
    try {
        await initStore();
        createWindow();
        setupIpcHandlers();
        setupRefreshInterval();
        setupClipboardMonitoring();
        setupAutoUpdater(); // Add this line
        globalShortcut.register('CommandOrControl+Shift+C', cloudCopy);
        globalShortcut.register('CommandOrControl+Shift+V', cloudPaste);
        registerCustomKeybindings(); // Register custom keybindings on app ready

        // Initial update check with error handling
        try {
            await checkForUpdatesIfEnabled();
        } catch (error) {
            logDebug('Initial update check failed:', error);
            // Don't crash the app, continue running
        }

        // Setup auto-updater events
        autoUpdater.on('checking-for-update', () => {
            logDebug('Checking for updates...');
        });

        autoUpdater.on('update-available', (info) => {
            logDebug('Update available:', info);
            showNotification(
                'Update Available', 
                `Version ${info.version} is available for download`
            );
            mainWindow?.webContents.send('updateAvailable', info);
        });

        autoUpdater.on('update-not-available', (info) => {
            logDebug('Update not available:', info);
        });

        autoUpdater.on('download-progress', (progressObj) => {
            logDebug('Download progress:', progressObj);
        });

        autoUpdater.on('update-downloaded', (info) => {
            logDebug('Update downloaded:', info);
            showNotification(
                'Update Ready', 
                'A new update is ready to install. Restart the app to apply the update.'
            );
            mainWindow?.webContents.send('updateDownloaded', info);
        });

        autoUpdater.on('error', (err) => {
            logDebug('Update error:', err);
            showNotification('Update Error', err.message);
            mainWindow?.webContents.send('updateError', err.message);
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    } catch (error) {
        logDebug('Operation failed:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// main.js
import Store from 'electron-store';
import { app, BrowserWindow, globalShortcut, clipboard, ipcMain, dialog, nativeImage } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

const DEFAULT_SETTINGS = {
    apiKey: '',
    preferences: {
        automaticClipboardSync: false,
        notifications: true
    },
    refreshIntervalSeconds: 60,
    apiBaseUrl: 'https://clipboard.cloudydestiny.com',
    theme: {
        primaryColor: '#6200ee',
        hoverColor: '#3700b3',
        bgColor: '#121212',
        surfaceColor: '#1e1e1e',
        textColor: '#ffffff'
    }
};

// Remove the schema constant and modify initStore
const initStore = () => {
    return new Store({
        defaults: DEFAULT_SETTINGS
    });
};

// Make sure initStore is called before use
const store = initStore();

let mainWindow;
let refreshInterval;
let lastLocalClipboardTimestamp = Date.now();
let clipboardMonitoringInterval; // Add this at the top with other global variables

const getSettings = () => {
    const defaults = {
        ...DEFAULT_SETTINGS,
        preferences: {
            ...DEFAULT_SETTINGS.preferences
        }
    };
    
    const settings = store?.store || defaults;
    
    // Ensure preferences exist with correct structure
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
        console.log('[DEBUG] Saving new settings:', newSettings);
        store.set(newSettings);
        setupRefreshInterval();
        return store.get();
    });

    // Add this to your existing IPC handlers in setupIpcHandlers()

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

            // Extract filename from Content-Disposition header as fallback
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
            console.error('Download failed:', error);
            throw error;
        }
    });

    ipcMain.handle('refreshMonitoring', () => {
        console.log('[DEBUG] Handling refresh monitoring request');
        setupClipboardMonitoring();
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

    // Load index.html by default
    mainWindow.loadFile('index.html');
};

const checkAndSyncClipboard = async () => {
    const settings = getSettings();
    if (!settings.preferences.automaticClipboardSync) return;

    const appKey = getAppKey();
    if (!appKey) return;

    try {
        // Get cloud clipboard timestamp
        const response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey }
        });
        
        const cloudTimestamp = parseInt(response.headers['x-clipboard-timestamp']);
        
        // Compare timestamps and sync accordingly
        if (cloudTimestamp > lastLocalClipboardTimestamp) {
            // Cloud is newer, update local
            await cloudPaste();
        } else if (lastLocalClipboardTimestamp > cloudTimestamp) {
            // Local is newer, update cloud
            await cloudCopy();
        }
    } catch (error) {
        console.error('Sync check failed:', error);
    }
};

let lastClipboardContent = {
    text: '',
    image: null,
    filePath: null
};

const setupClipboardMonitoring = () => {
    // Add logging
    console.log('[DEBUG] Setting up clipboard monitoring...');
    
    if (clipboardMonitoringInterval) {
        console.log('[DEBUG] Clearing existing monitoring interval');
        clearInterval(clipboardMonitoringInterval);
        clipboardMonitoringInterval = null;
    }

    const settings = getSettings();
    console.log('[DEBUG] Current settings:', {
        automaticClipboardSync: settings.preferences.automaticClipboardSync
    });

    // Explicitly check boolean value
    if (settings.preferences.automaticClipboardSync !== true) {
        console.log('[INFO] Automatic clipboard sync disabled');
        return;
    }

    console.log('[INFO] Starting clipboard monitoring');
    clipboardMonitoringInterval = setInterval(() => {
        const currentText = clipboard.readText();
        const currentImage = clipboard.readImage();
        
        // Check for changes in text content
        if (currentText && currentText !== lastClipboardContent.text) {
            lastClipboardContent.text = currentText;
            lastLocalClipboardTimestamp = Date.now();
            cloudCopy();
        }
        
        // Check for changes in image content
        if (!currentImage.isEmpty() && 
            currentImage.toDataURL() !== lastClipboardContent.image) {
            lastClipboardContent.image = currentImage.toDataURL();
            lastLocalClipboardTimestamp = Date.now();
            cloudCopy();
        }
        
        // Check for file paths in clipboard
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
            // Ignore errors when no file paths are in clipboard
        }
    }, 1000); // Poll every second
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

// Update the cloudCopy function to properly handle file paths
const cloudCopy = async () => {
    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;
    
    // Check if clipboard has an image
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
        const tempPath = path.join(app.getPath('temp'), `clipboard-${Date.now()}.png`);
        fs.writeFileSync(tempPath, image.toPNG());
        await cloudCopyFile(tempPath);
        fs.unlinkSync(tempPath);
        mainWindow?.webContents.send('triggerRefresh');
        return;
    }

    // Check for text content
    const text = clipboard.readText();
    if (text) {
        try {
            await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                headers: { AppKey: appKey },
            });
            mainWindow.webContents.send('refreshClipboard');
            mainWindow?.webContents.send('triggerRefresh');
        } catch (error) {
            console.error('Failed to copy text to cloud:', error);
        }
        return;
    }

    // Check if clipboard has a file
    try {
        const rawFilePaths = clipboard.readBuffer('FileNameW').toString('ucs2');
        const filePaths = rawFilePaths
            .split('\0')
            .filter(Boolean) // Remove empty strings
            .map(fp => fp.replace(/\\/g, '\\')); // Normalize backslashes
        
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
        console.error('Error reading file from clipboard:', error);
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
        console.error('Failed to copy file to cloud:', error);
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
            // Don't use arraybuffer by default
            responseType: 'json'
        });

        // Handle text content
        if (response.data.type === 'text') {
            clipboard.writeText(response.data.content);
            mainWindow?.webContents.send('refreshClipboard');
            return;
        }

        // For files/images, switch to arraybuffer
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
        console.error('Failed to retrieve from cloud:', error);
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
        console.log('Extracted filename:', filename); // Debug log
        
        const content = await response.text();
        document.getElementById('clipboardText').textContent = content;
        
        // Pass filename to download handler
        const downloadBtn = document.getElementById('downloadBtn');
        downloadBtn.onclick = () => handleFileDownload(filename);
    } catch (error) {
        console.error('Error fetching content:', error);
    }
}

async function handleFileDownload(filename) {
    try {
        console.log('Initiating download with filename:', filename); // Debug log
        const success = await window.electronAPI.downloadFile(filename);
        if (success) {
            document.getElementById('clipboardText').textContent = 'File downloaded successfully!';
        }
    } catch (error) {
        console.error('Download failed:', error);
    }
}

app.whenReady().then(async () => {
    try {
        await initStore();
        createWindow();
        setupIpcHandlers();
        setupRefreshInterval();
        setupClipboardMonitoring();
        globalShortcut.register('CommandOrControl+Shift+C', cloudCopy);
        globalShortcut.register('CommandOrControl+Shift+V', cloudPaste);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    } catch (error) {
        console.error('Startup error:', error);
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

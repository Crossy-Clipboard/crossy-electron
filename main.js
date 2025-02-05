import Store from 'electron-store';
import { app, BrowserWindow, globalShortcut, clipboard, ipcMain, dialog, nativeImage, Notification, Tray, Menu } from 'electron';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import FormData from 'form-data';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

// Add socket.io-client
import { io } from 'socket.io-client';

// Add crypto import
import crypto from 'crypto';

import { tmpdir } from 'os';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_SETTINGS = {
    apiKey: '',
    preferences: {
        automaticClipboardSync: false, // This now controls WebSocket connection
        notifications: false, // Changed to false
        debugLogging: false,
        runInBackground: process.platform === 'darwin', // macOS only, else false
    },
    apiBaseUrl: 'https://api.crossyclip.com',
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

let socket = null;

// Add WebSocket state tracking
let wsConnectionState = {
    isConnecting: false,
    retryCount: 0,
    maxRetries: 3,
    lastError: null
};

// Add near the top with other global variables
const lastClipboardContent = {
    text: '',
    image: '',
    filePath: '',
    timestamp: 0
};

// Add near the top with other state variables
const lastDownloadedContent = {
    timestamp: 0,
    textHash: '',
    imageHash: '',
    filePath: '',
    debounceDelay: 2000 // 2 second delay
};

const DEBOUNCE_DELAY = 1000; // 1 second
let lastOperation = {
    timestamp: 0,
    type: null
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

let tray = null; // Add this line
let mainWindow;
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
        
        // Stop clipboard monitoring
        if (clipboardMonitoringInterval) {
            clearInterval(clipboardMonitoringInterval);
            clipboardMonitoringInterval = null;
        }
        
        registerCustomKeybindings();
        setupWebSocket(); // Update WebSocket connection based on new settings
        
        showNotification('Settings Saved', 'Your settings have been updated successfully');
        
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

    // Add to setupIpcHandlers()
    ipcMain.handle('clearStore', () => {
        try {
            store.clear();
            showNotification('Data Cleared', 'All local data has been cleared');
            return true;
        } catch (error) {
            logDebug('Failed to clear store:', error);
            showNotification('Error', 'Failed to clear local data');
            return false;
        }
    });
};

// Add this to preserve the window instance when closing
const createWindow = () => {
    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: true
        },
        // Add icon for taskbar/dock
        icon: path.join(__dirname, process.platform === 'win32' ? 'build/icon.ico' : 'build/icon.png')
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        const settings = getSettings();
        if (settings.preferences.runInBackground) {
            event.preventDefault();
            mainWindow.hide();
            
            // Handle macOS dock visibility
            if (process.platform === 'darwin') {
                app.dock.hide();
            }
        }
    });

    // Show in taskbar when window is visible
    mainWindow.on('show', () => {
        if (process.platform === 'darwin') {
            app.dock.show();
        }
        mainWindow.setSkipTaskbar(false);
    });
};

// Replace the checkAndSyncClipboard function
const checkAndSyncClipboard = async () => {
    const settings = getSettings();
    if (!settings.preferences.automaticClipboardSync) return;

    const appKey = getAppKey();
    if (!appKey) return;

    // Add debouncing check
    const now = Date.now();
    if (now - lastOperation.timestamp < DEBOUNCE_DELAY) {
        logDebug('Debouncing clipboard check');
        return;
    }

    try {
        const response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey }
        });
        
        const cloudTimestamp = parseInt(response.headers['x-clipboard-timestamp']);
        
        if (cloudTimestamp > lastLocalClipboardTimestamp && 
            lastOperation.type !== 'paste') {
            await cloudPaste();
            lastOperation = { timestamp: Date.now(), type: 'paste' };
        } else if (lastLocalClipboardTimestamp > cloudTimestamp && 
                   lastOperation.type !== 'copy') {
            await cloudCopy();
            lastOperation = { timestamp: Date.now(), type: 'copy' };
        }
    } catch (error) {
        logDebug('Operation failed:', error);
    }
};

// Replace setupClipboardMonitoring function
const setupClipboardMonitoring = () => {
    logDebug('Setting up clipboard monitoring...');
    
    if (clipboardMonitoringInterval) {
        clearInterval(clipboardMonitoringInterval);
        clipboardMonitoringInterval = null;
    }

    const settings = getSettings();
    
    if (!settings.preferences.automaticClipboardSync) {
        logDebug('Automatic clipboard sync disabled');
        return;
    }

    setupWebSocket();

    clipboardMonitoringInterval = setInterval(() => {
        if (!socket?.connected) {
            logDebug('Skipping clipboard check - no connection');
            return;
        }

        const now = Date.now();
        if (now - lastOperation.timestamp < DEBOUNCE_DELAY) {
            return;
        }

        try {
            const currentText = clipboard.readText();
            const currentImage = clipboard.readImage();
            let hasChanged = false;

            if (currentText && currentText !== lastClipboardContent.text) {
                lastClipboardContent.text = currentText;
                lastClipboardContent.timestamp = now;
                hasChanged = true;
            }
            
            if (!currentImage.isEmpty() && 
                currentImage.toDataURL() !== lastClipboardContent.image) {
                lastClipboardContent.image = currentImage.toDataURL();
                lastClipboardContent.timestamp = now;
                hasChanged = true;
            }
            
            try {
                const rawFilePaths = clipboard.readBuffer('FileNameW').toString('ucs2');
                const filePaths = rawFilePaths
                    .split('\0')
                    .filter(Boolean)
                    .map(fp => fp.replace(/\\/g, '\\'));
                    
                if (filePaths[0] && filePaths[0] !== lastClipboardContent.filePath) {
                    lastClipboardContent.filePath = filePaths[0];
                    lastClipboardContent.timestamp = now;
                    hasChanged = true;
                }
            } catch (error) {
                // Ignore file reading errors
            }

            if (hasChanged) {
                lastLocalClipboardTimestamp = now;
                lastOperation = { timestamp: now, type: 'copy' };
                cloudCopy();
            }
        } catch (error) {
            logDebug('Clipboard monitoring error:', error);
        }
    }, 1000);
};

// Add helper function for hashing content
function hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

// Update the cloudCopy function's WebSocket notification
const cloudCopy = async () => {
    const now = Date.now();
    if (now - lastDownloadedContent.timestamp < lastDownloadedContent.debounceDelay) {
        logDebug('Skipping upload - too soon after download');
        return;
    }

    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;
    
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
        const imageHash = hashContent(image.toPNG());
        if (imageHash === lastDownloadedContent.imageHash) {
            logDebug('Skipping upload - image matches last download');
            return;
        }
        const tempPath = path.join(app.getPath('temp'), `clipboard-${Date.now()}.png`);
        fs.writeFileSync(tempPath, image.toPNG());
        await cloudCopyFile(tempPath);
        fs.unlinkSync(tempPath);
        mainWindow?.webContents.send('triggerRefresh');
        
        // After successful copy, emit update event
        if (socket?.connected) {
            socket.emit('clipboard_update', null, (error) => {
                if (error) {
                    logDebug('Failed to send clipboard update:', error);
                } else {
                    logDebug('Clipboard update sent successfully');
                }
            });
        }
        return;
    }

    const text = clipboard.readText();
    if (text) {
        const textHash = hashContent(text);
        if (textHash === lastDownloadedContent.textHash) {
            logDebug('Skipping upload - text matches last download');
            return;
        }
        try {
            await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                headers: { AppKey: appKey },
            });
            mainWindow?.webContents.send('triggerRefresh');
            showNotification('Clipboard Synced', 'Text copied to cloud clipboard');
            
            if (socket?.connected) {
                socket.emit('clipboard_update', null, (error) => {
                    if (error) {
                        logDebug('Failed to send clipboard update:', error);
                    } else {
                        logDebug('Clipboard update sent successfully');
                    }
                });
            }
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
            if (filePath && filePath === lastDownloadedContent.filePath) {
                logDebug('Skipping upload - file matches last download');
                return;
            }
            if (fs.existsSync(filePath)) {
                await cloudCopyFile(filePath);
                mainWindow?.webContents.send('triggerRefresh');
                
                // After successful copy, emit update event
                if (socket?.connected) {
                    socket.emit('clipboard_update', null, (error) => {
                        if (error) {
                            logDebug('Failed to send clipboard update:', error);
                        } else {
                            logDebug('Clipboard update sent successfully');
                        }
                    });
                }
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

// Update cloudPaste to track downloaded content
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
            const textContent = response.data.content;
            lastDownloadedContent.textHash = hashContent(textContent);
            lastDownloadedContent.timestamp = Date.now();
            clipboard.writeText(textContent);
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
            const imgBuffer = fileResponse.data;
            lastDownloadedContent.imageHash = hashContent(imgBuffer);
            lastDownloadedContent.timestamp = Date.now();
            const img = nativeImage.createFromBuffer(imgBuffer);
            clipboard.writeImage(img);
        } else {
            // Handle file downloads
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
            lastDownloadedContent.filePath = tempPath;
            lastDownloadedContent.timestamp = Date.now();
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

// Add this helper function
async function ensureUpdateDirectories() {
    const updateDir = path.join(tmpdir(), 'crossy-electron-updater');
    const pendingDir = path.join(updateDir, 'pending');
    const tempDir = path.join(updateDir, 'pending-temp');
    
    try {
        await fs.mkdir(updateDir, { recursive: true });
        await fs.mkdir(pendingDir, { recursive: true });
        await fs.mkdir(tempDir, { recursive: true });
    } catch (error) {
        logDebug('Failed to create update directories:', error);
    }
}

// Update the setupAutoUpdater function
const setupAutoUpdater = () => {
    autoUpdater.logger = {
        info: (msg) => logDebug('Update info:', msg),
        warn: (msg) => logDebug('Update warning:', msg),
        error: (msg) => logDebug('Update error:', msg)
    };

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    try {
        autoUpdater.setFeedURL({
            provider: 'github',
            owner: 'Crossy-Clipboard',
            repo: 'crossy-electron',
            private: false
        });
    } catch (error) {
        logDebug('Failed to set update feed URL:', error);
    }

    // Add pre-update check
    autoUpdater.on('checking-for-update', async () => {
        logDebug('Checking for updates...');
        await ensureUpdateDirectories();
    });

    // Update the download handler
    ipcMain.on('startUpdate', async () => {
        logDebug('Starting update download...');
        try {
            await ensureUpdateDirectories();
            showNotification('Update', 'Starting download...');
            await autoUpdater.downloadUpdate();
        } catch (error) {
            logDebug('Download start failed:', error);
            showNotification('Update Error', 'Could not start download.');
            mainWindow?.webContents.send('updateError', error.message);
        }
    });

    autoUpdater.on('error', async (error) => {
        logDebug('Update error:', error);
        
        // Clean up failed update files
        try {
            const updateDir = path.join(tmpdir(), 'crossy-electron-updater');
            await fs.rm(updateDir, { recursive: true, force: true });
            await ensureUpdateDirectories();
        } catch (cleanupError) {
            logDebug('Cleanup failed:', cleanupError);
        }

        // Only show notification for non-404 errors
        if (!error.message.includes('404')) {
            showNotification(
                'Update Error', 
                'There was a problem with the update. Please try again.'
            );
        }
        mainWindow?.webContents.send('updateError', error.message);
    });

    autoUpdater.on('update-downloaded', async (info) => {
        logDebug('Update downloaded:', info);
        showNotification(
            'Update Ready',
            'Update downloaded. The app will update on next restart.'
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

// Update the setupWebSocket function
const setupWebSocket = () => {
    const settings = getSettings();
    const appKey = getAppKey();

    logDebug('Setting up WebSocket connection...');
    logDebug('Auto-sync enabled:', settings.preferences.automaticClipboardSync);
    logDebug('App key present:', !!appKey);

    if (socket) {
        logDebug('Cleaning up existing socket connection');
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }

    if (!settings.preferences.automaticClipboardSync || !appKey) {
        logDebug('WebSocket setup skipped - sync disabled or no app key');
        return;
    }

    try {
        wsConnectionState.isConnecting = true;
        wsConnectionState.retryCount = 0;
        
        logDebug('Connecting to WebSocket server:', settings.apiBaseUrl);
        socket = connectSocket(settings, appKey);

        socket.on('connect', () => {
            logDebug('WebSocket connected successfully');
            wsConnectionState.isConnecting = false;
            wsConnectionState.retryCount = 0;
            wsConnectionState.lastError = null;
        });

        socket.on('connect_error', (error) => {
            wsConnectionState.lastError = error;
            logDebug('WebSocket connection error:', {
                message: error.message,
                type: error.type,
                description: error.description,
                attempt: wsConnectionState.retryCount + 1
            });

            if (wsConnectionState.retryCount < wsConnectionState.maxRetries) {
                wsConnectionState.retryCount++;
                logDebug(`Retrying connection (${wsConnectionState.retryCount}/${wsConnectionState.maxRetries})`);
            } else {
                logDebug('Max retry attempts reached');
                showNotification('Connection Error', 
                    `Failed to connect after ${wsConnectionState.maxRetries} attempts`);
            }
        });

        socket.on('disconnect', (reason) => {
            logDebug('WebSocket disconnected:', reason);
            if (reason === 'io server disconnect') {
                // Server disconnected us, attempt reconnection
                socket.connect();
            }
        });

        socket.on('error', (error) => {
            logDebug('WebSocket error:', error);
            showNotification('WebSocket Error', 'Connection error occurred');
        });

        // Debug events
        socket.onAny((event, ...args) => {
            logDebug('WebSocket event:', { event, args });
        });

        socket.on('clipboard_update', async () => {
            logDebug('Received clipboard_update event');
            
            // Check if we just performed an operation
            const now = Date.now();
            if (now - lastOperation.timestamp < DEBOUNCE_DELAY) {
                logDebug('Skipping clipboard update - too soon after last operation');
                return;
            }

            try {
                await cloudPaste(); // Fetch and apply latest content
                lastOperation = { timestamp: now, type: 'paste' };
                mainWindow?.webContents.send('triggerRefresh'); // Update UI
                // showNotification('Clipboard Updated', 'New content received');
            } catch (error) {
                logDebug('Failed to handle clipboard update:', error);
                showNotification('Error', 'Failed to sync latest clipboard content');
            }
        });
        
    } catch (error) {
        wsConnectionState.lastError = error;
        logDebug('Error setting up WebSocket:', {
            message: error.message,
            stack: error.stack
        });
        showNotification('Connection Error', 'Failed to initialize connection');
    }
};

// Update the connectSocket function
function connectSocket(settings, appKey) {
    if (!settings || !appKey) {
        throw new Error('Missing required connection parameters');
    }

    logDebug('Creating socket connection with:', {
        url: settings.apiBaseUrl,
        transports: ['websocket']
    });

    const socket = io(settings.apiBaseUrl, {
        auth: { appKey },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 3,
        reconnectionDelay: 1000,
        timeout: 5000,
        forceNew: true
    });

    return socket;
}

// Update the createTray function with better implementation
const createTray = () => {
    if (tray !== null) return;

    try {
        // Determine icon path based on platform
        const iconPath = path.join(__dirname, 
            process.platform === 'win32' ? 'build/icon.ico' : 'build/icon.png'
        );

        // Create tray with error handling
        try {
            tray = new Tray(iconPath);
        } catch (iconError) {
            logDebug('Failed to load tray icon:', iconError);
            // Fallback to default icon if custom icon fails
            tray = new Tray();
        }

        // Create more detailed context menu
        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Open Crossy Clipboard',
                click: () => {
                    mainWindow?.show();
                    mainWindow?.focus();
                    if (process.platform === 'darwin') {
                        app.dock.show();
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Copy to Cloud',
                click: async () => {
                    try {
                        await cloudCopy();
                    } catch (error) {
                        showNotification('Error', 'Failed to copy to cloud');
                    }
                }
            },
            {
                label: 'Paste from Cloud',
                click: async () => {
                    try {
                        await cloudPaste();
                    } catch (error) {
                        showNotification('Error', 'Failed to paste from cloud');
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Settings',
                click: () => {
                    mainWindow?.show();
                    mainWindow?.focus();
                    mainWindow?.webContents.send('showSettings');
                }
            },
            { type: 'separator' },
            { 
                label: 'Quit',
                click: () => {
                    // Cleanup before quit
                    if (tray) {
                        tray.destroy();
                        tray = null;
                    }
                    app.quit();
                }
            }
        ]);

        // Set up tray properties
        tray.setToolTip('Crossy Clipboard');
        tray.setContextMenu(contextMenu);

        // Handle platform-specific click behavior
        if (process.platform === 'win32' || process.platform === 'linux') {
            // Single click shows window on Windows/Linux
            tray.on('click', () => {
                if (mainWindow) {
                    if (mainWindow.isVisible()) {
                        mainWindow.hide();
                    } else {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            });
        }

        // Handle tray icon double click
        tray.on('double-click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });

    } catch (error) {
        logDebug('Failed to create tray:', error);
        showNotification('Error', 'Failed to create system tray icon');
    }
};

// Add tray cleanup to app quit events
app.on('before-quit', () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

// Add single instance lock handler
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.log('Another instance is running - quitting');
    app.quit();
} else {
    app.on('second-instance', () => {
        // Someone tried to run a second instance, focus our window instead
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Update app.whenReady()
    app.whenReady().then(async () => {
        try {
            await initStore();
            createWindow();
            createTray();
            setupIpcHandlers();
            setupClipboardMonitoring();
            setupAutoUpdater(); // Add this line
            globalShortcut.register('CommandOrControl+Shift+C', cloudCopy);
            globalShortcut.register('CommandOrControl+Shift+V', cloudPaste);
            registerCustomKeybindings(); // Register custom keybindings on app ready

            if (process.platform === 'darwin') {
                app.dock.setIcon(path.join(__dirname, 'build/icon.png'));
            }
    
            // Setup auto-updater events
            autoUpdater.on('checking-for-update', () => {
                logDebug('Checking for updates...');
            });
    
            autoUpdater.on('update-available', (info) => {
                logDebug('Update available:', info);
                showNotification(
                    'Update Available', 
                    `Version v${info.version} is available for download`  // Add 'v' prefix
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
}

// Update the window-all-closed handler
app.on('window-all-closed', () => {
    const settings = getSettings();
    if (!settings.preferences.runInBackground) {
        if (tray) {
            try {
                tray.destroy();
                tray = null;
            } catch (error) {
                logDebug('Error destroying tray:', error);
            }
        }
        app.quit();
    }
});

// Update the will-quit handler
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tray) {
        try {
            tray.destroy();
            tray = null;
        } catch (error) {
            logDebug('Error destroying tray:', error);
        }
    }
});

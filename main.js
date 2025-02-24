import Store from 'electron-store';
import { app, BrowserWindow, globalShortcut, clipboard, ipcMain, dialog, nativeImage, Notification, Tray, Menu } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import mime from 'mime';

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
    apiBaseUrl: 'https://dev.crossyclip.com',
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

// Add near the top with other state variables
const lastDownloadedContent = {
    timestamp: 0,
    textHash: '',
    imageHash: '',
    filePath: '',
    debounceDelay: 2000 // 2 second delay
};

const lastClipboardContent = {
    text: '',
    image: null, // Initialize as null
    timestamp: 0, // Use 0 to force initial sync
};

const DEBOUNCE_DELAY = 1000; // 1 second
let lastOperation = {
    timestamp: 0,
    type: null
};

const PROCESSING_TIMEOUT = 10000; // 10 seconds maximum processing time

const syncState = {
    isProcessing: false,
    processingTimeout: null,
    localHash: '',
    cloudHash: '',
    lastOperation: {
        type: null,
        timestamp: 0
    },
    async beginProcessing() {
        if (this.isProcessing) {
            // If processing has been stuck for too long, force reset
            if (Date.now() - this.lastOperation.timestamp > PROCESSING_TIMEOUT) {
                logDebug('Force releasing stuck processing lock');
                this.endProcessing();
            } else {
                return false;
            }
        }
        
        this.isProcessing = true;
        this.lastOperation.timestamp = Date.now();
        
        // Set timeout to auto-release lock
        this.processingTimeout = setTimeout(() => {
            logDebug('Processing timeout reached, auto-releasing lock');
            this.endProcessing();
        }, PROCESSING_TIMEOUT);
        
        return true;
    },
    endProcessing() {
        if (this.processingTimeout) {
            clearTimeout(this.processingTimeout);
            this.processingTimeout = null;
        }
        this.isProcessing = false;
    },
    updateLocal(content) {
        this.localHash = content ? hashContent(content) : '';
        logDebug('Local state updated:', { hash: this.localHash });
    },
    updateCloud(content) {
        this.cloudHash = content ? hashContent(content) : '';
        logDebug('Cloud state updated:', { hash: this.cloudHash });
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

// Update the showNotification function with safety checks
function showNotification(title, body) {
    try {
        const settings = getSettings();
        if (settings.preferences.notifications && !app.isQuitting) {
            // Check if app is not being destroyed
            if (Notification.isSupported()) {
                new Notification({ 
                    title, 
                    body,
                    silent: false
                }).show();
            }
        }
        // Only try to send to window if it exists and is not destroyed
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('showInAppNotification', { title, body });
        }
    } catch (error) {
        logDebug('Failed to show notification:', error);
    }
}

const initStore = () => {
    return new Store({
        defaults: DEFAULT_SETTINGS
    });
};

const store = initStore();

let tray = null; // Add this line
let mainWindow;


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

    ipcMain.handle('saveApiKey', (event, key) => {
        saveAppKey(key);
        return true;
    });

    // Add this new handler
    ipcMain.handle('cloudCopy', async () => {
        try {
            await cloudCopy();
            return true;
        } catch (error) {
            logDebug('cloudCopy IPC handler error:', error);
            throw error;
        }
    });

    ipcMain.handle('getLastLocalTimestamp', () => {
        return lastLocalClipboardTimestamp;
    });

    ipcMain.handle('downloadCloudContent', async () => {
        try {
            await cloudPaste();
            return true;
        } catch (error) {
            logDebug('Download failed:', error);
            throw error;
        }
    });

    ipcMain.handle('uploadLocalContent', async () => {
        try {
            await cloudCopy();
            return true;
        } catch (error) {
            logDebug('Upload failed:', error);
            throw error;
        }
    });

    ipcMain.handle('syncClipboard', async () => {
        try {
            // Simply trigger a display refresh without modifying clipboards
            mainWindow?.webContents.send('triggerRefresh');
            return { success: true };
        } catch (error) {
            logDebug('Display refresh failed:', error);
            throw error;
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

const setupClipboardMonitoring = () => {
    const settings = getSettings();
    if (!settings.preferences.automaticClipboardSync) {
        logDebug('Automatic clipboard sync disabled');
        return;
    }

    setupWebSocket();

    let lastText = clipboard.readText();
    setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        const currentText = clipboard.readText();
        if (currentText !== lastText) {
            lastText = currentText;
            handleLocalClipboardChange();
        } else {
            handleLocalClipboardChange(); // Check for images/files
        }
    }, 1000);

    mainWindow.on('focus', handleLocalClipboardChange);
};

// Add new function to handle local clipboard changes
const handleLocalClipboardChange = async () => {
    if (!socket?.connected) {
        logDebug('Skipping clipboard update - no connection');
        return;
    }

    const now = Date.now();
    if (now - lastOperation.timestamp < DEBOUNCE_DELAY) {
        logDebug('Skipping clipboard update - debounce');
        return;
    }

    try {
        if (!await syncState.beginProcessing()) {
            logDebug('Skipping clipboard update - sync in progress');
            return;
        }

        const formats = clipboard.availableFormats();

        // Priority 1: Files
        if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
            const filePaths = clipboard.readBuffer('public.file-url').toString('utf8').split('\n').filter(Boolean);
            if (filePaths.length > 0) {
                const filePath = filePaths[0].replace('file://', '');
                if (fs.existsSync(filePath) && filePath !== lastDownloadedContent.filePath) {
                    await cloudCopyFile(filePath);
                    lastClipboardContent.timestamp = now;
                    lastOperation = { timestamp: now, type: 'copy' };
                }
            }
        }
        // Priority 2: Images
        else if (!clipboard.readImage().isEmpty()) {
            const image = clipboard.readImage();
            const imageHash = hashContent(image.toPNG());
            if (imageHash !== lastDownloadedContent.imageHash) {
                const tempPath = path.join(app.getPath('temp'), `clipboard-${now}.png`);
                fs.writeFileSync(tempPath, image.toPNG());
                await cloudCopyFile(tempPath);
                fs.unlinkSync(tempPath);
                lastClipboardContent.image = image;
                lastClipboardContent.timestamp = now;
                lastOperation = { timestamp: now, type: 'copy' };
            }
        }
        // Priority 3: Text
        else {
            const text = clipboard.readText();
            if (text && text !== lastClipboardContent.text) {
                const textHash = hashContent(text);
                if (textHash !== lastDownloadedContent.textHash) {
                    const settings = getSettings();
                    const appKey = getAppKey();
                    await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                        headers: { AppKey: appKey },
                    });
                    lastClipboardContent.text = text;
                    lastClipboardContent.timestamp = now;
                    lastOperation = { timestamp: now, type: 'copy' };
                }
            }
        }
    } catch (error) {
        logDebug('Clipboard monitoring error:', error);
        showNotification('Sync Error', 'Failed to sync clipboard changes');
    } finally {
        syncState.endProcessing();
    }
};

// Add helper function for hashing content
function hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

// Update the cloudCopy function's WebSocket notification
const cloudCopy = async () => {
    try {
        if (!await syncState.beginProcessing()) {
            logDebug('Skipping upload - sync in progress');
            return;
        }

        const appKey = getAppKey();
        const settings = getSettings();
        if (!appKey) {
            logDebug('No app key provided');
            return;
        }

        const formats = clipboard.availableFormats();

        // Priority 1: Files
        if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
            const filePaths = clipboard.readBuffer('public.file-url').toString('utf8').split('\n').filter(Boolean);
            if (filePaths.length > 0) {
                const filePath = filePaths[0].replace('file://', '');
                if (fs.existsSync(filePath) && filePath !== lastDownloadedContent.filePath) {
                    await cloudCopyFile(filePath);
                    mainWindow?.webContents.send('triggerRefresh');
                }
            }
        }
        // Priority 2: Images
        else if (!clipboard.readImage().isEmpty()) {
            const image = clipboard.readImage();
            const imageHash = hashContent(image.toPNG());
            if (imageHash !== lastDownloadedContent.imageHash) {
                const tempPath = path.join(app.getPath('temp'), `clipboard-${Date.now()}.png`);
                fs.writeFileSync(tempPath, image.toPNG());
                await cloudCopyFile(tempPath);
                fs.unlinkSync(tempPath);
                mainWindow?.webContents.send('triggerRefresh');
            }
        }
        // Priority 3: Text
        else {
            const text = clipboard.readText();
            if (text) {
                const textHash = hashContent(text);
                if (textHash !== lastDownloadedContent.textHash) {
                    await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                        headers: { AppKey: appKey },
                    });
                    mainWindow?.webContents.send('triggerRefresh');
                    showNotification('Clipboard Uploaded', 'Text copied to cloud clipboard');
                }
            }
        }
    } catch (error) {
        logDebug('cloudCopy error:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    } finally {
        syncState.endProcessing();
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
        const mimeType = mime.lookup(filePath) || 'application/octet-stream';

        form.append('file', fileStream, {
            filename: fileName,
            contentType: mimeType,
        });

        await axios.post(`${settings.apiBaseUrl}/app/copy`, form, {
            headers: {
                AppKey: appKey,
                ...form.getHeaders(),
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        mainWindow?.webContents.send('refreshClipboard');
        showNotification('Clipboard Uploaded', 'File copied to cloud clipboard');
    } catch (error) {
        logDebug('cloudCopyFile error:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
        throw error;
    }
};

// Update cloudPaste to track downloaded content
const cloudPaste = async () => {
    if (syncState.isProcessing) {
        logDebug('Skipping download - sync in progress');
        return;
    }

    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;

    try {
        syncState.lastOperation = { type: 'download', timestamp: Date.now() };

        let response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey },
            responseType: 'json',
        });

        if (response.data.type === 'text') {
            const textContent = response.data.content;
            lastDownloadedContent.textHash = hashContent(textContent);
            lastDownloadedContent.timestamp = Date.now();
            lastDownloadedContent.imageHash = '';
            lastDownloadedContent.filePath = '';
            clipboard.writeText(textContent);
            showNotification('Clipboard Downloaded', 'New text content pasted from cloud');
        } else {
            response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
                headers: { AppKey: appKey },
                responseType: 'arraybuffer',
            });

            const contentType = response.headers['content-type'];
            if (contentType.startsWith('image/')) {
                const imgBuffer = Buffer.from(response.data);
                lastDownloadedContent.imageHash = hashContent(imgBuffer);
                lastDownloadedContent.timestamp = Date.now();
                lastDownloadedContent.textHash = '';
                lastDownloadedContent.filePath = '';
                const img = nativeImage.createFromBuffer(imgBuffer);
                clipboard.writeImage(img);
                showNotification('Clipboard Downloaded', 'New image content pasted from cloud');
            } else {
                let filename = 'downloaded_file';
                const disposition = response.headers['content-disposition'];
                if (disposition) {
                    const match = disposition.match(/filename="?([^"]+)"?/);
                    if (match) filename = match[1].trim();
                }
                const tempPath = path.join(app.getPath('temp'), filename);
                fs.writeFileSync(tempPath, Buffer.from(response.data));
                lastDownloadedContent.filePath = tempPath;
                lastDownloadedContent.timestamp = Date.now();
                lastDownloadedContent.textHash = '';
                lastDownloadedContent.imageHash = '';
                clipboard.writeBuffer('public.file-url', Buffer.from(`file://${tempPath}`));
                showNotification('Clipboard Downloaded', 'New file content pasted from cloud');
            }
        }

        mainWindow?.webContents.send('refreshClipboard');
    } catch (error) {
        logDebug('cloudPaste error:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
};

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
            await fs.rm(updateDir, { recursive: true, force: true }).catch(() => {});
        } catch (cleanupError) {
            logDebug('Cleanup failed:', cleanupError);
        }

        // Only show notification if app is not quitting
        if (!app.isQuitting && !error.message.includes('404')) {
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('updateError', error.message);
                }
            } catch (notifyError) {
                logDebug('Failed to send update error to window:', notifyError);
            }
        }
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

const setupWebSocket = () => {
    const settings = getSettings();
    const appKey = getAppKey();

    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }

    if (!settings.preferences.automaticClipboardSync || !appKey) {
        logDebug('WebSocket setup skipped - sync disabled or no app key');
        return;
    }

    socket = io(settings.apiBaseUrl, {
        auth: { appKey },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 3,
        reconnectionDelay: 1000,
    });

    socket.on('clipboard_update', async () => {
        logDebug('Received clipboard_update event');
        if (!await syncState.beginProcessing()) {
            logDebug('Skipping server update - sync in progress');
            return;
        }
        try {
            await cloudPaste();
        } finally {
            syncState.endProcessing();
        }
    });

    socket.on('connect', () => logDebug('WebSocket connected'));
    socket.on('disconnect', () => logDebug('WebSocket disconnected'));
    socket.on('connect_error', (error) => logDebug('WebSocket error:', error));
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
        forceNew: true,
        pingTimeout: 30000,    // How long to wait for pong
        pingInterval: 25000    // How often to ping
    });

    // Add keepalive ping
    const pingInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('ping');
        }
    }, 25000);

    socket.on('pong', () => {
        logDebug('Received pong from server');
    });

    socket.on('disconnect', () => {
        clearInterval(pingInterval);
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
                    mainWindow?.loadFile('settings.html');
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
                logDebug('Update not available, release name: ', info.releaseName, "\nPath: ", info.path);
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

// Add cleanup handling
let isCleaningUp = false;

const cleanup = async () => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    
    try {
        app.isQuitting = true;
        
        // Unregister shortcuts
        globalShortcut.unregisterAll();
        
        // Destroy tray
        if (tray) {
            try {
                tray.destroy();
                tray = null;
            } catch (error) {
                logDebug('Error destroying tray:', error);
            }
        }
        
        // Clear update directory
        try {
            const updateDir = path.join(tmpdir(), 'crossy-electron-updater');
            await fs.promises.rm(updateDir, { recursive: true, force: true }).catch(() => {});
        } catch (error) {
            logDebug('Error cleaning update directory:', error);
        }
        
        // Close socket connection
        if (socket) {
            socket.disconnect();
            socket = null;
        }

        // Stop polling local clipboard
        clearInterval(pollInterval);
        
    } catch (error) {
        logDebug('Error during cleanup:', error);
    } finally {
        isCleaningUp = false;
    }
};

// Update quit handlers
app.on('before-quit', async (event) => {
    if (!isCleaningUp) {
        event.preventDefault();
        await cleanup();
        app.quit();
    }
});

app.on('will-quit', async (event) => {
    if (!isCleaningUp) {
        event.preventDefault();
        await cleanup();
        app.quit();
    }
});

// Update the window-all-closed handler
app.on('window-all-closed', async () => {
    const settings = getSettings();
    if (!settings.preferences.runInBackground) {
        if (!isCleaningUp) {
            await cleanup();
            app.quit();
        }
    }
});

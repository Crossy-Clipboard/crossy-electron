import { app, BrowserWindow, globalShortcut, Notification, dialog, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';

// Import modules
import logger from '../../utils/logger.js';
import helper from '../../utils/helper.js';
import store from './store.js';
import clipboard from './clipboard.js';
import tray from './tray.js';
import updater from './updater.js';
import websocket from './websocket.js';
import axios from 'axios';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = path.join(__dirname, '../..');

// Global state
let mainWindow = null;
let socket = null;
let pollInterval = null;
let isCleaningUp = false;

/**
 * Create the main application window
 * @returns {BrowserWindow} The created window
 */
function createWindow() {
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
        icon: path.join(rootDir, process.platform === 'win32' ? 'build/icon.ico' : 'build/icon.png')
    });

    mainWindow.loadFile(path.join(rootDir, 'index.html'));

    mainWindow.on('close', (event) => {
        const settings = store.getSettings();
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

    return mainWindow;
}

/**
 * Show a notification if enabled in settings
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 */
function showNotification(title, body) {
    try {
        const settings = store.getSettings();
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
        logger.logDebug('Failed to show notification:', error);
    }
}

/**
 * Register global keyboard shortcuts
 */
function registerCustomKeybindings() {
    const settings = store.getSettings();
    const keybindings = settings.keybindings;
    const appKey = store.getApiKey();

    globalShortcut.unregisterAll();

    if (!appKey) {
        logger.logDebug('No API key found, skipping keybinding registration');
        return;
    }

    try {
        globalShortcut.register(keybindings.copy, async () => {
            await clipboard.cloudCopy(
                store.getSettings(),
                appKey,
                mainWindow,
                showNotification
            );
        });

        globalShortcut.register(keybindings.paste, async () => {
            await clipboard.cloudPaste(
                store.getSettings(),
                appKey,
                mainWindow,
                showNotification
            );
        });
    } catch (error) {
        logger.logDebug('Failed to register keybindings:', error);
        showNotification('Error', 'Failed to register keyboard shortcuts');
    }
}

/**
 * Setup WebSocket connection to server
 */
function setupWebSocket() {
    const settings = store.getSettings();
    const appKey = store.getApiKey();

    // Disconnect existing socket if any
    websocket.disconnectSocket();

    if (!settings.preferences.automaticClipboardSync || !appKey) {
        logger.logDebug('WebSocket setup skipped - sync disabled or no app key');
        return;
    }

    socket = websocket.connectSocket(settings, appKey, async () => {
        // This function is called when clipboard_update event is received
        await clipboard.cloudPaste(
            settings,
            appKey,
            mainWindow,
            showNotification
        );
    });
}

/**
 * Setup all IPC handlers for renderer process communication
 */
function setupIpcHandlers() {
    const appKey = store.getApiKey();
    const settings = store.getSettings();
    
    // API key management
    ipcMain.on('saveApiKey', (event, key) => {
        store.saveApiKey(key);
    });

    ipcMain.handle('getApiKey', () => {
        return store.getApiKey();
    });

    ipcMain.handle('saveApiKey', (event, key) => {
        store.saveApiKey(key);
        return true;
    });
    
    // Settings management
    ipcMain.handle('getSettings', () => {
        return store.getSettings();
    });

    ipcMain.handle('saveSettings', async (event, newSettings) => {
        logger.logDebug('Saving new settings:', newSettings);
        const updatedSettings = store.saveSettings(newSettings);
        
        // Apply changes that affect runtime behavior
        logger.setDebugLogging(newSettings.preferences.debugLogging);
        registerCustomKeybindings();
        setupWebSocket();
        
        showNotification('Settings Saved', 'Your settings have been updated successfully');
        
        return updatedSettings;
    });

    ipcMain.handle('clearStore', () => {
        try {
            store.clearStore();
            showNotification('Data Cleared', 'All local data has been cleared');
            return true;
        } catch (error) {
            logger.logDebug('Failed to clear store:', error);
            showNotification('Error', 'Failed to clear local data');
            return false;
        }
    });

    // File operations
    ipcMain.handle('selectFile', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile']
        });
        if (!result.canceled) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('saveFile', async (event, suggestedName) => {
        const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: suggestedName,
            properties: ['createDirectory', 'showOverwriteConfirmation']
        });
        return result.filePath;
    });

    // Clipboard operations
    ipcMain.handle('copyFile', async (event, filePath) => {
        await clipboard.cloudCopyFile(
            settings,
            appKey,
            filePath,
            mainWindow,
            showNotification
        );
    });

    ipcMain.handle('cloudCopy', async () => {
        try {
            await clipboard.cloudCopy(
                settings,
                appKey,
                mainWindow,
                showNotification
            );
            return true;
        } catch (error) {
            logger.logDebug('cloudCopy IPC handler error:', error);
            throw error;
        }
    });

    ipcMain.handle('downloadCloudContent', async () => {
        try {
            await clipboard.cloudPaste(
                settings,
                appKey,
                mainWindow,
                showNotification
            );
            return true;
        } catch (error) {
            logger.logDebug('Download failed:', error);
            throw error;
        }
    });

    ipcMain.handle('uploadLocalContent', async () => {
        try {
            await clipboard.cloudCopy(
                settings,
                appKey,
                mainWindow,
                showNotification
            );
            return true;
        } catch (error) {
            logger.logDebug('Upload failed:', error);
            throw error;
        }
    });

    // Download operations
    ipcMain.handle('downloadFile', async (event, filename) => {
        try {
            const appKey = store.getApiKey();
            const settings = store.getSettings();
            
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
                await fs.writeFile(result.filePath, response.data);
                return true;
            }
            return false;
        } catch (error) {
            logger.logDebug('Operation failed:', error);
            showNotification('Error', error.message);
            mainWindow?.webContents.send('clipboardError', error.message);
            throw error;
        }
    });

    // Update operations
    ipcMain.on('checkForUpdates', () => {
        updater.autoUpdater.checkForUpdatesAndNotify();
    });

    ipcMain.handle('getVersionInfo', () => {
        return app.getVersion();
    });

    ipcMain.handle('checkForUpdates', async () => {
        return await updater.checkForUpdates();
    });

    ipcMain.handle('getLatestVersion', async () => {
        return await updater.getLatestVersion();
    });

    ipcMain.on('startUpdate', () => {
        updater.downloadUpdate().catch(error => {
            logger.logDebug('Update download failed:', error);
            showNotification('Update Error', 'Failed to download update');
        });
    });

    // Keybinding operations
    ipcMain.handle('saveCustomKeybindings', (event, keybindings) => {
        const settings = store.getSettings();
        settings.keybindings = keybindings;
        store.saveSettings(settings);
        registerCustomKeybindings();
        showNotification('Keybindings Saved', 'Custom keybindings have been updated');
        return settings.keybindings;
    });

    ipcMain.handle('getCustomKeybindings', () => {
        const settings = store.getSettings();
        return settings.keybindings;
    });

    // Refresh operations
    ipcMain.on('manualRefresh', async () => {
        try {
            await clipboard.cloudPaste(
                settings,
                appKey,
                mainWindow,
                showNotification
            );
        } catch (error) {
            logger.logDebug('Manual refresh failed:', error);
            mainWindow?.webContents.send('clipboardError', error.message);
        }
    });

    ipcMain.handle('refreshMonitoring', () => {
        logger.logDebug('Handling refresh monitoring request');
        setupClipboardMonitoring();
        return true;
    });

    ipcMain.handle('syncClipboard', async () => {
        try {
            // Simply trigger a display refresh without modifying clipboards
            mainWindow?.webContents.send('triggerRefresh');
            return { success: true };
        } catch (error) {
            logger.logDebug('Display refresh failed:', error);
            throw error;
        }
    });
}

/**
 * Start clipboard monitoring service
 */
function setupClipboardMonitoring() {
    // Clear any existing monitoring
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    
    const settings = store.getSettings();
    const appKey = store.getApiKey();
    
    if (!settings || !appKey) {
        logger.logDebug('Cannot setup monitoring - missing settings or API key');
        return;
    }

    pollInterval = clipboard.setupClipboardMonitoring(
        settings,
        appKey,
        socket,
        mainWindow,
        showNotification
    );
}

/**
 * Cleanup resources before app exit
 * @returns {Promise<void>}
 */
async function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    
    try {
        app.isQuitting = true;
        
        // Unregister shortcuts
        globalShortcut.unregisterAll();
        
        // Destroy tray
        tray.destroyTray();
        
        // Clear update directory
        await helper.cleanUpdateDirectories();
        
        // Close socket connection
        websocket.disconnectSocket();
        
        // Stop polling local clipboard
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        
    } catch (error) {
        logger.logDebug('Error during cleanup:', error);
    } finally {
        isCleaningUp = false;
    }
}

/**
 * Initialize the application
 */
async function initialize() {
    try {
        // Initialize store
        store.initStore();
        
        // Set debug logging based on settings
        const settings = store.getSettings();
        logger.setDebugLogging(settings.preferences.debugLogging);
        
        // Create the main window
        createWindow();
        
        // Create the system tray icon
        tray.createTray(
            mainWindow,
            async () => await clipboard.cloudCopy(settings, store.getApiKey(), mainWindow, showNotification),
            async () => await clipboard.cloudPaste(settings, store.getApiKey(), mainWindow, showNotification),
            showNotification,
            rootDir
        );
        
        // Setup IPC handlers
        setupIpcHandlers();
        
        // Setup automatic clipboard monitoring
        setupClipboardMonitoring();
        
        // Setup auto-updater
        updater.setupAutoUpdater(showNotification, mainWindow);
        
        // Register custom keyboard shortcuts
        registerCustomKeybindings();
        
        // Setup WebSocket connection
        setupWebSocket();
        
        // Set Mac dock icon
        if (process.platform === 'darwin') {
            app.dock.setIcon(path.join(rootDir, 'build/icon.png'));
        }
        
        logger.logInfo('Application initialized successfully');
    } catch (error) {
        logger.logDebug('Initialization failed:', error);
        showNotification('Error', 'Application failed to initialize properly');
    }
}

export default {
    initialize,
    cleanup,
    createWindow,
    showNotification,
    setupClipboardMonitoring,
    setupWebSocket,
    registerCustomKeybindings
};

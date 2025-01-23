// main.js
const { app, BrowserWindow, globalShortcut, clipboard, ipcMain } = require('electron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

let store;
let mainWindow;

const DEFAULT_SETTINGS = {
    apiKey: '',
    apiBaseUrl: 'https://crossyclip.com',
    theme: {
        primaryColor: '#6200ee',
        hoverColor: '#3700b3',
        bgColor: '#121212',
        surfaceColor: '#1e1e1e',
        textColor: '#ffffff'
    }
};

const initStore = async () => {
    const Store = await import('electron-store');
    store = new Store.default({
        defaults: DEFAULT_SETTINGS
    });
};

const getSettings = () => {
    return store?.store || DEFAULT_SETTINGS;
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

const cloudCopy = async () => {
    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;
    
    const text = clipboard.readText();
    try {
        await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
            headers: { AppKey: appKey },
        });
        mainWindow.webContents.send('refreshClipboard');
    } catch (error) {
        console.error('Failed to copy text to cloud:', error);
    }
};

const cloudPaste = async () => {
    const appKey = getAppKey();
    const settings = getSettings();
    if (!appKey) return;
    
    try {
        const response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey },
        });
        if (response.data.type === 'text') {
            clipboard.writeText(response.data.content);
        }
        mainWindow.webContents.send('refreshClipboard');
    } catch (error) {
        console.error('Failed to retrieve text from cloud:', error);
    }
};

app.whenReady().then(async () => {
    await initStore();
    createWindow();
    setupIpcHandlers();
    globalShortcut.register('CommandOrControl+Shift+C', cloudCopy);
    globalShortcut.register('CommandOrControl+Shift+V', cloudPaste);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}).catch(error => {
    console.error('Startup error:', error);
    app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

import Store from 'electron-store';

// Default application settings
const DEFAULT_SETTINGS = {
    apiKey: '',
    preferences: {
        automaticClipboardSync: false, // This controls WebSocket connection
        notifications: false, 
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

let store = null;

/**
 * Initialize the settings store
 * @returns {Store} The store instance
 */
function initStore() {
    if (!store) {
        store = new Store({
            defaults: DEFAULT_SETTINGS
        });
    }
    return store;
}

/**
 * Get all application settings
 * @returns {Object} The current settings
 */
function getSettings() {
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
}

/**
 * Get the API key
 * @returns {string} The API key
 */
function getApiKey() {
    return store?.get('apiKey');
}

/**
 * Save the API key
 * @param {string} key - The API key to save
 */
function saveApiKey(key) {
    store?.set('apiKey', key);
}

/**
 * Save settings
 * @param {Object} newSettings - The new settings to save
 * @returns {Object} The updated settings
 */
function saveSettings(newSettings) {
    store.set(newSettings);
    return getSettings();
}

/**
 * Clear all stored settings
 * @returns {boolean} Whether the operation succeeded
 */
function clearStore() {
    try {
        store.clear();
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Get the default settings
 * @returns {Object} The default settings
 */
function getDefaultSettings() {
    return DEFAULT_SETTINGS;
}

export default {
    initStore,
    getSettings,
    getApiKey,
    saveApiKey,
    saveSettings,
    clearStore,
    getDefaultSettings,
    DEFAULT_SETTINGS
};

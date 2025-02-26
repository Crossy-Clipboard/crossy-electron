import { app, Tray, Menu } from 'electron';
import path from 'path';
import logger from '../../utils/logger.js';

let tray = null;

/**
 * Create system tray icon and menu
 * @param {Object} mainWindow - Main application window
 * @param {Function} cloudCopy - Function to copy to cloud
 * @param {Function} cloudPaste - Function to paste from cloud
 * @param {Function} showNotification - Function to show notifications
 * @param {string} __dirname - Directory name for icon path resolution
 * @returns {Tray|null} The created tray object or null if failed
 */
function createTray(mainWindow, cloudCopy, cloudPaste, showNotification, __dirname) {
    if (tray !== null) return tray;

    try {
        // Determine icon path based on platform
        const iconPath = path.join(__dirname, 
            process.platform === 'win32' ? 'build/icon.ico' : 'build/icon.png'
        );

        // Create tray with error handling
        try {
            tray = new Tray(iconPath);
        } catch (iconError) {
            logger.logDebug('Failed to load tray icon:', iconError);
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

        return tray;

    } catch (error) {
        logger.logDebug('Failed to create tray:', error);
        showNotification('Error', 'Failed to create system tray icon');
        return null;
    }
}

/**
 * Destroy the tray icon
 */
function destroyTray() {
    if (tray) {
        try {
            tray.destroy();
            tray = null;
        } catch (error) {
            logger.logDebug('Error destroying tray:', error);
        }
    }
}

/**
 * Get the current tray instance
 * @returns {Tray|null} The current tray instance or null
 */
function getTray() {
    return tray;
}

export default {
    createTray,
    destroyTray,
    getTray
};

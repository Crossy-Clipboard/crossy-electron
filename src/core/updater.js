import { app } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import logger from '../../utils/logger.js';
import helper from '../../utils/helper.js';

/**
 * Setup the auto-updater with appropriate event handlers
 * @param {Function} showNotification - Function to show notifications
 * @param {Object} mainWindow - Main application window
 */
function setupAutoUpdater(showNotification, mainWindow) {
    autoUpdater.logger = {
        info: (msg) => logger.logDebug('Update info:', msg),
        warn: (msg) => logger.logDebug('Update warning:', msg),
        error: (msg) => logger.logDebug('Update error:', msg)
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
        logger.logDebug('Failed to set update feed URL:', error);
    }

    // Setup auto-updater events
    autoUpdater.on('checking-for-update', async () => {
        logger.logDebug('Checking for updates...');
        await helper.ensureUpdateDirectories();
    });

    autoUpdater.on('update-available', (info) => {
        logger.logDebug('Update available:', info);
        showNotification(
            'Update Available', 
            `Version v${info.version} is available for download`
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updateAvailable', info);
        }
    });

    autoUpdater.on('update-not-available', (info) => {
        logger.logDebug('Update not available, release name: ', info.releaseName, "\nPath: ", info.path);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        logger.logDebug('Download progress:', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
        logger.logDebug('Update downloaded:', info);
        showNotification(
            'Update Ready', 
            'A new update is ready to install. Restart the app to apply the update.'
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updateDownloaded', info);
        }
    });

    autoUpdater.on('error', async (error) => {
        logger.logDebug('Update error:', error);
        
        // Clean up failed update files
        await helper.cleanUpdateDirectories();

        // Only show notification if app is not quitting
        if (!app.isQuitting && !error.message.includes('404')) {
            try {
                showNotification('Update Error', error.message);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('updateError', error.message);
                }
            } catch (notifyError) {
                logger.logDebug('Failed to send update error to window:', notifyError);
            }
        }
    });
}

/**
 * Check for updates
 * @returns {Promise<boolean>} Whether an update is available
 */
async function checkForUpdates() {
    try {
        const result = await autoUpdater.checkForUpdates();
        return result?.updateInfo?.version !== app.getVersion();
    } catch (error) {
        logger.logDebug('Update check failed:', error);
        return false;
    }
}

/**
 * Get the latest available version
 * @returns {Promise<string>} Latest version number
 */
async function getLatestVersion() {
    try {
        const result = await autoUpdater.checkForUpdates();
        return result?.updateInfo?.version;
    } catch (error) {
        logger.logDebug('Failed to get latest version:', error);
        return app.getVersion(); // Return current version if check fails
    }
}

/**
 * Start downloading an available update
 */
async function downloadUpdate() {
    try {
        await helper.ensureUpdateDirectories();
        await autoUpdater.downloadUpdate();
    } catch (error) {
        logger.logDebug('Download failed:', error);
        throw error;
    }
}

export default {
    setupAutoUpdater,
    checkForUpdates,
    getLatestVersion,
    downloadUpdate,
    autoUpdater
};

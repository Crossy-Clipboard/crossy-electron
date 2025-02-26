import { app, BrowserWindow } from 'electron';
import appCore from './src/core/app.js';

// Ensure only one instance of the app runs at a time
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    console.log('Another instance is running - quitting');
    app.quit();
} else {
    // Handle second instance launch
    app.on('second-instance', () => {
        // Focus our window if another instance tries to open
        const mainWindow = appCore.createWindow();
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Initialize application when ready
    app.whenReady().then(async () => {
        await appCore.initialize();
        
        // On macOS, recreate window when dock icon is clicked
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                appCore.createWindow();
            }
        });
    }).catch(error => {
        console.error('Failed to initialize application:', error);
        app.quit();
    });

    // Handle app quit events
    app.on('before-quit', async (event) => {
        event.preventDefault();
        await appCore.cleanup();
        app.quit();
    });

    app.on('will-quit', async (event) => {
        event.preventDefault();
        await appCore.cleanup();
        app.quit();
    });

    app.on('window-all-closed', async () => {
        // Import store here to avoid circular dependencies
        const store = (await import('./src/core/store.js')).default;
        const settings = store.getSettings();
        
        // Quit if runInBackground is disabled
        if (!settings.preferences.runInBackground) {
            await appCore.cleanup();
            app.quit();
        }
    });
}

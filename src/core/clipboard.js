import { clipboard, nativeImage } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import mime from 'mime';
import logger from '../../utils/logger.js';
import helper from '../../utils/helper.js';
import { app } from 'electron';

// State for tracking clipboard content and operations
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
const lastOperation = {
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
    beginProcessing: async function() {
        if (this.isProcessing) {
            // If processing has been stuck for too long, force reset
            if (Date.now() - this.lastOperation.timestamp > PROCESSING_TIMEOUT) {
                logger.logDebug('Force releasing stuck processing lock');
                this.endProcessing();
            } else {
                return false;
            }
        }
        
        this.isProcessing = true;
        this.lastOperation.timestamp = Date.now();
        
        // Set timeout to auto-release lock
        this.processingTimeout = setTimeout(() => {
            logger.logDebug('Processing timeout reached, auto-releasing lock');
            this.endProcessing();
        }, PROCESSING_TIMEOUT);
        
        return true;
    },
    endProcessing: function() {
        if (this.processingTimeout) {
            clearTimeout(this.processingTimeout);
            this.processingTimeout = null;
        }
        this.isProcessing = false;
    },
    updateLocal: function(content) {
        this.localHash = content ? helper.hashContent(content) : '';
        logger.logDebug('Local state updated:', { hash: this.localHash });
    },
    updateCloud: function(content) {
        this.cloudHash = content ? helper.hashContent(content) : '';
        logger.logDebug('Cloud state updated:', { hash: this.cloudHash });
    }
};

/**
 * Copy current clipboard content to the cloud
 * @param {Object} settings - Application settings
 * @param {string} appKey - API key
 * @param {Object} mainWindow - Main window instance
 * @param {Function} showNotification - Function to show notifications
 * @returns {Promise<void>}
 */
async function cloudCopy(settings, appKey, mainWindow, showNotification) {
    try {
        if (!await syncState.beginProcessing()) {
            logger.logDebug('Skipping upload - sync in progress');
            return;
        }

        if (!appKey) {
            logger.logDebug('No app key provided');
            return;
        }

        const formats = clipboard.availableFormats();

        // Priority 1: Files
        if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
            const filePaths = clipboard.readBuffer('public.file-url').toString('utf8').split('\n').filter(Boolean);
            if (filePaths.length > 0) {
                const filePath = filePaths[0].replace('file://', '');
                if (fs.existsSync(filePath) && filePath !== lastDownloadedContent.filePath) {
                    await cloudCopyFile(settings, appKey, filePath, mainWindow, showNotification);
                    mainWindow?.webContents.send('triggerRefresh'); // Use consistent event name
                }
            }
        }
        // Priority 2: Images
        else if (!clipboard.readImage().isEmpty()) {
            const image = clipboard.readImage();
            const imageHash = helper.hashContent(image.toPNG());
            if (imageHash !== lastDownloadedContent.imageHash) {
                const tempPath = path.join(app.getPath('temp'), `clipboard-${Date.now()}.png`);
                fs.writeFileSync(tempPath, image.toPNG());
                await cloudCopyFile(settings, appKey, tempPath, mainWindow, showNotification);
                fs.unlinkSync(tempPath);
                mainWindow?.webContents.send('triggerRefresh'); // Use consistent event name
            }
        }
        // Priority 3: Text
        else {
            const text = clipboard.readText();
            if (text) {
                const textHash = helper.hashContent(text);
                if (textHash !== lastDownloadedContent.textHash) {
                    await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                        headers: { AppKey: appKey },
                    });
                    mainWindow?.webContents.send('triggerRefresh'); // Use consistent event name
                    showNotification('Clipboard Uploaded', 'Text copied to cloud clipboard');
                }
            }
        }

        // After successful upload
        syncState.lastOperation = { type: 'upload', timestamp: Date.now() };
        
        // Add this to update the cloud hash to prevent immediate re-download
        if (text) {
            syncState.updateCloud(text);
        } else if (image) {
            syncState.updateCloud(image.toPNG());
        }
        
        mainWindow?.webContents.send('triggerRefresh');
    } catch (error) {
        logger.logDebug('cloudCopy error:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    } finally {
        syncState.endProcessing();
    }
}

/**
 * Copy a specific file to the cloud
 * @param {Object} settings - Application settings
 * @param {string} appKey - API key
 * @param {string} filePath - Path to the file
 * @param {Object} mainWindow - Main window instance
 * @param {Function} showNotification - Function to show notifications
 * @returns {Promise<void>}
 */
async function cloudCopyFile(settings, appKey, filePath, mainWindow, showNotification) {
    if (!appKey) return;

    try {
        logger.logDebug('Copying file to cloud:', filePath);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const form = new FormData();
        const fileStream = fs.createReadStream(filePath);
        const fileName = path.basename(filePath);
        
        // Use mime.getType instead of mime.lookup
        const mimeType = mime.getType(filePath) || 'application/octet-stream';
        logger.logDebug('File MIME type:', mimeType);

        form.append('file', fileStream, {
            filename: fileName,
            contentType: mimeType,
        });

        logger.logDebug('Sending file to server...');
        await axios.post(`${settings.apiBaseUrl}/app/copy`, form, {
            headers: {
                AppKey: appKey,
                ...form.getHeaders(),
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        logger.logDebug('File sent successfully');
        mainWindow?.webContents.send('triggerRefresh');
        showNotification('Clipboard Uploaded', 'File copied to cloud clipboard');
    } catch (error) {
        logger.logDebug('cloudCopyFile error:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
        throw error;
    }
}

/**
 * Paste the latest content from the cloud to local clipboard
 * @param {Object} settings - Application settings
 * @param {string} appKey - API key
 * @param {Object} mainWindow - Main window instance
 * @param {Function} showNotification - Function to show notifications
 * @returns {Promise<void>}
 */
async function cloudPaste(settings, appKey, mainWindow, showNotification) {
    if (syncState.isProcessing) {
        logger.logDebug('Skipping download - sync in progress');
        return;
    }

    if (!appKey) return;

    try {
        syncState.lastOperation = { type: 'download', timestamp: Date.now() };

        let response = await axios.get(`${settings.apiBaseUrl}/app/paste/latest`, {
            headers: { AppKey: appKey },
            responseType: 'json',
        });

        if (response.data.type === 'text') {
            const textContent = response.data.content;
            lastDownloadedContent.textHash = helper.hashContent(textContent);
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
                lastDownloadedContent.imageHash = helper.hashContent(imgBuffer);
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

        mainWindow?.webContents.send('triggerRefresh');
    } catch (error) {
        logger.logDebug('cloudPaste error:', error);
        showNotification('Error', error.message);
        mainWindow?.webContents.send('clipboardError', error.message);
    }
}

/**
 * Handle local clipboard changes for syncing
 * @param {Object} settings - Application settings
 * @param {string} appKey - API key
 * @param {Object} socket - WebSocket connection
 * @param {Object} mainWindow - Main window instance
 * @param {Function} showNotification - Function to show notifications
 * @returns {Promise<void>}
 */
async function handleLocalClipboardChange(settings, appKey, socket, mainWindow, showNotification) {
    // Skip if no API key
    if (!appKey) {
        logger.logDebug('Skipping clipboard update - no API key');
        return;
    }

    const now = Date.now();

    // Prevent operations too soon after last operation
    if (now - lastOperation.timestamp < DEBOUNCE_DELAY) {
        logger.logDebug('Skipping clipboard update - debounce active', {
            timeSinceLast: now - lastOperation.timestamp,
            debounceNeeded: DEBOUNCE_DELAY
        });
        return;
    }

    try {
        // Try to begin processing, return if another operation is in progress
        if (!await syncState.beginProcessing()) {
            logger.logDebug('Skipping clipboard update - sync already in progress');
            return;
        }

        logger.logDebug('Processing local clipboard change');
        const formats = clipboard.availableFormats();
        logger.logDebug('Available formats:', formats);

        // Priority 1: Files
        if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
            try {
                const fileUrlBuffer = clipboard.readBuffer('public.file-url') || 
                                      clipboard.readBuffer('text/uri-list');
                const filePaths = fileUrlBuffer.toString('utf8').split('\n').filter(Boolean);
                
                if (filePaths.length > 0) {
                    const filePath = filePaths[0].replace('file://', '')
                                                .replace(/^\/([A-Z]:)/, '$1') // Fix Windows paths
                                                .trim();
                                                
                    logger.logDebug('Processing file path:', filePath);
                    
                    if (fs.existsSync(filePath) && filePath !== lastDownloadedContent.filePath) {
                        logger.logDebug('File exists and is new, uploading');
                        await cloudCopyFile(settings, appKey, filePath, mainWindow, showNotification);
                        mainWindow?.webContents.send('triggerRefresh');
                        lastClipboardContent.timestamp = now;
                        lastOperation.timestamp = now;
                        lastOperation.type = 'copy';
                    } else {
                        logger.logDebug('File does not exist or is the same as last downloaded');
                    }
                }
            } catch (error) {
                logger.logDebug('Error processing file URL:', error);
            }
        }
        // Priority 2: Images
        else if (!clipboard.readImage().isEmpty()) {
            try {
                const image = clipboard.readImage();
                const imageHash = helper.hashContent(image.toPNG());
                
                if (imageHash !== lastDownloadedContent.imageHash) {
                    logger.logDebug('New image detected, uploading');
                    const tempPath = path.join(app.getPath('temp'), `clipboard-${now}.png`);
                    fs.writeFileSync(tempPath, image.toPNG());
                    await cloudCopyFile(settings, appKey, tempPath, mainWindow, showNotification);
                    mainWindow?.webContents.send('triggerRefresh');
                    
                    try {
                        fs.unlinkSync(tempPath);
                    } catch (err) {
                        logger.logDebug('Failed to delete temporary file:', err);
                    }
                    
                    lastClipboardContent.image = image;
                    lastClipboardContent.timestamp = now;
                    lastOperation.timestamp = now;
                    lastOperation.type = 'copy';
                } else {
                    logger.logDebug('Image is unchanged or was previously downloaded');
                }
            } catch (error) {
                logger.logDebug('Error processing image:', error);
            }
        }
        // Priority 3: Text
        else {
            try {
                const text = clipboard.readText();
                
                if (text && text !== lastClipboardContent.text) {
                    const textHash = helper.hashContent(text);
                    
                    if (textHash !== lastDownloadedContent.textHash) {
                        logger.logDebug('New text detected, uploading');
                        await axios.post(`${settings.apiBaseUrl}/app/copy`, { text }, {
                            headers: { AppKey: appKey },
                        });
                        mainWindow?.webContents.send('triggerRefresh');
                        
                        lastClipboardContent.text = text;
                        lastClipboardContent.timestamp = now;
                        lastOperation.timestamp = now;
                        lastOperation.type = 'copy';
                    } else {
                        logger.logDebug('Text is unchanged or was previously downloaded');
                    }
                }
            } catch (error) {
                logger.logDebug('Error processing text:', error);
            }
        }
        
    } catch (error) {
        logger.logDebug('Clipboard monitoring error:', error);
        showNotification('Sync Error', 'Failed to sync clipboard changes');
    } finally {
        syncState.endProcessing();
    }
}

/**
 * Setup clipboard monitoring
 * @param {Object} settings - Application settings
 * @param {Object} socket - WebSocket connection
 * @param {Object} mainWindow - Main window instance
 * @param {Function} showNotification - Function to show notifications
 * @returns {NodeJS.Timeout} Interval timer for cleanup
 */
function setupClipboardMonitoring(settings, appKey, socket, mainWindow, showNotification) {
    if (!settings.preferences.automaticClipboardSync) {
        logger.logDebug('Automatic clipboard sync disabled');
        return null;
    }

    logger.logDebug('Setting up clipboard monitoring');
    
    // Initialize last content values
    let lastText = clipboard.readText();
    let lastImageHash = clipboard.readImage().isEmpty() ? '' : 
                        helper.hashContent(clipboard.readImage().toPNG());
    let lastFileUrl = '';
    
    try {
        const formats = clipboard.availableFormats();
        if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
            lastFileUrl = clipboard.readBuffer('public.file-url').toString('utf8');
        }
    } catch (error) {
        logger.logDebug('Error reading initial file URL:', error);
    }
    
    const pollInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        let hasChanged = false;
        const formats = clipboard.availableFormats();
        
        // Check for file changes
        let currentFileUrl = '';
        if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
            try {
                currentFileUrl = clipboard.readBuffer('public.file-url').toString('utf8');
                if (currentFileUrl !== lastFileUrl) {
                    logger.logDebug('File URL changed:', { 
                        previous: lastFileUrl.substring(0, 50), 
                        current: currentFileUrl.substring(0, 50) 
                    });
                    lastFileUrl = currentFileUrl;
                    hasChanged = true;
                }
            } catch (error) {
                logger.logDebug('Error reading file URL:', error);
            }
        } else if (lastFileUrl) {
            // Previously had a file URL, but now it's gone
            logger.logDebug('File URL removed from clipboard');
            lastFileUrl = '';
            hasChanged = true;
        }
        
        // Check for image changes
        if (!clipboard.readImage().isEmpty()) {
            try {
                const currentImageHash = helper.hashContent(clipboard.readImage().toPNG());
                if (currentImageHash !== lastImageHash) {
                    logger.logDebug('Image changed:', { 
                        previous: lastImageHash.substring(0, 10), 
                        current: currentImageHash.substring(0, 10) 
                    });
                    lastImageHash = currentImageHash;
                    hasChanged = true;
                }
            } catch (error) {
                logger.logDebug('Error hashing image:', error);
            }
        } else if (lastImageHash) {
            // Previously had an image, but now it's empty
            logger.logDebug('Image removed from clipboard');
            lastImageHash = '';
            hasChanged = true;
        }
        
        // Check for text changes
        const currentText = clipboard.readText();
        if (currentText !== lastText) {
            logger.logDebug('Text changed:', { 
                previous: lastText?.substring(0, 20), 
                current: currentText?.substring(0, 20) 
            });
            lastText = currentText;
            hasChanged = true;
        }
        
        if (hasChanged) {
            handleLocalClipboardChange(settings, appKey, socket, mainWindow, showNotification);
        }
    }, 1000);

    // Also check for changes when window regains focus
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.on('focus', () => {
            handleLocalClipboardChange(settings, appKey, socket, mainWindow, showNotification);
        });
    }

    return pollInterval;
}

export default {
    cloudCopy,
    cloudCopyFile,
    cloudPaste,
    handleLocalClipboardChange,
    setupClipboardMonitoring,
    syncState,
    lastDownloadedContent,
    lastClipboardContent,
    lastOperation
};
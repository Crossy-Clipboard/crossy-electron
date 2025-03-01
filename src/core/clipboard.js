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
    fileHash: '',  // Add this new field to track file content hash
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
            
            // Extract filename with more robust parsing
            let filename = 'downloaded_file';
            const disposition = response.headers['content-disposition'];
            if (disposition) {
                const filenameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (filenameMatch && filenameMatch[1]) {
                    filename = filenameMatch[1].replace(/['"]/g, '').trim();
                }
            }
            
            // Determine file extension from content type if missing
            if (!path.extname(filename) && contentType) {
                const extension = mime.getExtension(contentType);
                if (extension) {
                    filename = `${filename}.${extension}`;
                }
            }
            
            // Handle different content types
            if (contentType.startsWith('image/')) {
                // Existing image handling
                const imgBuffer = Buffer.from(response.data);
                lastDownloadedContent.imageHash = helper.hashContent(imgBuffer);
                lastDownloadedContent.timestamp = Date.now();
                lastDownloadedContent.textHash = '';
                lastDownloadedContent.filePath = '';
                const img = nativeImage.createFromBuffer(imgBuffer);
                clipboard.writeImage(img);
                showNotification('Clipboard Downloaded', 'New image content pasted from cloud');
            } else {
                // Enhanced file handling
                const tempPath = path.join(app.getPath('temp'), filename);
                fs.writeFileSync(tempPath, Buffer.from(response.data));
                const fileBuffer = Buffer.from(response.data);
                const fileHash = helper.hashContent(fileBuffer);
                lastDownloadedContent.filePath = tempPath;
                lastDownloadedContent.fileHash = fileHash;  // Store the hash
                lastDownloadedContent.timestamp = Date.now();
                lastDownloadedContent.textHash = '';
                lastDownloadedContent.imageHash = '';
                
                // Use platform-specific clipboard formats
                if (process.platform === 'win32') {
                    clipboard.writeBuffer('FileNameW', Buffer.from(tempPath, 'ucs2'));
                } else if (process.platform === 'darwin') {
                    clipboard.writeBuffer('public.file-url', Buffer.from(`file://${tempPath}`));
                } else {
                    clipboard.writeBuffer('text/uri-list', Buffer.from(`file://${tempPath}`));
                }
                
                showNotification('Clipboard Downloaded', `New file downloaded: ${filename}`);
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

        let handled = false;

        // Priority 1: Files
        if (formats.some(format => format.includes('file') || format.includes('uri-list') || format === 'FileNameW')) {
            try {
                let filePaths = [];
                
                // Try different clipboard formats for files based on platform
                if (process.platform === 'win32') {
                    // Try Windows specific formats
                    if (formats.includes('FileNameW')) {
                        const fileBuffer = clipboard.readBuffer('FileNameW');
                        const filepath = fileBuffer.toString('ucs2').replace(/\0/g, '');
                        if (filepath) filePaths.push(filepath);
                    }
                    
                    // Also check for CF_HDROP format
                    if (formats.includes('CF_HDROP') && filePaths.length === 0) {
                        try {
                            const fileBuffer = clipboard.readBuffer('CF_HDROP');
                            const text = fileBuffer.toString();
                            if (text) filePaths.push(text);
                        } catch (err) {
                            logger.logDebug('Failed to read CF_HDROP:', err);
                        }
                    }
                    
                    // Try to get from text if it might be a file path and no other paths found
                    if (filePaths.length === 0) {
                        const text = clipboard.readText();
                        if (text && (text.startsWith('file:///') || /^[A-Z]:\\.+/.test(text))) {
                            filePaths.push(text.replace(/^file:\/\/\//, ''));
                        }
                    }
                } else if (process.platform === 'darwin') {
                    // macOS specific
                    if (formats.includes('public.file-url')) {
                        const fileBuffer = clipboard.readBuffer('public.file-url');
                        const urls = fileBuffer.toString('utf8').split('\n').filter(Boolean);
                        filePaths = urls.map(url => decodeURI(url.replace(/^file:\/\//, '')));
                    }
                } else {
                    // Linux and others
                    if (formats.includes('text/uri-list')) {
                        const fileBuffer = clipboard.readBuffer('text/uri-list');
                        const urls = fileBuffer.toString('utf8').split('\n').filter(Boolean);
                        filePaths = urls.map(url => {
                            // Handle both with and without file: prefix
                            if (url.startsWith('file:')) {
                                return decodeURI(url.replace(/^file:\/\//, ''));
                            }
                            return url;
                        });
                    }
                }
                
                // Also check text/uri-list on Windows (common when copying from File Explorer)
                if (process.platform === 'win32' && formats.includes('text/uri-list') && filePaths.length === 0) {
                    try {
                        const fileBuffer = clipboard.readBuffer('text/uri-list');
                        const text = fileBuffer.toString('utf8');
                        logger.logDebug('text/uri-list content:', text);
                        
                        if (text) {
                            const urls = text.split('\r\n').filter(Boolean);
                            const validPaths = urls.map(url => {
                                if (url.startsWith('file:///')) {
                                    return decodeURI(url.replace(/^file:\/\/\//, ''));
                                }
                                return url;
                            });
                            filePaths.push(...validPaths);
                        }
                    } catch (err) {
                        logger.logDebug('Failed to read text/uri-list:', err);
                    }
                }
                
                // Fallback: Try to get file path from text if it looks like a path
                if (filePaths.length === 0) {
                    const text = clipboard.readText();
                    if (text) {
                        // Check for common file path patterns
                        if (text.startsWith('/') || text.startsWith('\\\\') || /^[A-Za-z]:[\\\/]/.test(text)) {
                            filePaths.push(text);
                        } else if (text.startsWith('file://')) {
                            filePaths.push(decodeURI(text.replace(/^file:\/\//, '')));
                        }
                    }
                }
                
                logger.logDebug('Found file paths:', filePaths);
                
                if (filePaths.length > 0) {
                    // Clean up the file path
                    let filePath = filePaths[0]
                        .replace(/^file:\/\/\/?/, '') // Handle file:// and file:///
                        .replace(/^\/([A-Za-z]:)/, '$1') // Fix Windows paths
                        .replace(/%20/g, ' ') // Handle URL encoded spaces
                        .trim();
                    
                    // On Windows, handle forward slashes
                    if (process.platform === 'win32') {
                        filePath = filePath.replace(/\//g, '\\');
                    }
                    
                    logger.logDebug('Processing file path:', filePath);
                    
                    if (fs.existsSync(filePath)) {
                        // Check if this is different from the last downloaded file
                        const fileStats = fs.statSync(filePath);
                        
                        // Skip if file is too large (>100MB) or is a directory
                        if (fileStats.isDirectory()) {
                            logger.logDebug('Skipping directory upload');
                        } else if (fileStats.size > 100 * 1024 * 1024) {
                            logger.logDebug('Skipping large file:', fileStats.size);
                            showNotification('File too large', 'Files over 100MB cannot be uploaded');
                        } else {
                            const fileHash = helper.hashContent(fs.readFileSync(filePath));
                            
                            // Only upload if file is different from last downloaded file
                            if (filePath !== lastDownloadedContent.filePath && 
                                fileHash !== lastDownloadedContent.fileHash) {
                                logger.logDebug('File exists and is new, uploading');
                                await cloudCopyFile(settings, appKey, filePath, mainWindow, showNotification);
                                mainWindow?.webContents.send('triggerRefresh');
                                
                                lastClipboardContent.timestamp = now;
                                lastOperation.timestamp = now;
                                lastOperation.type = 'copy';
                                handled = true;
                            } else {
                                logger.logDebug('File is the same as last downloaded');
                            }
                        }
                    } else {
                        logger.logDebug('File path does not exist:', filePath);
                    }
                }
            } catch (error) {
                logger.logDebug('Error processing file URL:', error);
            }
        }

        // Priority 2: Images (if files weren't handled)
        if (!handled && !clipboard.readImage().isEmpty()) {
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
                    handled = true;
                } else {
                    logger.logDebug('Image is unchanged or was previously downloaded');
                }
            } catch (error) {
                logger.logDebug('Error processing image:', error);
            }
        }

        // Priority 3: Text (if nothing else was handled)
        if (!handled) {
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
    
    // Initialize state
    let lastState = {
        text: clipboard.readText(),
        imageHash: '',
        fileHash: '',
        formats: clipboard.availableFormats()
    };
    
    // Try to get image hash
    if (!clipboard.readImage().isEmpty()) {
        try {
            lastState.imageHash = helper.hashContent(clipboard.readImage().toPNG());
        } catch (error) {
            logger.logDebug('Error hashing initial image:', error);
        }
    }
    
    // Try to get initial file state
    try {
        if (lastState.formats.some(format => format.includes('file') || format.includes('uri-list'))) {
            // We'll compute hash on demand if needed
        }
    } catch (error) {
        logger.logDebug('Error reading initial file state:', error);
    }
    
    const pollInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        let hasChanged = false;
        const currentFormats = clipboard.availableFormats();
        
        // Check if formats changed
        const formatChanged = currentFormats.length !== lastState.formats.length || 
                            currentFormats.some(format => !lastState.formats.includes(format));
        
        if (formatChanged) {
            logger.logDebug('Clipboard formats changed', {
                old: lastState.formats,
                new: currentFormats
            });
            lastState.formats = [...currentFormats];
            hasChanged = true;
        }
        
        // Check if text changed (also handles file paths as text)
        const currentText = clipboard.readText();
        if (currentText !== lastState.text) {
            logger.logDebug('Text changed');
            lastState.text = currentText;
            hasChanged = true;
        }
        
        // Check if image changed
        if (!clipboard.readImage().isEmpty()) {
            try {
                const currentImageHash = helper.hashContent(clipboard.readImage().toPNG());
                if (currentImageHash !== lastState.imageHash) {
                    logger.logDebug('Image changed');
                    lastState.imageHash = currentImageHash;
                    hasChanged = true;
                }
            } catch (error) {
                logger.logDebug('Error hashing image:', error);
            }
        } else if (lastState.imageHash) {
            // Image was removed
            lastState.imageHash = '';
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
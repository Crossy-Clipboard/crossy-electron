import crypto from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import logger from './logger.js';

/**
 * Creates a hash from content to track changes
 * @param {Buffer|string} content - Content to hash
 * @returns {string} MD5 hash of the content
 */
function hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Ensures update directories exist for the auto-updater
 */
async function ensureUpdateDirectories() {
    const updateDir = path.join(tmpdir(), 'crossy-electron-updater');
    const pendingDir = path.join(updateDir, 'pending');
    const tempDir = path.join(updateDir, 'pending-temp');
    
    try {
        await fs.mkdir(updateDir, { recursive: true });
        await fs.mkdir(pendingDir, { recursive: true });
        await fs.mkdir(tempDir, { recursive: true });
    } catch (error) {
        logger.logDebug('Failed to create update directories:', error);
    }
}

/**
 * Clean up update directories
 */
async function cleanUpdateDirectories() {
    try {
        const updateDir = path.join(tmpdir(), 'crossy-electron-updater');
        await fs.rm(updateDir, { recursive: true, force: true }).catch(() => {});
    } catch (cleanupError) {
        logger.logDebug('Cleanup failed:', cleanupError);
    }
}

export default {
    hashContent,
    ensureUpdateDirectories,
    cleanUpdateDirectories
};

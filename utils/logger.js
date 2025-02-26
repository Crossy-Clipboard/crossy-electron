let debugLoggingEnabled = false;

/**
 * Log debug messages when debug logging is enabled
 * @param {string} message - The message to log
 * @param  {...any} args - Additional arguments to log
 */
function logDebug(message, ...args) {
    if (debugLoggingEnabled) {
        console.log(`[DEBUG] ${message}`, ...args);
    }
}

/**
 * Log informational messages regardless of debug setting
 * @param {string} message - The message to log
 * @param  {...any} args - Additional arguments to log
 */
function logInfo(message, ...args) {
    console.log(`[INFO] ${message}`, ...args);
}

/**
 * Set debug logging status
 * @param {boolean} enabled - Whether debug logging should be enabled
 */
function setDebugLogging(enabled) {
    debugLoggingEnabled = !!enabled;
}

export default {
    logDebug,
    logInfo,
    setDebugLogging
};

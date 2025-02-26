import { io } from 'socket.io-client';
import logger from '../../utils/logger.js';

let socket = null;
let pingInterval = null;

// WebSocket state tracking
const wsConnectionState = {
    isConnecting: false,
    retryCount: 0,
    maxRetries: 3,
    lastError: null
};

/**
 * Create WebSocket connection to the server
 * @param {Object} settings - Application settings
 * @param {string} appKey - API key for authentication
 * @param {Function} onClipboardUpdateCallback - Function to call when clipboard updates
 * @returns {Object} Socket.io instance
 */
function connectSocket(settings, appKey, onClipboardUpdateCallback) {
    if (!settings || !appKey) {
        throw new Error('Missing required connection parameters');
    }

    // Clean up existing socket if it exists
    disconnectSocket();

    logger.logDebug('Creating socket connection with:', {
        url: settings.apiBaseUrl,
        transports: ['websocket']
    });

    socket = io(settings.apiBaseUrl, {
        auth: { appKey },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 3,
        reconnectionDelay: 1000,
        timeout: 5000,
        forceNew: true,
        pingTimeout: 30000,    // How long to wait for pong
        pingInterval: 25000    // How often to ping
    });

    // Add keepalive ping
    pingInterval = setInterval(() => {
        if (socket && socket.connected) {
            socket.emit('ping');
        }
    }, 25000);

    socket.on('clipboard_update', () => {
        logger.logDebug('Received clipboard_update event');
        if (typeof onClipboardUpdateCallback === 'function') {
            onClipboardUpdateCallback();
        }
    });

    socket.on('pong', () => {
        logger.logDebug('Received pong from server');
    });

    socket.on('connect', () => logger.logDebug('WebSocket connected'));
    socket.on('disconnect', () => logger.logDebug('WebSocket disconnected'));
    socket.on('connect_error', (error) => logger.logDebug('WebSocket error:', error));

    return socket;
}

/**
 * Disconnect the WebSocket
 */
function disconnectSocket() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }

    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
}

/**
 * Check if the socket is currently connected
 * @returns {boolean} Whether the socket is connected
 */
function isSocketConnected() {
    return socket && socket.connected;
}

export default {
    connectSocket,
    disconnectSocket,
    isSocketConnected,
    wsConnectionState
};

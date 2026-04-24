/**
 * Bearer token authentication shared across HTTP and WebSocket transports
 * Verifies the Authorization: Bearer <token> header against a static secret
 * loaded from config.json, using a constant time comparison
 * (MCP spec 2025-06-18, OAuth 2.0 Bearer scheme)
 */

const crypto = require('crypto');
const config = require('../config.json');

const { enabled, token } = config.auth;
const AUTH_ENABLED = Boolean(enabled);

if (AUTH_ENABLED && (typeof token !== 'string' || token.length === 0)) {
	console.error('[Auth] auth.enabled=true but auth.token is empty, aborting');
	process.exit(1);
}

// Pre encode the secret once to avoid per request allocation
const SECRET_BUF = AUTH_ENABLED ? Buffer.from(token, 'utf8') : null;

/**
 * Constant time comparison of the presented token with the configured secret
 * @param {string} presented - Token value extracted from the Authorization header
 * @returns {boolean}
 */
function safeEqual(presented) {
	const buf = Buffer.from(presented, 'utf8');
	if (buf.length !== SECRET_BUF.length) {
		return false;
	}
	return crypto.timingSafeEqual(buf, SECRET_BUF);
}

/**
 * Verify an Authorization header value against the configured bearer token
 * Returns true only when the Bearer scheme matches and the token is correct
 * @param {string|undefined} header - Raw value of the Authorization header
 * @returns {boolean}
 */
function verifyAuthHeader(header) {
	if (typeof header !== 'string') {
		return false;
	}
	const spaceIdx = header.indexOf(' ');
	if (spaceIdx === -1) {
		return false;
	}
	if (header.slice(0, spaceIdx).toLowerCase() !== 'bearer') {
		return false;
	}
	const presented = header.slice(spaceIdx + 1).trim();
	if (presented.length === 0) {
		return false;
	}
	return safeEqual(presented);
}

module.exports = {
	AUTH_ENABLED,
	verifyAuthHeader
};

/**
 * Static bearer authentication for the WebSocket transport
 * Verifies the Authorization: Bearer <token> header against auth.staticToken
 * in constant time, active when auth.mode includes static
 * (MCP spec 2025-06-18, OAuth 2.0 Bearer scheme)
 */

const crypto = require('crypto');
const config = require('../config.json');

const { mode, staticToken } = config.auth;
const hasStaticToken = typeof staticToken === 'string' && staticToken.length > 0;
const STATIC = (mode === 'static' || mode === 'oauth+static') && hasStaticToken;
const AUTH_ENABLED = mode !== 'none';

// Static only mode is the sole guard here, an empty token would leave it open
if (mode === 'static' && !hasStaticToken) {
	console.error('[Auth] auth.mode is static but auth.staticToken is empty, aborting');
	process.exit(1);
}

// Pre encode the static token once to avoid per request allocation
// The WebSocket transport authenticates with the static bearer only, under
// oauth only mode it has no usable credential and rejects every connection
const SECRET_BUF = STATIC ? Buffer.from(staticToken, 'utf8') : null;

/**
 * Constant time comparison of the presented token with the configured secret
 * @param {string} presented - Token value extracted from the Authorization header
 * @returns {boolean}
 */
function safeEqual(presented) {
	if (!SECRET_BUF) {
		return false;
	}
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

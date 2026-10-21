/**
 * Moltbook API client
 * One request helper over the REST API, authenticated with the key of
 * config.json
 *
 * The key only travels to the configured base URL: redirects are refused
 * rather than followed, and every caller supplied path segment is checked so
 * an id never climbs to another route
 */

const config = require('../config.json').moltbook;

/**
 * Encode one path segment, rejecting the empty and dot segments the URL
 * parser would resolve into another route
 * @param {*} value
 * @param {string} what - Argument name for the error
 * @returns {string}
 */
function segment(value, what) {
	const text = value == null ? '' : String(value);
	if (text === '' || text === '.' || text === '..') {
		throw new Error(`Invalid ${what} "${text}"`);
	}
	return encodeURIComponent(text);
}

/**
 * Send one request to the API
 * @param {string} method
 * @param {string} route - Path under the base URL, segments already encoded
 * @param {{query?: object, body?: object}} [options]
 * @returns {Promise<{ok: boolean, status: number, data: *}>} data is the parsed
 * JSON body, or the raw text when the body is not JSON
 */
async function request(method, route, { query, body } = {}) {
	if (!config.apiKey) {
		throw new Error('No Moltbook API key, set moltbook.apiKey in config.json');
	}

	const url = new URL(config.baseUrl + route);
	for (const [key, value] of Object.entries(query || {})) {
		if (value != null && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}

	const headers = { Authorization: `Bearer ${config.apiKey}` };
	if (body) {
		headers['Content-Type'] = 'application/json';
	}

	const res = await fetch(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
		redirect: 'error',
		signal: AbortSignal.timeout(config.timeoutMs)
	});

	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}

	return { ok: res.ok, status: res.status, data };
}

module.exports = { segment, request };

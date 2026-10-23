/**
 * 1fichier API client
 * One request helper over the JSON API, authenticated with the key of
 * config.json
 *
 * Every endpoint takes a POST with a JSON body. The key only travels to the
 * configured base URL: redirects are refused rather than followed
 *
 * The API bans the address and the account for a while after repeated 401,
 * 403, 404 or 410 errors, so nothing here retries, and the callers check
 * every link before sending it
 */

const config = require('../config.json').onefichier;

const LINK = /^https:\/\/1fichier\.com\/\?[a-z0-9]{5,20}$/;

/**
 * Check a download link, the only form the API accepts
 * @param {*} value
 * @returns {string}
 */
function link(value) {
	const text = value == null ? '' : String(value);
	if (!LINK.test(text)) {
		throw new Error(`Invalid url "${text}", a link like https://1fichier.com/?abcde12345`);
	}
	return text;
}

/**
 * Send one request to the API
 * @param {string} route Endpoint path under the base URL, like /file/info.cgi
 * @param {object} [body]
 * @returns {Promise<{ok: boolean, status: number, data: *}>} data is the parsed
 * JSON body, or the raw text when the body is not JSON; ok also requires a
 * body without status "KO"
 */
async function request(route, body = {}) {
	if (!config.apiKey) {
		throw new Error('No 1fichier API key, set onefichier.apiKey in config.json');
	}

	const res = await fetch(config.baseUrl + route, {
		method: 'POST',
		headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
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

	return { ok: res.ok && data?.status !== 'KO', status: res.status, data };
}

module.exports = { link, request };

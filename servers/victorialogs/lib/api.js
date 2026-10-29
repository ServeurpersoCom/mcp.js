/**
 * VictoriaLogs client
 * One query helper over the LogsQL HTTP API at the base URL of config.json
 *
 * Only /select/logsql/query is called. It searches, counts and lists fields
 * through LogsQL pipes, none of which writes. Redirects are refused rather
 * than followed
 */

const config = require('../config.json').victorialogs;

/**
 * Run one LogsQL query
 * @param {string} text LogsQL query
 * @param {number} limit Maximum number of rows returned
 * @returns {Promise<object[]>} The rows, one object per line of the answer
 */
async function query(text, limit) {
	let res, body;
	try {
		res = await fetch(config.baseUrl + '/select/logsql/query', {
			method: 'POST',
			body: new URLSearchParams({ query: text, limit: String(limit) }),
			redirect: 'error',
			signal: AbortSignal.timeout(config.timeoutMs)
		});
		body = await res.text();
	} catch (error) {
		if (error.name === 'TimeoutError') {
			throw new Error(
				`No answer from VictoriaLogs at ${config.baseUrl} within ${config.timeoutMs} ms`
			);
		}
		const reason = error.cause?.code || error.cause?.message || error.message;
		throw new Error(`Cannot reach VictoriaLogs at ${config.baseUrl}: ${reason}`);
	}

	if (!res.ok) {
		throw new Error(body.trim() || `VictoriaLogs answered ${res.status}`);
	}
	return body
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

module.exports = { query };

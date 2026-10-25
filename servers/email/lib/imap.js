/**
 * IMAP client
 * One session per call over IMAPS, authenticated with the account of
 * config.json and closed once the call resolves
 *
 * The certificate is checked against the system authorities, or against the
 * single certificate named by ca when the server carries a self signed one.
 * servername is the name the certificate holds when host is an address. The
 * certificate file is read at each session, so a missing one fails the email
 * tools alone and never the start of the server
 *
 * A folder opens with EXAMINE, the read only select of the protocol, when the
 * call only looks, and with SELECT when it changes flags
 */

const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');

const config = require('../config.json').email;

/**
 * Run fn on an authenticated connection
 * @param {function(ImapFlow): Promise<*>} fn
 * @returns {Promise<*>} What fn resolves to
 */
async function session(fn) {
	if (!config.password) {
		throw new Error('No password, set email.password in config.json');
	}

	const ca = config.ca ? fs.readFileSync(path.join(__dirname, '..', config.ca)) : undefined;

	const client = new ImapFlow({
		host: config.host,
		port: config.port,
		secure: true,
		servername: config.servername || undefined,
		tls: ca ? { ca } : {},
		auth: { user: config.user, pass: config.password },
		logger: false,
		connectionTimeout: config.timeoutMs,
		greetingTimeout: config.timeoutMs,
		socketTimeout: config.timeoutMs
	});

	// A socket error is also emitted as an event, a missing listener would end the process
	client.on('error', () => {});

	await client.connect();
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

/**
 * Run fn with folder opened, read only with EXAMINE or writable with SELECT
 * @param {string} folder
 * @param {boolean} readOnly
 * @param {function(ImapFlow): Promise<*>} fn
 * @returns {Promise<*>} What fn resolves to
 */
async function open(folder, readOnly, fn) {
	return session(async (client) => {
		const lock = await client.getMailboxLock(folder, { readOnly });
		try {
			return await fn(client);
		} finally {
			lock.release();
		}
	});
}

module.exports = { session, open };

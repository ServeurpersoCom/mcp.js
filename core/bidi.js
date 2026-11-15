/**
 * WebDriver BiDi client
 * One connection to the WebSocket a browser opens with --remote-debugging-port:
 * commands answered by their id, events handed to one listener
 *
 * It carries no knowledge of what it drives: sessions, pages and tools live in
 * the caller, so the same client serves any browser speaking WebDriver BiDi
 */

const WS_OPEN = 1;

/**
 * Open a connection
 * @param {string} url ws://host:port/session
 * @param {number} timeoutMs Bound of the opening and of every command
 * @param {function(string, object): void} onEvent Receives the method and params of each event
 * @param {function(): void} onClose Called once when the connection ends
 * @returns {Promise<{call: function(string, object=): Promise<object>, close: function(): void}>}
 */
function connect(url, timeoutMs, onEvent, onClose) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const pending = new Map();
		let next = 1;
		let opened = false;

		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`No answer from ${url} within ${timeoutMs} ms`));
		}, timeoutMs);

		function call(method, params = {}) {
			if (ws.readyState !== WS_OPEN) {
				return Promise.reject(new Error('Browser connection closed'));
			}
			const id = next++;
			return new Promise((res, rej) => {
				const bound = setTimeout(() => {
					pending.delete(id);
					rej(new Error(`${method} got no answer within ${timeoutMs} ms`));
				}, timeoutMs);
				pending.set(id, { res, rej, bound });
				ws.send(JSON.stringify({ id, method, params }));
			});
		}

		ws.onopen = () => {
			opened = true;
			clearTimeout(timer);
			resolve({ call, close: () => ws.close() });
		};
		ws.onerror = () => {
			if (!opened) {
				clearTimeout(timer);
				reject(new Error(`Cannot reach ${url}`));
			}
		};
		ws.onclose = () => {
			for (const { rej, bound } of pending.values()) {
				clearTimeout(bound);
				rej(new Error('Browser connection closed'));
			}
			pending.clear();
			if (opened) {
				onClose();
			}
		};
		ws.onmessage = (event) => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (message.type === 'event') {
				onEvent(message.method, message.params);
				return;
			}
			const waiter = pending.get(message.id);
			if (!waiter) {
				return;
			}
			pending.delete(message.id);
			clearTimeout(waiter.bound);
			if (message.type === 'error') {
				const error = new Error(`${message.error}: ${message.message}`);
				error.code = message.error;
				waiter.rej(error);
				return;
			}
			waiter.res(message.result);
		};
	});
}

module.exports = { connect };

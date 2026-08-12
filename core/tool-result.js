/**
 * Tool results
 * The typed objects a tool hands back to the core, which turns them into the
 * content blocks of the protocol
 */

/**
 * Text result
 * @param {string} text
 * @param {boolean} [isError] - Marks a failure the model is meant to read
 * @returns {{type: string, text: string, isError: boolean}}
 */
function textResult(text, isError = false) {
	return {
		type: 'text',
		text: text == null ? '' : String(text),
		isError: Boolean(isError)
	};
}

/**
 * Image result, the data carrying the base64 payload
 * @param {string} data
 * @param {string} mimeType
 * @param {boolean} [isError]
 * @returns {{type: string, data: string, mimeType: string, isError: boolean}}
 */
function imageResult(data, mimeType, isError = false) {
	return {
		type: 'image',
		data: data == null ? '' : String(data),
		mimeType: mimeType || 'application/octet-stream',
		isError: Boolean(isError)
	};
}

module.exports = { textResult, imageResult };

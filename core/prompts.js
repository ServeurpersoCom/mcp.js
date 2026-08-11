/**
 * Prompts module shared by every server
 * Turns the prompts the registry gathered across servers into the two shapes
 * the protocol needs, one for prompts/list and one for prompts/get
 */

/**
 * Build the prompts module from a list of prompt declarations
 * @param {object[]} prompts - Prompt declarations, gathered across servers
 * @returns {{PROMPTS_DEFINITIONS: object[], PROMPTS_MAPPING: object}}
 */
function createPromptsModule(prompts) {
	// Build definitions for prompts/list (without messages)
	const PROMPTS_DEFINITIONS = prompts.map((prompt) => ({
		name: prompt.name,
		title: prompt.title,
		description: prompt.description,
		arguments: prompt.arguments || []
	}));

	// Build mapping for prompts/get
	const PROMPTS_MAPPING = {};
	for (const prompt of prompts) {
		PROMPTS_MAPPING[prompt.name] = {
			description: prompt.description,
			messages: prompt.messages || []
		};
	}

	return {
		PROMPTS_DEFINITIONS,
		PROMPTS_MAPPING
	};
}

module.exports = { createPromptsModule };

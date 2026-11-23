import { getCurrentTools, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import type { BridgeTools } from "./config.js";

export const CODEMODE_TOOL_NAME = "codemode";
export const CODEMODE_POLL_ARG = "pollCallId";
export const POLL_TOOL_NAME = "bridge_poll_result";
export const BRIDGE_POLL_TOOL: Tool = {
	name: POLL_TOOL_NAME,
	description: "Fetch the result of a long-running bridge tool call that answered STILL RUNNING with a callId. Poll again if it still reports running; the result or an error arrives here.",
	parameters: {
		type: "object",
		properties: { callId: { type: "string", description: "callId from the STILL RUNNING answer" } },
		required: ["callId"],
	},
};

export interface BridgeCatalogEntry {
	name: string;
	description: string;
	inputSchema: object;
}

export function toBridgeCatalog(tools: readonly Tool[]): BridgeCatalogEntry[] {
	return tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }));
}

/** Project only the ACP MCP request. Pi's declaration and execution allowlists stay intact. */
export function acpCodeModeCatalog(messages: TranscriptContext["messages"]): BridgeCatalogEntry[] {
	const tool = getCurrentTools(messages).find(({ name }) => name === CODEMODE_TOOL_NAME);
	if (!tool) return [];
	return [{
		name: tool.name,
		description: tool.description,
		inputSchema: {
			type: "object",
			properties: {
				...(tool.parameters as { properties?: object }).properties,
				[CODEMODE_POLL_ARG]: { type: "string", description: "Call ID from a STILL RUNNING response. Omit code when polling." },
			},
			oneOf: [{ required: ["code"] }, { required: [CODEMODE_POLL_ARG] }],
			additionalProperties: false,
		},
	}];
}

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { source?: string };
}

/** The bridge has one live HTTP endpoint. Catalog and dispatch must both use
 * the CURRENT Pi active set: /mcp and pi.setActiveTools() can change it mid-session.
 * A stale tools/call must not bypass a disabled Pi tool. */
export function bridgedPiTools(
	all: BridgeToolInfo[], active: readonly string[], mode: BridgeTools, hidden: ReadonlySet<string>,
): BridgeToolInfo[] {
	if (mode === "none") return [];
	const enabled = new Set(active);
	return all.filter((tool) =>
		enabled.has(tool.name) && !hidden.has(tool.name) &&
		// Never bridge the bridge's own tools. agy has native web tools, so
		// our quota-burning one-shot wrappers must not tempt it through MCP.
		tool.name !== "AskAntigravity" && tool.name !== "antigravity" &&
		tool.name !== "agy_web_search" && tool.name !== "agy_read_url" &&
		tool.name !== "bridge_poll_result" && tool.name !== "activate_skill" &&
		(mode !== "mcp" || /pi-mcp-adapter/.test(tool.sourceInfo?.source ?? "")),
	);
}

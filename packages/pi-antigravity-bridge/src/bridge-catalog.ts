import { getCurrentTools, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import type { BridgeTools } from "./config.js";

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

/** Change Pi's request, not its active/callable set: Code Mode still needs the hidden tools. */
export function projectCodeModeOnlyTools(
	messages: ContextWithSystemEvent["messages"],
	modelOnlyNames: ReadonlySet<string>,
	allowedAcpNames?: ReadonlySet<string>,
): ContextWithSystemEvent["messages"] | undefined {
	const systems = messages.filter((message): message is SystemMessage => message.role === "system");
	const system = systems.at(-1);
	if (!system) return undefined;
	const tools = getCurrentTools(systems);
	if (!tools.some((tool) => tool.name === "codemode")) return undefined;
	const removed = tools.filter(({ name }) =>
		(name !== "codemode" && (name === "tool_search" || !modelOnlyNames.has(name))) ||
		(allowedAcpNames !== undefined && !allowedAcpNames.has(name)));
	const addPoll = allowedAcpNames !== undefined && tools.length > removed.length;
	if (!removed.length && !addPoll) return undefined;

	const index = messages.lastIndexOf(system);
	const removedNames = new Set(removed.map(({ name }) => name));
	const next = messages.slice();
	// Patch the last declaration delta without changing the user/tool-result tail.
	next[index] = {
		...system,
		toolsRemoved: [...(system.toolsRemoved ?? []), ...removed.map(({ name }) => ({ name }))],
		toolsAdded: [
			...(system.toolsAdded ?? []).filter(({ name }) => !removedNames.has(name)),
			...(addPoll ? [BRIDGE_POLL_TOOL] : []),
		],
	};
	return next;
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

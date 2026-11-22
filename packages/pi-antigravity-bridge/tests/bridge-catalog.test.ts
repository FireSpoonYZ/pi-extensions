import { describe, expect, it } from "vitest";
import { getCurrentTools, type Message, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import { BRIDGE_POLL_TOOL, bridgedPiTools, projectCodeModeOnlyTools, toBridgeCatalog } from "../src/bridge-catalog.js";

const all = [
	{ name: "web_search", sourceInfo: { source: "pi-web-search" } },
	{ name: "mcp:files", sourceInfo: { source: "pi-mcp-adapter" } },
	{ name: "read", sourceInfo: { source: "builtin" } },
	{ name: "antigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "AskAntigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_web_search", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_read_url", sourceInfo: { source: "pi-antigravity-bridge" } },
];

describe("live Pi bridge catalog", () => {
	it("includes active builtins and extensions in all mode", () => {
		expect(bridgedPiTools(all, ["read", "web_search"], "all", new Set()).map((t) => t.name)).toEqual(["web_search", "read"]);
		expect(bridgedPiTools(all, ["mcp:files"], "all", new Set()).map((t) => t.name)).toEqual(["mcp:files"]);
	});
	it("supports session-only hide, MCP-only mode, and bridge-off", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set(["web_search"])).map((t) => t.name)).toEqual(["mcp:files", "read"]);
		expect(bridgedPiTools(all, active, "mcp", new Set()).map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "none", new Set()).map((t) => t.name)).toEqual([]);
	});
	it("projects ACP Code Mode only from Pi declarations, without loading discovered tools", () => {
		const codemode: Tool = {
			name: "codemode",
			description: "Pi's final Code Mode instructions",
			parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
		};
		const tool = (name: string): Tool => ({ name, description: name, parameters: { type: "object" } });
		const question = tool("ask_user_question");
		const input = { role: "user", content: "Find an authorized tool.", timestamp: 3 } as const;
		const messages: Message[] = [
			{ role: "system", content: "", toolsAdded: [codemode, question, tool("tool_search"), tool("hidden")], timestamp: 1 },
			{ role: "system", content: "", toolsAdded: [tool("loaded_deferred")], timestamp: 2 },
			input,
		];
		const modelOnly = new Set(["codemode", "ask_user_question", "tool_search", "hidden"]);
		const allowed = new Set(["codemode", "ask_user_question", "tool_search", "loaded_deferred", "not_declared"]);
		const projected = projectCodeModeOnlyTools(messages, modelOnly, allowed);
		const tools = getCurrentTools(projected!.filter((message): message is SystemMessage => message.role === "system"));
		expect(toBridgeCatalog(tools)).toEqual(toBridgeCatalog([codemode, question, BRIDGE_POLL_TOOL]));
		expect(projected?.at(-1)).toBe(input);
		expect(getCurrentTools(messages).map(({ name }) => name)).toContain("loaded_deferred");
	});

	it("never exposes the bridge's own tools, including the web wrappers", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set()).map((t) => t.name)).toEqual(["web_search", "mcp:files", "read"]);
	});
});

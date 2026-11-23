import { describe, expect, it } from "vitest";
import { getCurrentTools, type Message, type Tool } from "@earendil-works/pi-ai";
import { CODEMODE_POLL_ARG, acpCodeModeCatalog, bridgedPiTools } from "../src/bridge-catalog.js";
import { buildAcpAgentBody, formatEscalatedAck } from "../src/provider.js";

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
	it("exposes only codemode to ACP without rewriting Pi's worker allowlist", () => {
		const code = { type: "string" };
		const codemode: Tool = {
			name: "codemode",
			description: "Pi's final Code Mode instructions",
			parameters: { type: "object", properties: { code }, required: ["code"] },
		};
		const tool = (name: string): Tool => ({ name, description: name, parameters: { type: "object" } });
		const otherNames = ["read", "write", "ask_user_question", "tool_search", "bridge_poll_result"];
		const messages: Message[] = [
			{ role: "system", content: "", toolsAdded: [codemode, ...otherNames.map(tool)], timestamp: 1 },
			{ role: "system", content: "", toolsAdded: [tool("loaded_deferred")], timestamp: 2 },
			{ role: "user", content: "Find an authorized tool.", timestamp: 3 },
		];
		const catalog = acpCodeModeCatalog(messages);
		expect(catalog.map((entry) => entry.name)).toEqual(["codemode"]);
		expect(catalog[0]).toMatchObject({
			description: codemode.description,
			inputSchema: {
				properties: { code, [CODEMODE_POLL_ARG]: { type: "string" } },
				oneOf: [{ required: ["code"] }, { required: [CODEMODE_POLL_ARG] }],
			},
		});
		expect(getCurrentTools(messages).map(({ name }) => name)).toEqual(["codemode", ...otherNames, "loaded_deferred"]);
		expect(codemode.parameters).toMatchObject({ required: ["code"] });
		expect(acpCodeModeCatalog([...messages, {
			role: "system", content: "", toolsRemoved: [{ name: "codemode" }], timestamp: 4,
		}])).toEqual([]);

		const body = buildAcpAgentBody(undefined, catalog, true);
		expect(body).toContain("`mcp_pi-bridge_codemode` when offered");
		expect(body).toContain("If only `call_mcp_tool` is offered");
		expect(body).toContain(CODEMODE_POLL_ARG);
		expect(body).not.toContain("bridge_poll_result");
		expect(buildAcpAgentBody(undefined, [], true)).not.toContain("mcp_pi-bridge_codemode");
		const escalation = { escalated: true, name: "codemode", callId: "test-id" } as const;
		expect(JSON.stringify(formatEscalatedAck(escalation, true))).not.toContain("bridge_poll_result");
		expect(JSON.stringify(formatEscalatedAck(escalation, true))).toContain(CODEMODE_POLL_ARG);
		expect(JSON.stringify(formatEscalatedAck(escalation))).toContain("bridge_poll_result");
	});

	it("never exposes the bridge's own tools, including the web wrappers", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set()).map((t) => t.name)).toEqual(["web_search", "mcp:files", "read"]);
	});
});

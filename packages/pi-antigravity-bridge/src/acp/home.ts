import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "../mcp-server.js";
import { bridgeServerEntry, bridgeServerName, readGlobalMcpConfig } from "../mcp-registration.js";
import { isValidAgyAgentName } from "../agents.js";

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
	return value as Record<string, unknown>;
}

function linkDirectory(source: string, target: string): void {
	fs.symlinkSync(source, target, "junction");
}

function resolveCarrierAgentMd(agent: string, geminiHome: string, explicitRoot?: string): string {
	const candidates = [
		explicitRoot,
		process.env.AGY_AGENTS_ROOT,
		path.join(geminiHome, "config", "agents"),
		path.join(os.homedir(), ".gemini", "config", "agents"),
	];
	for (const root of candidates) {
		if (!root) continue;
		const file = path.join(root, agent, "agent.md");
		try {
			if (fs.statSync(file).isFile()) return file;
		} catch {
			/* try next candidate */
		}
	}
	throw new Error(`ACP carrier agent "${agent}" not found`);
}

/** Staging root for isolated agy homes. The directory name predates the
 *  stream-json engine adopting homes; renaming it would strand existing
 *  installs' unswept dirs, so both engines stage under it. */
export function agyHomeStagingDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "antigravity-bridge", "acp-homes");
}

export interface AgentMcpServerSpec {
	name: string;
	serverUrl: string;
	headers?: Record<string, string>;
}

function formatAgentMcpYaml(servers: readonly AgentMcpServerSpec[]): string {
	const lines: string[] = ["mcpServers:"];
	for (const server of servers) {
		lines.push(`  - name: ${JSON.stringify(server.name)}`);
		lines.push(`    serverUrl: ${JSON.stringify(server.serverUrl)}`);
		const headers = server.headers ? Object.entries(server.headers) : [];
		if (headers.length > 0) {
			lines.push("    headers:");
			for (const [k, v] of headers) {
				lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
			}
		}
	}
	return lines.join("\n");
}

function injectAgentMcpServers(md: string, servers: readonly AgentMcpServerSpec[]): string {
	if (servers.length === 0) return md;
	const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md);
	if (!match) throw new Error("ACP carrier agent.md is missing YAML frontmatter");
	const frontmatter = match[1];
	const suffix = match[2];
	const rest = md.slice(match[0].length);
	return `---\n${frontmatter}\n${formatAgentMcpYaml(servers)}\n---${suffix}${rest}`;
}

export interface StageAgyHomeOptions {
	geminiHome?: string;
	parentDir?: string;
	/** Dir-name prefix: "acp-home" (ACP engine, default) or "agy-home"
	 *  (stream-json). The sweep accepts both. */
	prefix?: string;
	/** This session's bridge entry, written ENABLED straight into the staged
	 *  config (issue #14). Never ride the suppression marker here: the marker
	 *  hides bridges from an agy reading the GLOBAL config, and a private-home
	 *  agy never reads global - a marker-disabled own entry would break G9
	 *  silently inside our own home. Omit when the bridge is off. */
	ownBridge?: { pid: number; port: number; token: string; tokenHeader: string };
	/** Inherit foreign/global MCP entries from global mcp_config.json (default
	 *  true for stream-json; ACP sets false because session/new and
	 *  session/load plus the private agent frontmatter inject pi-bridge). */
	inheritGlobalMcp?: boolean;
	/** Generated carrier agent name for ACP restricted sessions. Copied into
	 *  <staged>/config/agents/<agent>/agent.md as a real directory (never
	 *  junctioned to global agents) so AGY_AGENTS_ROOT works and global
	 *  agents dirs are never mutated. */
	agent?: string;
	/** Explicit agent discovery root for tests; falls back to AGY_AGENTS_ROOT
	 *  then geminiHome/config/agents. */
	agentsRoot?: string;
	/** Session MCP server specs injected as `mcpServers` list-of-objects into
	 *  the PRIVATE copied carrier frontmatter so bridge access is part of the
	 *  custom Agent definition at creation time without writing secrets to the
	 *  global agent file. */
	agentMcpServers?: AgentMcpServerSpec[];
}

/** Isolate a spawned agy from per-pid bridge entries in the global MCP
 *  config: the staged home carries the global servers (when inheritGlobalMcp
 *  is true) minus every pi-bridge-*, plus (optionally) this session's bridge
 *  entry. When an ACP carrier agent is set, stages only that agent into a
 *  real config/agents/<agent> directory without junctioning global agents. */
export function stageAgyHome(opts: StageAgyHomeOptions = {}): string {
	const geminiHome = opts.geminiHome ?? path.join(os.homedir(), ".gemini");
	const globalConfigDir = path.join(geminiHome, "config");
	const globalMcpPath = path.join(globalConfigDir, "mcp_config.json");
	const inheritGlobalMcp = opts.inheritGlobalMcp ?? true;
	let carrierMd: string | undefined;
	if (opts.agent !== undefined) {
		if (!isValidAgyAgentName(opts.agent)) {
			throw new Error(`Invalid ACP agent name: ${opts.agent}`);
		}
		carrierMd = resolveCarrierAgentMd(opts.agent, geminiHome, opts.agentsRoot);
	}

	let config: Record<string, unknown> = { mcpServers: {} };
	let filtered: Record<string, unknown> = {};
	if (inheritGlobalMcp) {
		try {
			// Tolerant of the CLI's 0-byte fresh-install file and a UTF-8 BOM;
			// only a missing file means "no config at all" (issue #11).
			config = record(readGlobalMcpConfig(globalMcpPath), globalMcpPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Cannot isolate inherited MCP config ${globalMcpPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const servers = record(config.mcpServers ?? {}, `${globalMcpPath} mcpServers`);
		filtered = Object.fromEntries(
			Object.entries(servers).filter(([name]) => !/^pi-bridge(?:-\d+)?$/.test(name)),
		);
	}
	if (opts.ownBridge) {
		filtered[bridgeServerName(opts.ownBridge.pid)] = bridgeServerEntry({ ...opts.ownBridge, disabled: false });
	}

	const parentDir = opts.parentDir ?? agyHomeStagingDir();
	const prefix = opts.prefix ?? "acp-home";
	fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
	const staged = fs.mkdtempSync(path.join(parentDir, `${prefix}-${process.pid}-`));
	try {
		fs.mkdirSync(path.join(staged, "config"), { mode: 0o700 });
		fs.writeFileSync(path.join(staged, "config", "mcp_config.json"), JSON.stringify({ ...config, mcpServers: filtered }), { mode: 0o600 });

		const appData = path.join(geminiHome, "antigravity-cli");
		if (fs.existsSync(appData)) linkDirectory(appData, path.join(staged, "antigravity-cli"));
		const instructions = path.join(geminiHome, "GEMINI.md");
		if (inheritGlobalMcp && fs.existsSync(instructions)) fs.copyFileSync(instructions, path.join(staged, "GEMINI.md"));
		const skipAgentsJunction = Boolean(opts.agent) || !inheritGlobalMcp;
		if (fs.existsSync(globalConfigDir)) {
			for (const entry of fs.readdirSync(globalConfigDir, { withFileTypes: true })) {
				if (entry.name === "mcp_config.json") continue;
				if (skipAgentsJunction && entry.name === "agents") continue;
				const source = path.join(globalConfigDir, entry.name);
				const target = path.join(staged, "config", entry.name);
				let stat: fs.Stats | fs.Dirent = entry;
				if (entry.isSymbolicLink()) {
					try {
						stat = fs.statSync(source);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw err;
					}
				}
				if (stat.isDirectory()) linkDirectory(source, target);
				else if (stat.isFile()) fs.copyFileSync(source, target);
			}
		}
		if (opts.agent && carrierMd) {
			const targetDir = path.join(staged, "config", "agents", opts.agent);
			fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
			const rawAgentMd = fs.readFileSync(carrierMd, "utf8");
			const privateAgentMd = opts.agentMcpServers?.length
				? injectAgentMcpServers(rawAgentMd, opts.agentMcpServers)
				: rawAgentMd;
			fs.writeFileSync(path.join(targetDir, "agent.md"), privateAgentMd, { mode: 0o600 });
		}
		return staged;
	} catch (err) {
		fs.rmSync(staged, { recursive: true, force: true });
		throw err;
	}
}

/** Sweep staged homes whose owning pi process died. Accepts both engine
 *  prefixes; a home staged by the CURRENT process is skipped (it may be in
 *  use by a live driver - process-exit leftovers are the next start's
 *  problem). */
export function sweepStagedAgyHomes(baseDir: string = agyHomeStagingDir(), alive: (pid: number) => boolean = isPidAlive): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(baseDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = /^(?:acp|agy)-home-(\d+)-/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || alive(pid)) continue;
		removeStagedAgyHome(path.join(baseDir, name));
	}
}

/** Add or refresh this session's own bridge entry in an ALREADY-STAGED
 *  home (the bridge was enabled after the first spawn staged the home
 *  without one). Single-writer file (our pid owns the session), plain
 *  write is fine. */
export function writeOwnBridgeEntry(staged: string, entry: { pid: number; port: number; token: string; tokenHeader: string }): void {
	const cfgPath = path.join(staged, "config", "mcp_config.json");
	const cfg = record(readGlobalMcpConfig(cfgPath), cfgPath);
	const servers = record(cfg.mcpServers ?? {}, `${cfgPath} mcpServers`);
	servers[bridgeServerName(entry.pid)] = bridgeServerEntry({ ...entry, disabled: false });
	// Same-dir tmp + rename: agy watches config dirs, so a truncated
	// mid-write read must be impossible (issue #14 review round 3).
	const tmp = `${cfgPath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify({ ...cfg, mcpServers: servers }), { mode: 0o600 });
	fs.renameSync(tmp, cfgPath);
}

export function removeStagedAgyHome(staged: string): void {
	const base = path.basename(staged);
	if (!base.startsWith("acp-home-") && !base.startsWith("agy-home-")) return;
	try {
		if (!fs.lstatSync(staged).isDirectory()) return;
		fs.rmSync(staged, { recursive: true, force: true });
	} catch {
		// Connection teardown is best-effort; startup sweeps crash leftovers.
	}
}

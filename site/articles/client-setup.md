# Client Setup

How to register `desktop-touch-mcp` in common MCP clients.

This page is intentionally practical.  
If you already know what MCP is, you should be able to copy one snippet, paste it into your client config, and move on.

For the public site, the simplest honest scope note is:

> **Assume Windows 11 only for now. Multi-OS support is not implemented yet.**

---

## Start with the transport

This project supports both local `stdio` launch and local `HTTP` connection.

All examples on this page assume a local Windows 11 machine.

### Stdio

Use this when your client can launch a local process directly.

```bash
npx -y @harusame64/desktop-touch-mcp
```

### HTTP

Use this when your client prefers a URL-based MCP registration.

```bash
npx -y @harusame64/desktop-touch-mcp --http
```

The default local endpoint is:

```text
http://127.0.0.1:23847/mcp
```

Optional health check:

```text
http://127.0.0.1:23847/health
```

If you want a different port:

```bash
npx -y @harusame64/desktop-touch-mcp --http --port 8080
```

---

## Which transport should I choose?

- Use `stdio` when the client already knows how to launch local MCP servers
- Use `HTTP` when the client asks for a server URL
- Use `HTTP` for ChatGPT Developer mode
- Use `stdio` first if you want the simplest local setup

---

## Tested clients

The transport shapes on this page are based on current official client docs, and this project has also been manually checked against:

- Claude
- GitHub Copilot CLI
- VS Code / Copilot Chat
- OpenAI Codex
- Gemini CLI

---

## Claude Code

Claude Code has both a CLI registration flow and a project JSON format.

### Fastest path

```bash
claude mcp add --transport stdio desktop-touch -- npx -y @harusame64/desktop-touch-mcp
```

### Local HTTP path

First start the server:

```bash
npx -y @harusame64/desktop-touch-mcp --http
```

Then register it:

```bash
claude mcp add --transport http desktop-touch http://127.0.0.1:23847/mcp
```

### Shared project config

Create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"]
    }
  }
}
```

HTTP version:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "http",
      "url": "http://127.0.0.1:23847/mcp"
    }
  }
}
```

---

## GitHub Copilot CLI

Copilot CLI supports both an interactive MCP form and a JSON configuration file.

### Interactive path

```text
/mcp add
```

Then choose:

- Server Name: `desktop-touch`
- Server Type: `Local` or `STDIO`
- Command: `npx -y @harusame64/desktop-touch-mcp`

For HTTP:

- Server Type: `HTTP`
- URL: `http://127.0.0.1:23847/mcp`

### JSON config

Edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

HTTP version:

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "http",
      "url": "http://127.0.0.1:23847/mcp",
      "tools": ["*"]
    }
  }
}
```

---

## VS Code / Copilot Chat

If you use MCP through VS Code Agent mode, use `.vscode/mcp.json`.

### Stdio

```json
{
  "servers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"]
    }
  }
}
```

### HTTP

```json
{
  "servers": {
    "desktop-touch": {
      "type": "http",
      "url": "http://127.0.0.1:23847/mcp"
    }
  }
}
```

If you start the server over HTTP, open Copilot Chat, switch to Agent mode, and enable the server from the tools picker.

---

## OpenAI Codex

Codex supports MCP servers through `~/.codex/config.toml`.  
If you prefer local setup, `stdio` is a good default. If you prefer endpoint-based setup, use `url`.

### Stdio

```toml
[mcp_servers.desktop_touch]
command = "npx"
args = ["-y", "@harusame64/desktop-touch-mcp"]
```

### HTTP

```toml
[mcp_servers.desktop_touch]
url = "http://127.0.0.1:23847/mcp"
```

You can also verify what Codex sees with:

```bash
codex mcp list
```

---

## ChatGPT Developer Mode

If by “GPT” you mean ChatGPT itself, the current public OpenAI docs describe remote MCP usage through Developer mode.

### Important note

For ChatGPT Developer mode, the officially documented path is remote MCP over streaming HTTP or SSE.  
So for `desktop-touch-mcp`, use the local HTTP mode and expose:

```text
http://127.0.0.1:23847/mcp
```

Then in ChatGPT:

1. Go to `Settings -> Apps -> Advanced settings -> Developer mode`
2. Enable Developer mode
3. Create an app for your MCP server
4. Add the local MCP endpoint

If you are writing public setup docs, it is safer to describe ChatGPT as an `HTTP-first` client.

---

## Gemini CLI

Gemini CLI reads MCP servers from `settings.json`.

- User config: `~/.gemini/settings.json`
- Workspace config: `.gemini/settings.json`

### Stdio

```json
{
  "mcpServers": {
    "desktop-touch": {
      "command": "npx",
      "args": ["-y", "@harusame64/desktop-touch-mcp"]
    }
  }
}
```

### HTTP

```json
{
  "mcpServers": {
    "desktop-touch": {
      "httpUrl": "http://127.0.0.1:23847/mcp"
    }
  }
}
```

Gemini CLI also has an `/mcp` command, which is useful for checking server status after registration.

---

## Small advice

If you are documenting this project for other people:

- show `stdio` first
- show `HTTP` second
- always include the exact local URL
- keep one copy-paste snippet per client
- do not make readers reverse-engineer transport names

That is usually enough to get someone from “interesting project” to “I actually tried it.”

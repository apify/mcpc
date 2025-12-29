# mcpc Claude Code skill

This directory contains a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) that helps AI agents use mcpc effectively.

## Installation

Copy or symlink the `SKILL.md` file to your Claude Code skills directory:

```bash
# Create skills directory if it doesn't exist
mkdir -p ~/.claude/skills/mcpc

# Option 1: Copy the file
cp SKILL.md ~/.claude/skills/mcpc/

# Option 2: Symlink (auto-updates when mcpc is updated)
ln -s "$(pwd)/SKILL.md" ~/.claude/skills/mcpc/SKILL.md
```

Then restart Claude Code to load the skill.

## What it does

The skill teaches Claude Code how to use mcpc for:

- Calling MCP tools efficiently via CLI instead of function calling
- Managing persistent sessions for better performance
- Parsing JSON output for scripting workflows
- Handling authentication (OAuth and bearer tokens)
- Debugging connection issues

## Usage

Once installed, Claude Code will automatically use mcpc when you ask it to interact with MCP servers. For example:

- "List the tools available on mcp.apify.com"
- "Call the search tool with query 'web scraper'"
- "Create a session to the Apify MCP server"

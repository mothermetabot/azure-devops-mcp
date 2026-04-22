# azure-devops-mcp

An MCP server that lets your AI assistant talk to Azure DevOps. Manage work items, inspect builds, read pipeline logs, and more, all through natural language via the [Model Context Protocol](https://modelcontextprotocol.io/).

## Why does this exist?

If you've ever found yourself constantly switching between your AI chat and the Azure DevOps web UI just to check a build status or update a work item, you know the pain. This project was born out of that exact frustration.

The idea is simple: give your MCP-compatible AI assistant (Claude, etc.) direct access to your Azure DevOps project so you can stay in the flow. Ask it to list your active bugs, create a task, check why a pipeline failed, or pull the logs from a broken build step. No more context switching, no more copying IDs back and forth.

## What can it do?

### Work Item Tracking

- **list_work_items** - Query work items with filters (state, type, assignee) or raw WIQL
- **get_work_item** - Fetch full details of a single work item
- **get_work_item_tree** - Get a work item with its parent, siblings, and children in one shot
- **create_work_item** - Create tasks, bugs, user stories, and other work item types
- **update_work_item** - Update fields on existing work items
- **comment** - Add comments to work items
- **add_tag** - Tag work items (merges with existing tags, no duplicates)

### Builds and Pipelines

- **list_pipelines** - Browse pipeline definitions
- **list_builds** - List recent builds, filterable by pipeline, result, and branch
- **get_build** - Full details for a single build
- **get_build_timeline** - Step-by-step breakdown of a build run with errors and warnings
- **get_build_log** - Read log output for a specific build step (supports tailing)

## Setup

### Prerequisites

- Node.js (v18 or later recommended)
- An Azure DevOps organization and project
- A Personal Access Token (PAT) with appropriate scopes (Work Items: Read/Write, Build: Read at minimum)

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/azure-devops-mcp.git
cd azure-devops-mcp
npm install
npm run build
```

### Configuration

Create a `config.json` file in the project root:

```json
{
  "organization": "your-org-name",
  "project": "your-project-name",
  "area_path": "optional\\default\\area path",
  "iteration_path": "optional\\default\\iteration path"
}
```

The `area_path` and `iteration_path` are optional. When provided, they serve as defaults for newly created work items.

Set your Personal Access Token as an environment variable:

```bash
export AZURE_DEVOPS_PAT="your-pat-here"
```

### Running

```bash
npm start
```

The server communicates over stdio, so you don't run it directly. Instead, you configure your MCP client to launch it.

### Using with Claude Desktop / Claude Code

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": ["path/to/azure-devops-mcp/dist/index.js"],
      "env": {
        "AZURE_DEVOPS_PAT": "your-pat-here"
      }
    }
  }
}
```

## Disclaimer

This is a personal project that I decided to share with the world. It works for my use case, but your mileage may vary. There are no guarantees that it will work for you, your organization, or your specific Azure DevOps setup. It might break, it might not cover the API you need, it might format something weird.

Use it at your own risk. If it breaks, you get to keep both pieces.

That said, if you find a bug or want to contribute, issues and PRs are welcome.

## Roadmap

Here's where things stand and where they're headed.

### Supported

- [x] Work item CRUD (create, read, update)
- [x] Work item comments and tags
- [x] Work item hierarchy traversal (parent/children/siblings)
- [x] WIQL query support
- [x] Pipeline/build definition listing
- [x] Build listing with filters
- [x] Build details and timeline inspection
- [x] Build log retrieval

### Not yet supported (but on the radar)

- [ ] Git/repository operations (repos, pull requests, branches)
- [ ] Release management
- [ ] Test management (test plans, test runs)
- [ ] Board and sprint management
- [ ] Work item attachments
- [ ] Deleting/moving work items
- [ ] Triggering pipeline runs
- [ ] Custom field support beyond the built-in set

### Not planned (for now)

- Wiki/documentation APIs
- Artifact management
- Service hooks / notifications

## License

ISC

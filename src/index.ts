import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as azdev from "azure-devops-node-api";
import type { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi.js";
import type { IBuildApi } from "azure-devops-node-api/BuildApi.js";
import type {
  Wiql,
  WorkItem,
} from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js";
import type {
  Build,
  TimelineRecord,
} from "azure-devops-node-api/interfaces/BuildInterfaces.js";
import { BuildResult, BuildStatus, BuildQueryOrder } from "azure-devops-node-api/interfaces/BuildInterfaces.js";
import { Operation } from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";

interface JsonPatchOperation {
  op: Operation;
  path: string;
  value: unknown;
}
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config & client (lazy)
// ---------------------------------------------------------------------------

interface Config {
  organization: string;
  project: string;
  area_path?: string;
  iteration_path?: string;
}

let _config: Config | null = null;
let _witClient: IWorkItemTrackingApi | null = null;
let _buildClient: IBuildApi | null = null;

function loadConfig(): Config {
  if (!_config) {
    const configPath = path.join(__dirname, "..", "config.json");
    _config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return _config!;
}

async function getWitClient(): Promise<IWorkItemTrackingApi> {
  if (!_witClient) {
    const pat = process.env.AZURE_DEVOPS_PAT;
    if (!pat) throw new Error("AZURE_DEVOPS_PAT environment variable is not set");
    const config = loadConfig();
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    const connection = new azdev.WebApi(
      `https://dev.azure.com/${config.organization}`,
      authHandler
    );
    _witClient = await connection.getWorkItemTrackingApi();
  }
  return _witClient;
}

async function getBuildClient(): Promise<IBuildApi> {
  if (!_buildClient) {
    const pat = process.env.AZURE_DEVOPS_PAT;
    if (!pat) throw new Error("AZURE_DEVOPS_PAT environment variable is not set");
    const config = loadConfig();
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    const connection = new azdev.WebApi(
      `https://dev.azure.com/${config.organization}`,
      authHandler
    );
    _buildClient = await connection.getBuildApi();
  }
  return _buildClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIELD_MAP: Record<string, string> = {
  title: "System.Title",
  description: "System.Description",
  acceptance_criteria: "Microsoft.VSTS.Common.AcceptanceCriteria",
  assigned_to: "System.AssignedTo",
  state: "System.State",
  area_path: "System.AreaPath",
  iteration_path: "System.IterationPath",
  story_points: "Microsoft.VSTS.Scheduling.StoryPoints",
};

function buildDocument(fields: Record<string, string>): JsonPatchOperation[] {
  const doc: JsonPatchOperation[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value && FIELD_MAP[key]) {
      doc.push({
        op: Operation.Add,
        path: `/fields/${FIELD_MAP[key]}`,
        value,
      });
    }
  }
  return doc;
}

const SUMMARY_FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.WorkItemType",
  "System.AreaPath",
  "System.IterationPath",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.Scheduling.StoryPoints",
];

function extractIdFromUrl(url: string): number | null {
  const match = url.match(/workItems\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function formatWorkItem(wi: WorkItem): Record<string, unknown> {
  const fields = wi.fields || {};
  const assignedTo = fields["System.AssignedTo"];

  const relations: { parent_id?: number; child_ids: number[]; related_ids: number[] } = {
    child_ids: [],
    related_ids: [],
  };

  for (const rel of wi.relations ?? []) {
    const id = rel.url ? extractIdFromUrl(rel.url) : null;
    if (!id) continue;
    if (rel.rel === "System.LinkTypes.Hierarchy-Reverse") {
      relations.parent_id = id;
    } else if (rel.rel === "System.LinkTypes.Hierarchy-Forward") {
      relations.child_ids.push(id);
    } else if (rel.rel === "System.LinkTypes.Related") {
      relations.related_ids.push(id);
    }
  }

  return {
    id: wi.id,
    url: wi.url,
    type: fields["System.WorkItemType"] ?? "",
    title: fields["System.Title"] ?? "",
    state: fields["System.State"] ?? "",
    assigned_to:
      typeof assignedTo === "object" && assignedTo !== null
        ? (assignedTo as Record<string, string>).displayName ?? ""
        : String(assignedTo ?? ""),
    area_path: fields["System.AreaPath"] ?? "",
    iteration_path: fields["System.IterationPath"] ?? "",
    description: fields["System.Description"] ?? "",
    acceptance_criteria: fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "",
    story_points: fields["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0,
    ...relations,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "azure-devops", version: "1.0.0" });

// -- list_work_items --

server.tool(
  "list_work_items",
  "List work items from Azure DevOps. Provide filters or a raw WIQL query.",
  {
    state: z.string().optional().describe('Filter by state (e.g. "New", "Active", "Closed")'),
    work_item_type: z.string().optional().describe('Filter by type (e.g. "Task", "Bug", "User Story")'),
    assigned_to: z.string().optional().describe("Filter by assigned user display name or email"),
    query: z.string().optional().describe("Raw WIQL query. If provided, other filters are ignored."),
    max_results: z.number().optional().default(50).describe("Maximum number of results (default 50)"),
  },
  async ({ state, work_item_type, assigned_to, query, max_results }) => {
    const client = await getWitClient();
    const config = loadConfig();
    const project = config.project;

    if (!query) {
      const clauses = [`[System.TeamProject] = '${project}'`];
      if (state) clauses.push(`[System.State] = '${state}'`);
      if (work_item_type) clauses.push(`[System.WorkItemType] = '${work_item_type}'`);
      if (assigned_to) clauses.push(`[System.AssignedTo] = '${assigned_to}'`);
      const fieldList = SUMMARY_FIELDS.map((f) => `[${f}]`).join(", ");
      query = `SELECT ${fieldList} FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [System.Id] DESC`;
    }

    const wiql: Wiql = { query };
    const result = await client.queryByWiql(wiql, { project }, undefined, max_results);
    const refs = result.workItems ?? [];
    if (refs.length === 0) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ work_items: [], count: 0 }) }] };
    }

    const ids = refs.map((r) => r.id!);
    const workItems = await client.getWorkItems(ids, SUMMARY_FIELDS);
    const formatted = workItems.map(formatWorkItem);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ work_items: formatted, count: formatted.length }, null, 2) }],
    };
  }
);

// -- get_work_item --

server.tool(
  "get_work_item",
  "Get full details of a single work item by ID.",
  {
    work_item_id: z.number().describe("The ID of the work item to retrieve"),
  },
  async ({ work_item_id }) => {
    const client = await getWitClient();
    const wi = await client.getWorkItem(work_item_id, undefined, undefined, 4 /* WorkItemExpand.All */);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(formatWorkItem(wi), null, 2) }],
    };
  }
);

// -- get_work_item_tree --

server.tool(
  "get_work_item_tree",
  "Get a work item with its full context: parent, siblings (other children of the same parent), and children. Returns the tree in a single call.",
  {
    work_item_id: z.number().describe("The ID of the work item to retrieve with its tree context"),
  },
  async ({ work_item_id }) => {
    const client = await getWitClient();

    // 1. Get the target work item with relations
    const wi = await client.getWorkItem(work_item_id, undefined, undefined, 4 /* WorkItemExpand.All */);
    const formatted = formatWorkItem(wi);

    const result: Record<string, unknown> = { work_item: formatted };

    // 2. Get parent (if any) and its children (= siblings)
    const parentId = formatted.parent_id as number | undefined;
    if (parentId) {
      const parent = await client.getWorkItem(parentId, undefined, undefined, 4 /* WorkItemExpand.All */);
      const formattedParent = formatWorkItem(parent);
      result.parent = formattedParent;

      // Siblings = parent's children, excluding the target item
      const siblingIds = (formattedParent.child_ids as number[]).filter((id) => id !== work_item_id);
      if (siblingIds.length > 0) {
        const siblings = await client.getWorkItems(siblingIds, undefined, undefined, 4 /* WorkItemExpand.All */);
        result.siblings = siblings.map(formatWorkItem);
      } else {
        result.siblings = [];
      }
    }

    // 3. Get children (if any)
    const childIds = formatted.child_ids as number[];
    if (childIds.length > 0) {
      const children = await client.getWorkItems(childIds, undefined, undefined, 4 /* WorkItemExpand.All */);
      result.children = children.map(formatWorkItem);
    } else {
      result.children = [];
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// -- create_work_item --

server.tool(
  "create_work_item",
  "Create a new work item in Azure DevOps.",
  {
    work_item_type: z.string().describe('Type of work item (e.g. "Task", "Bug", "User Story")'),
    title: z.string().describe("Title of the work item"),
    description: z.string().optional().default("").describe("HTML description"),
    acceptance_criteria: z.string().optional().default("").describe("Acceptance criteria (HTML). Populates the dedicated AC field, not the description."),
    assigned_to: z.string().optional().default("").describe("User to assign to"),
    state: z.string().optional().default("").describe('Initial state (e.g. "New", "Active")'),
    area_path: z.string().optional().default("").describe("Area path. Falls back to config default if empty."),
    iteration_path: z.string().optional().default("").describe("Iteration path. Falls back to config default if empty."),
    parent_id: z.number().optional().describe("Optional parent work item ID to link as child"),
  },
  async ({ work_item_type, title, description, acceptance_criteria, assigned_to, state, area_path, iteration_path, parent_id }) => {
    const client = await getWitClient();
    const config = loadConfig();

    const doc = buildDocument({
      title,
      description: description || "",
      acceptance_criteria: acceptance_criteria || "",
      assigned_to: assigned_to || "",
      state: state || "",
      area_path: area_path || config.area_path || "",
      iteration_path: iteration_path || config.iteration_path || "",
    });

    if (parent_id) {
      const parentUrl = `https://dev.azure.com/${config.organization}/${config.project}/_apis/wit/workItems/${parent_id}`;
      doc.push({
        op: Operation.Add,
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: parentUrl,
        },
      });
    }

    const wi = await client.createWorkItem(undefined, doc, config.project, work_item_type);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id: wi.id, url: wi.url }, null, 2) }],
    };
  }
);

// -- update_work_item --

server.tool(
  "update_work_item",
  "Update fields on an existing work item. Only non-empty fields are updated.",
  {
    work_item_id: z.number().describe("The ID of the work item to update"),
    title: z.string().optional().default("").describe("New title"),
    description: z.string().optional().default("").describe("New HTML description"),
    acceptance_criteria: z.string().optional().default("").describe("New acceptance criteria (HTML)"),
    assigned_to: z.string().optional().default("").describe("New assignee"),
    state: z.string().optional().default("").describe("New state"),
    area_path: z.string().optional().default("").describe("New area path"),
    iteration_path: z.string().optional().default("").describe("New iteration path"),
    story_points: z.number().optional().describe("Story points (numeric). Set to 0 or omit to leave unchanged."),
  },
  async ({ work_item_id, title, description, acceptance_criteria, assigned_to, state, area_path, iteration_path, story_points }) => {
    const client = await getWitClient();
    const config = loadConfig();

    const doc = buildDocument({
      title: title || "",
      description: description || "",
      acceptance_criteria: acceptance_criteria || "",
      assigned_to: assigned_to || "",
      state: state || "",
      area_path: area_path || "",
      iteration_path: iteration_path || "",
    });

    if (story_points !== undefined && story_points > 0) {
      doc.push({
        op: Operation.Add,
        path: `/fields/${FIELD_MAP.story_points}`,
        value: story_points,
      });
    }

    if (doc.length === 0) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }] };
    }

    const wi = await client.updateWorkItem(undefined, doc, work_item_id, config.project);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id: wi.id, url: wi.url }, null, 2) }],
    };
  }
);

// -- comment --

server.tool(
  "comment",
  "Add a comment to an existing work item.",
  {
    work_item_id: z.number().describe("The ID of the work item to comment on"),
    text: z.string().describe("The comment text (supports HTML)"),
  },
  async ({ work_item_id, text }) => {
    const client = await getWitClient();
    const config = loadConfig();

    const doc: JsonPatchOperation[] = [
      {
        op: Operation.Add,
        path: "/fields/System.History",
        value: text,
      },
    ];

    const wi = await client.updateWorkItem(undefined, doc, work_item_id, config.project);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id: wi.id, comment_added: true }, null, 2) }],
    };
  }
);

// -- add_tag --

server.tool(
  "add_tag",
  "Add one or more tags to an existing work item. Preserves existing tags.",
  {
    work_item_id: z.number().describe("The ID of the work item"),
    tags: z.string().describe('Tags to add, separated by semicolons (e.g. "urgent; frontend")'),
  },
  async ({ work_item_id, tags }) => {
    const client = await getWitClient();
    const config = loadConfig();

    // Fetch current tags so we can merge
    const wi = await client.getWorkItem(work_item_id, ["System.Tags"]);
    const existing = (wi.fields?.["System.Tags"] as string) || "";
    const existingSet = new Set(
      existing
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean)
    );
    const newTags = tags
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean);
    for (const t of newTags) existingSet.add(t);

    const merged = [...existingSet].join("; ");
    const doc: JsonPatchOperation[] = [
      {
        op: Operation.Replace,
        path: "/fields/System.Tags",
        value: merged,
      },
    ];

    const updated = await client.updateWorkItem(undefined, doc, work_item_id, config.project);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ id: updated.id, tags: merged }, null, 2),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Build / Pipeline helpers
// ---------------------------------------------------------------------------

const RESULT_MAP: Record<string, BuildResult> = {
  failed: BuildResult.Failed,
  succeeded: BuildResult.Succeeded,
  partiallysucceeded: BuildResult.PartiallySucceeded,
  canceled: BuildResult.Canceled,
};

function resultToString(r: BuildResult | undefined): string {
  switch (r) {
    case BuildResult.Succeeded: return "succeeded";
    case BuildResult.PartiallySucceeded: return "partiallySucceeded";
    case BuildResult.Failed: return "failed";
    case BuildResult.Canceled: return "canceled";
    default: return "none";
  }
}

function formatBuild(b: Build): Record<string, unknown> {
  return {
    id: b.id,
    buildNumber: b.buildNumber ?? "",
    definition: b.definition ? { id: b.definition.id, name: b.definition.name } : null,
    result: resultToString(b.result),
    status: b.status === BuildStatus.Completed ? "completed"
      : b.status === BuildStatus.InProgress ? "inProgress"
      : b.status === BuildStatus.Cancelling ? "cancelling"
      : b.status === BuildStatus.NotStarted ? "notStarted"
      : "unknown",
    sourceBranch: b.sourceBranch ?? "",
    sourceVersion: b.sourceVersion ?? "",
    startTime: b.startTime ?? null,
    finishTime: b.finishTime ?? null,
    requestedFor: b.requestedFor?.displayName ?? "",
    requestedBy: b.requestedBy?.displayName ?? "",
    reason: b.reason ?? "",
  };
}

function formatTimelineRecord(r: TimelineRecord): Record<string, unknown> {
  return {
    id: r.id ?? "",
    name: r.name ?? "",
    type: r.type ?? "",
    state: r.state === 0 ? "pending" : r.state === 1 ? "inProgress" : r.state === 2 ? "completed" : "unknown",
    result: r.result === 0 ? "succeeded"
      : r.result === 1 ? "succeededWithIssues"
      : r.result === 2 ? "failed"
      : r.result === 3 ? "canceled"
      : r.result === 4 ? "skipped"
      : r.result === 5 ? "abandoned"
      : "unknown",
    errorCount: r.errorCount ?? 0,
    warningCount: r.warningCount ?? 0,
    issues: (r.issues ?? []).map((i) => ({ type: i.type, message: i.message, category: i.category })),
    log: r.log ? { id: r.log.id } : null,
    startTime: r.startTime ?? null,
    finishTime: r.finishTime ?? null,
    parentId: r.parentId ?? null,
    order: r.order ?? 0,
  };
}

// -- list_pipelines --

server.tool(
  "list_pipelines",
  "List pipeline definitions. Helps find pipeline names and IDs.",
  {
    name: z.string().optional().describe("Filter by pipeline name (substring match)"),
    top: z.number().optional().default(20).describe("Maximum results (default 20)"),
  },
  async ({ name, top }) => {
    const client = await getBuildClient();
    const config = loadConfig();

    const defs = await client.getDefinitions(
      config.project,
      name || undefined, // name filter
      undefined, undefined, undefined,
      top,
    );

    const formatted = defs.map((d) => ({
      id: d.id,
      name: d.name ?? "",
      path: d.path ?? "",
      latestBuild: d.latestBuild ? {
        id: d.latestBuild.id,
        buildNumber: d.latestBuild.buildNumber,
        result: resultToString(d.latestBuild.result),
        finishTime: d.latestBuild.finishTime,
      } : null,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ pipelines: formatted, count: formatted.length }, null, 2) }],
    };
  }
);

// -- list_builds --

server.tool(
  "list_builds",
  "List recent builds with filtering by result, pipeline, and branch.",
  {
    pipeline_id: z.number().optional().describe("Filter to a specific pipeline definition ID"),
    result: z.string().optional().default("failed").describe('Filter by result: "failed", "succeeded", "partiallySucceeded", "canceled"'),
    top: z.number().optional().default(10).describe("Maximum results (default 10)"),
    branch: z.string().optional().describe("Filter by branch name (e.g. refs/heads/dev)"),
  },
  async ({ pipeline_id, result, top, branch }) => {
    const client = await getBuildClient();
    const config = loadConfig();

    const resultFilter = RESULT_MAP[(result || "failed").toLowerCase()] ?? BuildResult.Failed;
    const definitions = pipeline_id ? [pipeline_id] : undefined;

    const builds = await client.getBuilds(
      config.project,
      definitions,
      undefined, // queues
      undefined, // buildNumber
      undefined, // minTime
      undefined, // maxTime
      undefined, // requestedFor
      undefined, // reasonFilter
      BuildStatus.Completed,
      resultFilter,
      undefined, // tagFilters
      undefined, // properties
      top,
      undefined, // continuationToken
      undefined, // maxBuildsPerDefinition
      undefined, // deletedFilter
      BuildQueryOrder.FinishTimeDescending,
      branch || undefined,
    );

    const formatted = builds.map(formatBuild);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ builds: formatted, count: formatted.length }, null, 2) }],
    };
  }
);

// -- get_build --

server.tool(
  "get_build",
  "Get full details of a single build by ID.",
  {
    build_id: z.number().describe("The build ID to retrieve"),
  },
  async ({ build_id }) => {
    const client = await getBuildClient();
    const config = loadConfig();
    const build = await client.getBuild(config.project, build_id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(formatBuild(build), null, 2) }],
    };
  }
);

// -- get_build_timeline --

server.tool(
  "get_build_timeline",
  "Get the timeline of a build — shows all tasks/steps with status, errors, and log references. Only returns Job and Task records.",
  {
    build_id: z.number().describe("The build ID"),
  },
  async ({ build_id }) => {
    const client = await getBuildClient();
    const config = loadConfig();
    const timeline = await client.getBuildTimeline(config.project, build_id);

    if (!timeline || !timeline.records) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ records: [], count: 0 }) }] };
    }

    // Only include Job and Task records to keep output concise
    const relevant = timeline.records
      .filter((r) => r.type === "Job" || r.type === "Task")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const formatted = relevant.map(formatTimelineRecord);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ records: formatted, count: formatted.length }, null, 2) }],
    };
  }
);

// -- get_build_log --

server.tool(
  "get_build_log",
  "Get log content for a specific log ID from a build. Returns the last N lines (tail). Use log IDs from get_build_timeline results.",
  {
    build_id: z.number().describe("The build ID"),
    log_id: z.number().describe("The log ID (from timeline record's log.id field)"),
    tail: z.number().optional().default(200).describe("Number of lines from the end to return (default 200)"),
  },
  async ({ build_id, log_id, tail }) => {
    const client = await getBuildClient();
    const config = loadConfig();

    const lines = await client.getBuildLogLines(config.project, build_id, log_id);
    const trimmed = lines.slice(-tail);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ log_id, total_lines: lines.length, returned_lines: trimmed.length, lines: trimmed }, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

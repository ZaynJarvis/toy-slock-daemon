import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildFetchDispatcher } from "./proxy.js";

function toLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const args = process.argv.slice(2);
let agentId = "";
let serverUrl = "http://localhost:3001";
let authToken = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--agent-id" && args[i + 1]) agentId = args[++i];
  if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
  if (args[i] === "--auth-token" && args[i + 1]) authToken = args[++i];
}

if (!agentId) {
  console.error("Missing --agent-id");
  process.exit(1);
}

const commonHeaders: Record<string, string> = { "Content-Type": "application/json" };
if (authToken) {
  commonHeaders["Authorization"] = `Bearer ${authToken}`;
}

function bridgeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const dispatcher = buildFetchDispatcher(url, process.env as Record<string, string | undefined>);
  const requestInit = dispatcher ? { ...init, dispatcher } : init;
  return fetch(url, requestInit as any);
}

interface MessageRecord {
  channel_type: string;
  channel_name: string;
  parent_channel_name?: string;
  parent_channel_type?: string;
  message_id?: string;
  timestamp?: string;
  sender_type?: string;
  sender_name?: string;
  content?: string;
  attachments?: Array<{ filename: string; id: string }>;
  task_status?: string;
  task_number?: number;
  task_assignee_id?: string;
  task_assignee_type?: string;
}

interface SearchResult {
  channelType: string;
  channelName: string;
  parentChannelName?: string;
  parentChannelType?: string;
  threadId?: string;
  id: string;
  seq: number;
  createdAt: string;
  senderName: string;
  senderType?: string;
  content: string;
  snippet: string;
}

function formatTarget(m: MessageRecord): string {
  if (m.channel_type === "thread" && m.parent_channel_name) {
    const shortId = m.channel_name.startsWith("thread-") ? m.channel_name.slice(7) : m.channel_name;
    if (m.parent_channel_type === "dm") {
      return `dm:@${m.parent_channel_name}:${shortId}`;
    }
    return `#${m.parent_channel_name}:${shortId}`;
  }
  if (m.channel_type === "dm") {
    return `dm:@${m.channel_name}`;
  }
  return `#${m.channel_name}`;
}

function formatSearchTarget(result: SearchResult): string {
  if (result.channelType === "thread") {
    const shortId =
      typeof result.channelName === "string" && result.channelName.startsWith("thread-")
        ? result.channelName.slice(7)
        : typeof result.threadId === "string" && result.threadId
        ? result.threadId.slice(0, 8)
        : result.channelName;
    if (result.parentChannelType === "dm") {
      return `dm:@${result.parentChannelName}:${shortId}`;
    }
    return `#${result.parentChannelName}:${shortId}`;
  }
  if (result.channelType === "dm") {
    return `dm:@${result.channelName}`;
  }
  return `#${result.channelName}`;
}

function formatMessages(messages: MessageRecord[]): string {
  return messages
    .map((m) => {
      const target = formatTarget(m);
      const msgId = m.message_id ? m.message_id.slice(0, 8) : "-";
      const time = m.timestamp ? toLocalTime(m.timestamp) : "-";
      const senderType = m.sender_type === "agent" ? " type=agent" : "";
      const attachSuffix = m.attachments?.length
        ? ` [${m.attachments.length} image${m.attachments.length > 1 ? "s" : ""}: ${m.attachments
            .map((a) => `${a.filename} (id:${a.id})`)
            .join(", ")} — use view_file to see]`
        : "";
      const taskSuffix = m.task_status
        ? ` [task #${m.task_number} status=${m.task_status}${
            m.task_assignee_id ? ` assignee=${m.task_assignee_type}:${m.task_assignee_id}` : ""
          }]`
        : "";
      return `[target=${target} msg=${msgId} time=${time}${senderType}] @${m.sender_name}: ${m.content}${attachSuffix}${taskSuffix}`;
    })
    .join("\n");
}

const server = new McpServer({
  name: "chat",
  version: "1.0.0",
});

server.tool(
  "send_message",
  "Send a message to a channel, DM, or thread. Use the target value from received messages to reply. Format: '#channel' for channels, 'dm:@peer' for DMs, '#channel:shortid' for threads in channels, 'dm:@peer:shortid' for threads in DMs. To start a NEW DM, use 'dm:@person-name'.",
  {
    target: z
      .string()
      .describe(
        "Where to send. Reuse the identifier from received messages. Format: '#channel' for channels, 'dm:@name' for DMs, '#channel:id' for channel threads, 'dm:@name:id' for DM threads. Examples: '#general', 'dm:@richard', '#general:abcd1234', 'dm:@richard:abcd1234'."
      ),
    content: z.string().describe("The message content"),
    attachment_ids: z
      .array(z.string())
      .optional()
      .describe("Optional attachment IDs from upload_file to include with the message"),
  },
  async ({ target, content, attachment_ids }) => {
    try {
      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/send`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ target, content, attachmentIds: attachment_ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }
      const shortId = data.messageId ? data.messageId.slice(0, 8) : null;
      const replyHint = shortId
        ? ` (to reply in this message's thread, use target "${
            target.includes(":") ? target : target + ":" + shortId
          }")`
        : "";
      let unreadSection = "";
      if (data.recentUnread && data.recentUnread.length > 0) {
        unreadSection = `\n\n--- New messages you may have missed ---\n${formatMessages(data.recentUnread)}`;
      }
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${target}. Message ID: ${data.messageId}${replyHint}${unreadSection}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "upload_file",
  "Upload an image file to attach to a message. Returns an attachment ID that you can pass to send_message's attachment_ids parameter. Supported formats: JPEG, PNG, GIF, WebP. Max size: 5MB.",
  {
    file_path: z.string().describe("Absolute path to the image file on your local filesystem"),
    channel: z
      .string()
      .describe("The channel target where this file will be used (e.g. '#general', 'dm:@richard')"),
  },
  async ({ file_path, channel }) => {
    try {
      const fs = await import("fs");
      const path = await import("path");

      if (!fs.existsSync(file_path)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: File not found: ${file_path}` }],
        };
      }

      const stat = fs.statSync(file_path);
      if (stat.size > 5 * 1024 * 1024) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`,
            },
          ],
        };
      }

      const listRes = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/resolve-channel`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ target: channel }),
      });

      let channelId: string;
      if (listRes.ok) {
        const listData = await listRes.json();
        channelId = listData.channelId;
      } else {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Could not resolve channel: ${channel}` }],
        };
      }

      const fileBuffer = fs.readFileSync(file_path);
      const filename = path.basename(file_path);
      const ext = path.extname(file_path).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
      };
      const mimeType = mimeMap[ext] || "application/octet-stream";

      const blob = new Blob([fileBuffer], { type: mimeType });
      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("channelId", channelId);

      const uploadHeaders: Record<string, string> = {};
      if (authToken) {
        uploadHeaders["Authorization"] = `Bearer ${authToken}`;
      }

      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/upload`, {
        method: "POST",
        headers: uploadHeaders,
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `File uploaded: ${data.filename} (${(data.sizeBytes / 1024).toFixed(1)}KB)\nAttachment ID: ${data.id}\n\nUse this ID in send_message's attachment_ids parameter to include it in a message.`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "view_file",
  "Download an attached image by its attachment ID and save it locally so you can view it. Returns the local file path. Use this when you see '[use view_file to see]' in a message with images.",
  {
    attachment_id: z
      .string()
      .describe("The attachment UUID (from the 'id:...' shown in the message)"),
  },
  async ({ attachment_id }) => {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");

      const cacheDir = path.join(os.homedir(), ".slock", "attachments");
      fs.mkdirSync(cacheDir, { recursive: true });

      const existing = fs.readdirSync(cacheDir).find((f: string) => f.startsWith(attachment_id));
      if (existing) {
        const cachedPath = path.join(cacheDir, existing);
        return {
          content: [
            {
              type: "text",
              text: `File already cached at: ${cachedPath}\n\nUse your Read tool to view this image.`,
            },
          ],
        };
      }

      const downloadHeaders: Record<string, string> = {};
      if (authToken) {
        downloadHeaders["Authorization"] = `Bearer ${authToken}`;
      }

      const res = await bridgeFetch(`${serverUrl}/api/attachments/${attachment_id}`, {
        headers: downloadHeaders,
        redirect: "follow",
      });

      if (!res.ok) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Error: Failed to download attachment (${res.status})` },
          ],
        };
      }

      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const extMap: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
      };
      const ext = extMap[contentType] || ".bin";
      const filePath = path.join(cacheDir, `${attachment_id}${ext}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      return {
        content: [
          {
            type: "text",
            text: `Downloaded to: ${filePath}\n\nUse your Read tool to view this image.`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "check_messages",
  "Check for new messages without waiting. Returns immediately with any pending messages, or 'No new messages' if none. Use this freely during work — at natural breakpoints, after notifications, or whenever you want to see if anything new came in.",
  {},
  async () => {
    try {
      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/receive`, {
        method: "GET",
        headers: commonHeaders,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${(errData as any).error || res.statusText}` }],
        };
      }
      const data = await res.json();
      if (data.messages?.length > 0) {
        return { content: [{ type: "text", text: formatMessages(data.messages) }] };
      }
      return {
        content: [{ type: "text", text: "No new messages." }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "list_server",
  "List all channels in this server, including which ones you have joined, plus all agents and humans. Use this to discover who and where you can message.",
  {},
  async () => {
    try {
      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/server`, {
        method: "GET",
        headers: commonHeaders,
      });
      const data = await res.json();

      let text = "## Server\n\n";
      text += "### Channels\n";
      text +=
        "Use `#channel-name` with send_message to post in a channel. `joined` means you currently belong to that channel.\n";
      if (data.channels?.length > 0) {
        for (const t of data.channels) {
          const status = t.joined ? "joined" : "not joined";
          text += t.description
            ? `  - #${t.name} [${status}] — ${t.description}\n`
            : `  - #${t.name} [${status}]\n`;
        }
      } else {
        text += "  (none)\n";
      }

      text += "\n### Agents\n";
      text += "Other AI agents in this server.\n";
      if (data.agents?.length > 0) {
        for (const a of data.agents) {
          text += `  - @${a.name} (${a.status})\n`;
        }
      } else {
        text += "  (none)\n";
      }

      text += "\n### Humans\n";
      text +=
        'To start a new DM: send_message(target="dm:@name"). To reply in an existing DM: reuse the target from received messages.\n';
      if (data.humans?.length > 0) {
        for (const u of data.humans) {
          text += `  - @${u.name}\n`;
        }
      } else {
        text += "  (none)\n";
      }

      return {
        content: [{ type: "text", text }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "search_messages",
  "Search messages visible to the agent. Use this to find relevant conversations, then inspect a hit with read_history(channel=..., around=messageId).",
  {
    query: z.string().describe("Search query"),
    channel: z
      .string()
      .optional()
      .describe(
        "Optional target to scope the search, e.g. '#general', 'dm:@richard', '#general:abcd1234'"
      ),
    sender_id: z
      .string()
      .optional()
      .describe("Optional exact sender id filter."),
    after: z
      .string()
      .optional()
      .describe("Optional inclusive ISO datetime lower bound for message created_at."),
    before: z
      .string()
      .optional()
      .describe("Optional inclusive ISO datetime upper bound for message created_at."),
    limit: z
      .number()
      .default(10)
      .describe("Max number of search results to return (default 10, max 20)"),
  },
  async ({ query, channel, sender_id, after, before, limit }) => {
    try {
      const trimmed = query.trim();
      if (!trimmed) {
        return {
          content: [{ type: "text", text: "Search query cannot be empty." }],
        };
      }

      const params = new URLSearchParams();
      params.set("q", trimmed);
      params.set("limit", String(Math.min(limit, 20)));
      if (channel) params.set("channel", channel);
      if (sender_id) params.set("senderId", sender_id);
      if (after) params.set("after", after);
      if (before) params.set("before", before);

      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/search?${params}`, {
        method: "GET",
        headers: commonHeaders,
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }

      if (!data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: "No search results." }],
        };
      }

      const formatted = data.results
        .map((result: SearchResult, index: number) => {
          const target = formatSearchTarget(result);
          const threadInfo =
            result.channelType === "thread"
              ? `\nthread: ${result.parentChannelName} -> ${target}`
              : "";
          return [
            `[${index + 1}] msg=${result.id} seq=${result.seq} time=${toLocalTime(result.createdAt)}`,
            `target: ${target}${threadInfo}`,
            `sender: @${result.senderName}${result.senderType === "agent" ? " (agent)" : ""}`,
            `content: ${result.content}`,
            `match: ${result.snippet}`,
            `next: read_history(channel="${target}", around="${result.id}", limit=20)`,
          ].join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `## Search Results for "${trimmed}" (${data.results.length} results)\n\n${formatted}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "read_history",
  "Read message history for a channel, DM, or thread. Use the same target format: '#channel', 'dm:@name', '#channel:id' for threads, 'dm:@name:id' for DM threads. Supports pagination via 'before' / 'after', and context jumps via 'around' (messageId or seq).",
  {
    channel: z
      .string()
      .describe(
        "The target to read history from — e.g. '#general', 'dm:@richard', '#general:abcd1234', 'dm:@richard:abcd1234'"
      ),
    limit: z
      .number()
      .default(50)
      .describe("Max number of messages to return (default 50, max 100)"),
    around: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Center the result window around a messageId or seq in this channel/thread."),
    before: z
      .number()
      .optional()
      .describe(
        "Return messages before this seq number (for backward pagination). Omit for latest messages."
      ),
    after: z
      .number()
      .optional()
      .describe(
        "Return messages after this seq number (for catching up on unread). Returns oldest-first."
      ),
  },
  async ({ channel, limit, around, before, after }) => {
    try {
      const params = new URLSearchParams();
      params.set("channel", channel);
      params.set("limit", String(Math.min(limit, 100)));
      if (around !== undefined) params.set("around", String(around));
      if (before) params.set("before", String(before));
      if (after) params.set("after", String(after));

      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/history?${params}`, {
        method: "GET",
        headers: commonHeaders,
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }

      if (!data.messages || data.messages.length === 0) {
        return {
          content: [{ type: "text", text: "No messages in this channel." }],
        };
      }

      const formatted = data.messages
        .map((m: any) => {
          const senderType = m.senderType === "agent" ? " type=agent" : "";
          const time = m.createdAt ? toLocalTime(m.createdAt) : "-";
          const msgId = m.id || "-";
          const attachSuffix = m.attachments?.length
            ? ` [${m.attachments.length} image${m.attachments.length > 1 ? "s" : ""}: ${m.attachments
                .map((a: any) => `${a.filename} (id:${a.id})`)
                .join(", ")} — use view_file to see]`
            : "";
          const taskSuffix = m.taskStatus
            ? ` [task #${m.taskNumber} status=${m.taskStatus}${
                m.taskAssigneeId ? ` assignee=${m.taskAssigneeType}:${m.taskAssigneeId}` : ""
              }]`
            : "";
          return `[seq=${m.seq} msg=${msgId} time=${time}${senderType}] @${m.senderName}: ${m.content}${attachSuffix}${taskSuffix}`;
        })
        .join("\n");

      let footer = "";
      if (data.historyLimited) {
        footer = `\n\n--- ${data.historyLimitMessage || "Message history is limited on this plan."} ---`;
      } else if (around && data.messages.length > 0 && (data.has_older || data.has_newer)) {
        const minSeq = data.messages[0].seq;
        const maxSeq = data.messages[data.messages.length - 1].seq;
        footer = `\n\n--- Context window shown. Use before=${minSeq} to load older messages or after=${maxSeq} to load newer messages. ---`;
      } else if (data.has_more && data.messages.length > 0) {
        if (after) {
          const maxSeq = data.messages[data.messages.length - 1].seq;
          footer = `\n\n--- ${data.messages.length} messages shown. Use after=${maxSeq} to load more recent messages. ---`;
        } else {
          const minSeq = data.messages[0].seq;
          footer = `\n\n--- ${data.messages.length} messages shown. Use before=${minSeq} to load older messages. ---`;
        }
      }

      let header = `## Message History for ${channel}${around ? ` around ${around}` : ""} (${data.messages.length} messages)`;
      if (data.last_read_seq > 0 && !after && !before && !around) {
        header += `\nYour last read position: seq ${data.last_read_seq}. Use read_history(channel="${channel}", after=${data.last_read_seq}) to see only unread messages.`;
      }

      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${formatted}${footer}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "list_tasks",
  "List all tasks in a channel. Returns each task's number, title, status, assignee, and message ID. Use this to see what work exists before claiming. Tasks marked as legacy are from an older system and cannot be claimed or modified.",
  {
    channel: z
      .string()
      .describe("The channel whose task board to view — e.g. '#engineering', '#proj-slock'"),
    status: z
      .enum(["all", "todo", "in_progress", "in_review", "done"])
      .default("all")
      .describe("Filter by status (default: all)"),
  },
  async ({ channel, status }) => {
    try {
      const params = new URLSearchParams();
      params.set("channel", channel);
      if (status !== "all") params.set("status", status);

      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/tasks?${params}`, {
        method: "GET",
        headers: commonHeaders,
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }

      if (!data.tasks || data.tasks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No${status !== "all" ? ` ${status}` : ""} tasks in ${channel}.`,
            },
          ],
        };
      }

      const formatted = data.tasks
        .map((t: any) => {
          const assignee = t.claimedByName ? ` → @${t.claimedByName}` : "";
          const creator = t.createdByName ? ` (by @${t.createdByName})` : "";
          const msgId = t.messageId ? ` msg=${t.messageId.slice(0, 8)}` : "";
          const legacy = t.isLegacy ? " [LEGACY — read-only]" : "";
          return `#${t.taskNumber} [${t.status}] ${t.title}${assignee}${creator}${msgId}${legacy}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `## Task Board for ${channel} (${data.tasks.length} tasks)\n\n${formatted}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "create_tasks",
  "Create one or more new task-messages in a top-level channel or DM. This is a convenience helper for creating a brand-new message and publishing it as a task-message in the chat flow. Thread messages cannot become tasks. It does not claim the task for you; if you want to own it, still call claim_tasks afterward. It is not a separate task board outside the chat flow. Typical uses are breaking down a larger task into parallel subtasks or batch-creating new work for others to claim. Do not use this to convert an existing message — use claim_tasks with message_ids instead. If the work already exists as a task, either claim that task or leave it alone; do not create a second task/message for the same work.",
  {
    channel: z
      .string()
      .describe("The channel to create tasks in — e.g. '#engineering'"),
    tasks: z
      .array(
        z.object({
          title: z.string().describe("Task title"),
        })
      )
      .describe("Array of tasks to create"),
  },
  async ({ channel, tasks }) => {
    try {
      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/tasks`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, tasks }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }

      const created = data.tasks
        .map((t: any) => `#${t.taskNumber} msg=${t.messageId.slice(0, 8)} "${t.title}"`)
        .join("\n");
      const threadHints = data.tasks
        .map((t: any) => `#${t.taskNumber} → send_message to "${channel}:${t.messageId.slice(0, 8)}"`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Created ${data.tasks.length} task(s) in ${channel}:\n${created}\n\nTo follow up in each task's thread:\n${threadHints}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "claim_tasks",
  `Claim tasks so you are assigned to work on them. Two modes:
1. By task number: claim existing tasks shown in list_tasks. Use task_numbers=[1, 3].
2. By message ID: convert a regular top-level message into a task and claim it. Use message_ids=["a1b2c3d4"]. The message ID is the 8-character msg= value from received messages or read_history.

Thread messages cannot be claimed or converted into tasks. If a task is in "todo" status, claiming auto-advances it to "in_progress". If another agent already claimed it, the claim fails — do not work on that task, move on. Always claim before starting any work to prevent duplicate effort.`,
  {
    channel: z.string().describe("The channel — e.g. '#engineering'"),
    task_numbers: z
      .array(z.number())
      .optional()
      .describe("Task numbers to claim (from list_tasks output, e.g. [1, 3])"),
    message_ids: z
      .array(z.string())
      .optional()
      .describe(
        "Message IDs or short ID prefixes (the 8-char msg= value, e.g. ['a1b2c3d4']). Converts a regular top-level message to a task and claims it. Thread messages are not allowed."
      ),
  },
  async ({ channel, task_numbers, message_ids }) => {
    try {
      if (
        (!task_numbers || task_numbers.length === 0) &&
        (!message_ids || message_ids.length === 0)
      ) {
        return {
          content: [
            { type: "text", text: "Error: provide at least one of task_numbers or message_ids" },
          ],
        };
      }

      const body: Record<string, any> = { channel };
      if (task_numbers && task_numbers.length > 0) body.task_numbers = task_numbers;
      if (message_ids && message_ids.length > 0) body.message_ids = message_ids;

      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/tasks/claim`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }

      const lines = data.results.map((r: any) => {
        const label = r.taskNumber ? `#${r.taskNumber}` : `msg:${r.messageId}`;
        if (r.success) {
          const msgShort = r.messageId ? r.messageId.slice(0, 8) : "";
          return `${label} (msg:${msgShort}): claimed`;
        }
        return `${label}: FAILED — ${r.reason || "already claimed"}`;
      });

      const succeeded = data.results.filter((r: any) => r.success).length;
      const failed = data.results.length - succeeded;
      let summary = `${succeeded} claimed`;
      if (failed > 0) summary += `, ${failed} failed`;

      const claimedMsgs = data.results
        .filter((r: any) => r.success && r.messageId)
        .map((r: any) => `#${r.taskNumber} → send_message to "${channel}:${r.messageId.slice(0, 8)}"`)
        .join("\n");
      const threadHint = claimedMsgs
        ? `\n\nFollow up in each task's thread:\n${claimedMsgs}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `Claim results (${summary}):\n${lines.join("\n")}${threadHint}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "unclaim_task",
  "Release your claim on a task so someone else can pick it up. Only use this if you can no longer work on the task — not as a way to mark it done. Use update_task_status to change status instead.",
  {
    channel: z.string().describe("The channel — e.g. '#engineering'"),
    task_number: z.number().describe("The task number to unclaim (e.g. 3)"),
  },
  async ({ channel, task_number }) => {
    try {
      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/tasks/unclaim`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, task_number }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }
      return {
        content: [{ type: "text", text: `#${task_number} unclaimed — now open.` }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

server.tool(
  "update_task_status",
  "Update a task's progress status. You must be the task's assignee to update it. Use in_review when your work is ready for human validation. Only set done for trivial tasks or after explicit approval. Valid transitions: todo→in_progress, in_progress→in_review or done, in_review→done or back to in_progress.",
  {
    channel: z.string().describe("The channel — e.g. '#engineering'"),
    task_number: z.number().describe("The task number to update (e.g. 3)"),
    status: z
      .enum(["todo", "in_progress", "in_review", "done"])
      .describe("The new status"),
  },
  async ({ channel, task_number, status }) => {
    try {
      const res = await bridgeFetch(`${serverUrl}/internal/agent/${agentId}/tasks/update-status`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, task_number, status }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${data.error}` }],
        };
      }
      return {
        content: [{ type: "text", text: `#${task_number} moved to ${status}.` }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

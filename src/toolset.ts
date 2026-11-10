import Anthropic from "@anthropic-ai/sdk"

// Define one tool. The input_schema is a JSON Schema object describing
// the arguments Claude should pass when it calls this tool.
const runBashTool = {
  name: "bash" as const,
  description: "Run a shell command",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The command for bash to run."
      }
    },
    required: ["command"] as const
  }
} satisfies Anthropic.Tool

const readFileTool = {
  name: "readFile" as const,
  description: "Read file contents.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path of the file to be read."
      },
      limit: {
        type: "integer",
        description: "The number of lines to be read."
      }
    },
    required: ["path"] as const
  }
} satisfies Anthropic.Tool

const writeFileTool = {
  name: "writeFile" as const,
  description: "Write content to file.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path of the file to be written."
      },
      content: {
        type: "string",
        description: "The content of the file to be written."
      }
    },
    required: ["path", "content"] as const
  }
} satisfies Anthropic.Tool

const editFileTool = {
  name: "editFile" as const,
  description: "Replace a text snippet in a file.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path of the file to edit."
      },
      oldText: {
        type: "string",
        description: "Exact text to find. Must match once and uniquely."
      },
      newText: {
        type: "string",
        description: "Text to replace it with."
      }
    },
    required: ["path", "oldText", "newText"] as const
  }
} satisfies Anthropic.Tool

const globTool = {
  name: "glob" as const,
  description: "Glob pattern to match files.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The pattern to be matched."
      }
    },
    required: ["pattern"] as const
  }
} satisfies Anthropic.Tool

const todoWrite = {
  name: "todoWrite" as const,
  description: "Create and manage a task list for your current coding session.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["completed", "in_progress", "pending"] }
          },
          required: ["content", "status"] as const
        }
      }
    },
    required: ["todos"] as const
  }
} satisfies Anthropic.Tool

const taskTool = {
  name: "task" as const,
  description:
    "Launch a subagent with fresh conversation context to handle a complex subtask. Returns only the final conclusion.",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string"
      }
    },
    required: ["prompt"]
  }
} satisfies Anthropic.Tool

const loadSkillTool = {
  name: "loadSkill" as const,
  description: "Load the full SKILL.md content by skill name.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" }
    },
    required: ["name"]
  }
} satisfies Anthropic.Tool

export const subTools = [runBashTool, readFileTool, writeFileTool, editFileTool, globTool, todoWrite]

export const baseTools = [...subTools, taskTool, loadSkillTool]

export type SubToolName = (typeof subTools)[number]["name"]
export type BaseToolName = (typeof baseTools)[number]["name"]
// ToolName is now "bash" | "readFile" | "writeFile" | "editFile" | "glob" | "todoWrite"

interface TodoType {
  content: string
  status: "completed" | "in_progress" | "pending"
}

export type TodoList = TodoType[]

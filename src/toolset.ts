import Anthropic from "@anthropic-ai/sdk"

// Define one tool. The input_schema is a JSON Schema object describing
// the arguments Claude should pass when it calls this tool.
const runBashTool = {
  name: "bash" as const,
  description: "Run a shell command",
  input_schema: {
    type: "object" as const,
    properties: {
      command: { type: "string", 
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
        type:"integer",
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
      },
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
      },
    },
    required: ["pattern"] as const
  }
} satisfies Anthropic.Tool

const tools = [runBashTool, readFileTool, writeFileTool, editFileTool, globTool]

export type ToolName = typeof tools[number]["name"]
// ToolName is now "bash" | "readFile" | "writeFile" | "editFile" | "glob"



export default tools
import Anthropic from "@anthropic-ai/sdk"

// Define one tool. The input_schema is a JSON Schema object describing
// the arguments Claude should pass when it calls this tool.
const runBashTool: Anthropic.Tool = {
  name: "bash",
  description: "Run a shell command",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", 
        description: "The command for bash to run."
      }
    },
    required: ["command"]
  }
}


const readFileTool:Anthropic.Tool ={
  name:"readFile",
  description: "Read file contents.",
    input_schema: {
    type: "object",
    properties: {
      path: { 
        type: "string",
        description: "The path of the file to be read."
       },
       limit:{
        type:"integer",
        description: "The number of lines to be read."
       }
    },
    required: ["path"]
  }
}

const writeFileTool: Anthropic.Tool = {
  name: "writeFile",
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
    required: ["path", "content"]
  }
}

const editFileTool: Anthropic.Tool = {
  name: "editFile",
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
    required: ["path", "oldText", "newText"]
  }
}

const globTool: Anthropic.Tool = {
  name: "glob",
  description: "Glob pattern to match files.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The pattern to be matched."
      },
    },
    required: ["pattern"]
  }
}

const tools: Array<Anthropic.Tool> = [runBashTool, readFileTool, writeFileTool, editFileTool, globTool]

export default tools
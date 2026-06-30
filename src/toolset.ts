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

const tools: Array<Anthropic.Tool> = [runBashTool,readFileTool]

export default tools
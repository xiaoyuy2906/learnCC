import Anthropic from "@anthropic-ai/sdk"
import { execSync } from 'child_process'
import * as readline from 'node:readline/promises'
import figlet from "figlet"
import 'dotenv/config'

// console.log(process.env.ANTHROPIC_API_KEY)

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 4096
const system = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`


// Define one tool. The input_schema is a JSON Schema object describing
// the arguments Claude should pass when it calls this tool.
const runBashTool: Anthropic.Tool = {
  name: "bash",
  description: "Run a shell command",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", }
    },
    required: ["command"]
  }
}

const tools: Array<Anthropic.Tool> = [runBashTool]


function runBash(input: Record<string, unknown>) {
  const command = input.command as string
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
  if (dangerous.some(it => (command as string).includes(it))) {
    // ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"].some(it=>('sudo rm -rf /').includes(it))
    return "Error: Dangerous command blocked"
  }
  try {
    const result = execSync(command, {
      cwd: process.cwd(),
      timeout: 120000,
      encoding: 'utf-8'
    })
    return result.slice(0, max_tokens) || "(no output)"
  } catch (e: any) {
    if (e.code === 'ETIMEDOUT') {
      return "Error: Timeout (120s)"
    }
    return `Error: ${e.stderr || e.message}`
  }
}


function runTool(name: string, input: Record<string, unknown>) {
  if (name === "bash") {
    return runBash(input)
  }
  return { error: `Unknown tool: ${name}` }
}




async function agentLoop(messages: Anthropic.MessageParam[]) {
  let response = await client.messages.create({
    model,
    max_tokens,
    tools,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages,
    system,
  })

  // Loop until Claude stops asking for tools. Each iteration runs the requested
  // tool, appends the result to history, and asks Claude to continue.
  while (response.stop_reason === "tool_use") {

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    )!


    const result = runTool(toolUse.name, toolUse.input as Record<string, unknown>);

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        },
      ],
    });

    response = await client.messages.create({
      model,
      max_tokens,
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
      system,
    });
  }

  // Claude stopped calling tools: save its final turn and print the text.
  messages.push({ role: "assistant", content: response.content })
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`Claude (${new Date().toISOString()}) >> ` + block.text)
    }
  }
}


async function main() {
  const msgHistory: Anthropic.MessageParam[] = []
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log(
    await figlet.text("Welcome To Learn CC!", {
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 120,
      whitespaceBreak: true,
    })
  )

  while (true) {
    const input = await rl.question(`s01 (${new Date().toISOString()}) >> `)
    if (["q", "exit", ""].includes(input.trim().toLowerCase())) {
      break
    }
    msgHistory.push({ role: "user", content: input })
    await agentLoop(msgHistory)
  }

  rl.close()
}

main()

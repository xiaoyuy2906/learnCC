import Anthropic from "@anthropic-ai/sdk"
import { execSync } from 'child_process'
import * as readline from 'node:readline/promises'
import figlet from "figlet"
import path from 'node:path'
import 'dotenv/config'
import tools from './toolset.js'
import { readFile } from 'node:fs/promises'

// console.log(process.env.ANTHROPIC_API_KEY)

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const workDir = process.cwd()
const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 4096
const system = `You are a coding agent at ${workDir}. Use bash to solve tasks. Act, don't explain.`


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


async function runRead(input: Record<string, unknown>){
 const limit = input.limit as number | undefined| null
  try{
    const filePath = checkPath((input.path) as string ) 
    const contents = await readFile(filePath, { encoding: 'utf8' })
    let lines = contents.split('\n')
    if (limit && limit < lines.length){
      lines = lines.slice(0,limit).concat(`... (${lines.length - limit} more lines)`)
    }
    return lines.join('\n') || '(empty file)'
  }catch(e){
     return `Error: ${e}`
  }
}

async function runTool(name: string, input: Record<string, unknown>) {
  if (name === "bash") {
    return runBash(input)
  }else if ( name ==='readFile'){
    const result = await runRead(input)
    return result
  }
  return { error: `Unknown tool: ${name}` }
}


function checkPath(p: string): string {
  const resolvedPath = path.resolve(workDir, p)
  if (resolvedPath.startsWith(workDir + path.sep)) {
    return p
  } else {
    throw Error(`Path escapes workspace: ${p}`)
  }
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


    const result = await runTool(toolUse.name, toolUse.input as Record<string, unknown>);

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

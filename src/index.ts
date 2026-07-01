import Anthropic from "@anthropic-ai/sdk"
import { execSync } from 'child_process'
import * as readline from 'node:readline/promises'
import figlet from "figlet"
import path from 'node:path'
import 'dotenv/config'
import tools from './toolset.js'
import { type ToolName } from './toolset.js'
import { readFile, mkdir, writeFile, glob } from 'node:fs/promises'

// console.log(process.env.ANTHROPIC_API_KEY)

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const workDir = process.cwd()
const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 4096
const system = `You are a coding agent at ${workDir}. Use bash to solve tasks. Act, don't explain.`

// Gate 1: Hard deny list — always forbidden
const denyList: string[] = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"]

function checkDenyList(command: string): void {
  const hit = denyList.find(it => command.includes(it))
// ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"].some(it=>('sudo rm -rf /').includes(it))
  if (hit) {
    throw new Error(`Blocked: ${hit} is on the deny list`)
  }
  return
}


interface Rule {
  toolsName: ToolName[]
  check: (input: Record<string, unknown>) => boolean
  message: string
}

const permissionRules: Rule[] = [
  {
    toolsName: ["writeFile", "editFile"],
    check: (input) => !path.resolve(workDir, input.path as string).startsWith(workDir + path.sep),
    message: "Writing outside workspace"
  },
  {
    toolsName: ["bash"],
    check: (input) => ["rm ", "> /etc/", "chmod 777"].some(it => (input.command as string).includes(it)),
    message: "Potentially destructive command"
  },
]


function checkRules(name: ToolName, input: Record<string, unknown>) {
  permissionRules.forEach(rule => {
    if (rule.toolsName.includes(name) && rule.check(input)) {
      throw new Error(rule.message)
    }
  })
}



function checkPath(p: string): string {
  const resolvedPath = path.resolve(workDir, p)
  if (resolvedPath.startsWith(workDir + path.sep)) {
    return p
  } else {
    throw new Error(`Path escapes workspace: ${p}`)
  }
}

function runBash(input: Record<string, unknown>) {
  const command = input.command as string
  // const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
  // if (dangerous.some(it => (command as string).includes(it))) {
  //   // ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"].some(it=>('sudo rm -rf /').includes(it))
  //   return "Error: Dangerous command blocked"
  // }
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

async function runWrite(input: Record<string, unknown>) {
  const content = input.content as string
  try {
    const filePath = checkPath((input.path) as string)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
    return `Wrote ${content.length} bytes to ${filePath}`
  } catch (e) {
    return `Error: ${e}`
  }
}

async function runEdit(input: Record<string, unknown>) {
  const oldText = input.oldText as string
  const newText = input.newText as string
  try {
    const filePath = checkPath((input.path) as string)
    const contents = await readFile(filePath, { encoding: 'utf8' })
    if (contents.includes(oldText)) {
      await writeFile(filePath, contents.replace(oldText, () => newText))
      return `Edited ${filePath}`
    } else {
      return `Error: Text not found in ${filePath}`
    }
  } catch (e) {
    return `Error: ${e}`
  }
}

async function runGlob(input: Record<string, unknown>) {
  const pattern = input.pattern as string
  const result = []
  try {
    for await (const entry of glob(pattern, { cwd: workDir })) {
      result.push(checkPath(entry))
    }
    return result.join('\n') || "(no matches)"
  } catch (e) {
    return `Error: ${e}`
  }
}

async function runTool(name: string, input: Record<string, unknown>) {
  if (name === "bash") {
    return runBash(input)
  }else if ( name ==='readFile'){
    return await runRead(input)
  } else if (name === 'writeFile') {
    return await runWrite(input)
  } else if (name == 'editFile') {
    return await runEdit(input)
  } else if (name === 'glob') {
    return await runGlob(input)
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

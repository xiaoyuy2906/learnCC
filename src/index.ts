import Anthropic from "@anthropic-ai/sdk"
import { execSync } from "child_process"
import * as readline from "node:readline/promises"
import figlet from "figlet"
import path from "node:path"
import "dotenv/config"
import tools from "./toolset.js"
import os from "node:os"
import { type ToolName } from "./toolset.js"
import { readFile, mkdir, writeFile, glob } from "node:fs/promises"

// console.log(process.env.ANTHROPIC_API_KEY)

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const workDir = process.cwd()
const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 9216

const environmentPrompt =
  os.platform() === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell"

const system = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. All destructive operations require user approval.`

// Gate 1: Hard deny list — always forbidden
const denyList: string[] = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"]

// Returns the reason if blocked, undefined if the command is not on the deny list
function checkDenyList(command: string) {
  const hit = denyList.find(it => command.includes(it))
  // ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"].some(it=>('sudo rm -rf /').includes(it))
  if (hit) {
    return `Blocked: ${hit} is on the deny list`
  }
}

// Gate 2: Rule matching — context-dependent checks

// Why this regex?
// The system prompt tells the model to use cmd.exe on Windows, and cmd.exe doesn't delete with `rm`,
// so the old rule that only looked for "rm " missed every Windows delete command.
// These are the delete commands across shells:
//
//   Command      Shell              What it does                 Unix equivalent
//   rm           Unix (bash/zsh)    Delete files/directories     rm
//   del          cmd.exe            Delete files                 rm
//   erase        cmd.exe            Same as del, another name    rm
//   rmdir        cmd.exe and Unix   Delete a directory           rmdir / rm -r
//   rd           cmd.exe            Short for rmdir              rmdir
//   Remove-Item  PowerShell         Delete files or directories  rm -r
//
// The regex piece by piece: /(^|[\s;&|(])(rm|del|erase|rmdir|rd|Remove-Item)\s/i
//
//   (^|[\s;&|(])   What comes right before the command name must be one of:
//                    ^         the start of the string, e.g. "del a.txt"
//                    [\s;&|(]  whitespace or one of ; & | (  — i.e. where the previous command ended,
//                              e.g. "cd tmp && del a.txt", "echo hi; rm a", "ls | rm"
//                  This part keeps the "rm" inside "perform" or "confirm" from counting as a command.
//
//   (rm|del|...)   Any one command name from the table above; | means "or".
//
//   \s             The command name must be followed by whitespace, meaning the name ends there.
//                  This part stops "rmdir" from matching as just "rm", and "delete" from matching as "del".
//
//   i              Case-insensitive, because cmd and PowerShell ignore case: DEL and remove-item are valid too.
//
// Examples:
//   "rm -f a.tmp"           ✅ start + rm + space
//   "del /q *.tmp"          ✅ start + del + space
//   "cd temp && rd /s x"    ✅ space + rd + space
//   "Remove-Item x.txt"     ✅ start + Remove-Item + space
//   "echo perform test"     ❌ "rm" follows the letter o, not the start or a separator
//   "echo hello world"      ❌ "rd" follows the letter o
//   "git status"            ❌ no delete command
const destructiveCmd = /(^|[\s;&|(])(rm|del|erase|rmdir|rd|Remove-Item)\s/i

interface Rule {
  toolsName: ToolName[]
  check: (input: Record<string, unknown>) => boolean
  message: string
}

const permissionRules: Rule[] = [
  {
    toolsName: ["writeFile", "editFile"],
    check: input => !path.resolve(workDir, String(input.path ?? "")).startsWith(workDir + path.sep),
    message: "Writing outside workspace"
  },
  {
    toolsName: ["bash"],
    check: input => {
      const command = String(input.command ?? "")
      return destructiveCmd.test(command) || ["> /etc/", "chmod 777"].some(it => command.includes(it))
    },
    message: "Potentially destructive command"
  }
]

function checkRules(name: ToolName, input: Record<string, unknown>) {
  for (const rule of permissionRules) {
    if (rule.toolsName.includes(name) && rule.check(input)) {
      return rule.message
    }
  }
}

//  Gate 3: User approval — wait for confirmation after rule match
async function askUser(
  rl: readline.Interface,
  name: ToolName,
  input: Record<string, unknown>,
  reason: string
): Promise<boolean> {
  console.log(`\n⚠  ${reason}`)
  console.log(`   Tool: ${name}(${JSON.stringify(input)})`)
  const answer = await rl.question("   Allow? [y/N] ")
  return ["y", "yes"].includes(answer.trim().toLowerCase())
}

// Pipeline: Gate 1 -> Gate 2 -> Gate 3
async function checkPermission(toolUseBlock: Anthropic.ToolUseBlock, rl: readline.Interface): Promise<boolean> {
  const { name, input } = toolUseBlock as { name: ToolName; input: Record<string, unknown> }

  if (name === "bash") {
    const command = input.command
    if (typeof command !== "string") {
      return false
    }

    const blocked = checkDenyList(command)
    if (blocked) {
      console.log(`\n⛔ ${blocked}`)
      return false
    }
  }

  const reason = checkRules(name, input)
  if (reason) {
    return askUser(rl, name, input, reason)
  }
  return true
}

// s02: Tool Definitions & Dispatch

type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>

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
      encoding: "utf-8"
    })
    return result.slice(0, max_tokens) || "(no output)"
  } catch (e: any) {
    if (e.code === "ETIMEDOUT") {
      return "Error: Timeout (120s)"
    }
    // Many tools (tsc, test runners) print the failure reason to stdout, so return both streams
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim()
    return `Error: ${output || e.message}`.slice(0, max_tokens)
  }
}

async function runRead(input: Record<string, unknown>) {
  const limit = input.limit as number | undefined | null
  try {
    const filePath = checkPath(input.path as string)
    const contents = await readFile(filePath, { encoding: "utf8" })
    let lines = contents.split("\n")
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`)
    }
    return lines.join("\n") || "(empty file)"
  } catch (e) {
    return `Error: ${e}`
  }
}

async function runWrite(input: Record<string, unknown>) {
  const content = input.content as string
  try {
    const filePath = checkPath(input.path as string)
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
    const filePath = checkPath(input.path as string)
    const contents = await readFile(filePath, { encoding: "utf8" })
    if (contents.includes(oldText)) {
      await writeFile(
        filePath,
        contents.replace(oldText, () => newText)
      )
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
    return result.join("\n") || "(no matches)"
  } catch (e) {
    return `Error: ${e}`
  }
}

const toolHandlerMap = {
  bash: runBash,
  readFile: runRead,
  writeFile: runWrite,
  editFile: runEdit,
  glob: runGlob
} satisfies {
  [key in ToolName]: ToolHandler
}

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolHandlerMap, name)
}

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (isToolName(name)) {
    return await toolHandlerMap[name](input) // 这里 name 是 ToolName 了
  }
  return `Error: Unknown tool: ${name}`
}

async function agentLoop(messages: Anthropic.MessageParam[], rl: readline.Interface) {
  let response = await client.messages.create({
    model,
    max_tokens,
    tools,
    messages,
    system
  })

  // Loop until Claude stops asking for tools. Each iteration runs every requested
  // tool (Claude may ask for several at once), appends all results to history in
  // one user message, and asks Claude to continue.
  while (response.stop_reason === "tool_use") {
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (await checkPermission(block, rl)) {
          console.log(`> ${block.name}(${JSON.stringify(block.input)})`)
          try {
            const result = await runTool(block.name, block.input as Record<string, unknown>)
            console.log(result.slice(0, 200))
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result)
            })
          } catch (err) {
            // Signal failure so Claude can retry or ask for clarification.
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: String(err),
              is_error: true
            })
          }
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Permission denied."
          })
        }
      }
    }

    messages.push({ role: "assistant", content: response.content })
    messages.push({ role: "user", content: toolResults })

    response = await client.messages.create({
      model,
      max_tokens,
      tools,
        messages,
      system
    })
  }

  // Claude stopped calling tools: save its final turn and print the text.
  messages.push({ role: "assistant", content: response.content })
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`Claude (${new Date().toISOString()}) >> ` + block.text)
    }
  }
  // console.log(JSON.stringify(response, null, 2))
}

async function main() {
  const msgHistory: Anthropic.MessageParam[] = []
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log(
    await figlet.text("Welcome To Learn CC!", {
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 120,
      whitespaceBreak: true
    })
  )

  while (true) {
    const input = await rl.question(`s03 (${new Date().toISOString()}) >> `)
    if (["q", "exit", ""].includes(input.trim().toLowerCase())) {
      break
    }
    msgHistory.push({ role: "user", content: input })
    try {
      await agentLoop(msgHistory, rl)
    } catch (err) {
      // API failed (network, rate limit, bad key...): report it and keep the session alive
      console.log(`\nAPI error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  rl.close()
}

main()

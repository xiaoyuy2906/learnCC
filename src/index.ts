import Anthropic from "@anthropic-ai/sdk"
import { execSync } from "child_process"
import * as readline from "node:readline/promises"
import figlet from "figlet"
import path from "node:path"
import "dotenv/config"
import tools from "./toolset.js"
import os from "node:os"
import { type ToolName, type TodoList } from "./toolset.js"
import { readFile, mkdir, writeFile, glob } from "node:fs/promises"
import { styleText } from "node:util"

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

const system = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. Before starting any multi-step task, use todoWrite to plan your steps. Update status as you go.`

// s03: Three-Gate Permission Pipeline

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
  console.log(styleText("yellow", `\n⚠  ${reason}`))
  console.log(styleText("gray", `   Tool: ${name}(${JSON.stringify(input)})`))
  const answer = await rl.question("   Allow? [y/N] ")
  return ["y", "yes"].includes(answer.trim().toLowerCase())
}

type DenyMessages = "Permission denied by deny list" | "Permission denied by user"

// Pipeline: Gate 1 -> Gate 2 -> Gate 3
async function permissionHook(
  toolUseBlock: Anthropic.ToolUseBlock,
  rl: readline.Interface
): Promise<DenyMessages | undefined> {
  const { name, input } = toolUseBlock as { name: ToolName; input: Record<string, unknown> }
  if (name === "bash") {
    const command = input.command as string

    const blocked = checkDenyList(command)
    if (blocked) {
      console.log(styleText("red", `\n⛔ ${blocked}`))
      return "Permission denied by deny list"
    }
  }

  const reason = checkRules(name, input)
  if (reason) {
    const answer = await askUser(rl, name, input, reason)
    return answer ? undefined : "Permission denied by user"
  }
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
    return `Error: ${e instanceof Error ? e.message : String(e)}`
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
    return `Error: ${e instanceof Error ? e.message : String(e)}`
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
    return `Error: ${e instanceof Error ? e.message : String(e)}`
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
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

let todoList: TodoList = []

function validateTodoList(todos: TodoList | string) {
  if (typeof todos == "string") {
    try {
      todos = JSON.parse(todos)
    } catch (e) {
      throw new Error("todos must be an array or a JSON array string")
    }
  }

  if (!Array.isArray(todos)) {
    throw new Error("todos must be an array")
  }

  if (todos.length > 20) {
    throw new Error("Max 20 todos allowed")
  }

  const validated: TodoList = []
  let count = 0

  for (const [index, todo] of Object.entries(todos)) {
    if (typeof todo == "object" && todo != null && !Array.isArray(todo)) {
      const content = String(todo.content ?? "").trim()
      const status = String(todo.status ?? "pending").toLowerCase()
      if (!content) {
        throw new Error(`todos[${index}] requires content`)
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`todos[${index}] has invalid status ${status}`)
      }
      if (status == "in_progress") {
        count++
      }
      validated.push({
        content,
        status: status as TodoList[number]["status"]
      })
    } else {
      throw new Error(`todos[${index}] must be an object`)
    }
  }

  if (count > 1) {
    throw new Error("Only one todo can be in_progress at a time")
  }

  return validated
}

function runTodoWrite(input: Record<string, unknown>) {
  const markerMap = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]"
  } as const

  const colorMap = {
    pending: "gray",
    in_progress: "cyan",
    completed: "green"
  } as const

  function renderTodos() {
    if (todoList.length === 0) {
      return "No todos."
    }
    const doneCount = todoList.filter(todo => todo.status == "completed").length
    const lines = todoList.map(todo => `${markerMap[todo.status]} ${todo.content}`)
    lines.push(`\n(${doneCount}/${todoList.length} completed)`)
    return lines.join("\n")
  }

  function printTodos() {
    console.log(styleText(["bold", "yellow"], "\n## Current Tasks"))
    for (const todo of todoList) {
      console.log(styleText(colorMap[todo.status], `${markerMap[todo.status]} ${todo.content}`))
    }
  }

  try {
    todoList = validateTodoList(input.todos as TodoList | string)
    printTodos()
    return renderTodos()
  } catch (e) {
    const errMsg = `Error: ${e instanceof Error ? e.message : String(e)}`
    console.log(styleText("red", errMsg))
    return errMsg
  }
}

const toolHandlerMap = {
  bash: runBash,
  readFile: runRead,
  writeFile: runWrite,
  editFile: runEdit,
  glob: runGlob,
  todoWrite: runTodoWrite
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

// s04: Hook System

type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop"

const hooks: Record<HookEvent, any[]> = { UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [] }

function registerHook(event: HookEvent, callback: (...args: never[]) => void) {
  hooks[event].push(callback)
}

async function triggerHooks(event: HookEvent, ...args: any[]) {
  const reasons: string[] = []
  for (const cb of hooks[event]) {
    const result = await cb(...args)
    if (result !== undefined) {
      reasons.push(result)
    }
  }
  return reasons.length > 0 ? reasons.join("\n") : undefined
}

function logHook(block: Anthropic.Messages.ToolUseBlock) {
  // PreToolUse: log every tool call.
  const { name, input } = block as { name: ToolName; input: Record<string, unknown> }
  const argsPreview = JSON.stringify(Object.values(input).slice(0, 2)).slice(0, 80)
  console.log(styleText("cyan", `[HOOK] > ${name}(${argsPreview})`))
}

function contextInjectHook(input: string) {
  // UserPromptSubmit: log user input before it reaches the LLM
  console.log(styleText("cyan", `[HOOK] > UserPromptSubmit: working in ${workDir}`))
}

function largeOutputHook(block: Anthropic.Messages.ToolUseBlock, output: string) {
  // PostToolUse: warn on large output.
  if (output.length > 100000) {
    console.log(styleText("cyan", `[HOOK] > ⚠ Large output from ${block.name}: ${output.length} chars`))
  }
  return
}

function summaryHook(messages: Anthropic.Messages.MessageParam[]) {
  // Stop hook: print summary when loop is about to exit
  const toolCount = messages
    .map(msg => msg.content)
    .filter(content => Array.isArray(content))
    .flat()
    .reduce((acc, cur) => (cur.type == "tool_result" ? acc + 1 : acc), 0)
  console.log(styleText("cyan", `[HOOK] > Stop: session used ${toolCount} tool calls`))
}

registerHook("UserPromptSubmit", contextInjectHook)
registerHook("PreToolUse", logHook)
registerHook("PreToolUse", permissionHook)
registerHook("PostToolUse", largeOutputHook)
registerHook("Stop", summaryHook)

async function agentLoop(messages: Anthropic.MessageParam[], rl: readline.Interface) {
  let roundSinceLastTodo: number = 0

  // Each round: call Claude, run its tools, send the results back.
  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens,
      tools,
      messages,
      system
    })

    messages.push({ role: "assistant", content: response.content })

    // Any stop_reason other than "tool_use" ends this turn.
    if (response.stop_reason != "tool_use") {
      // Print before the Stop hook, so forced extra rounds are shown too.
      for (const block of response.content) {
        if (block.type === "text") {
          console.log(styleText(["bold", "green"], `Claude (${new Date().toISOString()}) >> `) + block.text)
        }
      }

      // A Stop hook can return a string to force another round.
      const force = await triggerHooks("Stop", messages)
      if (force) {
        messages.push({ role: "user", content: force })
        continue
      }
      return
    }

    // Run every tool call in this response. A denied call still gets a tool_result.
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let usedTodo: boolean = false
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const denyMessage = await triggerHooks("PreToolUse", block, rl)
        if (!denyMessage) {
          try {
            const result = await runTool(block.name, block.input as Record<string, unknown>)

            if (block.name != "todoWrite") {
              console.log(styleText("gray", result.slice(0, 200)))
            }
            await triggerHooks("PostToolUse", block, result)

            if (block.name == "todoWrite") {
              usedTodo = true
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result
            })
          } catch (err) {
            // Tell Claude the tool failed so it can retry.
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
            content: denyMessage
          })
        }
      }
    }

    // Send all results in one user message. After 3 rounds without todoWrite, add a reminder.
    usedTodo ? (roundSinceLastTodo = 0) : roundSinceLastTodo++
    if (roundSinceLastTodo >= 3) {
      const todoReminder: Anthropic.TextBlockParam = {
        type: "text",
        text: "<reminder>Update your todos.</reminder>"
      }
      roundSinceLastTodo = 0
      messages.push({ role: "user", content: [...toolResults, todoReminder] })
    } else {
      messages.push({ role: "user", content: toolResults })
    }
  }
}

async function main() {
  const msgHistory: Anthropic.MessageParam[] = []
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log(
    styleText(
      "cyan",
      await figlet.text("Welcome To Learn CC!", {
        horizontalLayout: "default",
        verticalLayout: "default",
        width: 120,
        whitespaceBreak: true
      })
    )
  )

  while (true) {
    const input = await rl.question(`s05 (${new Date().toISOString()}) >> `)
    if (["q", "exit", ""].includes(input.trim().toLowerCase())) {
      break
    }
    await triggerHooks("UserPromptSubmit", input)
    msgHistory.push({ role: "user", content: input })
    try {
      await agentLoop(msgHistory, rl)
    } catch (err) {
      // API failed (network, rate limit, bad key...): report it and keep the session alive
      console.log(styleText("red", `\nAPI error: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  rl.close()
}

main()

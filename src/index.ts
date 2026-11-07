import Anthropic from "@anthropic-ai/sdk"
import * as readline from "node:readline/promises"
import figlet from "figlet"
import path from "node:path"
import "dotenv/config"
import { baseTools, subTools, type SubToolName } from "./toolset.js"
import { type BaseToolName, type TodoList } from "./toolset.js"
import { runBash, runEdit, runGlob, runRead, runWrite, runTodoWrite } from "./toolHandlers.js"
import { type ToolHandler } from "./toolHandlers.js"
import { styleText } from "node:util"
import { workDir, model, max_tokens, system, subSystem } from "./config.js"

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

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
  toolsName: BaseToolName[]
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

function checkRules(name: BaseToolName, input: Record<string, unknown>) {
  for (const rule of permissionRules) {
    if (rule.toolsName.includes(name) && rule.check(input)) {
      return rule.message
    }
  }
}

//  Gate 3: User approval — wait for confirmation after rule match
async function askUser(
  rl: readline.Interface,
  name: BaseToolName,
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
  const { name, input } = toolUseBlock as { name: BaseToolName; input: Record<string, unknown> }
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

const baseToolHandlerMap = {
  bash: runBash,
  readFile: runRead,
  writeFile: runWrite,
  editFile: runEdit,
  glob: runGlob,
  todoWrite: runTodoWrite,
  task: spawnSubagent
} satisfies {
  [key in BaseToolName]: ToolHandler
}

const subToolHandlerMap = {
  bash: runBash,
  readFile: runRead,
  writeFile: runWrite,
  editFile: runEdit,
  glob: runGlob,
  todoWrite: runTodoWrite
} satisfies Record<SubToolName, ToolHandler>

async function spawnSubagent(input: Record<string, unknown>) {
  console.log(styleText("magenta", "\n[Subagent spawned]"))
  const prompt = input.prompt as string
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }]

  for (let i = 0; i < 30; i++) {
    const response = await client.messages.create({
      model,
      max_tokens,
      tools: subTools,
      messages,
      system: subSystem
    })

    messages.push({ role: "assistant", content: response.content })
  }
}

function isToolName(name: string): name is BaseToolName {
  return Object.hasOwn(baseToolHandlerMap, name)
}

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (isToolName(name)) {
    return await baseToolHandlerMap[name](input) // 这里 name 是 ToolName 了
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
  const { name, input } = block as { name: BaseToolName; input: Record<string, unknown> }
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
      tools: baseTools,
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

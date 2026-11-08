import path from "node:path"
import { styleText } from "node:util"
import { readFile, mkdir, writeFile, glob } from "node:fs/promises"
import * as readline from "node:readline/promises"
import { execSync } from "child_process"
import { workDir, max_tokens } from "./config.js"
import { type TodoList } from "./toolset.js"

// s02: Tool Definitions & Dispatch

type ToolHandler = (input: Record<string, unknown>, rl: readline.Interface) => string | Promise<string>

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

// Each call creates its own todoList (closure), so agents don't share one.
function createTodoWrite() {
  let todoList: TodoList = []

  return function runTodoWrite(input: Record<string, unknown>) {
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
}

export { runBash, runEdit, runGlob, runRead, runWrite, createTodoWrite }

export { type ToolHandler }

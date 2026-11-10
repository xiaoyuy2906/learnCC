import os from "node:os"
import "dotenv/config"
import { load } from "js-yaml"

const workDir = process.cwd()
const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 9216

const environmentPrompt =
  os.platform() === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell"

const system = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. Before starting any multi-step task, use todoWrite to plan your steps. Update status as you go. Use task for focused exploration or a self-contained subtask.`
const subSystem = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. Complete the given task, then return a concise final answer.`

interface SkillHeader {
  name: string
  description: string
}

interface ParsedSkillFile {
  header: SkillHeader
  body: string
}

function parseFrontmatter(text: string): ParsedSkillFile {
  const lines = text.split(/\r?\n/)
  const closingIdx = lines.findIndex((it, idx) => it == "---" && idx > 0)

  if (lines[0] != "---" || closingIdx == -1) {
    return {
      header: {
        name: "",
        description: ""
      },
      body: text
    }
  }

  const frontmatter = lines.slice(1, closingIdx).join("\n").trim()
  const body = lines
    .slice(closingIdx + 1)
    .join("\n")
    .trim()

  // load() can return anything: an object, a string, a number...
  let loaded
  try {
    loaded = load(frontmatter)
  } catch (e) {
    loaded = null
  }

  // Start empty, then copy name/description only when they are really strings.
  const header: SkillHeader = { name: "", description: "" }
  if (typeof loaded == "object" && loaded != null) {
    const obj = loaded as Record<string, unknown>
    if (typeof obj.name == "string") {
      header.name = obj.name
    }
    if (typeof obj.description == "string") {
      header.description = obj.description
    }
  }
  return { header, body }
}

function scanSkills(path) {}

export { workDir, model, max_tokens, system, subSystem }

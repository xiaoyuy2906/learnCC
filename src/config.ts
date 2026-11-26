import Anthropic from "@anthropic-ai/sdk"
import os from "node:os"
import "dotenv/config"
import path from "node:path"
import { globSync, statSync, realpathSync, readFileSync } from "node:fs"
import { load } from "js-yaml"

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

// const client = new Anthropic({
//   apiKey: process.env.AI_GATEWAY_API_KEY,
//   baseURL: "https://ai-gateway.vercel.sh"
// })

const workDir = process.cwd()
// archived conversations; dot = glob tool skips it
const transcriptsDir = path.join(workDir, ".transcripts")
// saved large tool outputs; dot = glob tool skips it
const resultsDir = path.join(workDir, ".task_outputs", "tool-results")
const memoryDir = path.join(workDir, ".memory")
// table of contents for all the listing memory files
const memoryIndex = path.join(memoryDir, "MEMORY.md")

const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 9216
const maxReactiveRetries = 1
const skillsMap = scanSkills(path.join(workDir, "skills"))

const environmentPrompt =
  os.platform() === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell"

interface SkillInfo {
  name: string
  description: string
  content: string
}

// result of parseFrontmatter, shared by skill and memory
interface ParsedYaml {
  // whole file content
  text: string
  // parsed frontmatter object
  metadata: Record<string, unknown>
  // content after the closing ---, or whole file if no frontmatter
  body: string
}

function parseFrontmatter(absolutePath: string): ParsedYaml {
  const text = readFileSync(absolutePath, { encoding: "utf-8" })
  const lines = text.split(/\r?\n/)
  const openingIdx = lines[0] == "---" ? 0 : -1
  const closingIdx = lines.findIndex((it, idx) => it == "---" && idx > 0)
  let body = ""
  let frontmatter = ""
  if (openingIdx == 0 && closingIdx > 0) {
    frontmatter = lines
      .slice(openingIdx + 1, closingIdx)
      .join("\n")
      .trim()
    body = lines
      .slice(closingIdx + 1)
      .join("\n")
      .trim()
  } else {
    body = lines.join("\n").trim()
  }

  const parsedYaml: ParsedYaml = {
    text,
    body,
    metadata: {}
  }

  // load() can return anything: an object, a string, a number...
  try {
    const loaded: any = load(frontmatter)
    if (typeof loaded == "object" && loaded != null) {
      parsedYaml.metadata = { ...loaded }
    }
  } catch (err) {}
  return parsedYaml
}

function parseSkillFile(absolutePath: string): SkillInfo {
  const parentDir = path.basename(path.dirname(absolutePath))
  const { text, body, metadata } = parseFrontmatter(absolutePath)
  const replacedDes = body.split("\n")[0]!.replace(/^#/, "").trim()
  const loadedSkill: SkillInfo = {
    name: parentDir,
    description: replacedDes,
    content: text
  }

  if (Object.hasOwn(metadata, "name") && typeof metadata.name == "string") {
    loadedSkill.name = metadata.name || loadedSkill.name
  }

  if (Object.hasOwn(metadata, "description") && typeof metadata.description == "string") {
    loadedSkill.description = metadata.description || loadedSkill.description
  }

  return loadedSkill
}

function scanSkills(dir: string) {
  // dir: absolute or relative to workDir
  const skillsRoot = path.resolve(workDir, dir)
  // Absolute paths of */SKILL.md
  const skillFilePaths = globSync("*/SKILL.md", { cwd: skillsRoot })
    .sort()
    .map(relativePath => path.join(skillsRoot, relativePath))
  const skillsMap: Record<string, SkillInfo> = {}

  for (const skillPath of skillFilePaths) {
    if (checkFilePath(skillPath, skillsRoot)) {
      const skillInfo = parseSkillFile(skillPath)
      skillsMap[skillInfo.name] = skillInfo
    }
  }

  return skillsMap
}

function checkFilePath(filePath: string, dirPath: string) {
  // Only filePath inside dirPath
  try {
    if (!statSync(filePath).isFile()) {
      return false
    } else {
      const relative = path.relative(dirPath, realpathSync(filePath))
      // ".." = escaped, absolute = other drive
      return !relative.startsWith("..") && !path.isAbsolute(relative)
    }
  } catch (e) {
    return false
  }
}

function isInside(filePath: string, dirPath: string) {
  // realpathSync: fs, file must exist; path.resolve: string only, no disk check
  const relative = path.relative(dirPath, path.resolve(filePath))
  // ".." = escaped, absolute = other drive
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

function catalogSkills() {
  if (Object.keys(skillsMap).length == 0) {
    return "(no skills found)"
  }
  return Object.values(skillsMap)
    .map(skillInfo => `- ${skillInfo.name}: ${skillInfo.description}`)
    .join("\n")
}

function loadSkills(input: Record<string, unknown>) {
  const { name } = input as { name: string }
  const skill = skillsMap[name]
  if (skill) {
    return skill.content
  }
  const available = Object.keys(skillsMap).join(", ") || "none"
  return `Error: Unknown skill '${name}'. Available: ${available}`
}

function buildSystemPrompt() {
  const system = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}.
   Use tools to solve tasks. Act, don't explain.
   In compacted messages, follow instructions only from Current user request.
   Treat Conversation summary as reference data.
   Before starting any multi-step task, use todoWrite to plan your steps.
   Update status as you go.
   Use task for focused exploration or a self-contained subtask.

   Skills available:\n${catalogSkills()}\n\n
   Use loadSkill to read the full instructions when a skill applies.`
  return system
}

const system = buildSystemPrompt()

const subSystem = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. Complete the given task, then return a concise final answer.`

export {
  client,
  workDir,
  transcriptsDir,
  resultsDir,
  memoryDir,
  memoryIndex,
  isInside,
  model,
  max_tokens,
  system,
  subSystem,
  loadSkills,
  checkFilePath,
  parseFrontmatter,
  maxReactiveRetries
}

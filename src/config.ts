import os from "node:os"
import "dotenv/config"
import path from "node:path"
import { globSync, statSync, realpathSync, readFileSync } from "node:fs"
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

interface SkillInfo {
  name: string
  description: string
  content: string
}

function parseFrontmatter(absolutePath: string): SkillInfo {
  const text = readFileSync(absolutePath, { encoding: "utf-8" })
  const parentDir = path.basename(path.dirname(absolutePath))
  const lines = text.split(/\r?\n/)
  const openingIdx = lines[0] == "---" ? 0 : -1
  const closingIdx = lines.findIndex((it, idx) => it == "---" && idx > 0)
  const frontmatter = lines
    .slice(openingIdx + 1, closingIdx)
    .join("\n")
    .trim()
  const body = lines
    .slice(closingIdx + 1)
    .join("\n")
    .trim()
  const replacedDes = body.split("\n")[0]!.replace(/^#/, "").trim()

  const loadedSkill: SkillInfo = {
    name: parentDir,
    description: replacedDes,
    content: text
  }

  // load() can return anything: an object, a string, a number...
  try {
    const loaded: any = load(frontmatter)
    if (typeof loaded == "object" && loaded != null) {
      loadedSkill.name = loaded.name || parentDir
      loadedSkill.description = loaded.description || replacedDes
    }
    return loadedSkill
  } catch (err) {}
  return loadedSkill
}

function scanSkills(dir: string) {
  // dir: absolute or relative to workDir
  const skillsRoot = path.resolve(workDir, dir)
  // Absolute paths of */SKILL.md
  const skillFilePaths = globSync("*/SKILL.md", { cwd: skillsRoot })
    .sort()
    .map(relativePath => path.join(skillsRoot, relativePath))
  const skillsMap = {}

  function checkFilePath(filePath: string) {
    // Only files inside skillsRoot
    if (!statSync(filePath).isFile()) {
      return false
    } else {
      const relative = path.relative(skillsRoot, realpathSync(filePath))
      // ".." = escaped, absolute = other drive
      return !relative.startsWith("..") && !path.isAbsolute(relative)
    }
  }
}

export { workDir, model, max_tokens, system, subSystem }

import os from "node:os"
import "dotenv/config"

const workDir = process.cwd()
const model = process.env.MODEL_ID || "claude-sonnet-4-6"
const max_tokens = 9216

const environmentPrompt =
  os.platform() === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell"

const system = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. Before starting any multi-step task, use todoWrite to plan your steps. Update status as you go. Use task for focused exploration or a self-contained subtask.`
const subSystem = `You are a coding agent at ${workDir}. Environment: ${environmentPrompt}. Complete the given task, then return a concise final answer.`

export { workDir, model, max_tokens, system, subSystem }

import { workDir, transcriptsDir, resultsDir } from "./config.js"
import Anthropic from "@anthropic-ai/sdk"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

async function saveOutput(tool_use_id: string, output: string) {
  await mkdir(resultsDir, { recursive: true })
  const safeId = tool_use_id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200)
  const fallback = "unknown_" + Math.random().toString(36).slice(2)
  const docName = (safeId || fallback) + ".txt"
  const outputPath = path.join(resultsDir, docName)
  await writeFile(outputPath, output)
  return outputPath
}

function toolResultBudget(messages: Anthropic.MessageParam[], maxChars: number) {
  if (messages.length < 1) {
    return messages
  }
  const lastMsg = messages[messages.length - 1]
  if (lastMsg!.role != "user" || !Array.isArray(lastMsg!.content)) {
    return messages
  }
}

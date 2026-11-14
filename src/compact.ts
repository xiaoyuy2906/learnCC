import { workDir, transcriptsDir, resultsDir } from "./config.js"
import Anthropic from "@anthropic-ai/sdk"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

const contextCharLimit = 50000
const toolResultBatchCharLimit = 200000
const largeResultCharLimit = 30000
const summaryInputCharLimit = 80000
const keepRecentResults = 3
const keepRecentMessages = 5

async function saveOutput(tool_use_id: string, output: string) {
  await mkdir(resultsDir, { recursive: true })
  const safeId = tool_use_id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200)
  const fallback = "unknown_" + Math.random().toString(36).slice(2)
  const docName = (safeId || fallback) + ".txt"
  const outputPath = path.join(resultsDir, docName)
  await writeFile(outputPath, output)
  return outputPath
}

// string content as-is, block array as JSON
function toString(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (content === undefined) return ""
  return typeof content === "string" ? content : JSON.stringify(content)
}

function toolResultBudget(messages: Anthropic.MessageParam[], maxChars: number | undefined) {
  const limit = maxChars ?? toolResultBatchCharLimit
  if (messages.length == 0) {
    return messages
  }
  const lastMsg = messages[messages.length - 1]
  if (lastMsg!.role != "user" || !Array.isArray(lastMsg!.content)) {
    return messages
  }
  // at this point, lastMsg.content is an array of blocks: tool_result blocks, possibly mixed with others (e.g. text)
  const toolResults: Anthropic.ToolResultBlockParam[] = lastMsg!.content.filter(it => it.type == "tool_result")
  let totalCharLen = toolResults.map(block => toString(block.content).length).reduce((acc, cur) => acc + cur, 0)
  const sortedToolResults = toolResults.toSorted((a, b) => toString(b.content).length - toString(a.content).length)

  for (const block of sortedToolResults) {
    if (totalCharLen <= limit) {
      return messages
    }
    const oldBlockLen = toString(block.content).length
    const output: string = toString(block.content)
    if (output.length <= largeResultCharLimit) {
      continue
    }
    block.content = persistLargeOutput(block.tool_use_id, output)
    totalCharLen = totalCharLen - oldBlockLen + block.content.length
  }

  return messages
}

function persistLargeOutput(tool_use_id: string, originOutput: string): string {}

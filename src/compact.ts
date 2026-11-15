import { workDir, transcriptsDir, resultsDir, checkFilePath } from "./config.js"
import Anthropic from "@anthropic-ai/sdk"
import path from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"

const contextCharLimit = 50000
const toolResultBatchCharLimit = 200000
const largeResultCharLimit = 30000
const summaryInputCharLimit = 80000
const keepRecentResults = 3
const keepRecentMessages = 5

async function saveOutput(tool_use_id: Anthropic.ToolResultBlockParam["tool_use_id"], output: string) {
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

async function toolResultBudget(messages: Anthropic.MessageParam[], maxChars: number | undefined) {
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
    const oldContent = toString(block.content)
    if (oldContent.length <= largeResultCharLimit) {
      continue
    }
    block.content = await persistLargeOutput(block.tool_use_id, oldContent)
    totalCharLen = totalCharLen - oldContent.length + block.content.length
  }

  return messages
}

async function persistLargeOutput(tool_use_id: Anthropic.ToolResultBlockParam["tool_use_id"], originOutput: string) {
  if (originOutput.length <= largeResultCharLimit) {
    return originOutput
  }
  return await persistedPreview(tool_use_id, originOutput)
}

async function persistedPreview(
  tool_use_id: Anthropic.ToolResultBlockParam["tool_use_id"],
  output: string,
  previewChars: number | undefined = 2000
) {
  let savedPath = persistedOutputPath(output)
  let preview
  if (savedPath) {
    try {
      preview = (await readFile(savedPath, { encoding: "utf8" })).slice(0, previewChars)
    } catch (e) {
      preview = output.slice(0, previewChars)
    }
  } else {
    savedPath = await saveOutput(tool_use_id, output)
    preview = output.slice(0, previewChars)
  }
  return `<persisted-output>\nFull output: ${savedPath}\nPreview:\n${preview}\n</persisted-output>`
}

function persistedOutputPath(output: string): string | undefined {
  let candidate: string | undefined

  if (output.startsWith("<persisted-output>")) {
    const lines = output.split("\n")
    lines.forEach(line => {
      const keyword = "Full output: "
      if (line.startsWith(keyword) && !candidate) {
        candidate = line.slice(keyword.length)
      }
    })
  }

  if (output.startsWith("[Earlier tool result saved at ") && output.endsWith("]")) {
    const prefix = "[Earlier tool result saved at "
    candidate = output.slice(prefix.length, output.length - 1)
  }

  if (candidate && checkFilePath(candidate, resultsDir)) {
    return candidate
  }
}

import { workDir, transcriptsDir, resultsDir, checkFilePath } from "./config.js"
import { randomUUID } from "node:crypto"
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
  const fallback = "unknown_" + randomUUID().replace(/-/g, "")
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

async function snipCompact(
  messages: Anthropic.MessageParam[],
  triggerMsgNum: number | undefined = 50,
  targetMsgNum: number | undefined = 30
) {
  if (triggerMsgNum <= targetMsgNum || targetMsgNum < 5) {
    throw new Error("Require 5 <= target_messages < trigger_messages")
  }
  if (messages.length < triggerMsgNum) {
    return messages
  }

  let headEnd = 3
  let tailStart = messages.length - (targetMsgNum - headEnd - 1)

  if (hasToolUse(messages[headEnd - 1])) {
    while (headEnd < tailStart && isToolResult(messages[headEnd])) {
      headEnd++
    }
  }

  if (tailStart > 0 && isToolResult(messages[tailStart]) && hasToolUse(messages[tailStart - 1])) {
    tailStart--
  }

  if (headEnd >= tailStart) {
    return messages
  }

  const snippedMsgs = messages.slice(headEnd, tailStart)
  if (snippedMsgs.length == 1 && isArchiveMarker(snippedMsgs[0])) {
    return messages
  }
  const transcriptPath = await writeTranscript(messages)
  const archiveMarker = {
    role: "user",
    content: `[${tailStart - headEnd} messages archived at ${transcriptPath}]`
  } satisfies Anthropic.MessageParam
  return messages.toSpliced(headEnd, tailStart - headEnd, archiveMarker)
}

function hasToolUse(message: Anthropic.MessageParam | undefined) {
  if (message == undefined) {
    return false
  }
  const content = message.content
  return message.role == "assistant" && Array.isArray(content) && content.some(block => block.type == "tool_use")
}

function isToolResult(message: Anthropic.MessageParam | undefined) {
  if (message == undefined) {
    return false
  }
  const content = message.content
  return message.role == "user" && Array.isArray(content) && content.some(block => block.type == "tool_result")
}

async function writeTranscript(messages: Anthropic.MessageParam[]) {
  await mkdir(transcriptsDir, { recursive: true })
  const docName = `transcript_${randomUUID().replace(/-/g, "")}.jsonl`
  const outputPath = path.join(transcriptsDir, docName)
  let lines = ""
  for (const message of messages) {
    lines += JSON.stringify(message) + "\n"
  }
  await writeFile(outputPath, lines)
  return outputPath
}

function isArchiveMarker(message: Anthropic.MessageParam | undefined) {
  if (message == undefined) {
    return false
  }
  const content = message.content
  const regexp = /^\[\d+ messages archived at (.+)\]$/g
  if (typeof content == "string") {
    const matchArr = regexp.exec(content)
    if (matchArr && matchArr.length > 0) {
      const path = matchArr[1] as string
      return checkFilePath(path, transcriptsDir)
    }
  }
  return false
}

type IndexedToolResultBlock = {
  messageIdx: number
  blockIdx: number
  toolResultBlock: Anthropic.ToolResultBlockParam
}

async function microCompact(messages: Anthropic.MessageParam[], targetChars: number | undefined) {
  const toolResultArr: IndexedToolResultBlock[] = []

  for (const [messageIdx, msg] of Object.entries(messages)) {
    const { role, content } = msg
    if (role == "user" && Array.isArray(content)) {
      for (const [blockIdx, block] of Object.entries(content)) {
        if (block.type == "tool_result") {
          toolResultArr.push({
            messageIdx: Number(messageIdx),
            blockIdx: Number(blockIdx),
            toolResultBlock: block
          })
        }
      }
    }
  }

  const unseenTools = unseenToolResultPositions(messages)
  const consumedToolResultArr = toolResultArr.filter(block => {
    for (const unseen of unseenTools) {
      if (unseen.messageIdx == block.messageIdx && unseen.blockIdx == block.blockIdx) {
        return false
      }
    }
    return true
  })

  for (const consumed of consumedToolResultArr.slice(0, -keepRecentResults)) {
    const { content, tool_use_id } = consumed.toolResultBlock

    if (targetChars && estimateChars(messages) < targetChars) {
      return messages
    }

    if (toString(content).length > 120) {
      const savedPath = persistedOutputPath(toString(content)) ?? (await saveOutput(tool_use_id, toString(content)))
      consumed.toolResultBlock.content = `[Earlier tool result saved at ${savedPath}]`
    }
  }
  return messages
}

type UnseenToolResultPositions = {
  [key in keyof IndexedToolResultBlock as Exclude<key, "toolResultBlock">]: IndexedToolResultBlock[key]
}

function unseenToolResultPositions(messages: Anthropic.MessageParam[]): UnseenToolResultPositions[] {
  const unseenArr: UnseenToolResultPositions[] = []
  const lastAssistantIdx =
    messages.findLastIndex(msg => msg.role == "assistant") == -1
      ? 0
      : messages.findLastIndex(msg => msg.role == "assistant")
  for (let messageIdx = lastAssistantIdx; messageIdx < messages.length; messageIdx++) {
    if (messages[messageIdx]!.role == "user" && Array.isArray(messages[messageIdx]!.content)) {
      const blockArr = messages[messageIdx]!.content as Anthropic.Messages.ContentBlockParam[]
      for (const [blockIdx, block] of Object.entries(blockArr)) {
        if (block.type == "tool_result") {
          unseenArr.push({
            messageIdx: Number(messageIdx),
            blockIdx: Number(blockIdx)
          })
        }
      }
    }
  }
  return unseenArr
}

function estimateChars(messages: Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length
}

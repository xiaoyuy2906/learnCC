import Anthropic from "@anthropic-ai/sdk"
import { memoryDir, memoryIndex, isInside, parseFrontmatter } from "./config.js"
import { dump } from "js-yaml"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { globSync, existsSync } from "node:fs"
import path, { basename } from "node:path"

const memoryTypes = ["user", "feedback", "project", "reference"] as const
type MemoryTypes = (typeof memoryTypes)[number]

function isMemoryType(type: string): type is MemoryTypes {
  return (memoryTypes as readonly string[]).includes(type)
}

function memorySlug(name: string): string {
  // old: /[^\w]+/g  (\w = ASCII only, drops Chinese)
  // new: \p{L} any-language letter, \p{N} any digit; \p{} needs flag u (flags = gu)
  const regex = /[^\p{L}\p{N}_]+/gu
  const slug = name
    .toLowerCase()
    .replace(regex, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
  // "memory.md" = "MEMORY.md" on macOS, would hit the index
  if (slug == "" || slug == "memory") {
    return "memory" + randomUUID().replace(/-/g, "")
  }
  return slug
}

function memoryDocument(name: string, memType: MemoryTypes, description: string, body: string) {
  const metadata = dump({
    name,
    description,
    type: memType
  }).trim()

  return `---\n${metadata}\n---\n\n${body.trim()}\n`
}

// filename: bare file name ("xxx.md"), NOT a path
function memoryPath(filename: string) {
  if (path.basename(filename) !== filename || filename == "" || filename == ".") {
    // this error will be thrown when the input filename is a path
    throw new Error(`Invalid memory filename: ${filename}`)
  }

  if (filename.toLowerCase() == path.basename(memoryIndex).toLowerCase()) {
    throw new Error("The memory index is not a memory record")
  }

  const filePath = path.join(memoryDir, filename)

  if (!isInside(filePath, memoryDir)) {
    throw new Error(`Memory path escapes the store: ${filename}`)
  }

  return filePath
}

// parsed memory file
interface MemoryFileInfo {
  // absolute path, NOT a bare name
  filename: string
  // title for the model
  name: string
  // short summary
  description: string
  type: MemoryTypes
  // text after frontmatter
  body: string
}

function parseMemoryFile(absolutePath: string): MemoryFileInfo {
  const { body, metadata } = parseFrontmatter(absolutePath)
  const filename = path.basename(absolutePath, path.extname(absolutePath))
  const firstLine = body.split("\n").find(line => line !== "") ?? "".trim()
  const memoryInfo: MemoryFileInfo = {
    filename: absolutePath,
    name: filename,
    type: "project",
    description: firstLine,
    body
  }
  if (Object.hasOwn(metadata, "name") && typeof metadata.name == "string") {
    memoryInfo.name = (metadata.name || filename).replace(/\s+/g, " ").trim()
  }

  if (Object.hasOwn(metadata, "description") && typeof metadata.description == "string") {
    memoryInfo.description = (metadata.description || firstLine).replace(/\s+/g, " ").trim()
  }

  if (Object.hasOwn(metadata, "type") && typeof metadata.type == "string" && isMemoryType(metadata.type)) {
    memoryInfo.type = metadata.type || "project"
  }

  return memoryInfo
}

async function rebuildMemoryIndex() {
  await mkdir(memoryDir, { recursive: true })
  const lines: string[] = []
  for (const entry of globSync("*.md", { cwd: memoryDir }).sort()) {
    try {
      const fullPath = memoryPath(entry)
      const { name, description } = parseMemoryFile(fullPath)
      lines.push(`- [${name}](${fullPath}) - ${description}`)
    } catch (err) {
      continue
    }
  }
  const memoryIndexText = lines.join("\n") + "\n"
  await writeFile(memoryIndex, memoryIndexText)
}

async function writeMemoryFile(name: string, memType: MemoryTypes, description: string, body: string) {
  if (name.trim() == "") {
    throw new Error("Memory name cannot be empty")
  }
  if (!memoryTypes.includes(memType)) {
    throw new Error(`Unknown memory type: ${memType}`)
  }
  if (description.trim() == "" || body.trim() == "") {
    throw new Error("Memory description and body cannot be empty")
  }

  await mkdir(memoryDir, { recursive: true })
  const filePath = memoryPath(`${memorySlug(name)}.md`)

  await writeFile(filePath, memoryDocument(name, memType, description, body))
  await rebuildMemoryIndex()
  return filePath
}

function selectRelevantMemories(messages: Anthropic.MessageParam[], maxItems: number = 5) {}

function listMemoryFiles() {
  const records: Array<MemoryFileInfo> = []

  if (!existsSync(memoryDir)) {
    return records
  }

  for (const entry of globSync("*.md", { cwd: memoryDir }).sort()) {
    if (entry == basename(memoryIndex)) {
      continue
    }
    let fullPath: string = ""
    try {
      fullPath = memoryPath(entry)
    } catch (err) {
      continue
    }
    const { name, description, type, body } = parseMemoryFile(fullPath)
    records.push({
      filename: fullPath,
      name,
      description,
      type,
      body
    })
  }

  return records
}

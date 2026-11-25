import { memoryDir, memoryIndex, isInside } from "./config.js"
import { dump } from "js-yaml"
import { mkdir, writeFile } from "node:fs/promises"
import { globSync } from "node:fs"
import path from "node:path"

const memoryTypes = ["user", "feedback", "project", "reference"] as const
type MemoryTypes = (typeof memoryTypes)[number]

function memorySlug(name: string): string {
  // old: /[^\w]+/g  (\w = ASCII only, drops Chinese)
  // new: \p{L} any-language letter, \p{N} any digit; \p{} needs flag u (flags = gu)
  const regex = /[^\p{L}\p{N}_]+/gu
  const slug = name
    .toLowerCase()
    .replace(regex, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
  return slug || "memory"
}

function memoryDocument(name: string, memType: MemoryTypes, description: string, body: string) {
  const metadata = dump({
    name,
    description,
    type: memType
  }).trim()

  return `---\n${metadata}\n---\n\n${body.trim()}`
}

// filename: bare file name ("xxx.md"), NOT a path
function memoryPath(filename: string, allowIndex: boolean = false) {
  if (path.basename(filename) !== filename || filename == "" || filename == ".") {
    // this error will be thrown when the input filename is a path
    throw new Error(`Invalid memory filename: ${filename}`)
  }

  if (filename.toLowerCase() == path.basename(memoryIndex).toLowerCase() && allowIndex == false) {
    throw new Error("The memory index is not a memory record")
  }

  const filePath = path.join(memoryDir, filename)

  if (!isInside(filePath, memoryDir)) {
    throw new Error(`Memory path escapes the store: ${filename}`)
  }

  return filePath
}

async function rebuildMemoryIndex() {
  await mkdir(memoryDir, { recursive: true })

  for (const entry of globSync("*.md", { cwd: memoryDir }).sort()) {
    try {
      const fullpath = memoryPath(entry)
    } catch (err) {
      continue
    }
  }
}

async function writeMemoryFile(name: string, memType: MemoryTypes, description: string, body: string) {
  if (name.trim() == "") {
    throw new Error("Memory name cannot be empty")
  }
  if (!memoryTypes.includes(memType)) {
    throw new Error(`"Unknown memory type: ${memType}`)
  }
  if (description.trim() == "" || body.trim() == "") {
    throw new Error("Memory description and body cannot be empty")
  }

  await mkdir(memoryDir, { recursive: true })
  const filePath = memoryPath(`${memorySlug(name)}.md`)

  await writeFile(filePath, memoryDocument(name, memType, description, body))
  rebuildMemoryIndex()
  return filePath
}

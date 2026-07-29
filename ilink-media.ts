/**
 * 微信 iLink CDN 媒体收发。
 *
 * 协议实现参考 @weixin-claw/core（MIT License，Copyright (c) 2026 Tencent Inc.）。
 * 媒体在 CDN 中使用 AES-128-ECB + PKCS#7 加密。
 */
import crypto from "node:crypto"
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

export const DEFAULT_CDN_BASE_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c"
export const DEFAULT_MEDIA_MAX_BYTES = 100 * 1024 * 1024

export type CDNMedia = {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
}

export type MediaMessageItem = {
  type?: number
  image_item?: {
    media?: CDNMedia
    aeskey?: string
    mid_size?: number
  }
  voice_item?: {
    media?: CDNMedia
    encode_type?: number
    playtime?: number
    text?: string
  }
  file_item?: {
    media?: CDNMedia
    file_name?: string
    len?: string
  }
  video_item?: {
    media?: CDNMedia
    video_size?: number
  }
}

export type IncomingAttachment = {
  type: "image" | "file" | "video" | "voice"
  path: string
  name: string
  mime: string
  size: number
}

type UploadUrlPayload = {
  filekey: string
  media_type: number
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb: boolean
  aeskey: string
}

type UploadUrlResponse = {
  upload_param?: string
  upload_full_url?: string
  ret?: number
  errcode?: number
  errmsg?: string
}

const ITEM_TYPE = { IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3 } as const

const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".silk": "audio/silk",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

function mimeFromFilename(filename: string): string {
  return EXTENSION_TO_MIME[path.extname(filename).toLowerCase()]
    ?? "application/octet-stream"
}

function imageType(buffer: Buffer): { mime: string; extension: string } {
  if (
    buffer.length >= 4
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) return { mime: "image/png", extension: ".png" }
  if (
    buffer.length >= 3
    && buffer[0] === 0x47
    && buffer[1] === 0x49
    && buffer[2] === 0x46
  ) return { mime: "image/gif", extension: ".gif" }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return { mime: "image/webp", extension: ".webp" }
  return { mime: "image/jpeg", extension: ".jpg" }
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function paddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64")
  if (decoded.length === 16) return decoded
  if (
    decoded.length === 32
    && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex")
  }
  throw new Error(`无效的微信媒体 AES key，解码长度：${decoded.length}`)
}

function safeName(value: string): string {
  const base = path.basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
  if (!base) return "file.bin"
  const extension = path.extname(base)
  const stem = path.basename(base, extension).slice(0, 100)
  return `${stem || "file"}${extension.slice(0, 20)}`
}

function shanghaiDateParts(timestamp: number): {
  date: string
  time: string
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00"
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}${get("minute")}${get("second")}`,
  }
}

async function downloadCdn(
  media: CDNMedia,
  aesKey: string | undefined,
  cdnBaseUrl: string,
  maxBytes: number,
): Promise<Buffer> {
  if (!media.encrypt_query_param) throw new Error("媒体缺少下载参数")
  const url = `${cdnBaseUrl.replace(/\/+$/, "")}/download?encrypted_query_param=${
    encodeURIComponent(media.encrypt_query_param)
  }`
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`微信 CDN 下载失败：HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get("content-length") ?? 0)
  if (declaredSize > maxBytes + 16) {
    throw new Error(`附件超过大小限制：${declaredSize} 字节`)
  }
  const encrypted = Buffer.from(await response.arrayBuffer())
  if (encrypted.length > maxBytes + 16) {
    throw new Error(`附件超过大小限制：${encrypted.length} 字节`)
  }
  const output = aesKey
    ? decryptAesEcb(encrypted, parseAesKey(aesKey))
    : encrypted
  if (output.length > maxBytes) {
    throw new Error(`附件超过大小限制：${output.length} 字节`)
  }
  return output
}

async function saveUnique(
  directory: string,
  preferredName: string,
  content: Buffer,
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const parsed = path.parse(safeName(preferredName))
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index ? `-${index}` : ""
    const candidate = path.join(
      directory,
      `${parsed.name}${suffix}${parsed.ext}`,
    )
    try {
      await writeFile(candidate, content, { flag: "wx", mode: 0o600 })
      return candidate
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "EEXIST"
      ) continue
      throw error
    }
  }
  throw new Error("附件重名过多，无法保存")
}

/**
 * 下载并归档一条微信媒体 item。
 * 目录格式：<用户工作目录>/attachments/YYYY-MM-DD/。
 */
export async function archiveIncomingMedia(params: {
  item: MediaMessageItem
  userDirectory: string
  messageId: string
  itemIndex: number
  timestamp: number
  cdnBaseUrl?: string
  maxBytes?: number
}): Promise<IncomingAttachment | null> {
  const {
    item,
    userDirectory,
    messageId,
    itemIndex,
    timestamp,
  } = params
  const cdnBaseUrl = params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
  const maxBytes = params.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES
  const clock = shanghaiDateParts(timestamp)
  const directory = path.join(userDirectory, "attachments", clock.date)
  const prefix = `${clock.time}-${safeName(messageId)}-${itemIndex + 1}`

  let type: IncomingAttachment["type"]
  let buffer: Buffer
  let mime: string
  let originalName: string

  if (item.type === ITEM_TYPE.IMAGE && item.image_item?.media) {
    const image = item.image_item
    const media = image.media
    if (!media) return null
    const key = image.aeskey
      ? Buffer.from(image.aeskey, "hex").toString("base64")
      : media.aes_key
    buffer = await downloadCdn(media, key, cdnBaseUrl, maxBytes)
    const detected = imageType(buffer)
    type = "image"
    mime = detected.mime
    originalName = `image${detected.extension}`
  } else if (item.type === ITEM_TYPE.FILE && item.file_item?.media) {
    const file = item.file_item
    const media = file.media
    if (!media) return null
    buffer = await downloadCdn(
      media,
      media.aes_key,
      cdnBaseUrl,
      maxBytes,
    )
    type = "file"
    originalName = safeName(file.file_name ?? "file.bin")
    mime = mimeFromFilename(originalName)
  } else if (item.type === ITEM_TYPE.VIDEO && item.video_item?.media) {
    const video = item.video_item
    const media = video.media
    if (!media) return null
    buffer = await downloadCdn(
      media,
      media.aes_key,
      cdnBaseUrl,
      maxBytes,
    )
    type = "video"
    originalName = "video.mp4"
    mime = "video/mp4"
  } else if (
    item.type === ITEM_TYPE.VOICE
    && item.voice_item?.media
    && !item.voice_item.text
  ) {
    const voice = item.voice_item
    const media = voice.media
    if (!media) return null
    buffer = await downloadCdn(
      media,
      media.aes_key,
      cdnBaseUrl,
      maxBytes,
    )
    type = "voice"
    originalName = "voice.silk"
    mime = "audio/silk"
  } else {
    return null
  }

  const archivedPath = await saveUnique(
    directory,
    `${prefix}-${originalName}`,
    buffer,
  )
  return {
    type,
    path: archivedPath,
    name: path.basename(archivedPath),
    mime,
    size: buffer.length,
  }
}

async function uploadCiphertext(params: {
  plaintext: Buffer
  aesKey: Buffer
  uploadUrl: string
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.plaintext, params.aesKey)
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(params.uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) {
        throw new Error(`微信 CDN 上传失败：HTTP ${response.status}`)
      }
      const result = response.headers.get("x-encrypted-param")
      if (!result) throw new Error("微信 CDN 上传响应缺少 x-encrypted-param")
      return result
    } catch (error) {
      lastError = error
      if (attempt < 3) await Bun.sleep(500 * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error("微信 CDN 上传失败")
}

/**
 * 加密上传本地文件并构造可直接用于 sendmessage 的媒体 item。
 */
export async function createOutgoingMediaItem(params: {
  filePath: string
  toUserId: string
  cdnBaseUrl?: string
  maxBytes?: number
  getUploadUrl: (payload: UploadUrlPayload) => Promise<UploadUrlResponse>
}): Promise<MediaMessageItem> {
  const info = await stat(params.filePath)
  const maxBytes = params.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES
  if (!info.isFile()) throw new Error("待发送路径不是文件")
  if (info.size > maxBytes) throw new Error(`文件超过大小限制：${info.size} 字节`)
  const plaintext = await readFile(params.filePath)
  const mime = mimeFromFilename(params.filePath)
  const mediaType = mime.startsWith("image/")
    ? UPLOAD_MEDIA_TYPE.IMAGE
    : mime.startsWith("video/")
      ? UPLOAD_MEDIA_TYPE.VIDEO
      : UPLOAD_MEDIA_TYPE.FILE
  const filekey = crypto.randomBytes(16).toString("hex")
  const aesKey = crypto.randomBytes(16)
  const ciphertextSize = paddedSize(plaintext.length)
  const response = await params.getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: params.toUserId,
    rawsize: plaintext.length,
    rawfilemd5: crypto.createHash("md5").update(plaintext).digest("hex"),
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aesKey.toString("hex"),
  })
  const uploadUrl = response.upload_full_url || (
    response.upload_param
      ? `${(params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(/\/+$/, "")}/upload?encrypted_query_param=${
          encodeURIComponent(response.upload_param)
        }&filekey=${encodeURIComponent(filekey)}`
      : ""
  )
  if (!uploadUrl) {
    throw new Error(
      `微信未返回媒体上传地址：ret=${response.ret ?? "?"} `
      + `errcode=${response.errcode ?? "?"} ${response.errmsg ?? ""}`,
    )
  }
  const downloadParam = await uploadCiphertext({
    plaintext,
    aesKey,
    uploadUrl,
  })
  const media: CDNMedia = {
    encrypt_query_param: downloadParam,
    // 微信文件/视频使用 base64(hex)，接收端同时兼容 base64(raw)。
    aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
    encrypt_type: 1,
  }
  if (mediaType === UPLOAD_MEDIA_TYPE.IMAGE) {
    return {
      type: ITEM_TYPE.IMAGE,
      image_item: { media, mid_size: ciphertextSize },
    }
  }
  if (mediaType === UPLOAD_MEDIA_TYPE.VIDEO) {
    return {
      type: ITEM_TYPE.VIDEO,
      video_item: { media, video_size: ciphertextSize },
    }
  }
  return {
    type: ITEM_TYPE.FILE,
    file_item: {
      media,
      file_name: path.basename(params.filePath),
      len: String(plaintext.length),
    },
  }
}

export type OutgoingAttachmentSelection = {
  text: string
  files: string[]
  rejected: string[]
}

/**
 * 提取 AI 回复中的 `[发送文件](路径)` 标记。
 * 真实路径必须位于当前微信用户工作目录内，符号链接也不能越界。
 */
export async function extractOutgoingAttachments(
  text: string,
  userDirectory: string,
): Promise<OutgoingAttachmentSelection> {
  const marker = /!?\[发送(?:文件|图片|附件)?\]\(([^)\r\n]+)\)/g
  const candidates: string[] = []
  const cleaned = text.replace(marker, (_whole, rawPath: string) => {
    const value = rawPath.trim().replace(/^<|>$/g, "")
    candidates.push(value)
    return `附件：${path.basename(value)}`
  })
  const root = await realpath(userDirectory)
  const files: string[] = []
  const rejected: string[] = []
  for (const value of [...new Set(candidates)]) {
    try {
      const candidate = path.isAbsolute(value)
        ? value
        : path.resolve(root, value)
      const resolved = await realpath(candidate)
      const relative = path.relative(root, resolved)
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("文件不在当前用户工作目录内")
      }
      const info = await stat(resolved)
      if (!info.isFile()) throw new Error("路径不是文件")
      if (info.size > DEFAULT_MEDIA_MAX_BYTES) throw new Error("文件超过 100MB")
      files.push(resolved)
    } catch (error) {
      rejected.push(`${value}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { text: cleaned, files, rejected }
}

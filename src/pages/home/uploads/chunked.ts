import { password } from "~/store"
import { EmptyResp } from "~/types"
import { r } from "~/utils"
import { SetUpload, Upload } from "./types"
import { calculateHash, calculatesha256 } from "./util"

// 默认分片大小为5MB
const DEFAULT_CHUNK_SIZE = 100 * 1024 * 1024
// 文件大小超过此值时使用分片上传
const CHUNKED_UPLOAD_THRESHOLD = 10 * 1024 * 1024

interface ChunkInfo {
  upload_id: string
  chunk_size: number
  total_size: number
  total_chunk: number
  file_name: string
  file_path: string
}

/**
 * 检查是否应该使用分片上传
 * @param file 要上传的文件
 */
export const shouldUseChunkedUpload = (file: File): boolean => {
  return file.size > CHUNKED_UPLOAD_THRESHOLD
}

export const ChunkedUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
): Promise<Error | undefined> => {
  try {
    // 初始化分片上传
    setUpload("status", "preparing")

    // 计算文件的哈希值（用于校验）
    setUpload("status", "hashing")
    let fileHash = null
    if (rapid || file.size > CHUNKED_UPLOAD_THRESHOLD) {
      const fileHash = await calculatesha256(file)
      console.log("File SHA256 hash calculated:", fileHash)
    }

    setUpload("status", "preparing")
    const initResp = await initChunkedUpload(
      uploadPath,
      file,
      overwrite,
      fileHash,
    )

    if (initResp.code !== 200 || !initResp.data) {
      return new Error(
        initResp.message || "Failed to initialize chunked upload",
      )
    }

    const chunkInfo: ChunkInfo = initResp.data
    const totalChunks = chunkInfo.total_chunk
    const chunkSize = chunkInfo.chunk_size

    // 开始上传分片
    setUpload("status", "uploading")
    let oldTimestamp = new Date().valueOf()
    let totalUploaded = 0

    // 逐个上传分片
    for (let i = 0; i < totalChunks; i++) {
      setUpload("progress", Math.floor((i / totalChunks) * 100))

      // 计算当前分片的范围
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const chunk = file.slice(start, end)

      // 上传分片
      const chunkResp = await uploadChunk(chunkInfo.upload_id, i, chunk)

      if (chunkResp.code !== 200) {
        // 如果上传失败，尝试中止上传
        await abortChunkedUpload(chunkInfo.upload_id)
        return new Error(`Failed to upload chunk ${i}: ${chunkResp.message}`)
      }

      // 更新上传进度和速度
      totalUploaded += chunk.size
      const timestamp = new Date().valueOf()
      const duration = (timestamp - oldTimestamp) / 1000

      if (duration > 1) {
        const speed = chunk.size / duration
        setUpload("speed", speed)
        oldTimestamp = timestamp
      }
    }

    // 完成上传
    setUpload("status", "backending")
    setUpload("progress", 100)

    const completeResp = await completeChunkedUpload(
      chunkInfo.upload_id,
      asTask,
    )

    if (completeResp.code !== 200) {
      return new Error(`Failed to complete upload: ${completeResp.message}`)
    }

    return undefined
  } catch (err: any) {
    console.error("Chunked upload failed:", err)
    return new Error(err.message || "Unknown error during chunked upload")
  }
}

/**
 * 初始化分片上传
 */
async function initChunkedUpload(
  uploadPath: string,
  file: File,
  overwrite: boolean,
  fileHash: string | null,
) {
  return await r.post("/fs/chunk/init", null, {
    headers: {
      "File-Path": encodeURIComponent(uploadPath),
      "File-Size": file.size.toString(),
      "Chunk-Size": DEFAULT_CHUNK_SIZE.toString(),
      Password: password(),
      Overwrite: overwrite.toString(),
      "File-Hash": fileHash || "",
    },
  })
}

/**
 * 上传单个分片
 */
async function uploadChunk(uploadId: string, chunkIndex: number, chunk: Blob) {
  return await r.put("/fs/chunk/upload", chunk, {
    headers: {
      "Upload-ID": uploadId,
      "Chunk-Index": chunkIndex.toString(),
      "Content-Type": "application/octet-stream",
      Password: password(),
    },
  })
}

/**
 * 完成分片上传
 */
async function completeChunkedUpload(uploadId: string, asTask: boolean) {
  return await r.post("/fs/chunk/complete", null, {
    headers: {
      "Upload-ID": uploadId,
      "As-Task": asTask.toString(),
      Password: password(),
    },
  })
}

/**
 * 中止分片上传
 */
async function abortChunkedUpload(uploadId: string) {
  return await r.delete("/fs/chunk/abort", {
    headers: {
      "Upload-ID": uploadId,
      Password: password(),
    },
  })
}

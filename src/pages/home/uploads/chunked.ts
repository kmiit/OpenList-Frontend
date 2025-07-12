import { password } from "~/store"
import { EmptyResp, Resp } from "~/types"
import { r } from "~/utils"
import { SetUpload, Upload } from "./types"
import { calculateHash, calculatesha256, getSettingValue } from "./util"
import { AxiosProgressEvent } from "axios"

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
      // 计算当前分片的范围
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const chunk = file.slice(start, end)

      // 上传分片，带进度回调
      const chunkResp = await uploadChunk(
        chunkInfo.upload_id,
        i,
        chunk,
        (progressEvent: AxiosProgressEvent) => {
          // 计算总体进度：已完成的分片 + 当前分片的进度
          const completedSize = totalUploaded
          const currentChunkProgress = progressEvent.loaded || 0
          const totalProgress =
            (completedSize + currentChunkProgress) / file.size
          const progressPercent = Math.min(Math.floor(totalProgress * 100), 99) // 最多到99%，完成时才到100%

          setUpload("progress", progressPercent)

          // 计算实时速度
          const timestamp = new Date().valueOf()
          const duration = (timestamp - oldTimestamp) / 1000

          if (duration > 0.5) {
            // 每0.5秒更新一次速度
            const speed = currentChunkProgress / duration
            setUpload("speed", speed)
            oldTimestamp = timestamp
          }
        },
      )

      if (chunkResp.code !== 200) {
        // 如果上传失败，尝试中止上传
        await abortChunkedUpload(chunkInfo.upload_id)
        return new Error(`Failed to upload chunk ${i}: ${chunkResp.message}`)
      }

      // 更新已上传的总大小
      totalUploaded += chunk.size
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
): Promise<Resp<ChunkInfo>> {
  const sliceSizeSetting = await getSettingValue("slice_transmission_size")
  const sliceSize =
    (sliceSizeSetting ? parseInt(sliceSizeSetting as any) : 10) * 1024 * 1024
  return await r.post("/fs/chunk/init", null, {
    headers: {
      "File-Path": encodeURIComponent(uploadPath),
      "File-Size": file.size.toString(),
      "Chunk-Size": sliceSize,
      Password: password(),
      Overwrite: overwrite.toString(),
      "File-Hash": fileHash || "",
    },
  })
}

/**
 * 上传单个分片
 */
async function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  chunk: Blob,
  onProgress?: (progressEvent: AxiosProgressEvent) => void,
): Promise<EmptyResp> {
  return await r.put("/fs/chunk/upload", chunk, {
    headers: {
      "Upload-ID": uploadId,
      "Chunk-Index": chunkIndex.toString(),
      "Content-Type": "application/octet-stream",
      Password: password(),
    },
    onUploadProgress: onProgress,
  })
}

/**
 * 完成分片上传
 */
async function completeChunkedUpload(
  uploadId: string,
  asTask: boolean,
): Promise<EmptyResp> {
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
async function abortChunkedUpload(uploadId: string): Promise<EmptyResp> {
  return await r.delete("/fs/chunk/abort", {
    headers: {
      "Upload-ID": uploadId,
      Password: password(),
    },
  })
}

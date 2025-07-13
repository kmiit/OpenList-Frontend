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

    // 计算文件的哈希值（用于断点续传和校验）
    setUpload("status", "hashing")
    let fileHash = ""
    // 对于大文件或启用了rapid模式时，计算文件哈希
    if (rapid || file.size > CHUNKED_UPLOAD_THRESHOLD) {
      fileHash = await calculatesha256(file)
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

    // 直接从初始化响应中获取已上传的分片信息（用于断点续传）
    const uploadedChunks = new Set<number>()
    if (
      initResp.data.uploaded_chunks &&
      Array.isArray(initResp.data.uploaded_chunks)
    ) {
      initResp.data.uploaded_chunks.forEach((chunkIndex: number) => {
        uploadedChunks.add(chunkIndex)
      })
      if (uploadedChunks.size > 0) {
        console.log(`Found ${uploadedChunks.size} previously uploaded chunks`)
      }
    }

    // 开始上传分片
    setUpload("status", "uploading")
    let oldTimestamp = new Date().valueOf()
    let lastTotalBytes = 0 // 记录上次统计时的总字节数
    const chunkProgress: Record<number, number> = {} // 记录每个分片的上传进度

    // 计算已经上传的字节数（断点续传）
    let alreadyUploadedBytes = 0
    uploadedChunks.forEach((chunkIndex) => {
      const chunkActualSize =
        chunkIndex === totalChunks - 1
          ? file.size - chunkIndex * chunkSize
          : chunkSize

      alreadyUploadedBytes += chunkActualSize
      chunkProgress[chunkIndex] = chunkActualSize // 标记为已完成
    })

    // 更新初始进度
    if (alreadyUploadedBytes > 0) {
      const initialProgress = Math.floor(
        (alreadyUploadedBytes / file.size) * 100,
      )
      setUpload("progress", Math.min(initialProgress, 99))
      lastTotalBytes = alreadyUploadedBytes
    }

    // 创建并行上传任务
    const uploadTasks: Array<() => Promise<void>> = []

    for (let i = 0; i < totalChunks; i++) {
      const chunkIndex = i

      // 如果该分片已上传，跳过
      if (uploadedChunks.has(chunkIndex)) {
        continue
      }

      const start = chunkIndex * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const chunk = file.slice(start, end)

      uploadTasks.push(async () => {
        const chunkResp = await uploadChunk(
          chunkInfo.upload_id,
          chunkIndex,
          chunk,
          (progressEvent: AxiosProgressEvent) => {
            // 更新当前分片的进度
            chunkProgress[chunkIndex] = progressEvent.loaded || 0

            // 计算总体进度：所有分片的进度之和
            const totalProgressBytes = Object.values(chunkProgress).reduce(
              (sum, progress) => sum + progress,
              0,
            )
            const totalProgress = totalProgressBytes / file.size
            const progressPercent = Math.min(
              Math.floor(totalProgress * 100),
              99,
            ) // 最多到99%，完成时才到100%

            setUpload("progress", progressPercent)

            // 计算实时速度 - 基于总字节数的增量
            const timestamp = new Date().valueOf()
            const duration = (timestamp - oldTimestamp) / 1000

            if (duration > 0.5) {
              // 计算这段时间内的字节增量
              const bytesIncrement = totalProgressBytes - lastTotalBytes
              const speed = bytesIncrement / duration

              setUpload("speed", speed)
              oldTimestamp = timestamp
              lastTotalBytes = totalProgressBytes
            }
          },
        )

        if (chunkResp.code !== 200) {
          throw new Error(
            `Failed to upload chunk ${chunkIndex}: ${chunkResp.message}`,
          )
        }

        // 标记分片完成
        chunkProgress[chunkIndex] = chunk.size
      })
    }

    // 使用并发池执行上传任务
    try {
      // 如果所有分片都已上传完成，不需要执行上传任务
      if (uploadTasks.length > 0) {
        let transmission_count = await getSettingValue(
          "slice_transmission_count",
        )
        const trans_count = transmission_count
          ? parseInt(transmission_count as any)
          : 3
        await executeWithConcurrencyLimit(uploadTasks, trans_count)
      } else {
        console.log("All chunks already uploaded, skipping upload tasks")
      }
    } catch (error) {
      // 如果上传失败，尝试中止上传
      await abortChunkedUpload(chunkInfo.upload_id)
      throw error
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
 * 获取分片上传状态
 * @param uploadId 上传ID
 */
async function getChunkUploadStatus(
  uploadId: string,
): Promise<Resp<{ uploaded_chunks: number[] }>> {
  return await r.get("/fs/chunk/status", {
    headers: {
      "Upload-ID": uploadId,
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

/**
 * 并发控制执行函数 - 维持固定数量的并发任务
 * @param tasks 要执行的任务数组
 * @param concurrencyLimit 并发限制数量
 */
async function executeWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrencyLimit: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = new Array(tasks.length)
    let completed = 0
    let nextTaskIndex = 0
    let runningTasks = 0
    let hasError = false

    const startNextTask = () => {
      if (hasError || nextTaskIndex >= tasks.length) return

      const taskIndex = nextTaskIndex++
      runningTasks++

      const task = tasks[taskIndex]

      task()
        .then((result) => {
          if (hasError) return

          results[taskIndex] = result
          completed++
          runningTasks--

          // 检查是否所有任务都完成了
          if (completed === tasks.length) {
            resolve(results)
            return
          }

          // 立即启动下一个任务（如果还有待执行的任务）
          startNextTask()
        })
        .catch((error) => {
          if (!hasError) {
            hasError = true
            reject(error)
          }
        })
    }

    // 启动初始的并发任务，数量不超过并发限制和总任务数
    const initialTasks = Math.min(concurrencyLimit, tasks.length)
    for (let i = 0; i < initialTasks; i++) {
      startNextTask()
    }

    // 如果没有任务需要执行，直接resolve
    if (tasks.length === 0) {
      resolve(results)
    }
  })
}

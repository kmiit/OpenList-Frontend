import { UploadFileProps } from "./types"
import { createMD5, createSHA1, createSHA256 } from "hash-wasm"

export const traverseFileTree = async (entry: FileSystemEntry) => {
  let res: File[] = []
  const internalProcess = async (entry: FileSystemEntry, path: string) => {
    const promise = new Promise<{}>((resolve, reject) => {
      const errorCallback: ErrorCallback = (e) => {
        console.error(e)
        reject(e)
      }
      if (entry.isFile) {
        ;(entry as FileSystemFileEntry).file((file) => {
          const newFile = new File([file], path + file.name, {
            type: file.type,
          })
          res.push(newFile)
          console.log(newFile)
          resolve({})
        }, errorCallback)
      } else if (entry.isDirectory) {
        const dirReader = (entry as FileSystemDirectoryEntry).createReader()
        const readEntries = () => {
          dirReader.readEntries(async (entries) => {
            for (let i = 0; i < entries.length; i++) {
              await internalProcess(entries[i], path + entry.name + "/")
            }
            resolve({})
            /**
            why? https://stackoverflow.com/questions/3590058/does-html5-allow-drag-drop-upload-of-folders-or-a-folder-tree/53058574#53058574
            Unfortunately none of the existing answers are completely correct because 
            readEntries will not necessarily return ALL the (file or directory) entries for a given directory. 
            This is part of the API specification (see Documentation section below).
            
            To actually get all the files, we'll need to call readEntries repeatedly (for each directory we encounter) 
            until it returns an empty array. If we don't, we will miss some files/sub-directories in a directory 
            e.g. in Chrome, readEntries will only return at most 100 entries at a time.
            */
            if (entries.length > 0) {
              readEntries()
            }
          }, errorCallback)
        }
        readEntries()
      }
    })
    await promise
  }
  await internalProcess(entry, "")
  return res
}

export const File2Upload = (file: File): UploadFileProps => {
  return {
    name: file.name,
    path: file.webkitRelativePath ? file.webkitRelativePath : file.name,
    size: file.size,
    progress: 0,
    speed: 0,
    status: "pending",
  }
}

export const calculateHash = async (file: File) => {
  const md5Digest = await createMD5()
  const sha1Digest = await createSHA1()
  const sha256Digest = await createSHA256()
  const reader = file.stream().getReader()
  const read = async () => {
    const { done, value } = await reader.read()
    if (done) {
      return
    }
    md5Digest.update(value)
    sha1Digest.update(value)
    sha256Digest.update(value)
    await read()
  }
  await read()
  const md5 = md5Digest.digest("hex")
  const sha1 = sha1Digest.digest("hex")
  const sha256 = sha256Digest.digest("hex")
  return { md5, sha1, sha256 }
}
export const calculatesha256 = async (
  file: File,
  progressCallback?: (progress: number) => void,
): Promise<string> => {
  // 预先初始化哈希实例，避免后续计算时的延迟
  const sha256Digest = await createSHA256()

  // 更优化的块大小 - 实验表明8MB是WebAssembly处理的良好平衡点
  const chunkSize = 8 * 1024 * 1024 // 8MB
  const totalBytes = file.size
  let processedBytes = 0
  let lastReportedProgress = -1

  // 对非常小的文件使用更简单的处理方式
  if (file.size < chunkSize) {
    const buffer = await file.arrayBuffer()
    sha256Digest.update(new Uint8Array(buffer))
    return sha256Digest.digest("hex")
  }

  try {
    // 使用FileReader API读取块，而不是流API，某些情况下性能更好
    return await new Promise<string>((resolve, reject) => {
      // 创建文件分块
      const chunks = Math.ceil(file.size / chunkSize)
      let currentChunk = 0

      // 处理每个块的函数
      const processChunk = async () => {
        if (currentChunk >= chunks) {
          // 完成所有块的处理后，返回哈希值
          try {
            const hash = sha256Digest.digest("hex")
            resolve(hash)
          } catch (err) {
            reject(err)
          }
          return
        }

        const start = currentChunk * chunkSize
        const end = Math.min(start + chunkSize, file.size)
        const chunk = file.slice(start, end)

        try {
          // 使用ArrayBuffer直接处理数据
          const arrayBuffer = await chunk.arrayBuffer()
          sha256Digest.update(new Uint8Array(arrayBuffer))

          // 更新进度
          processedBytes += end - start
          if (progressCallback) {
            const progress = Math.floor((processedBytes / totalBytes) * 100)
            // 避免过多进度回调导致UI更新频繁
            if (progress > lastReportedProgress) {
              lastReportedProgress = progress
              progressCallback(progress)
            }
          }

          // 处理下一个块，但允许UI线程有机会更新
          currentChunk++
          setTimeout(processChunk, 0)
        } catch (err) {
          reject(err)
        }
      }

      // 开始处理第一个块
      processChunk()
    })
  } catch (error) {
    console.error("SHA-256计算错误:", error)
    throw error
  }
}

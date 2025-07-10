import { objStore } from "~/store"
import { ChunkedUpload, shouldUseChunkedUpload } from "./chunked"
import { FormUpload } from "./form"
import { StreamUpload } from "./stream"
import { Upload } from "./types"

type Uploader = {
  upload: Upload
  name: string
  provider: RegExp
}

const AllUploads: Uploader[] = [
  {
    name: "Chunked",
    upload: ChunkedUpload,
    provider: /.*/,
  },
  {
    name: "Stream",
    upload: StreamUpload,
    provider: /.*/,
  },
  {
    name: "Form",
    upload: FormUpload,
    provider: /.*/,
  },
]

export const getUploads = (): Pick<Uploader, "name" | "upload">[] => {
  return AllUploads.filter((u) => u.provider.test(objStore.provider))
}

// 智能选择最适合的上传方法
export const getBestUploadMethod = (file: File): Upload => {
  // 对于大文件使用分片上传
  if (shouldUseChunkedUpload(file)) {
    return ChunkedUpload
  }
  // 否则使用流式上传
  return StreamUpload
}

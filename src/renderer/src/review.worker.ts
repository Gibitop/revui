import { parseDiffFromFile } from '@pierre/diffs'
import { prepareFileTreeInput } from '@pierre/trees'
import type { FileContent, Snapshot } from '../../shared/review'

self.onmessage = (
  event: MessageEvent<
    | { kind: 'tree'; paths: string[] }
    | { kind: 'diff'; content: FileContent }
    | { kind: 'snapshot'; snapshot: Snapshot }
  >,
) => {
  try {
    const data = event.data
    if (data.kind === 'snapshot') {
      const paths = [...prepareFileTreeInput(data.snapshot.paths).paths]
      const files = new Map(data.snapshot.files.map((file) => [file.path, file]))
      self.postMessage({
        result: {
          ...data.snapshot,
          paths,
          files: paths.flatMap((path) => {
            const file = files.get(path)
            return file ? [file] : []
          }),
        },
      })
      return
    }
    self.postMessage({
      result:
        data.kind === 'tree'
          ? prepareFileTreeInput(data.paths).paths
          : parseDiffFromFile(data.content.oldFile, data.content.newFile, undefined, true),
    })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

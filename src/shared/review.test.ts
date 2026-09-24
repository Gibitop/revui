import { expect, it } from 'vitest'
import { commentPriority } from './review'

it('extracts only a leading supported priority and preserves Markdown and suggestions', () => {
  for (const priority of [0, 1, 2, 3]) {
    expect(commentPriority(` [P${priority}] **Issue**\n\n\`\`\`suggestion\nfix\n\`\`\``)).toEqual({
      priority,
      body: '**Issue**\n\n```suggestion\nfix\n```',
    })
  }
  for (const body of ['Normal comment', 'Mention [P1] here', '[P9] Unknown'])
    expect(commentPriority(body)).toEqual({ priority: null, body })
})

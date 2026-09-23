import type { Discussion, GitLabRequest, GitLabReview } from '../../shared/gitlab'

// Only mutation requests change the visible review while their network request is pending.
export function optimisticGitLabReview(review: GitLabReview, request: GitLabRequest): GitLabReview {
  const next = structuredClone(review)
  const user = [
    review.mr.author,
    ...review.mr.reviewers,
    ...(review.mr.assignees ?? []),
    ...(review.approvals?.approved_by.map(({ user }) => user) ?? []),
    ...review.discussions.flatMap(({ notes }) => notes.map(({ author }) => author)),
  ].find(({ id }) => id === review.userId) ?? { id: review.userId, name: 'You' }
  switch (request.kind) {
    case 'comment': {
      const anchor = request.anchor
      const note: Discussion['notes'][number] = {
        id: -Date.now(),
        author: user,
        body: request.body,
        system: false,
        resolvable: !!anchor || !!request.discussion,
        resolved: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      if (request.discussion) {
        next.discussions.find(({ id }) => id === request.discussion)?.notes.push(note)
      } else {
        if (anchor) {
          const side = anchor.side === 'additions' ? 'new' : 'old'
          note.position = {
            ...review.pinned,
            position_type: 'text',
            old_path: anchor.path,
            new_path: anchor.path,
            [side === 'new' ? 'new_line' : 'old_line']: anchor.line,
            ...(anchor.startLine !== undefined && anchor.startLine !== anchor.line
              ? {
                  line_range: {
                    start: { type: side, line_code: '', [`${side}_line`]: anchor.startLine },
                    end: { type: side, line_code: '', [`${side}_line`]: anchor.line },
                  },
                }
              : {}),
          }
        }
        next.discussions.push({ id: `pending-${note.id}`, individual_note: false, notes: [note] })
      }
      break
    }
    case 'edit': {
      const note = next.discussions
        .find(({ id }) => id === request.discussion)
        ?.notes.find(({ id }) => id === request.note)
      if (note) note.body = request.body
      break
    }
    case 'delete-note':
      next.discussions = next.discussions
        .map((discussion) =>
          discussion.id === request.discussion
            ? { ...discussion, notes: discussion.notes.filter(({ id }) => id !== request.note) }
            : discussion,
        )
        .filter(({ notes }) => notes.length)
      break
    case 'resolve':
      next.discussions
        .find(({ id }) => id === request.discussion)
        ?.notes.forEach((note) => {
          if (note.resolvable) note.resolved = request.resolved
        })
      break
    case 'approve':
      if (next.approvals) {
        next.approvals.approved_by = next.approvals.approved_by.filter(
          ({ user }) => user.id !== review.userId,
        )
        if (request.approved) next.approvals.approved_by.push({ user })
      }
      break
    default:
      return review
  }
  return next
}

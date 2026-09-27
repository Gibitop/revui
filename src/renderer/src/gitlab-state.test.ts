import { describe, expect, it } from 'vitest'
import type { GitLabReview } from '../../shared/gitlab'
import { optimisticGitLabReview } from './gitlab-state'

const user = { id: 1, name: 'Reviewer' }
const review = {
  session: 'session',
  userId: 1,
  mr: { author: user, reviewers: [], assignees: [] },
  pinned: { base_sha: 'base', start_sha: 'start', head_sha: 'head' },
  approvals: { approved: false, approved_by: [] },
  discussions: [
    {
      id: 'thread',
      individual_note: false,
      notes: [
        {
          id: 2,
          body: 'original',
          suggestions: [
            {
              id: 1,
              from_line: 1,
              to_line: 1,
              from_content: 'old',
              to_content: 'new',
              applicable: true,
              applied: false,
            },
          ],
          author: user,
          resolvable: true,
          resolved: false,
          system: false,
          updated_at: '',
        },
      ],
    },
  ],
} as unknown as GitLabReview

describe('optimistic GitLab review', () => {
  it('previews edits, resolution and deletion without modifying the rollback state', () => {
    const edited = optimisticGitLabReview(review, {
      kind: 'edit',
      session: 'session',
      discussion: 'thread',
      note: 2,
      body: 'edited',
    })
    expect(edited.discussions[0].notes[0].body).toBe('edited')
    expect(edited.discussions[0].notes[0].suggestions).toBeUndefined()
    expect(review.discussions[0].notes[0].suggestions).toHaveLength(1)
    const resolved = optimisticGitLabReview(review, {
      kind: 'resolve',
      session: 'session',
      discussion: 'thread',
      resolved: true,
    })
    expect(resolved.discussions[0].notes[0].resolved).toBe(true)
    const deleted = optimisticGitLabReview(review, {
      kind: 'delete-note',
      session: 'session',
      discussion: 'thread',
      note: 2,
    })
    expect(deleted.discussions).toEqual([])
    expect(review.discussions[0].notes[0]).toMatchObject({ body: 'original', resolved: false })
  })
  it('previews inline ranges and replies with temporary identities', () => {
    const posted = optimisticGitLabReview(review, {
      kind: 'comment',
      session: 'session',
      body: 'new',
      anchor: { path: 'file.ts', side: 'deletions', startLine: 2, line: 4 },
    })
    expect(posted.discussions[1].notes[0]).toMatchObject({
      author: user,
      body: 'new',
      position: { old_line: 4, line_range: { start: { old_line: 2 }, end: { old_line: 4 } } },
    })
    expect(posted.discussions[1].notes[0].id).toBeLessThan(0)
    const reply = optimisticGitLabReview(review, {
      kind: 'comment',
      session: 'session',
      body: 'reply',
      discussion: 'thread',
    })
    expect(reply.discussions[0].notes.map(({ body }) => body)).toEqual(['original', 'reply'])
    expect(review.discussions[0].notes).toHaveLength(1)
  })
  it('updates personal approval without guessing project approval rules', () => {
    const approved = optimisticGitLabReview(review, {
      kind: 'approve',
      session: 'session',
      approved: true,
    })
    expect(approved.approvals?.approved_by).toEqual([{ user }])
    expect(approved.approvals?.approved).toBe(false)
    const unapproved = optimisticGitLabReview(approved, {
      kind: 'approve',
      session: 'session',
      approved: false,
    })
    expect(unapproved.approvals?.approved_by).toEqual([])
  })
})

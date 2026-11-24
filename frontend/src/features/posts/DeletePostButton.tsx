import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { useTask } from '../auth/use-task.ts'
import { runContentAction } from '../moderation/content-action.ts'
import { Icon } from '../../shared/components/Icon.tsx'

export function DeletePostButton({ postId, detailLink }: { postId: string; detailLink: boolean }) {
  const { api, controller, scope, notify } = useAuth()
  const task = useTask(), cache = useQueryClient(), navigate = useNavigate(), active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  return <div className="post-delete">
    <button type="button" role="menuitem" className="post-menu-action" aria-label="Xóa bài viết" title="Xóa bài viết" disabled={task.busy} aria-busy={task.busy}
      onClick={event => { event.stopPropagation(); if (task.busy || !window.confirm('Xóa bài viết này? Bài sẽ không còn hiển thị và chưa có chức năng khôi phục.')) return
        void task.run(() => runContentAction(cache, scope, { type: 'POST', id: postId }, () => api.deletePost(postId),
          () => active.current && controller.getScope() === scope, controller.reject, () => { notify('Đã xóa bài viết.'); if (!detailLink) navigate('/bang-tin', { replace: true }) }))
      }}><Icon name="trash" />Xóa bài viết</button>
    {task.error && <p role="alert" className="content-action-error">{task.error}</p>}
  </div>
}

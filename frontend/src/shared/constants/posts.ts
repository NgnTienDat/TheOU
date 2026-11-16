import type { PostTag } from '../api/SocialApiClient.ts'

export const postTags: Record<PostTag, string> = {
  CONFESSION: 'Confession', REVIEW_MON: 'Review môn', TAI_LIEU: 'Tài liệu', TIM_TRO: 'Tìm trọ', HOI_GAP: 'Hỏi gấp',
}
export const tagFilters = [{ value: null, label: 'Tất cả' }, ...Object.entries(postTags).map(([value, label]) => ({ value: value as PostTag, label }))]

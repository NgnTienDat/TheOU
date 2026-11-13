export type PostTag = 'CONFESSION' | 'REVIEW_MON' | 'TAI_LIEU' | 'TIM_TRO' | 'HOI_GAP'
export type DisplayMode = 'ANONYMOUS' | 'NICKNAME'

export interface PublicImage {
  id: string
  signedUrl: string
  expiresAt: string
}

export interface PostPublic {
  id: string
  tag: PostTag
  body: string
  displayMode: DisplayMode
  authorLabel: string
  contactUrl: string | null
  publishedAt: string
  upvoteCount: number
  commentCount: number
  hasUpvoted: boolean
  isMine: boolean
  images: PublicImage[]
}

export interface CommentPublic {
  id: string
  postId: string
  body: string
  authorLabel: string
  isOriginalPoster: boolean
  isMine: boolean
  createdAt: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ListPostsInput {
  sort: 'NEW' | 'HOT'
  tag: PostTag | null
  cursor: string | null
  limit: number
}

export interface CreatePostInput {
  body: string
  tag: PostTag
  displayMode: DisplayMode
  contactUrl?: string | null
  idempotencyKey: string
}

export interface CreateCommentInput {
  postId: string
  body: string
  idempotencyKey: string
}

// Hợp đồng T01; adapter gọi Edge Function sẽ được bổ sung cùng các task nghiệp vụ.
export interface SocialApiClient {
  listPosts(input: ListPostsInput): Promise<Page<PostPublic>>
  getPost(postId: string): Promise<PostPublic>
  createPost(input: CreatePostInput): Promise<{ postId: string; status: 'DRAFT' }>
  publishPost(postId: string): Promise<PostPublic>
  listComments(postId: string, cursor?: string): Promise<Page<CommentPublic>>
  createComment(input: CreateCommentInput): Promise<CommentPublic>
  setUpvote(postId: string, desiredState: boolean): Promise<{ hasUpvoted: boolean; upvoteCount: number }>
}

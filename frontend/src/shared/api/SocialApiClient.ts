export type PostTag = 'CONFESSION' | 'REVIEW_MON' | 'TAI_LIEU' | 'TIM_TRO' | 'HOI_GAP'
export type DisplayMode = 'ANONYMOUS' | 'NICKNAME'

export interface PublicImage {
  id: string
  signedUrl: string
  expiresAt: string
}
export interface ImageUploadInput { postId: string; mimeType: string; sizeBytes: number; position: number }
export interface ImageUpload { imageId: string; path: string; token: string }

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
export interface ListCommentsInput { postId: string; cursor: string | null; limit: number }

export interface UpvoteState { hasUpvoted: boolean; upvoteCount: number }

// API nghiệp vụ qua Edge Function; không truy cập bảng trực tiếp.
export interface SocialApiClient {
  createImageUpload(input: ImageUploadInput): Promise<ImageUpload>
  uploadImage(upload: ImageUpload, file: Blob): Promise<void>
  finalizeImage(postId: string, imageId: string): Promise<{ imageId: string; status: 'READY' }>
  removeDraftImage(postId: string, imageId: string): Promise<{ success: true }>
  getMe(): Promise<Me>
  updateNickname(nickname: string): Promise<{ nickname: string }>
  listPosts(input: ListPostsInput): Promise<Page<PostPublic>>
  getPost(postId: string): Promise<PostPublic>
  createPost(input: CreatePostInput): Promise<{ postId: string; status: 'DRAFT' }>
  publishPost(postId: string): Promise<PostPublic>
  listComments(input: ListCommentsInput): Promise<Page<CommentPublic>>
  createComment(input: CreateCommentInput): Promise<CommentPublic>
  deleteComment(commentId: string): Promise<{ success: true }>
  setUpvote(postId: string, desiredState: boolean): Promise<UpvoteState>
}

export interface Me {
  nickname: string
  emailMasked: string
  isAdmin: boolean
}

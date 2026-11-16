export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'

const errors = {
  UNAUTHENTICATED: {
    status: 401,
    message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
  },
  FORBIDDEN: { status: 403, message: 'Tài khoản không đủ điều kiện truy cập TheOU hoặc đã bị khóa.' },
  VALIDATION_ERROR: { status: 400, message: 'Yêu cầu không hợp lệ. Vui lòng kiểm tra và thử lại.' },
  NOT_FOUND: { status: 404, message: 'Không tìm thấy nội dung hoặc bạn không được phép truy cập.' },
  CONFLICT: {
    status: 409,
    message: 'Yêu cầu trùng với nội dung khác hoặc trạng thái bài đã thay đổi. Vui lòng tải lại.',
  },
  INTERNAL_ERROR: { status: 500, message: 'Hệ thống tạm thời gặp sự cố. Vui lòng thử lại sau.' },
} as const

export class ApiError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode) {
    super(errors[code].message)
    this.code = code
  }
}

export function success(data: unknown, requestId: string, headers: Headers): Response {
  return Response.json({ data, error: null, meta: { requestId } }, { headers })
}

export function failure(error: unknown, requestId: string, headers: Headers): Response {
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
  return Response.json({
    data: null,
    error: { code, message: errors[code].message, details: null },
    meta: { requestId },
  }, { status: errors[code].status, headers })
}

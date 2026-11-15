// Project ref công khai, được xác nhận bằng CLI; đổi môi trường phải review lại giá trị này.
const developmentProjectRef = 'puhkisyehspcmgzerutm'

export function readCloudTestConfig(env: NodeJS.ProcessEnv, linkedRef: string) {
  if (env.THEOU_ALLOW_CLOUD_TESTS !== 'theou-dev') {
    throw new Error('Chưa cho phép ghi dữ liệu kiểm thử Cloud. Chỉ chạy sau khi chủ dự án phê duyệt Giai đoạn B.')
  }
  const ref = env.THEOU_TEST_PROJECT_REF?.trim()
  if (ref !== developmentProjectRef || ref !== linkedRef.trim()) {
    throw new Error('Project ref kiểm thử không khớp project CLI đang liên kết.')
  }
  const url = env.THEOU_TEST_SUPABASE_URL?.trim()
  if (url !== `https://${ref}.supabase.co`) {
    throw new Error('URL kiểm thử phải khớp chính xác project ref đã xác nhận.')
  }
  const publishableKey = env.THEOU_TEST_PUBLISHABLE_KEY?.trim()
  const secretKey = env.THEOU_TEST_SECRET_KEY?.trim()
  if (!publishableKey?.startsWith('sb_publishable_') || !secretKey?.startsWith('sb_secret_')) {
    throw new Error('Thiếu publishable key hoặc secret key riêng cho test server. Không đặt các key test trong frontend.')
  }
  const emailBase = env.THEOU_TEST_EMAIL_BASE?.trim().toLowerCase()
  if (!emailBase || !/^[a-z0-9][a-z0-9.]{4,28}[a-z0-9]@gmail\.com$/.test(emailBase)
    || emailBase.includes('..')) {
    throw new Error('THEOU_TEST_EMAIL_BASE phải là địa chỉ Gmail gốc hợp lệ, username 6–30 ký tự, không có dấu cộng hoặc dấu chấm liên tiếp.')
  }
  return { url, publishableKey, secretKey, emailBase }
}

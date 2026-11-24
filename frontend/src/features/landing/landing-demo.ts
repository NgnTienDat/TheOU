// Synthetic content copied from the approved landing prototype.
export const demoPosts = [
      { tag:'confession', label:'Confession', body:'Có ai từng đi nhầm cơ sở vào ngày đầu nhập học chưa? Hay chỉ có mình tui 😭', votes:28, comments:12, hours:2 },
      { tag:'review', label:'ReviewMôn', body:'Mọi người có bí quyết học nhóm hiệu quả trước kỳ thi không? Cho mình xin kinh nghiệm với!', votes:17, comments:9, hours:4 },
      { tag:'documents', label:'TàiLiệu', body:'Có bạn nào biết cách hệ thống lại ghi chú các môn đại cương không? Mình đang tập làm đây ✨', votes:21, comments:6, hours:5 },
      { tag:'housing', label:'TìmTrọ', body:'Đầu năm học mới, mọi người hay tìm phòng trọ theo tiêu chí nào để đỡ đi lại?', votes:13, comments:5, hours:7 },
      { tag:'urgent', label:'HỏiGấp', body:'Mai thuyết trình nhóm mà run quá, mọi người có mẹo gì để bớt hồi hộp không?', votes:34, comments:18, hours:1 }
    ] as const

export function landingPosts(tag: string, sort: string) {
  return demoPosts.filter(post => tag === 'all' || post.tag === tag)
    .sort((a, b) => sort === 'hot' ? b.votes - a.votes : a.hours - b.hours)
    .slice(0, tag === 'all' ? 2 : 1)
}

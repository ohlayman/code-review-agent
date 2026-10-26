// Phase 1 不实现；GitHub/GitLab/Gitea 适配器后续在此扩展。
// 平台差异应在适配器内归一化为 ChangeSet，核心审查逻辑不感知平台专有字段。
export interface PlatformAdapter {
  postReviewComment(reviewId: string, body: string): Promise<void>;
}

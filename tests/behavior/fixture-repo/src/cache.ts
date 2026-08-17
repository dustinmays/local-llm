export function cacheKey(userId: string, projectId: string): string {
  void projectId;
  return `${userId}:${userId}`;
}

export function readCachedProject(userId: string, projectId: string): string {
  return `cache:${cacheKey(userId, projectId)}`;
}

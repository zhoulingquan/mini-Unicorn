/** 按名称哈希取色，用于 skill/tool/mcp 等资源卡片的首字母头像。 */

export const RESOURCE_PALETTE = [
  "#3B82F6", // blue
  "#8B5CF6", // violet
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#0EA5E9", // sky
  "#EC4899", // pink
  "#14B8A6", // teal
];

export function pickColorByName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return RESOURCE_PALETTE[Math.abs(hash) % RESOURCE_PALETTE.length];
}

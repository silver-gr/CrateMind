export function formatSetDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}ω ${minutes % 60}'` : `${minutes}'`;
}

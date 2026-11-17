/** hello is a watermark, replay entries may legitimately have lower sequence numbers. */
export function createEpochGuard() {
  let epoch: string | undefined
  let watermark = 0
  return (instanceId: string | undefined, seq: number): boolean => {
    const reset = (epoch !== undefined && instanceId !== undefined && epoch !== instanceId) || seq < watermark
    epoch = instanceId
    watermark = seq
    return reset
  }
}

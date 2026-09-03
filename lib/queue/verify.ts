import { Receiver } from '@upstash/qstash'

export async function verifyQstashSignature(signature: string, body: string): Promise<boolean> {
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
  })
  try {
    await receiver.verify({ signature, body })
    return true
  } catch {
    return false
  }
}

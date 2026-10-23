import { ImageResponse } from 'next/og'
import { AppIcon } from '@/lib/ui/app-icon'

// The icon never changes: it is drawn once, when the app is built.
export const dynamic = 'force-static'

export function GET() {
  return new ImageResponse(<AppIcon size={512} />, { width: 512, height: 512 })
}

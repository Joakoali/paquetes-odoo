'use client'

import { ErrorView } from '@/components/error-view'

// Catches what the admin screens throw. The admin layout itself is not under it: an error there goes up to the root.
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} />
}

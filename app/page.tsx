import { redirect } from 'next/navigation'

// Whoever has no session is sent on to /login from there (proxy.ts, and the layout of (app)).
export default function Home() {
  redirect('/recepcion')
}

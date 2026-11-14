import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, login } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { homeFor } from '@/lib/nav'
import { useSetupNeeded } from '@/lib/setup'

export function LoginPage() {
  const user = useAuth((s) => s.user)
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setup = useSetupNeeded()

  if (user) return <Navigate to={homeFor(user.role)} replace />
  if (setup.data?.needed) return <Navigate to="/setup" replace />

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const me = await login(String(form.get('username')), String(form.get('password')))
      navigate(homeFor(me.role), { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Wrong username or password.'
          : 'Could not reach the server. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Restaurant POS</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" autoFocus required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

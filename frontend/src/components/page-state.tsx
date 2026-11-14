export function PageState({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p className={`py-16 text-center text-sm ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
      {children}
    </p>
  )
}

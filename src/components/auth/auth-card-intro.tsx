interface AuthCardIntroProps {
  eyebrow: string
  title: string
  description: string
}

export function AuthCardIntro({
  eyebrow,
  title,
  description,
}: AuthCardIntroProps) {
  return (
    <div className="mesh-auth-card-intro text-center">
      <p className="mesh-auth-card-intro__eyebrow">{eyebrow}</p>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

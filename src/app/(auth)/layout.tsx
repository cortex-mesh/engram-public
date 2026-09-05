import { Archivo, Fraunces, Martian_Mono } from "next/font/google"

import { instrumentSerif, schibstedGrotesk } from "@/lib/fonts"
import { cn } from "@/lib/utils"

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-auth-display",
  display: "swap",
})

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-auth-body",
  display: "swap",
})

const martianMono = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-auth-mono",
  display: "swap",
})

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        fraunces.variable,
        archivo.variable,
        martianMono.variable,
        instrumentSerif.variable,
        schibstedGrotesk.variable,
      )}
    >
      {children}
    </div>
  )
}
